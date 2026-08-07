import "dotenv/config";
import express from "express";
import { join } from "node:path";
import { renderApprovalPage } from "./page.js";
import { paywall, railSummary, type RoutePrices } from "./payments.js";
import { ROUTE_SCHEMAS } from "./schemas.js";
import {
  ApprovalError,
  approve,
  create,
  decline,
  get,
  outcome,
  priceFor,
  recent,
  toPublic,
  verifyArtifact,
} from "./service.js";

/**
 * Paid routes.
 *
 * The agent's poll (GET on a request) is a fixed $0.001 for the current signed
 * outcome. The human's approval route is priced at whatever the agent asked them
 * to authorize, so the 402 challenge is itself the invoice.
 *
 * Both routes challenge first and look the request up afterwards: an unpaid call
 * always gets a 402 with both rails in `accepts`, even for an id that does not
 * exist, because that is what discovery probes and unfamiliar agents need to
 * see. An id that is unknown or already decided cannot be invoiced, so it is
 * challenged at `NOMINAL_PRICE` (one atomic USDC unit) and the handler answers
 * 404 / 409 — or replays the existing grant — once payment settles.
 */
const PRICES: RoutePrices = {
  "GET /requests/*": {
    price: "$0.001",
    description: "Signed approval outcome — approved (with grant + receipt), declined, pending, or expired",
    ...ROUTE_SCHEMAS["GET /requests/*"],
  },
  "POST /requests/*/approve": {
    price: (req) => priceFor(String(req.path.split("/")[2] ?? "")),
    description: "Human approval — paying this is the approval; returns the signed grant",
    ...ROUTE_SCHEMAS["POST /requests/*/approve"],
  },
};

const app = express();
app.use(express.json({ limit: "256kb" }));

// The approval page is same-origin, but keep CORS permissive so an operator can
// host the page somewhere else and still point the modal here.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-payment");
  res.setHeader("Access-Control-Expose-Headers", "x-payment-response");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Browser Solana checkout. Phantom signs serialized transactions rather than
// typed data, so the payment modal POSTs here to have the SPL transferChecked
// built (`prepare`) and the signed tx wrapped into the X-PAYMENT envelope
// (`encode`). This is checkout construction only — verification and settlement
// happen in payments.ts through the x402 facilitator, like every other rail.
// The EVM lane needs nothing server-side.
await mountSolanaCheckout(app);

// Dual-rail x402: both paid routes offer USDC on Base *and* USDC on Solana.
app.use(paywall(PRICES));

app.use(express.static(join(process.cwd(), "public"), { dotfiles: "allow", index: false }));

// ---------------------------------------------------------------- free routes

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-approval-page", rails: ["base", "solana"] });
});

app.get("/skill.md", (_req, res) => {
  res.type("text/markdown").sendFile(join(process.cwd(), "skill.md"));
});

/**
 * POST /requests — free.
 *
 * Opening a request costs nothing: an agent that has already hit its cap should
 * not have to spend more to ask for help. Returns the link to send a human, the
 * poll URL, and the agentToken (shown once).
 */
app.post("/requests", (req, res) => {
  try {
    res.status(201).json(create(req.body || {}, baseUrl(req)));
  } catch (e) {
    handleError(res, e);
  }
});

// Free — the human declines. Never charge someone to say no.
app.post("/requests/:id/decline", (req, res) => {
  try {
    res.json(decline(req.params.id, req.body?.note, req.body?.agentToken));
  } catch (e) {
    handleError(res, e);
  }
});

// Free — verify any artifact this service signed.
app.post("/verify", (req, res) => {
  const { payload, signature } = req.body || {};
  if (payload === undefined || typeof signature !== "string") {
    res.status(400).json({ error: "INVALID_REQUEST", message: "send { payload, signature }" });
    return;
  }
  res.json(verifyArtifact(payload, signature));
});

