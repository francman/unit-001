// Binds each ID-bearing send to its exact prompt and answers whether a send was admitted, without waiting on it.
import { createHash } from "node:crypto";
import { defineDoc, type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";

/** One admitted send: the digest of its exact prompt, the Durable submission it created and its insertion order. */
export type SendReceipt = { digest: string; submission: SubmissionId; seq: number };

/** Receipts of one chat, keyed by request ID; the oldest is evicted past `SEND_RECEIPT_LIMIT`. */
export type SendReceiptsState = { next: number; receipts: Record<string, SendReceipt> };

/**
 * What durable state says about one send in one chat. `binding` says how the prompt is known to match: `exact` (the
 * receipt digest equals the caller's), `recorded` (a receipt exists; the caller gave no digest), `unverified` (no
 * receipt: the send predates receipts or its receipt was evicted). `not-found` means nothing was committed under the ID
 * as of this read; it is not proof of non-admission, because a request still in transit can commit later.
 */
export type SendAdmission =
	| {
			readonly status: "admitted";
			readonly source: "model" | "host";
			readonly binding: "exact" | "recorded" | "unverified";
			readonly outcome: "queued" | "placed" | "answered" | "unanswered";
			readonly reason?: string;
	  }
	| { readonly status: "rejected"; readonly reason: "different-prompt" | "other-operation" }
	| { readonly status: "not-found" };

/**
 * A replay the owner refuses instead of answering the original: its receipt binds another prompt (`different-prompt`),
 * or the ID was admitted without a receipt it can still compare against (`unverifiable`: before receipts, or evicted).
 */
export class SendReplayConflict extends Error {
	constructor(reason: "different-prompt" | "unverifiable") {
		super(
			reason === "different-prompt"
				? "Request ID already identifies a send with a different prompt; use a new request ID."
				: "Request ID already identifies an admitted send whose prompt can no longer be compared; check its admission or use a new request ID.",
		);
	}
}

// Covers the terminal's seven-day draft window and the browser's 32 IDs per pairing many times over (~30 KiB).
const SEND_RECEIPT_LIMIT = 256;
const MAX_REASON_LENGTH = 200;

/** Receipts start empty in a fork: a request ID belongs to the chat that admitted it. */
export const SendReceiptsDoc = defineDoc<SendReceiptsState>({
	kind: "unit.send.receipts",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ next: 0, receipts: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});

/** Digest of the full send request as the owner admits it: the exact prompt, never trimmed or truncated. */
export function sendDigest(prompt: string): string {
	// UTF-16 code units, not UTF-8: JSON can carry unpaired surrogates, which UTF-8 encoding turns into U+FFFD, so two
	// different wire prompts would share a digest.
	return createHash("sha256").update("unit.send.v2\0").update(Buffer.from(prompt, "utf16le")).digest("hex");
}

/**
 * Throws `SendReplayConflict` unless a send under `requestId` may proceed: a fresh ID, or a replay whose receipt binds
 * the same prompt. An ID already `admitted` without a receipt is refused, because only the receipt holds its full prompt.
 */
export function checkSendReplay(
	state: Readonly<SendReceiptsState>,
	requestId: string,
	digest: string,
	admitted: boolean,
): void {
	const receipt = Object.hasOwn(state.receipts, requestId) ? state.receipts[requestId] : undefined;
	if (receipt !== undefined) {
		if (receipt.digest !== digest) throw new SendReplayConflict("different-prompt");
	} else if (admitted) throw new SendReplayConflict("unverifiable");
}

/** Records a fresh admission inside its admission commit and evicts the oldest receipt past the limit. */
export function recordSendReceipt(
	state: SendReceiptsState,
	requestId: string,
	digest: string,
	submission: SubmissionId,
): void {
	state.receipts[requestId] = { digest, submission, seq: state.next++ };
	const ids = Object.keys(state.receipts);
	if (ids.length <= SEND_RECEIPT_LIMIT) return;
	let oldest = ids[0];
	for (const id of ids) if (state.receipts[id].seq < state.receipts[oldest].seq) oldest = id;
	delete state.receipts[oldest];
}

/**
 * Projects one committed submission, its receipt and, for a host-fact write, the exact input it answered. A caller
 * digest that differs from the recorded one means this prompt was never admitted under the ID.
 */
export function sendAdmission(
	record: SubmissionRecord | undefined,
	receipt: SendReceipt | undefined,
	hostInput: string | undefined,
	digest: string | undefined,
): SendAdmission {
	if (record === undefined) return { status: "not-found" };
	if (record.type !== "input" && hostInput === undefined) return { status: "rejected", reason: "other-operation" };
	// A host-fact entry keeps its full input, so it binds as exactly as a receipt does.
	const recorded = hostInput === undefined ? receipt?.digest : sendDigest(hostInput);
	if (recorded !== undefined && digest !== undefined && recorded !== digest)
		return { status: "rejected", reason: "different-prompt" };
	const binding = recorded === undefined ? "unverified" : digest === undefined ? "recorded" : "exact";
	const source = record.type === "write" ? "host" : "model";
	if (record.status !== "unanswered")
		return { status: "admitted", source, binding, outcome: record.status === "done" ? "answered" : record.status };
	const reason = record.reason.slice(0, MAX_REASON_LENGTH);
	return { status: "admitted", source, binding, outcome: "unanswered", reason };
}

/** Validates an admission lookup answer from a local or authenticated remote owner. */
export function parseSendAdmission(value: unknown): SendAdmission {
	if (typeof value !== "object" || value === null || !("status" in value)) throw new Error("Invalid send admission.");
	if (value.status === "not-found") return { status: "not-found" };
	if (value.status === "rejected" && "reason" in value) {
		if (value.reason === "different-prompt" || value.reason === "other-operation")
			return { status: "rejected", reason: value.reason };
	}
	if (
		value.status === "admitted" &&
		"source" in value &&
		(value.source === "model" || value.source === "host") &&
		"binding" in value &&
		(value.binding === "exact" || value.binding === "recorded" || value.binding === "unverified") &&
		"outcome" in value &&
		(value.outcome === "queued" ||
			value.outcome === "placed" ||
			value.outcome === "answered" ||
			value.outcome === "unanswered")
	) {
		const { source, binding, outcome } = value;
		const admission = { status: "admitted", source, binding, outcome } as const;
		if (!("reason" in value)) return admission;
		if (typeof value.reason === "string" && value.reason.length <= MAX_REASON_LENGTH)
			return { ...admission, reason: value.reason };
	}
	throw new Error("Invalid send admission.");
}

/** Validates the wire digest a client may send to check its prompt against the receipt. */
export function isSendDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
