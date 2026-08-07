# x402-approval-page

> Human-in-the-loop checkout: agent requests approval above its cap, human pays via the drop-in modal, agent fetches the signed outcome.

![License](https://img.shields.io/badge/license-Apache--2.0-blue) ![x402](https://img.shields.io/badge/payments-x402-0052ff) ![USDC](https://img.shields.io/badge/asset-USDC-2775CA) ![Rails](https://img.shields.io/badge/rails-Base%20%2B%20Solana-9945FF)

**Pay in USDC on Base or Solana — your client picks the rail.**

An agent hits its spending cap. Instead of giving up or finding a way around it, it opens an
approval request here and sends a person a link. The human sees exactly what is being asked, for
how much, and why — then pays it with their own wallet. **That payment is the approval.** The
agent polls, gets back a signed grant tied to an on-chain transaction, and proceeds.

## Why x402 for this

Every other approval flow leaves two things to reconcile: a decision, and money that may or may
not have moved. Approve-then-charge means chasing a payment that failed after the fact;
charge-then-approve means holding funds you might have to return. x402 collapses both into one
event — the human signs a USDC payment for exactly the amount under discussion, it settles, and
the same response hands back the grant. There is no "approved but unfunded" state because there
is no moment between the two.

It also means the approval page needs no accounts, no card on file, and no merchant integration.
A link, a wallet, and a 402.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-approval-page
cd x402-approval-page && npm install
npm run dev                                          # on :4040, both rails live

# the agent half: opens a request, prints the link, polls until you decide
# (Base Sepolia USDC faucet: https://faucet.circle.com)
PRIVATE_KEY=0xAgentWallet npm run client
```

### Run the demo

Open **http://localhost:4040/** and play both sides. Fill in the form as the agent — amount,
merchant, what it wants, and why it can't decide alone — then follow the link and be the human.
Connect Phantom to approve on Solana or an EVM wallet to approve on Base; the same 402 serves
both.

## API

| Route | Price | What you get back |
|---|---|---|
| `POST /requests` | free | The approval link, the poll URL, and a one-time `agentToken`. |
| `GET /requests/:id` | **$0.001** | Signed outcome: `pending`, `approved` (with grant token + on-chain receipt), `declined` (with the human's note), or `expired`. |
| `POST /requests/:id/approve` | **the amount itself** | The human's route. Priced dynamically at the request's own `amountUsd`, so the 402 challenge is the invoice. Returns the signed grant. |
| `POST /requests/:id/decline` | free | Decline with a note, or withdraw your own request with the `agentToken`. |
| `GET /a/:id` | free | The page a human opens. |
| `GET /requests` · `POST /verify` · `GET /health` | free | Recent requests, signature verification, liveness. |

Every paid call returns its artifact in the same response — the poll returns the snapshot as of
that instant, the approval returns the grant. Nothing is delivered later.

Full reference: [docs/api.md](docs/api.md) · [openapi.json](openapi.json)

## The dynamic price

The approve route has no fixed price. It is worth exactly what the agent asked a human to
authorize:

```bash
curl -s -X POST http://localhost:4040/requests/apr_…/approve | jq '.accepts[] | {network, maxAmountRequired}'
# { "network": "base-sepolia", "maxAmountRequired": "50000" }   ← $0.05, the request's own amount
# { "network": "solana",       "maxAmountRequired": "50000" }
```

Paying it is idempotent — twice returns the same grant, not a second charge. The challenge comes
before the lookup, so an unpaid call always gets a 402 with both rails, even for an id that does
not exist. A request that is unknown or already decided cannot be invoiced, so it is challenged at
a nominal **$0.0001**, a hundredth of a cent, and the handler answers `404` / `409` once that
settles, rather than pretending the route is free.

## The flow

```
agent hits its cap
  → POST /requests                      (free)    → approvalUrl + pollUrl
  → sends approvalUrl to a human
  → GET /requests/:id                   ($0.001)  → "pending"
  … human opens the page, pays through the modal …
  → GET /requests/:id                   ($0.001)  → "approved" + grantToken + receipt
  → makes the purchase it was asking about
```

The grant is the artifact: signed, timestamped, and tied to a transaction hash — evidence that a
*person*, not the agent, decided to spend this money on this specific thing.

## How x402 works

1. Call a paid route → `402 Payment Required` with an `accepts` array listing **both rails**:
   USDC on Base (EVM, EIP-3009) and USDC on Solana (SPL `transferChecked`).
2. Whoever is paying picks whichever entry their wallet supports and signs it.
3. Retry with the base64 `X-PAYMENT` header; the matching facilitator verifies and settles on-chain.
4. `200` — artifact in the body, settlement receipt (`{rail, network, transaction, payer}`) in `X-PAYMENT-RESPONSE`.

| rail | network (default) | mainnet | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` | `NETWORK=base` | `PAY_TO_ADDRESS` | `FACILITATOR_URL` (default `https://x402.org/facilitator`) |
| Solana | `solana` | `SOLANA_NETWORK=devnet` for testing | `SOLANA_PAY_TO_ADDRESS` | `SOLANA_FACILITATOR_URL` (default `https://facilitator.payai.network`) |

Both rails ship with the suite's public receive addresses pre-filled in `.env.example`, so
`npm run dev` works with zero configuration. A rail with an invalid address is simply omitted
from `accepts` — the service still runs on the other.

## Human checkout

The approval page is **server-rendered** rather than a static file, because the point is that
the person sees *this* request — who is asking, for what, how much, and why the agent couldn't
decide alone — before any wallet appears.

The pay button is [`@three-ws/x402-payment-modal`](https://www.npmjs.com/package/@three-ws/x402-payment-modal),
loaded from the CDN and pointed at the request's own paid route. It reads the dual-rail 402 and
drives Phantom for Solana or an EVM wallet for Base.

Two of its features matter more here than anywhere else in the suite. **SIWX re-entry** means
someone who approves several of these a day signs in once instead of every single time. Its
**client-side spending caps** give the human the same kind of guardrail the agent has — useful
when the thing you are approving was itself generated by software. The modal is a proprietary
npm package by the same author, referenced via CDN and npm only, never vendored, so this repo
stays Apache-2.0.

The Solana lane needs two small server endpoints (`POST /api/x402-checkout`) because Phantom
signs serialized transactions rather than typed data; they are mounted from the package's
Express adapter, and only if the optional packages are installed. The EVM lane needs nothing
server-side. Verification and settlement never go through that package — both rails are verified
and settled through an x402 facilitator.

## Real backend / API keys

Fully self-contained: no third-party APIs, no paid keys, nothing fixture-labeled. Requests live
in memory by design — an approval that outlives a restart is usually one nobody should honour —
and `DATA_FILE` persists them if you disagree. Three envs matter:

- `SIGNING_SECRET` — the HMAC key behind every grant and outcome. Unset falls back to an insecure
  dev default; set it before anyone relies on a grant as proof.
- `MAX_APPROVAL_USD` (default 100) — the hard ceiling on what any single request may ask a human
  to authorize. This is the last line of defence against a compromised or confused agent.
- `SOLANA_RPC_URL` — used by the browser checkout endpoints. The public endpoint is heavily rate
  limited.

**Approval links are unguessable but unauthenticated**: anyone holding one can approve or
decline. That is deliberate — it is a payment link, and the payment is the approval. Treat it
like an invoice.

## For AI agents

- [`skill.md`](skill.md) — agent-facing capability sheet, served at `GET /skill.md`.
- `GET /.well-known/x402` — machine-readable manifest ([source](public/.well-known/x402)) listing
  both networks per resource and marking the approve route's price as dynamic, in the format
  indexed by [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).
- MCP: [`examples/mcp-tool.md`](examples/mcp-tool.md) exposes `request_approval` and
  `check_approval` to Claude with a `claude_desktop_config.json` example.
- Guide: [docs/agents.md](docs/agents.md) — including how to write a `reason` a human can act on.

Pairs with [x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet) (policy checks that
tell an agent *when* it needs approval), [x402-mcp-commerce](https://github.com/nirholas/x402-mcp-commerce)
(whose cap errors point here), and [x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox)
(rehearse the whole escalation for fractions of a cent).

## Docs

Site: **https://nirholas.github.io/x402-approval-page/** — [tutorial](docs/tutorial.md) · [API](docs/api.md) · [agents](docs/agents.md) · [curl walkthrough](examples/curl.md)

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## Support

Questions, bugs, integration help: **nichxbt@gmail.com**

## License

[Apache-2.0](LICENSE)
