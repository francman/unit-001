import type { SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
	checkSendReplay,
	isSendDigest,
	parseSendAdmission,
	recordSendReceipt,
	type SendReceiptsState,
	SendReplayConflict,
	sendAdmission,
	sendDigest,
} from "../src/send-receipt.ts";

const submission = (id: number) => id as SubmissionId;
const conversationId = 1 as SubmissionRecord["conversationId"];

describe("send receipts", () => {
	it("digests the exact prompt, so whitespace and text past any prefix both count", () => {
		expect(isSendDigest(sendDigest("hello"))).toBe(true);
		expect(sendDigest("hello")).not.toBe(sendDigest("hello "));
		expect(sendDigest(`${"x".repeat(2000)}a`)).not.toBe(sendDigest(`${"x".repeat(2000)}b`));
	});

	// #26 review: a lone surrogate and U+FFFD encode to the same UTF-8 bytes; JSON carries both as distinct prompts.
	it("digests every JS string losslessly, ill-formed ones included", () => {
		expect(sendDigest("a\uD800")).not.toBe(sendDigest("a�"));
		expect(sendDigest("\uDC00\uD800")).not.toBe(sendDigest("��"));
	});

	it("refuses a replay when a receipt binds the ID to another prompt", () => {
		const state: SendReceiptsState = { next: 0, receipts: {} };
		checkSendReplay(state, "r1", sendDigest("a"), false);
		recordSendReceipt(state, "r1", sendDigest("a"), submission(7));
		checkSendReplay(state, "r1", sendDigest("a"), true);
		expect(() => checkSendReplay(state, "r1", sendDigest("b"), true)).toThrow("different prompt");
		// Inherited object keys are not receipts.
		checkSendReplay(state, "constructor", sendDigest("b"), false);
	});

	// #26 review, blocker 3: past the cap the receipt is gone, and no shorter record can tell the prompts apart.
	it("refuses any replay of an admitted ID whose receipt was evicted or never written", () => {
		const state: SendReceiptsState = { next: 0, receipts: {} };
		recordSendReceipt(state, "r0", sendDigest("a"), submission(0));
		for (let index = 1; index <= 256; index++) recordSendReceipt(state, `r${index}`, sendDigest(`${index}`), submission(index));
		expect(state.receipts.r0).toBeUndefined();
		expect(() => checkSendReplay(state, "r0", sendDigest("b"), true)).toThrow(SendReplayConflict);
		expect(() => checkSendReplay(state, "r0", sendDigest("a"), true)).toThrow("can no longer be compared");
		expect(() => checkSendReplay(state, "legacy", sendDigest("a"), true)).toThrow("can no longer be compared");
	});

	it("keeps the newest 256 receipts and evicts the oldest", () => {
		const state: SendReceiptsState = { next: 0, receipts: {} };
		for (let index = 0; index < 257; index++) recordSendReceipt(state, `r${index}`, sendDigest(`${index}`), submission(index));
		expect(Object.keys(state.receipts)).toHaveLength(256);
		expect(state.receipts.r0).toBeUndefined();
		expect(state.receipts.r256).toEqual({ digest: sendDigest("256"), submission: 256, seq: 256 });
	});
});

describe("send admission projection", () => {
	const input = (status: "queued" | "placed" | "done" | "unanswered"): SubmissionRecord =>
		status === "queued"
			? { id: submission(1), conversationId, type: "input", status }
			: status === "placed"
				? { id: submission(1), conversationId, type: "input", status, entry: 2 as never }
				: status === "done"
					? { id: submission(1), conversationId, type: "input", status, entry: 2 as never, answer: 3 as never }
					: { id: submission(1), conversationId, type: "input", status, reason: "aborted" };
	const receipt = { digest: sendDigest("a"), submission: submission(1), seq: 0 };

	it("reports nothing committed as not found, never as rejected", () => {
		expect(sendAdmission(undefined, undefined, undefined, sendDigest("a"))).toEqual({ status: "not-found" });
	});

	it("maps each Durable state to an outcome and keeps a bounded unanswered reason", () => {
		expect(sendAdmission(input("queued"), receipt, undefined, sendDigest("a"))).toMatchObject({ outcome: "queued" });
		expect(sendAdmission(input("placed"), receipt, undefined, sendDigest("a"))).toMatchObject({ outcome: "placed" });
		expect(sendAdmission(input("done"), receipt, undefined, sendDigest("a"))).toMatchObject({ outcome: "answered" });
		expect(sendAdmission(input("unanswered"), receipt, undefined, undefined)).toEqual({
			status: "admitted",
			source: "model",
			binding: "recorded",
			outcome: "unanswered",
			reason: "aborted",
		});
	});

	it("labels a submission without a receipt unverified instead of matching it", () => {
		expect(sendAdmission(input("done"), undefined, undefined, sendDigest("b"))).toMatchObject({
			status: "admitted",
			binding: "unverified",
		});
	});

	it("rejects a different prompt and a request ID owned by another operation", () => {
		expect(sendAdmission(input("done"), receipt, undefined, sendDigest("b"))).toEqual({
			status: "rejected",
			reason: "different-prompt",
		});
		const write: SubmissionRecord = { id: submission(1), conversationId, type: "write", status: "done", entry: 2 as never };
		expect(sendAdmission(write, undefined, undefined, undefined)).toEqual({ status: "rejected", reason: "other-operation" });
		expect(sendAdmission(write, undefined, "a", sendDigest("a"))).toMatchObject({ source: "host", binding: "exact" });
	});
});

describe("send admission wire", () => {
	it("round-trips each answer and rejects unknown shapes", () => {
		for (const admission of [
			{ status: "not-found" },
			{ status: "rejected", reason: "different-prompt" },
			{ status: "admitted", source: "host", binding: "exact", outcome: "answered" },
			{ status: "admitted", source: "model", binding: "unverified", outcome: "unanswered", reason: "aborted" },
		])
			expect(parseSendAdmission(JSON.parse(JSON.stringify(admission)))).toEqual(admission);
		for (const invalid of [
			null,
			{ status: "admitted" },
			{ status: "rejected", reason: "held" },
			{ status: "admitted", source: "model", binding: "exact", outcome: "unanswered", reason: "x".repeat(201) },
		])
			expect(() => parseSendAdmission(invalid)).toThrow("Invalid send admission.");
		expect(isSendDigest("A".repeat(64))).toBe(false);
	});
});
