/**
 * The approval page a human actually opens.
 *
 * Server-rendered rather than a static file, because the whole point is that the
 * person sees *this* request — who is asking, for what, for how much, and why
 * the agent could not decide alone — before any wallet appears. The payment
 * button is the drop-in modal from `@three-ws/x402-payment-modal`, loaded from
 * the CDN and pointed at this request's own paid route, which is priced at
 * exactly the amount under discussion.
 *
 * The modal handles both rails from the 402 challenge: Phantom for USDC on
 * Solana, an EVM wallet for USDC on Base. It also carries SIWX re-entry (sign in
 * once, skip the prompt next time) and client-side spending caps, which is
 * exactly the right shape for a human who approves several of these a day.
 */
import type { PublicRequest } from "./service.js";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (n: number): string => `$${n.toFixed(n < 0.01 ? 6 : 2).replace(/0+$/, "").replace(/\.$/, "")}`;

const STYLE = `
  :root {
    --accent: #0052ff;
    --bg: #ffffff; --fg: #0b0e14; --muted: #5a6270; --card: #f5f7fa; --border: #e3e7ee;
    --code-bg: #0b0e14; --code-fg: #e6e9f0; --ok: #1a7f4b; --warn: #b45309; --bad: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0e14; --fg: #e6e9f0; --muted: #98a1b3; --card: #141a26; --border: #232b3b;
            --code-bg: #05070c; --code-fg: #dfe4ee; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--fg); line-height: 1.6; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 48px 20px 80px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
           border-radius: 999px; padding: 3px 12px; margin-bottom: 18px; }
  .badge.pending { color: var(--warn); border: 1px solid var(--warn); }
  .badge.approved { color: var(--ok); border: 1px solid var(--ok); }
  .badge.declined, .badge.expired { color: var(--bad); border: 1px solid var(--bad); }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .who { color: var(--muted); font-size: 15px; margin: 0 0 28px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px; margin-bottom: 20px; }
  .amount { font-size: 40px; font-weight: 800; letter-spacing: -0.03em; margin: 0; }
  .amount small { font-size: 15px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 18px; font-size: 14.5px; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .reason { border-left: 3px solid var(--accent); padding: 2px 0 2px 14px; margin: 18px 0 0; font-size: 15px; }
  button[data-x402-endpoint] {
    width: 100%; background: var(--accent); color: #fff; border: 0; border-radius: 10px;
    padding: 14px 18px; font: inherit; font-weight: 700; font-size: 16px; cursor: pointer;
  }
  button[data-x402-endpoint]:hover { filter: brightness(1.1); }
  .decline { width: 100%; margin-top: 10px; background: none; border: 1px solid var(--border); color: var(--muted);
             border-radius: 10px; padding: 11px 18px; font: inherit; font-size: 15px; cursor: pointer; }
  .decline:hover { color: var(--fg); }
  .fineprint { color: var(--muted); font-size: 13px; margin-top: 18px; }
  .fineprint code { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; font-size: 12px; }
  pre { background: var(--code-bg); color: var(--code-fg); border-radius: 12px; padding: 16px; overflow-x: auto;
        font-size: 12.5px; font-family: ui-monospace, Menlo, Consolas, monospace; line-height: 1.5; }
  .result { margin-top: 22px; }
  .result:empty { display: none; }
  .ok { color: var(--ok); font-weight: 700; }
  .bad { color: var(--bad); font-weight: 700; }
  a { color: var(--accent); }
`;

const LABEL: Record<string, string> = {
  pending: "Awaiting your decision",
  approved: "Approved and paid",
  declined: "Declined",
  expired: "Expired",
};

