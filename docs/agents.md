# For AI agents

## When to reach for this

You have a purchase to make and it is above your spending cap. The wrong answers are to give up
silently, to retry until something breaks, or to find a way around the cap. The right answer is
to ask — and this service is the asking mechanism.

It is designed for the moment after a policy check fails. [x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet)
tells you *when* you need approval; [x402-mcp-commerce](https://github.com/nirholas/x402-mcp-commerce)
returns cap errors that point here.

## Discovery

- [`skill.md`](https://github.com/nirholas/x402-approval-page/blob/main/skill.md) — the capability
  sheet: endpoints, schemas, error codes, payment details. Served at `GET /skill.md`.
- `GET /.well-known/x402` — the machine-readable manifest, with **both networks**, `payTo` per
  rail, and an output schema per paid resource. The approve route is marked
  `priceIsDynamic: true` — its price is the request's own amount, not a constant. Indexed by
  [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).

## The loop

```
you hit your cap
  → POST /requests                      (free)    → approvalUrl + pollUrl + agentToken
  → hand approvalUrl to a human
  → GET /requests/:id                   ($0.001)  → "pending"
  … the human opens the page and pays through the modal …
  → GET /requests/:id                   ($0.001)  → "approved" + grantToken + paymentReceipt
  → make the purchase you were asking about
```

Opening the request is free — an agent that has already hit its cap should not have to spend
more to ask for help. Each poll is $0.001 and returns the signed snapshot as of that instant, so
there is never anything pending on the server's side that you have to wait for.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { selectPaymentRequirements } from "x402/client";
import { wrapFetchWithPayment } from "x402-fetch";

// Pin the selector to the EVM entry — a viem wallet can't sign the Solana one.
const payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(process.env.PRIVATE_KEY),
  undefined, (reqs) => selectPaymentRequirements(reqs, "base-sepolia", "exact"));

// 1. Ask. Free.
const { requestId, links } = await (await fetch(`${BASE}/requests`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    agent: "Travel concierge",
    merchant: "Chez x402",
    description: "Table for 4, Friday 19:00, window seat",
    reason: "This booking is $0.05 and my per-call cap is $0.01. The party grew from 2 to 4.",
    amountUsd: 0.05,
  }),
})).json();

console.log("send this to a human:", links.approvalUrl);

// 2. Poll. $0.001 a look.
const res = await payFetch(`${BASE}/requests/${requestId}`);
const { payload } = await res.json();
if (payload.decision === "approved") { /* payload.grantToken, payload.paymentReceipt */ }
```

## Writing the `reason`

This is the field that matters most and the one agents get wrong. A human is about to be asked
to spend money on your say-so, and the reason is the only context they get. Write it for them:

> "This booking is $0.05 and my per-call cap is $0.01. The party size changed from 2 to 4, so I
> need a person to confirm the larger spend."

Not:

> "cap_exceeded: per_call limit 0.01 < 0.05"

Same information, and only one of them lets someone decide in five seconds.

Fill in `merchant`, `description` and `resource` too. The page renders them; a request that says
"an AI agent wants $0.05 for a purchase" is one nobody should approve.

## Protocol version

This service speaks **x402 v1**. The challenge body is
`{ x402Version: 1, error, resource, accepts[] }`, and every `accepts[]` entry carries the
route's invocation contract in `outputSchema` — `input` (HTTP method, path/query params, JSON
body fields) and `output` (JSON Schema of the success body) — so a client can build a correct
call and validate the response straight from the 402 it just received, without fetching the
OpenAPI document first.

x402 **v2** moves those schemas to `extensions.bazaar.schema` and switches to CAIP-2 network
ids. It is a planned future upgrade for [agentcash](https://agentcash.com) compatibility;
switching today would break the `x402-fetch` clients shipped in `examples/`, so v1 remains the
wire format until the ecosystem's clients speak both.

## What you get back

On approval, the **grant** — and it is worth being precise about what it proves:

```json
{
  "requestId": "apr_…",
  "decision": "approved",
  "amountUsd": 0.05,
  "merchant": "Chez x402",
  "resource": "POST https://tablebook.example.com/book",
  "approvedAt": "2026-08-07T12:03:11.000Z",
  "grantToken": "grt_…",
  "paymentReceipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" }
}
```

Signed, timestamped, and tied to an on-chain transaction — evidence that a *person*, not you,
decided to spend this money on this specific thing. Keep it. Anyone can check it against the
service's `SIGNING_SECRET` through the free `POST /verify`, without holding the secret
themselves.

On decline, `note` may carry what the human said. Read it: "book the 2-person table instead" is
an instruction, not just a refusal. Do not re-open an identical request after a decline.

On `expired`, nobody acted in time. Opening a fresh request is fine if the purchase still
matters; opening five is not.

## Paying — two rails, one 402

**Pay in USDC on Base or Solana — your client picks the rail.** Both paid routes answer an
unpaid request with a single `402` whose `accepts` array carries both:

| rail | network | asset | payTo | signs |
|---|---|---|---|---|
| EVM | `base-sepolia` (default) / `base` | USDC (`0x036C…CF7e` on Sepolia) | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | EIP-3009 `transferWithAuthorization` |
| Solana | `solana` (default) / `solana-devnet` | USDC (`EPjF…TDt1v`) | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | SPL `transferChecked` |

Verification and settlement go to that rail's facilitator — the server never holds a key, and
the Solana lane's sponsor pays the SOL fee, so a paying agent needs only USDC.

The approve route's price is **dynamic**: `maxAmountRequired` is the request's own `amountUsd`
in atomic units, so the challenge is the invoice. A request that is already decided or expired
has no price at all and answers `409` rather than taking money for nothing.

## A note on the links

Approval links are unguessable but unauthenticated: anyone holding one can approve or decline.
That is deliberate — it is a payment link, and the payment is the approval. Don't post them
anywhere you wouldn't post an invoice.

## Rehearsing

[x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox) lets you exercise the whole
escalation flow — hit a cap against a fake merchant, escalate here, approve, proceed — for
fractions of a cent, before any of it touches a real booking.

## Listing this service

Operators: keep `/.well-known/x402` reachable at your public origin and submit the URL to
x402scan.com, the x402 Bazaar, and agentic.market. The manifest already carries prices, **both
networks**, `payTo` per rail, output schemas, and the dynamic-price marker on the approve route.

## Contact

**nichxbt@gmail.com**
