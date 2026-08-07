# API reference

Base URL: your deployment (default `http://localhost:4040`). Paid routes speak x402: an unpaid
request returns `402` with `PaymentRequirements` listing **both** payment rails (USDC on Base
and USDC on Solana); pay either and retry with `X-PAYMENT`.
Full machine-readable spec: [`openapi.json`](https://github.com/nirholas/x402-approval-page/blob/main/openapi.json).

---

## POST /requests — free

Open an approval request. Free by design: an agent that has already hit its spending cap should
not have to spend more to ask for help.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `amountUsd` | number | yes | Positive. Rejected above the deployment's `MAX_APPROVAL_USD`. |
| `reason` | string | yes | Why the agent can't decide alone. Shown prominently to the human — write it for them, not for a log. |
| `agent` | string | no | Who is asking. Defaults to "an AI agent"; supply something better. |
| `merchant` | string | no | Who would be paid. |
| `description` | string | no | What is being bought. |
| `resource` | string | no | The exact route the agent would call. |
| `expiresInSeconds` | integer | no | Default `DEFAULT_TTL_SECONDS` (3600), max 86400. |

**`201`**

```json
{
  "requestId": "apr_af7c54673f48500a11",
  "agent": "Travel concierge",
  "merchant": "Chez x402",
  "resource": "POST https://tablebook.example.com/book",
  "description": "Table for 4, Friday 19:00, window seat",
  "reason": "This booking is $0.05 and my per-call cap is $0.01…",
  "amountUsd": 0.05,
  "currency": "USD",
  "createdAt": "2026-08-07T12:00:00.000Z",
  "expiresAt": "2026-08-07T12:15:00.000Z",
  "decision": "pending",
  "decidedAt": null,
  "note": null,
  "paymentReceipt": null,
  "grantToken": null,
  "links": {
    "approvalUrl": "http://localhost:4040/a/apr_af7c54673f48500a11",
    "pollUrl": "http://localhost:4040/requests/apr_af7c54673f48500a11",
    "payUrl": "http://localhost:4040/requests/apr_af7c54673f48500a11/approve"
  },
  "agentToken": "agt_…",
  "signature": "hex HMAC-SHA256 over the request"
}
```

`agentToken` is returned **exactly once**. It lets the agent withdraw its own request later.
Send `links.approvalUrl` to the human.

**Errors**: `400 INVALID_AMOUNT`, `400 AMOUNT_TOO_LARGE`, `400 REASON_REQUIRED`.

---

## GET /requests/:id — $0.001

The agent's poll. Buys the current signed outcome — a snapshot as of right now, in the response
body. There is nothing to wait on and nothing delivered later.

**`200`**

```json
{
  "payload": {
    "requestId": "apr_af7c54673f48500a11",
    "decision": "approved",
    "amountUsd": 0.05,
    "currency": "USD",
    "merchant": "Chez x402",
    "resource": "POST https://tablebook.example.com/book",
    "description": "Table for 4, Friday 19:00, window seat",
    "reason": "…",
    "createdAt": "2026-08-07T12:00:00.000Z",
    "expiresAt": "2026-08-07T12:15:00.000Z",
    "decidedAt": "2026-08-07T12:03:11.000Z",
    "note": null,
    "paymentReceipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" },
    "grantToken": "grt_…",
    "secondsRemaining": 709,
    "checkedAt": "2026-08-07T12:03:20.000Z"
  },
  "signature": "hex…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

| `decision` | Meaning | What to do |
|---|---|---|
| `pending` | Nobody has acted yet. | Poll again later. Each look costs $0.001 — use a sensible interval. |
| `approved` | A human paid. `grantToken` and `paymentReceipt` are present. | Proceed with the purchase. Keep the grant. |
| `declined` | A human said no. `note` may explain. | Do not retry this request. |
| `expired` | Nobody acted before `expiresAt`. | Open a new request if it still matters. |

**Errors**: `402`, `404 NOT_FOUND`.

---

## POST /requests/:id/approve — the request's own `amountUsd`

The **human's** route. Priced dynamically at exactly the amount the agent asked them to
authorize, so the 402 challenge is itself the invoice:

```bash
curl -s -X POST http://localhost:4040/requests/apr_…/approve | jq '.accepts[] | {network, maxAmountRequired}'
# { "network": "base-sepolia", "maxAmountRequired": "50000" }   ← $0.05, not a flat fee
# { "network": "solana",       "maxAmountRequired": "50000" }
```

Paying it **is** the approval. The signed grant comes back in the same response.

**`200`**

```json
{
  "payload": {
    "requestId": "apr_af7c54673f48500a11",
    "decision": "approved",
    "amountUsd": 0.05,
    "currency": "USD",
    "merchant": "Chez x402",
    "resource": "POST https://tablebook.example.com/book",
    "description": "Table for 4, Friday 19:00, window seat",
    "approvedAt": "2026-08-07T12:03:11.000Z",
    "expiresAt": "2026-08-07T12:15:00.000Z",
    "grantToken": "grt_…",
    "paymentReceipt": { "success": true, "rail": "solana", "network": "solana", "transaction": "5Kd…", "payer": "…" }
  },
  "signature": "hex…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

Idempotent: paying twice returns the same grant rather than minting a second one or charging
again. The paywall runs before the lookup, so an unpaid call gets the 402 challenge whether or not
the id exists. A request that is unknown or already decided has no invoice to quote and is
challenged at a nominal **$0.0001**; the handler answers `404` / `409` once that payment
settles.

**Errors**: `402`, `404 NOT_FOUND`, `409 ALREADY_DECIDED`.

---

## POST /requests/:id/decline — free

Never charged. Nobody should pay to say no.

**Body**

| Field | Notes |
|---|---|
| `note` | Optional, ≤500 chars. Comes back on the agent's next poll — the difference between "denied" and telling the agent what to do instead. |
| `agentToken` | Optional. An agent withdrawing its own request proves it with this; a human declining from the link doesn't need it. |

**`200`** — the signed outcome, same shape as `GET /requests/:id`.

**Errors**: `403 BAD_AGENT_TOKEN`, `404 NOT_FOUND`, `409 ALREADY_DECIDED`.

---

## GET /a/:id — free

The page a human opens. Server-rendered so the person sees *this* request — who is asking, for
what, how much, and why — before any wallet appears. Carries the drop-in payment modal wired to
the approve route, plus a decline button.

`404` renders a plain "no such request" page rather than JSON.

---

## GET /requests — free

Recent requests on this deployment, newest first. `?limit=` (default 20). Never includes
`agentToken`.

---

## POST /verify — free

`{ payload, signature }` → `{ valid: true|false, canonical: "…" }` for any grant or outcome this
service signed. `canonical` is the exact string that was HMAC'd — keys sorted recursively, no
whitespace — so you can reproduce the signature offline with `SIGNING_SECRET`.

---

## GET /health — free

`{ ok: true, service: "x402-approval-page", rails: ["base", "solana"] }`.

## GET /skill.md, GET /.well-known/x402 — free

The agent-facing capability sheet and the machine-readable discovery manifest.

## POST /api/x402-checkout — free

The browser payment modal's Solana `prepare`/`encode` endpoints. Phantom signs serialized
transactions rather than typed data, so the SPL transfer is built server-side. Agents never call
this; the EVM rail needs nothing equivalent. Mounted only if `@three-ws/x402-payment-modal`,
`@solana/web3.js` and `@solana/spl-token` are installed — otherwise Phantom checkout is disabled
and everything else keeps working.

---

## 402 shape (both paid routes)

Dual-rail: `accepts` always lists **both** USDC on Base and USDC on Solana. Pay either one.

```json
{
  "x402Version": 1,
  "error": "Payment required — pay in USDC on Base or Solana; your client picks the rail.",
  "resource": {
    "url": "http://localhost:4040/requests/apr_af7c54673f48500a11",
    "description": "Signed approval outcome — approved (with grant + receipt), declined, pending, or expired",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "1000",
      "resource": "http://localhost:4040/requests/apr_af7c54673f48500a11",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 60, "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact", "network": "solana", "maxAmountRequired": "1000", "amount": "1000",
      "resource": "http://localhost:4040/requests/apr_af7c54673f48500a11",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 60,
      "extra": { "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "name": "USDC", "decimals": 6 }
    }
  ]
}
```

Amounts are atomic units — USDC has 6 decimals, so `1000` is $0.001 and `50000` is $0.05.

On success the `200` carries the artifact in the body and the receipt in `X-PAYMENT-RESPONSE`
(base64 JSON: `{success, rail, network, transaction, payer}`).

## Error codes

| HTTP | code | meaning |
|---|---|---|
| 400 | `INVALID_AMOUNT` / `AMOUNT_TOO_LARGE` / `REASON_REQUIRED` / `INVALID_REQUEST` | malformed request; `AMOUNT_TOO_LARGE` means it exceeds `MAX_APPROVAL_USD` |
| 402 | (x402) | payment required — pay and retry |
| 403 | `BAD_AGENT_TOKEN` | the `agentToken` does not match this request |
| 404 | `NOT_FOUND` | unknown request id |
| 409 | `ALREADY_DECIDED` | already approved, declined, or expired |
| 500 | `INTERNAL` | unexpected error |
