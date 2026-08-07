/**
 * Human-in-the-loop approval requests.
 *
 * The shape of the problem: an agent wants to buy something above its spending
 * cap. It cannot decide alone, and it cannot hand its wallet to a person. So it
 * opens an approval request here, sends a human the link, and polls for the
 * outcome. The human opens the page, sees exactly what is being asked and for
 * how much, and either pays it with their own wallet through the drop-in modal
 * or declines. The payment *is* the approval — there is no separate "approved
 * but unfunded" state to reconcile later.
 *
 * What the agent gets back is a signed grant: proof that a human authorized this
 * specific purchase for this specific amount, plus the on-chain receipt. That
 * grant is the artifact, returned in the response body of the paid poll.
 *
 * State is in-memory by design (the suite is file-based, and an approval that
 * outlives a restart is usually one nobody should honour anyway). Set
 * `DATA_FILE` to persist it.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize, sign, signArtifact, type SignedArtifact } from "./sign.js";

export type Decision = "pending" | "approved" | "declined" | "expired";

export interface ApprovalRequest {
  requestId: string;
  /** Who is asking, in the agent's own words. */
  agent: string;
  /** What they want to buy. */
  merchant: string;
  resource: string;
  description: string;
  /** Why the agent could not decide alone — shown prominently to the human. */
  reason: string;
  amountUsd: number;
  currency: "USD";
  createdAt: string;
  expiresAt: string;
  decision: Decision;
  decidedAt: string | null;
  /** Free-text note the human left when declining. */
  note: string | null;
  /** Settlement receipt from the human's payment, once approved. */
  paymentReceipt: Record<string, unknown> | null;
  /** Bearer token proving a human authorized this purchase. Issued on approval. */
  grantToken: string | null;
  /** Secret held by the requesting agent; required to decline on its behalf or cancel. */
  agentToken: string;
}

/** What the agent sees. `agentToken` never leaves the creation response. */
export type PublicRequest = Omit<ApprovalRequest, "agentToken">;

export class ApprovalError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_AMOUNT_USD = Number(process.env.MAX_APPROVAL_USD || 100);
const DEFAULT_TTL = Number(process.env.DEFAULT_TTL_SECONDS || 3600);
const DATA_FILE = process.env.DATA_FILE || join(process.cwd(), "data", "requests.json");

const store = new Map<string, ApprovalRequest>();
let loaded = false;

function load(): Map<string, ApprovalRequest> {
  if (loaded) return store;
  loaded = true;
  if (existsSync(DATA_FILE)) {
    try {
      for (const r of JSON.parse(readFileSync(DATA_FILE, "utf8")) as ApprovalRequest[]) {
        store.set(r.requestId, r);
      }
    } catch {
      // corrupt store — start clean rather than refuse to boot
    }
  }
  return store;
}

function persist(): void {
  if (!process.env.DATA_FILE) return; // in-memory unless the operator asked for a file
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify([...load().values()], null, 2));
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

/** Lazily expire. A request past its deadline is `expired`, never silently approvable. */
function settle(r: ApprovalRequest): ApprovalRequest {
  if (r.decision === "pending" && Date.parse(r.expiresAt) < Date.now()) {
    r.decision = "expired";
    r.decidedAt = new Date().toISOString();
    persist();
  }
  return r;
}

export function get(requestId: string): ApprovalRequest {
  const r = load().get(requestId);
  if (!r) throw new ApprovalError(404, "NOT_FOUND", `no approval request ${requestId}`);
  return settle(r);
}

export function toPublic(r: ApprovalRequest): PublicRequest {
  const { agentToken: _agentToken, ...pub } = r;
  return pub;
}

