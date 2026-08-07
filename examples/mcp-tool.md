# Exposing approvals as MCP tools for Claude

Give Claude a way to ask you before it spends. Two tools — one to open a request, one to check
the outcome — and a model that hits its spending cap can escalate instead of failing.

> Ready-made alternative: [x402-mcp-commerce](https://github.com/nirholas/x402-mcp-commerce) is a
> full MCP commerce server whose spending-cap errors already point here. This page shows the
> minimal DIY version.

## Minimal MCP server (stdio)

```ts
// mcp-approvals.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { selectPaymentRequirements } from "x402/client";
import { wrapFetchWithPayment } from "x402-fetch";

const BASE_URL = process.env.APPROVAL_URL || "http://localhost:4040";
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// The 402 offers both rails; pin the EVM one for a viem wallet.
const payFetch = wrapFetchWithPayment(fetch, account, undefined, (reqs) =>
  selectPaymentRequirements(reqs, "base-sepolia", "exact"),
);

const server = new McpServer({ name: "x402-approval-page", version: "0.1.0" });

server.tool(
  "request_approval",
  "Ask a human to approve a purchase that is above your spending cap. Free. Returns a link to send them and a requestId to poll. Use this instead of giving up when a purchase is blocked.",
  {
    amountUsd: z.number().positive().describe("What the purchase costs, in USD"),
    reason: z.string().describe("Why you cannot decide alone. Write it for the human, not for a log."),
    merchant: z.string().optional(),
    description: z.string().optional().describe("What you want to buy"),
    resource: z.string().optional().describe("The exact route you would call"),
    expiresInSeconds: z.number().int().optional(),
  },
  async (args) => {
    const res = await fetch(`${BASE_URL}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "Claude", ...args }),
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

server.tool(
  "check_approval",
  "Check whether a human has approved, declined, or ignored a request ($0.001 in USDC per check). Returns the signed outcome: on approval it includes a grant token and the on-chain payment receipt.",
  { requestId: z.string() },
  async ({ requestId }) => {
    const res = await payFetch(`${BASE_URL}/requests/${requestId}`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

await server.connect(new StdioServerTransport());
```

## Claude Desktop config

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-approvals": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-approvals.ts"],
      "env": {
        "APPROVAL_URL": "http://localhost:4040",
        "PRIVATE_KEY": "0x…funded Base Sepolia wallet…"
      }
    }
  }
}
```

## The behaviour you want

Tell Claude, in its instructions or in the conversation:

> When a purchase exceeds your spending cap, call `request_approval` with the amount and a plain
> explanation of why you need it. Give me the link. Then poll `check_approval` every 30 seconds
> or so — each check costs $0.001, so don't hammer it — and tell me what I decided.

Now a blocked purchase turns into a conversation instead of a dead end:

```
Claude: That table is $0.05 and my cap is $0.01. I've opened an approval request —
        http://localhost:4040/a/apr_af7c54673f48500a11 — have a look and decide.
   You: *opens the link, sees the request, pays with Phantom*
Claude: Approved, settled on Solana, tx 5Kd…. Booking the table now.
```

## Why the payment is the approval

There is no "approved" flag to reconcile against money that may or may not have moved. The
human's payment settles on-chain and the same response returns a signed grant — decision,
amount, merchant, timestamp, transaction hash. That grant is what Claude reports back, and what
you can check later with the free `POST /verify`.

## Pairs with

- [x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet) — policy checks that tell an
  agent *when* it needs approval.
- [x402-mcp-commerce](https://github.com/nirholas/x402-mcp-commerce) — the commerce toolbox whose
  cap errors point here.
- [x402-agent-sandbox](https://github.com/nirholas/x402-agent-sandbox) — rehearse the whole
  escalation flow against fake merchants first.

Discovery for agents that browse: `GET /.well-known/x402` and `GET /skill.md`.
