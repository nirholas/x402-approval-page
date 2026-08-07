# Raw x402 flow with curl

The x402 protocol is plain HTTP. Here is the whole approval loop against a locally running
server (`npm run dev` — both rails use the suite defaults, so no configuration).

## 1. Open a request — free

An agent that has already hit its cap should not have to spend more to ask for help, so this
costs nothing.

```bash
curl -s -X POST http://localhost:4040/requests \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "Travel concierge",
    "merchant": "Chez x402",
    "description": "Table for 4, Friday 19:00, window seat",
    "resource": "POST https://tablebook.example.com/book",
    "reason": "This booking is $0.05 and my per-call cap is $0.01. The party size changed from 2 to 4.",
    "amountUsd": 0.05,
    "expiresInSeconds": 900
  }' | jq
```

```json
{
  "requestId": "apr_af7c54673f48500a11",
  "amountUsd": 0.05,
  "decision": "pending",
  "expiresAt": "2026-08-07T12:15:00.000Z",
  "links": {
    "approvalUrl": "http://localhost:4040/a/apr_af7c54673f48500a11",
    "pollUrl": "http://localhost:4040/requests/apr_af7c54673f48500a11",
    "payUrl": "http://localhost:4040/requests/apr_af7c54673f48500a11/approve"
  },
  "agentToken": "agt_…",
  "signature": "…"
}
```

Send `approvalUrl` to a human. Keep `agentToken` — it is returned exactly once.

```bash
RID=apr_af7c54673f48500a11
```

## 2. The agent's poll → 402

```bash
curl -i http://localhost:4040/requests/$RID
```

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

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
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",          // $0.001 in 6-decimal USDC units
      "resource": "http://localhost:4040/requests/apr_af7c54673f48500a11",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "1000",
      "amount": "1000",
      "resource": "http://localhost:4040/requests/apr_af7c54673f48500a11",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 60,
      "extra": { "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "name": "USDC", "decimals": 6 }
    }
  ]
}
```

Two entries, two rails. Take whichever your wallet can sign — the server settles that one.

## 3. The human's approval → 402, priced at the amount under discussion

This is the interesting one. The approve route has no fixed price: it is worth exactly what the
agent asked a human to authorize, so the challenge *is* the invoice.

```bash
curl -s -X POST http://localhost:4040/requests/$RID/approve \
  | jq '.accepts[] | {network, payTo, maxAmountRequired}'
```

```json
{ "network": "base-sepolia", "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "maxAmountRequired": "50000" }
{ "network": "solana",       "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "maxAmountRequired": "50000" }
```

`50000` atomic units is $0.05 — the request's own `amountUsd`, not a flat fee.

## 4. Pay

`X-PAYMENT` is a base64 payment matching **one** `accepts` entry: an EIP-3009
`transferWithAuthorization` signature on the Base entry, or a signed SPL `transferChecked`
transaction on the Solana entry. Signing either by hand is painful.

**The human** opens the page and lets the modal do it:

```
http://localhost:4040/a/apr_af7c54673f48500a11
```

**The agent** uses any x402 client for its polls:

```bash
PRIVATE_KEY=0x… BASE_URL=http://localhost:4040 npx tsx examples/agent-client.ts
```

## 5. Approved → the signed grant, in the same response

```bash
curl -i -X POST http://localhost:4040/requests/$RID/approve -H "X-PAYMENT: $PAYMENT_B64"
```

```
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJyYWlsIjoiZXZtIiwi…

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
    "paymentReceipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" }
  },
  "signature": "…", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-keys-json"
}
```

Paying twice returns the same grant — it is idempotent, not a second charge.

## 6. The agent's next poll sees it

```bash
curl -s http://localhost:4040/requests/$RID -H "X-PAYMENT: $POLL_PAYMENT_B64" | jq '.payload | {decision, grantToken, paymentReceipt}'
```

```json
{
  "decision": "approved",
  "grantToken": "grt_…",
  "paymentReceipt": { "success": true, "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x…" }
}
```

## 7. Declining is free

Nobody should pay to say no.

```bash
curl -s -X POST http://localhost:4040/requests/$RID/decline \
  -H 'Content-Type: application/json' \
  -d '{"note":"Too expensive for a Friday — book the 2-person table instead."}' | jq '.payload | {decision, note}'
```

An agent can withdraw its own request the same way, proving it with the `agentToken`:

```bash
curl -s -X POST http://localhost:4040/requests/$RID/decline \
  -H 'Content-Type: application/json' \
  -d '{"agentToken":"agt_…","note":"no longer needed"}' | jq '.payload.decision'
```

Once decided, there is nothing left to invoice, so the approve route drops to a nominal
`$0.0001` — the 402 challenge still comes first:

```bash
curl -s -X POST http://localhost:4040/requests/$RID/approve -w " %{http_code}\n" | tail -1
# 402        ← accepts[0].maxAmountRequired is "100" — $0.0001, the protocol floor

# pay that nominal challenge and the handler explains itself:
# {"error":"ALREADY_DECIDED","message":"request apr_… is declined"} 409
```

## 8. Other free routes

```bash
curl -s http://localhost:4040/requests?limit=5 | jq '.requests[] | {requestId, amountUsd, decision}'
curl -s http://localhost:4040/health
curl -s http://localhost:4040/.well-known/x402 | jq '.resources[].resource'

# verify any grant or outcome without the signing secret
curl -s -X POST http://localhost:4040/verify \
  -H 'Content-Type: application/json' \
  -d '{"payload":{…},"signature":"…"}' | jq
```