export function renderApprovalPage(r: PublicRequest, checkoutOrigin: string): string {
  const decided = r.decision !== "pending";
  const remaining = Math.max(0, Math.round((Date.parse(r.expiresAt) - Date.now()) / 60_000));

  const actions = decided
    ? ""
    : `
      <button
        data-x402-endpoint="/requests/${esc(r.requestId)}/approve"
        data-x402-method="POST"
        data-x402-merchant="${esc(r.merchant)}"
        data-x402-action="Approve ${esc(money(r.amountUsd))}"
        id="approve">Approve &amp; pay ${esc(money(r.amountUsd))}</button>
      <button class="decline" id="decline">Decline</button>
      <p class="fineprint">
        Paying is the approval — the money moves once, from your wallet, on the rail you choose.
        Pay in <strong>USDC on Base</strong> or <strong>USDC on Solana</strong>; the modal picks up
        whichever wallet you have. Nothing is charged if you decline or let it expire
        ${remaining > 0 ? `(${remaining} min left)` : ""}.
      </p>`;

  const outcome = decided
    ? `<div class="card">
        <p class="${r.decision === "approved" ? "ok" : "bad"}">${esc(LABEL[r.decision])}</p>
        ${r.decidedAt ? `<p class="fineprint">Decided ${esc(new Date(r.decidedAt).toLocaleString())}.</p>` : ""}
        ${r.note ? `<p class="fineprint">Note: ${esc(r.note)}</p>` : ""}
        ${r.grantToken ? `<p class="fineprint">Grant issued. The agent can now fetch the signed outcome and proceed.</p>` : ""}
      </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve ${esc(money(r.amountUsd))} — ${esc(r.merchant)}</title>
<meta name="robots" content="noindex">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <span class="badge ${esc(r.decision)}">${esc(LABEL[r.decision])}</span>
  <h1>${esc(r.agent)} wants to spend your money</h1>
  <p class="who">It hit its own spending cap and needs a person to sign off.</p>

  <div class="card">
    <p class="amount">${esc(money(r.amountUsd))} <small>USDC</small></p>
    <dl>
      <dt>Merchant</dt><dd>${esc(r.merchant)}</dd>
      <dt>Buying</dt><dd>${esc(r.description)}</dd>
      ${r.resource ? `<dt>Resource</dt><dd><code>${esc(r.resource)}</code></dd>` : ""}
      <dt>Requested</dt><dd>${esc(new Date(r.createdAt).toLocaleString())}</dd>
      <dt>Expires</dt><dd>${esc(new Date(r.expiresAt).toLocaleString())}</dd>
    </dl>
    <p class="reason">${esc(r.reason)}</p>
  </div>

  ${outcome}
  ${actions}

  <div class="result" id="result"></div>

  <p class="fineprint">
    Request <code>${esc(r.requestId)}</code>. The agent is polling
    <code>GET /requests/${esc(r.requestId)}</code> and will see your decision, signed, within seconds.
    It never sees your wallet.
  </p>
</div>

<script type="module" src="https://unpkg.com/@three-ws/x402-payment-modal"
        data-x402-checkout-origin="${esc(checkoutOrigin)}"></script>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[<&]/g, (c) => ({ "<": "&lt;", "&": "&amp;" })[c]);

  // detail is { ok, result, payment, response } — "result" is the signed grant.
  addEventListener("x402:result", (e) => {
    const { result, payment } = e.detail || {};
    const rail = payment?.network || payment?.rail || "chain";
    $("result").innerHTML =
      '<p class="ok">✓ Approved and settled on ' + esc(rail) + '. The agent has its grant.</p>' +
      "<pre>" + esc(JSON.stringify(result ?? e.detail, null, 2)) + "</pre>";
    if ($("approve")) $("approve").disabled = true;
    if ($("decline")) $("decline").remove();
  });

  addEventListener("x402:error", (e) => {
    const msg = (e.detail && (e.detail.error || e.detail.message)) || "unknown error";
    $("result").innerHTML = '<p class="bad">Payment did not complete: ' + esc(msg) + "</p>";
  });

  $("decline")?.addEventListener("click", async () => {
    const note = prompt("Optional: tell the agent why you're declining.") || "";
    const res = await fetch("/requests/${esc(r.requestId)}/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const body = await res.json();
    $("result").innerHTML = res.ok
      ? '<p class="bad">Declined. The agent will see this on its next poll.</p><pre>' +
        esc(JSON.stringify(body.payload ?? body, null, 2)) + "</pre>"
      : '<p class="bad">' + esc(body.message || "could not decline") + "</p>";
    if ($("approve")) $("approve").disabled = true;
  });
</script>
</body>
</html>
`;
}
