# x402-approval-page — agent skill

Human-in-the-loop checkout for agents. When a purchase is above your spending cap, open an
approval request here (free), send the link to a person, and poll for the outcome. The human
sees exactly what you want to buy and why, then pays it with their own wallet — **that payment
is the approval**, so there is never an "approved but unfunded" state to reconcile. You get back
a signed grant: proof a human authorized this specific purchase for this specific amount, plus
the on-chain receipt.

**Base URL**: `{BASE_URL}` (self-hosted — e.g. `http://localhost:4040`)

## Endpoints

### POST /requests — free
Open a request. Free by design: an agent that has already hit its cap should not have to spend
more to ask for help.

Request body:
```json
{
  "agent": "Travel concierge",
  "merchant": "Chez x402",
  "description": "Table for 4, Friday 19:00, window seat",
  "resource": "POST https://tablebook.example.com/book",
  "reason": "This booking is $0.05 and my per-call cap is $0.01. The party size changed from 2 to 4.",
  "amountUsd": 0.05,
  "expiresInSeconds": 3600
}
```

| Field | Required | Notes |
|---|---|---|
| `amountUsd` | yes | Positive. Capped by the deployment's `MAX_APPROVAL_USD`. |
| `reason` | yes | Why you can't decide alone. Shown prominently to the human — write it for them, not for a log. |
| `agent`, `merchant`, `description`, `resource` | no | Context. Defaults are vague; supply them. |
| `expiresInSeconds` | no | Default 3600, max 86400. |

Response `201`:
```json
{
  "requestId": "apr_af7c54673f48500a11",
  "agent": "Travel concierge",
  "merchant": "Chez x402",
  "description": "Table for 4, Friday 19:00, window seat",
  "reason": "…",
  "amountUsd": 0.05,
  "currency": "USD",
  "createdAt": "2026-08-07T12:00:00.000Z",
  "expiresAt": "2026-08-07T13:00:00.000Z",
  "decision": "pending",
  "decidedAt": null,
  "note": null,
  "paymentReceipt": null,
  "grantToken": null,
  "links": {
    "approvalUrl": "{BASE_URL}/a/apr_af7c54673f48500a11",
    "pollUrl": "{BASE_URL}/requests/apr_af7c54673f48500a11",
    "payUrl": "{BASE_URL}/requests/apr_af7c54673f48500a11/approve"
  },
  "agentToken": "agt_… (shown once — keep it)",
  "signature": "hex HMAC-SHA256"
}
```

Send `links.approvalUrl` to the human. Keep `agentToken`: it is returned exactly once and lets
you withdraw your own request.

### GET /requests/:id — $0.001 (paid via x402)
Your poll. Buys the current signed outcome — a snapshot as of right now, in the response body.

Response `200`:
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
    "createdAt": "…", "expiresAt": "…", "decidedAt": "…",
    "note": null,
    "paymentReceipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" },
    "grantToken": "grt_…",
    "secondsRemaining": 2841,
    "checkedAt": "…"
  },
  "signature": "hex…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

`decision` ∈ `pending | approved | declined | expired`.

- **approved** — `grantToken` and `paymentReceipt` are present. Proceed.
- **declined** — `note` may carry what the human said. Do not retry the same request.
- **expired** — nobody acted in time. Open a new request if it still matters.
- **pending** — check again later. Poll on a sensible interval; each look costs $0.001.

### POST /requests/:id/approve — the request's own `amountUsd` (paid via x402)
The **human's** route, not yours. Priced dynamically at exactly the amount under discussion, so
the 402 challenge is itself the invoice. Paying it is the approval; the signed grant comes back
in the same response.

Response `200`:
```json
{
  "payload": {
    "requestId": "apr_…", "decision": "approved", "amountUsd": 0.05, "currency": "USD",
    "merchant": "Chez x402", "resource": "…", "description": "…",
    "approvedAt": "…", "expiresAt": "…",
    "grantToken": "grt_…",
    "paymentReceipt": { "success": true, "rail": "solana", "network": "solana", "transaction": "…", "payer": "…" }
  },
  "signature": "hex…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

Idempotent: paying twice returns the same grant rather than minting a second one. A request that
is already decided or expired has no price and answers `409 ALREADY_DECIDED`.

### Free routes
- `POST /requests/:id/decline` `{note?, agentToken?}` — the human declines, or you withdraw your
  own request with the `agentToken`. Returns the signed outcome. Never charged.
- `GET /a/:id` — the page a human opens.
- `GET /requests?limit=` — recent requests on this deployment (no secrets).
- `POST /verify` `{payload, signature}` — `{valid, canonical}` for any grant or outcome.
- `GET /health`, `GET /skill.md`, `GET /.well-known/x402`.

## The pattern

```
agent hits its cap
  → POST /requests                      (free)   → approvalUrl + pollUrl
  → send approvalUrl to a human
  → GET /requests/:id                   ($0.001) → "pending"
  … human opens the page, pays through the modal …
  → GET /requests/:id                   ($0.001) → "approved" + grantToken + receipt
  → proceed with the purchase
```

The grant is the artifact. Keep it: it is the evidence that a person, not the agent, decided to
spend this money — signed, timestamped, and tied to an on-chain transaction.

Pairs with [x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet) (policy checks that
tell you when you need approval) and
[x402-mcp-commerce](https://github.com/nirholas/x402-mcp-commerce), whose cap errors point here.

## Payment

x402 protocol (HTTP 402). **Pay in USDC on Base or Solana — your client picks the rail.**

Both paid routes answer an unpaid request with one `402` whose `accepts` array lists both rails:

| rail | network | asset | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (default) or `base` | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `https://x402.org/facilitator` |
| Solana | `solana` (default) or `solana-devnet` | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `https://facilitator.payai.network` |

Flow: call the route → receive `402` with `accepts` → pick the entry your wallet supports → sign
the USDC payment (EIP-3009 authorization on EVM, SPL `transferChecked` on Solana) → retry with
the base64 `X-PAYMENT` header. The artifact comes back in the `200` body and the settlement
receipt in `X-PAYMENT-RESPONSE`.

Humans use `@three-ws/x402-payment-modal` in the browser, which reads the same challenge and
drives Phantom or an EVM wallet. Agents use `x402-fetch` or any x402 client.

## Error codes

| HTTP | code | meaning |
|---|---|---|
| 400 | `INVALID_AMOUNT` / `AMOUNT_TOO_LARGE` / `REASON_REQUIRED` | malformed request; `AMOUNT_TOO_LARGE` means it exceeds this deployment's `MAX_APPROVAL_USD` |
| 402 | (x402) | payment required — pay and retry |
| 403 | `BAD_AGENT_TOKEN` | the `agentToken` does not match this request |
| 404 | `NOT_FOUND` | unknown request id |
| 409 | `ALREADY_DECIDED` | already approved, declined, or expired |
| 500 | `INTERNAL` | unexpected error |

Machine-readable manifest: [`/.well-known/x402`]({BASE_URL}/.well-known/x402)

Contact: **nichxbt@gmail.com**
