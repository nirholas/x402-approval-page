---
name: human-approval-checkout
description: Open a human approval request when an agent purchase exceeds its spending cap, send the link to a person, and poll for the signed grant, using a self-hosted x402-approval-page server. Use when an agent hits its cap and needs a human to authorize the spend.
---

# x402-approval-page

When an agent wants to buy something above its cap, it opens a request here,
sends a link to a human, and polls. The human pays the request amount with their
own wallet; that payment is the approval, so there is no approved-but-unfunded
state. The agent receives a signed grant with the on-chain receipt.

## Run the server

It is a self-hosted Node server (Express, Node 18 or newer). Run it from a clone:

```bash
git clone https://github.com/nirholas/x402-approval-page && cd x402-approval-page
npm install
cp .env.example .env     # then adjust; see the comments in the file
npm run dev              # tsx src/server.ts, listens on PORT (default 4040)
```

`npm run build` then `npm start` runs the compiled server. `npm run client`
runs `examples/agent-client.ts`, a reference paying client. Set `PAY_TO_ADDRESS`
and `SOLANA_PAY_TO_ADDRESS` to your own wallets to be paid yourself.

Related settings: `MAX_APPROVAL_USD` (cap on any request, default 100),
`DEFAULT_TTL_SECONDS` (default 3600), `SIGNING_SECRET`, `DATA_FILE`.

## Flow

1. `POST /requests` (free) with `amountUsd` and `reason` (required), plus
   optional `agent`, `merchant`, `description`, `resource`, `expiresInSeconds`
   (default 3600, max 86400). The 201 response has `requestId`, `links`
   (`approvalUrl`, `pollUrl`, `payUrl`) and an `agentToken` shown once.
2. Give `links.approvalUrl` (`GET /a/:id`) to the human.
3. Poll `GET /requests/:id` ($0.001 per look, paid via x402). The signed payload
   has `decision`: `pending`, `approved`, `declined` or `expired`. On `approved`
   it carries `grantToken` and `paymentReceipt`.
4. The human's route `POST /requests/:id/approve` is priced at the request's own
   `amountUsd`; paying it is the approval.

Free routes: `POST /requests/:id/decline` (body `note`, `agentToken`; the human
declines or the agent withdraws), `GET /requests?limit=`, `POST /verify`
(body `{ payload, signature }`), `GET /health`, `GET /skill.md`,
`GET /.well-known/x402`. Do not retry a declined request. Write `reason` for
the human reader.

## Example

```bash
curl -s -X POST http://localhost:4040/requests -H 'content-type: application/json' \
  -d '{"agent":"Travel concierge","merchant":"Chez x402","amountUsd":0.05,"reason":"Party size changed from 2 to 4, above my $0.01 cap."}'
```

## Paying (x402)

Paid routes follow the x402 protocol. An unpaid call returns HTTP 402 with an
`accepts` array listing USDC on Base and USDC on Solana. Sign for one rail,
retry with the base64 payload in the `X-PAYMENT` header, and the 200 body
carries the result; the settlement receipt is in the `X-PAYMENT-RESPONSE`
header. Clients: `x402-fetch` (EVM), `@three-ws/x402-payment-modal` (browser,
both rails), or any x402 client. The rail networks are chosen by `NETWORK`
(EVM, `base-sepolia` by default) and `SOLANA_NETWORK` in `.env`; see
`.env.example`. Settlement moves real USDC on the chosen network: show the user
the recipient, amount and network and get an explicit yes before every paid call.
