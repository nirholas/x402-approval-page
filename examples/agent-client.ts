/**
 * The agent's half of a human-in-the-loop purchase.
 *
 *   PRIVATE_KEY=0x... BASE_URL=http://localhost:4040 npx tsx examples/agent-client.ts
 *
 * It opens an approval request (free), prints the link for you to open, then
 * polls until a human decides. Each poll costs $0.001 in USDC, so the wallet
 * needs testnet USDC on Base Sepolia — faucet: https://faucet.circle.com
 *
 * Open the printed link in a browser and either approve (paying the amount with
 * your own wallet, on Base or Solana) or decline. Watch this process pick it up.
 *
 * This service is DUAL-RAIL: every 402 offers USDC on Base *and* USDC on Solana.
 * This example takes the EVM rail (see the Solana note at the bottom of the file).
 */
import { privateKeyToAccount } from "viem/accounts";
import { selectPaymentRequirements } from "x402/client";
import type { PaymentRequirements } from "x402/types";
import { wrapFetchWithPayment } from "x402-fetch";

const BASE_URL = process.env.BASE_URL || "http://localhost:4040";
const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Set PRIVATE_KEY to a funded Base Sepolia wallet (testnet USDC: https://faucet.circle.com)");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);

// The 402 lists both rails. A viem wallet can only sign the EVM one, so pin the
// selector to the EVM network instead of letting the default picker choose.
const EVM_NETWORK = (process.env.NETWORK || "base-sepolia") as "base" | "base-sepolia";
const payFetch = wrapFetchWithPayment(fetch, account, undefined, (reqs: PaymentRequirements[]) =>
  selectPaymentRequirements(reqs, EVM_NETWORK, "exact"),
);

function receipt(res: Response): string {
  const h = res.headers.get("x-payment-response");
  if (!h) return "(no X-PAYMENT-RESPONSE header)";
  try {
    return JSON.stringify(JSON.parse(Buffer.from(h, "base64").toString("utf8")));
  } catch {
    return h;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`agent wallet: ${account.address}\n`);

  // 1. Free: open the request. This is what an agent does the moment a purchase
  //    exceeds its own cap — it does not decide, it asks.
  console.log("POST /requests  (free) …");
  const created = await (
    await fetch(`${BASE_URL}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "Travel concierge",
        merchant: "Chez x402",
        description: "Table for 4, Friday 19:00, window seat",
        resource: "POST https://tablebook.example.com/book",
        reason:
          "This booking is $0.05 and my per-call cap is $0.01. The party size changed from 2 to 4, " +
          "so I need a person to confirm the larger spend.",
        amountUsd: 0.05,
        expiresInSeconds: 900,
      }),
    })
  ).json();

  if (created.error) {
    console.error("could not open the request:", created);
    process.exit(1);
  }

  console.log(JSON.stringify(created, null, 2));
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log("  Open this and decide:");
  console.log(`  ${created.links.approvalUrl}`);
  console.log("────────────────────────────────────────────────────────────────\n");

  // 2. Paid: poll for the outcome. $0.001 a look, and every look returns the
  //    signed snapshot as of that instant — there is nothing to wait on.
  const deadline = Date.now() + 10 * 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const res = await payFetch(`${BASE_URL}/requests/${created.requestId}`);
    const { payload, signature } = await res.json();

    console.log(
      `poll #${attempt}  ($0.001)  →  ${payload.decision}` +
        (payload.decision === "pending" ? `  (${payload.secondsRemaining}s left)` : ""),
    );
    if (attempt === 1) console.log("  payment receipt:", receipt(res));

    if (payload.decision !== "pending") {
      console.log("\nfinal outcome:\n" + JSON.stringify(payload, null, 2));
      console.log("\nsignature:", signature);

      if (payload.decision === "approved") {
        console.log("\n✓ A human authorized this. The grant is the proof:");
        console.log(`   grantToken:     ${payload.grantToken}`);
        console.log(`   they paid:      $${payload.amountUsd} on ${payload.paymentReceipt?.network}`);
        console.log(`   transaction:    ${payload.paymentReceipt?.transaction}`);
        console.log("\n   Now go make the purchase you were asking about.");
      } else if (payload.decision === "declined") {
        console.log(`\n✗ Declined${payload.note ? `: "${payload.note}"` : "."} Do not retry this request.`);
      } else {
        console.log("\n✗ Expired — nobody acted in time. Open a new request if it still matters.");
      }

      // 3. Free: anyone can verify the outcome without the signing secret.
      const verified = await (
        await fetch(`${BASE_URL}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload, signature }),
        })
      ).json();
      console.log("\nPOST /verify  (free) → valid:", verified.valid);
      return;
    }

    await sleep(5000);
  }

  console.log("\ngave up waiting — the request is still pending. Poll it again later.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Paying on the SOLANA rail instead
 *
 * The same 402 also offers `{ scheme: "exact", network: "solana", asset: <USDC
 * mint>, payTo: <base58>, maxAmountRequired, extra: { feePayer } }`. A Solana
 * agent builds an SPL `transferChecked` for that amount to `payTo` with the
 * facilitator's `feePayer` as fee payer (so it needs no SOL), signs it, and
 * retries with the base64 X-PAYMENT envelope:
 *
 *   const challenge = await (await fetch(`${BASE_URL}/requests/${id}`)).json();
 *   const accept    = challenge.accepts.find((a) => a.network.startsWith("solana"));
 *   // build + sign the SPL transfer with @solana/web3.js, or let the browser
 *   // modal do it: @three-ws/x402-payment-modal drives Phantom end to end —
 *   // which is exactly how the human approves on the page at GET /a/:id.
 *   const xPayment  = Buffer.from(JSON.stringify({
 *     x402Version: 1, scheme: "exact", network: accept.network,
 *     payload: { transaction: signedTxBase64 },
 *   })).toString("base64");
 *   // then retry the same request with { headers: { "X-PAYMENT": xPayment } }
 *
 * Raw dual-rail 402 body, for reference:
 *   curl -s http://localhost:4040/requests/apr_… | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
 * ───────────────────────────────────────────────────────────────────────────── */
