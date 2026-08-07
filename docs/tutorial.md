# Tutorial

From a clean clone to an agent asking you for permission, you approving with your own wallet,
and the agent reading the signed grant — the whole loop, on testnet.

## 1. Install

```bash
git clone https://github.com/nirholas/x402-approval-page
cd x402-approval-page
npm install
```

Node 18+ required.

## 2. Configure

```bash
cp .env.example .env
```

Every value has a working default, so you can skip to step 3. The ones worth knowing:

```
PAY_TO_ADDRESS=0x40252CFDF8B20Ed757D61ff157719F33Ec332402        # EVM (Base) receive address
SOLANA_PAY_TO_ADDRESS=WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW  # Solana receive address
MAX_APPROVAL_USD=100                                              # ceiling on any single request
DEFAULT_TTL_SECONDS=3600                                          # how long a request stays open
SIGNING_SECRET=                                                   # HMAC key behind every grant
```

`MAX_APPROVAL_USD` is the one to think about. It is the last line of defence against a
compromised or confused agent — no request may ask a human to authorize more than this,
whatever the agent claims. Set it to the largest amount you would be comfortable seeing on an
approval page.

## 3. Run it

```bash
npm run dev
```

```
x402-approval-page listening on :4040
  rail evm     base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402  (facilitator https://x402.org/facilitator)
  rail solana  solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW  (facilitator https://facilitator.payai.network)
  paid routes:
    GET  /requests/:id          $0.001   signed approval outcome
    POST /requests/:id/approve  the request's own amount   the human's payment = the approval
```

## 4. Play both sides in the browser

Open **http://localhost:4040/**. Fill in the form as the agent — amount, merchant, what it wants
to buy, and why it can't decide alone — and click *Open the approval request*. You get back
exactly what an agent gets: a `requestId`, the three links, and a one-time `agentToken`.

Follow the approval link and you are now the human. You see who is asking, for how much, and the
reason, with a pay button and a decline button. Nothing about a wallet appears until you choose
to pay.

## 5. Open a request from the command line

```bash
curl -s -X POST http://localhost:4040/requests \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "Travel concierge",
    "merchant": "Chez x402",
    "description": "Table for 4, Friday 19:00, window seat",
    "reason": "This booking is $0.05 and my per-call cap is $0.01. The party size changed from 2 to 4.",
    "amountUsd": 0.05,
    "expiresInSeconds": 900
  }' | jq
```

Free — an agent that has already hit its cap should not have to spend more to ask for help.

## 6. The two 402s

The agent's poll costs a flat $0.001:

```bash
RID=apr_…
curl -s http://localhost:4040/requests/$RID | jq '.accepts[] | {network, maxAmountRequired}'
# { "network": "base-sepolia", "maxAmountRequired": "1000" }
# { "network": "solana",       "maxAmountRequired": "1000" }
```

The human's approval costs the amount under discussion — the challenge *is* the invoice:

```bash
curl -s -X POST http://localhost:4040/requests/$RID/approve | jq '.accepts[] | {network, maxAmountRequired}'
# { "network": "base-sepolia", "maxAmountRequired": "50000" }   ← $0.05
# { "network": "solana",       "maxAmountRequired": "50000" }
```

Both list two rails. Whoever is paying picks whichever their wallet supports.

## 7. Run the agent for real

Fund a throwaway wallet with Base Sepolia USDC (https://faucet.circle.com), then:

```bash
PRIVATE_KEY=0xAgentWallet BASE_URL=http://localhost:4040 npm run client
```

It opens a request, prints the approval link, and polls every five seconds. Open the link,
approve or decline, and watch the process pick up your decision:

```
poll #1  ($0.001)  →  pending  (893s left)
poll #2  ($0.001)  →  pending  (888s left)
poll #3  ($0.001)  →  approved

✓ A human authorized this. The grant is the proof:
   grantToken:     grt_…
   they paid:      $0.05 on base-sepolia
   transaction:    0x…
```

Each poll is its own purchase and returns the signed snapshot as of that instant. Poll on a
sensible interval — every look costs a tenth of a cent.

## 8. Read the grant

```json
{
  "payload": {
    "requestId": "apr_…",
    "decision": "approved",
    "amountUsd": 0.05,
    "merchant": "Chez x402",
    "resource": "POST https://tablebook.example.com/book",
    "approvedAt": "2026-08-07T12:03:11.000Z",
    "grantToken": "grt_…",
    "paymentReceipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" }
  },
  "signature": "…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

That is the artifact: evidence that a person, not the agent, decided to spend this money —
signed, timestamped, and tied to an on-chain transaction. Anyone can check it without the
secret:

```bash
curl -s -X POST http://localhost:4040/verify \
  -H 'Content-Type: application/json' \
  -d '{"payload":{…},"signature":"…"}' | jq
```

## 9. Declining, withdrawing, expiring

Declining is free — nobody should pay to say no:

```bash
curl -s -X POST http://localhost:4040/requests/$RID/decline \
  -H 'Content-Type: application/json' \
  -d '{"note":"Too expensive for a Friday — book the 2-person table instead."}' | jq '.payload | {decision, note}'
```

The note comes back on the agent's next poll, which is the difference between "denied" and a
person telling the agent what to do instead.

An agent can withdraw its own request with the `agentToken`. A request nobody touches becomes
`expired` at its deadline — never silently approvable.

Once decided, there is nothing left to invoice, so the approve route drops to a nominal
`$0.0001` — it still answers with a 402 challenge rather than a bare error, because a paid route
should always show its payment requirements first:

```bash
curl -s -X POST http://localhost:4040/requests/$RID/approve | jq '.accepts[0].maxAmountRequired'
# "100"      ← $0.0001 in atomic USDC units, not the original amount

# pay that nominal challenge and the handler tells you why it went nowhere:
# {"error":"ALREADY_DECIDED","message":"request apr_… is declined"} 409
```

## 10. Going to production

- **EVM**: `NETWORK=base` and a `FACILITATOR_URL` that settles Base mainnet (the x402.org
  reference facilitator is testnet-only) — e.g. `https://facilitator.payai.network`.
- **Solana**: already mainnet by default; `SOLANA_NETWORK=devnet` while testing. Set a dedicated
  `SOLANA_RPC_URL` — the public endpoint is heavily rate limited and the browser checkout depends
  on it.
- Set a real `SIGNING_SECRET` before anyone relies on a grant as proof, and both `payTo`
  addresses to wallets you control.
- Set `MAX_APPROVAL_USD` deliberately. It is the only thing standing between a compromised agent
  and an approval page asking someone for a large number.
- Requests live in memory by default — an approval that outlives a restart is usually one nobody
  should honour. Set `DATA_FILE` if you genuinely need them to persist.
- Approval links are unguessable but unauthenticated: anyone holding one can approve or decline.
  Treat them like a payment link, because that is what they are.