/**
 * The smallest amount x402 will price (`$0.0001` — a hundredth of a cent, 100
 * atomic USDC units). Used as the challenge price whenever the approve route
 * cannot be priced from a live pending request: an unknown id, or one already
 * approved, declined, or expired.
 *
 * A paid route must answer an unpaid request with a 402 *before* it validates
 * anything, so discovery probes and agents always reach a real challenge with
 * both rails in `accepts` instead of a bare 404. Whether the id exists is the
 * handler's business, after payment: it answers 404 / 409, or replays the same
 * grant for an already-approved request. Pricing those cases at the floor keeps
 * that unavoidable "pay first, find out second" cost down to a rounding error.
 */
export const NOMINAL_PRICE = "$0.0001";

/** The same floor as a number, for validating what an agent may ask a human to authorize. */
export const MIN_AMOUNT_USD = 0.0001;

/**
 * The amount a human must pay to approve this request, as an x402 price string.
 * A live pending request is priced at exactly what the agent asked to spend, so
 * the challenge is the invoice; anything else gets `NOMINAL_PRICE`.
 */
export function priceFor(requestId: string): string {
  const r = load().get(requestId);
  if (!r) return NOMINAL_PRICE; // unknown id — the handler 404s once paid
  if (settle(r).decision !== "pending") return NOMINAL_PRICE; // decided — grant replay or 409
  return `$${r.amountUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

// ------------------------------------------------------------------ creating

/** Free. The agent opens a request and gets back a link to send a human. */
export function create(body: Record<string, unknown>, baseUrl: string) {
  const amountUsd = typeof body.amountUsd === "number" ? body.amountUsd : Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new ApprovalError(400, "INVALID_AMOUNT", "amountUsd must be a positive number");
  }
  if (amountUsd < MIN_AMOUNT_USD) {
    // The approval *is* the payment, so an amount x402 cannot invoice is an
    // approval nobody could ever grant. Refuse it here rather than mint a
    // request whose 402 challenge would come back with no payable rail.
    throw new ApprovalError(
      400,
      "INVALID_AMOUNT",
      `amountUsd ${amountUsd} is below the x402 minimum of ${MIN_AMOUNT_USD} USD`,
    );
  }
  if (amountUsd > MAX_AMOUNT_USD) {
    throw new ApprovalError(
      400,
      "AMOUNT_TOO_LARGE",
      `amountUsd ${amountUsd} exceeds this deployment's MAX_APPROVAL_USD of ${MAX_AMOUNT_USD}`,
    );
  }
  const reason = str(body.reason);
  if (!reason) {
    throw new ApprovalError(400, "REASON_REQUIRED", "reason is required — a human is being asked to spend money");
  }

  const ttl = Math.min(Number(body.expiresInSeconds) || DEFAULT_TTL, 86_400);
  const now = new Date();
  const requestId = `apr_${randomBytes(9).toString("hex")}`;

  const request: ApprovalRequest = {
    requestId,
    agent: str(body.agent, "an AI agent"),
    merchant: str(body.merchant, "unnamed merchant"),
    resource: str(body.resource),
    description: str(body.description, "a purchase"),
    reason,
    amountUsd: Number(amountUsd.toFixed(6)),
    currency: "USD",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    decision: "pending",
    decidedAt: null,
    note: null,
    paymentReceipt: null,
    grantToken: null,
    agentToken: `agt_${randomBytes(24).toString("hex")}`,
  };

  load().set(requestId, request);
  persist();

  const links = {
    /** Send this to the human. */
    approvalUrl: `${baseUrl}/a/${requestId}`,
    /** The agent polls this — $0.001 a look. */
    pollUrl: `${baseUrl}/requests/${requestId}`,
    /** Where the human's payment lands, and what the modal is pointed at. */
    payUrl: `${baseUrl}/requests/${requestId}/approve`,
  };

  return {
    ...toPublic(request),
    links,
    agentToken: request.agentToken,
    signature: sign(toPublic(request)),
  };
}

// ------------------------------------------------------------------ deciding

/**
 * Called after a human's payment has settled. Turns the request into an
 * approved grant and returns the artifact the agent is waiting for.
 */