// Free — the page a human opens. Server-rendered so they see this request.
app.get("/a/:id", (req, res) => {
  try {
    res.type("html").send(renderApprovalPage(toPublic(get(req.params.id)), baseUrl(req)));
  } catch (e) {
    if (e instanceof ApprovalError) {
      res.status(e.status).type("html").send(notFoundPage(req.params.id));
      return;
    }
    handleError(res, e);
  }
});

// Free — recent requests, for the demo gallery. Never leaks agentToken.
app.get("/requests", (req, res) => {
  res.json({ requests: recent(Number(req.query.limit) || 20) });
});

// ---------------------------------------------------------------- paid routes

/**
 * POST /requests/:id/approve — priced at the request's own amount.
 *
 * The paywall has already verified and settled the human's payment by the time
 * this handler runs, so reaching it *is* the approval. The signed grant goes
 * back in the same response, and the settlement receipt rides in
 * X-PAYMENT-RESPONSE — which is also what the agent will see on its next poll.
 */
app.post("/requests/:id/approve", (req, res) => {
  try {
    const receiptHeader = res.getHeader("X-PAYMENT-RESPONSE");
    let receipt: Record<string, unknown> | null = null;
    if (typeof receiptHeader === "string") {
      try {
        receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")) as Record<string, unknown>;
      } catch {
        receipt = { raw: receiptHeader };
      }
    }
    res.json(approve(req.params.id, receipt));
  } catch (e) {
    handleError(res, e);
  }
});

// GET /requests/:id ($0.001) — the agent's poll. Snapshot in, snapshot out.
app.get("/requests/:id", (req, res) => {
  try {
    res.json(outcome(req.params.id));
  } catch (e) {
    handleError(res, e);
  }
});

// The demo gallery.
app.get("/", (_req, res) => {
  res.sendFile(join(process.cwd(), "public", "index.html"));
});

// -------------------------------------------------------------------- helpers

function baseUrl(req: express.Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

function handleError(res: express.Response, e: unknown): void {
  if (e instanceof ApprovalError) {
    res.status(e.status).json({ error: e.code, message: e.message });
    return;
  }
  console.error(e);
  res.status(500).json({ error: "INTERNAL", message: "unexpected error" });
}

function notFoundPage(id: string): string {
  return `<!doctype html><meta charset="utf-8"><title>No such request</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;line-height:1.6">
<h1 style="font-size:22px">No such approval request</h1>
<p style="color:#5a6270">Nothing here matches <code>${id.replace(/[<&]/g, "")}</code>. The link may be mistyped, or the
request may have been created on a different deployment.</p>
</body>`;
}

/**
 * Mounts the payment modal's Solana checkout router if the optional packages are
 * installed. Missing them disables Phantom checkout and nothing else — the EVM
 * rail and the whole agent-facing API keep working.
 */
async function mountSolanaCheckout(target: express.Express): Promise<void> {
  try {
    const mod = await import("@three-ws/x402-payment-modal/server/express");
    target.all(
      "/api/x402-checkout",
      mod.x402CheckoutRouter({
        rpcUrl: process.env.SOLANA_RPC_URL,
        devnetRpcUrl: process.env.SOLANA_DEVNET_RPC_URL,
      }),
    );
  } catch {
    console.warn(
      "[x402] Solana browser checkout not mounted — install @three-ws/x402-payment-modal, @solana/web3.js and @solana/spl-token to enable Phantom checkout. The Base rail is unaffected.",
    );
  }
}

const port = Number(process.env.PORT || 4040);
app.listen(port, () => {
  console.log(`x402-approval-page listening on :${port}`);
  for (const line of railSummary()) console.log(line);
  console.log("  paid routes:");
  console.log("    GET  /requests/:id          $0.001   signed approval outcome");
  console.log("    POST /requests/:id/approve  the request's own amount   the human's payment = the approval");
  console.log("  free routes: POST /requests, POST /requests/:id/decline, POST /verify,");
  console.log("               GET /a/:id (the human's page), GET /requests, GET /health");
  console.log(`  demo page:  http://localhost:${port}/`);
  console.log("  discovery:  GET /.well-known/x402, /skill.md");
});