export function approve(requestId: string, receipt: Record<string, unknown> | null): SignedArtifact<Grant> {
  const r = get(requestId);
  if (r.decision === "approved") {
    // Idempotent: paying twice for the same approval returns the same grant
    // rather than minting a second one.
    return grantFor(r);
  }
  if (r.decision !== "pending") {
    throw new ApprovalError(409, "ALREADY_DECIDED", `request ${requestId} is ${r.decision}`);
  }
  r.decision = "approved";
  r.decidedAt = new Date().toISOString();
  r.paymentReceipt = receipt;
  // Deterministic in the request, unguessable from outside.
  r.grantToken = `grt_${createHash("sha256").update(`${r.requestId}${r.agentToken}${r.decidedAt}`).digest("hex").slice(0, 40)}`;
  persist();
  return grantFor(r);
}

/** Free. The human declines, or the agent withdraws its own request. */
export function decline(requestId: string, note: string | undefined, agentToken?: string) {
  const r = get(requestId);
  if (r.decision !== "pending") {
    throw new ApprovalError(409, "ALREADY_DECIDED", `request ${requestId} is ${r.decision}`);
  }
  // Anyone holding the link may decline — declining costs nobody anything and
  // the alternative is a request that hangs until it expires. An agent
  // withdrawing its own request proves it with the agentToken.
  if (agentToken && agentToken !== r.agentToken) {
    throw new ApprovalError(403, "BAD_AGENT_TOKEN", "agentToken does not match this request");
  }
  r.decision = "declined";
  r.decidedAt = new Date().toISOString();
  r.note = note ? note.slice(0, 500) : null;
  persist();
  return signArtifact(outcomeOf(r));
}

// ------------------------------------------------------------------ outcomes

export interface Grant {
  requestId: string;
  decision: "approved";
  amountUsd: number;
  currency: "USD";
  merchant: string;
  resource: string;
  description: string;
  approvedAt: string;
  expiresAt: string;
  grantToken: string;
  paymentReceipt: Record<string, unknown> | null;
  [key: string]: unknown;
}

function grantFor(r: ApprovalRequest): SignedArtifact<Grant> {
  return signArtifact<Grant>({
    requestId: r.requestId,
    decision: "approved",
    amountUsd: r.amountUsd,
    currency: "USD",
    merchant: r.merchant,
    resource: r.resource,
    description: r.description,
    approvedAt: r.decidedAt!,
    expiresAt: r.expiresAt,
    grantToken: r.grantToken!,
    paymentReceipt: r.paymentReceipt,
  });
}

export interface Outcome {
  requestId: string;
  decision: Decision;
  amountUsd: number;
  currency: "USD";
  merchant: string;
  resource: string;
  description: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  note: string | null;
  paymentReceipt: Record<string, unknown> | null;
  grantToken: string | null;
  /** Seconds left before this request expires; negative once it has. */
  secondsRemaining: number;
  checkedAt: string;
  [key: string]: unknown;
}

function outcomeOf(r: ApprovalRequest): Outcome {
  return {
    requestId: r.requestId,
    decision: r.decision,
    amountUsd: r.amountUsd,
    currency: "USD",
    merchant: r.merchant,
    resource: r.resource,
    description: r.description,
    reason: r.reason,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt,
    note: r.note,
    paymentReceipt: r.paymentReceipt,
    grantToken: r.grantToken,
    secondsRemaining: Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * PAID $0.001 — the agent's poll. Returns the signed outcome snapshot as of
 * right now: still pending, approved with the grant and receipt, declined with
 * the human's note, or expired. Never a promise of something later.
 */
export function outcome(requestId: string): SignedArtifact<Outcome> {
  return signArtifact(outcomeOf(get(requestId)));
}

/** Verify any artifact this service signed, without holding the secret. */
export function verifyArtifact(payload: unknown, signature: string) {
  return { valid: sign(payload) === signature, canonical: canonicalize(payload) };
}

/** Recent requests, newest first — powers the demo gallery. Never leaks agentToken. */
export function recent(limit = 20): PublicRequest[] {
  return [...load().values()]
    .map(settle)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map(toPublic);
}
