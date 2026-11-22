// Browser mission definition: the contract admits draft, propose and one confirmed agreement, and nothing else.
import { describe, expect, it } from "vitest";
import { parseWebRequest } from "../src/web/contract.ts";

const digest = "a".repeat(64);
const mission = (request: unknown) => parseWebRequest({ requestId: "r-1", operation: { type: "mission", request } });

describe("browser mission operations", () => {
	it("reconstructs draft and propose with the envelope's request ID", () => {
		expect(mission({ operation: "draft", expectedRevision: 0, terms: { objective: "Keep docs current" } })).toEqual({
			requestId: "r-1",
			operation: {
				type: "mission",
				request: { operation: "draft", expectedRevision: 0, requestId: "r-1", terms: { objective: "Keep docs current" } },
			},
		});
		expect(mission({ operation: "propose", expectedRevision: 3 }).operation).toEqual({
			type: "mission",
			request: { operation: "propose", expectedRevision: 3, requestId: "r-1" },
		});
		expect(mission({ operation: "status" }).operation).toEqual({ type: "mission", request: { operation: "status" } });
	});

	it("admits agreement only with explicit confirmation on an exact revision and digest", () => {
		expect(mission({ operation: "agree", revision: 2, digest, confirmed: true }).operation).toEqual({
			type: "mission",
			request: { operation: "agree", revision: 2, digest, requestId: "r-1" },
		});
		expect(() => mission({ operation: "agree", revision: 2, digest })).toThrow("explicit confirmation");
		expect(() => mission({ operation: "agree", revision: 2, digest, confirmed: "yes" })).toThrow("explicit confirmation");
		expect(() => mission({ operation: "agree", revision: 0, digest, confirmed: true })).toThrow("revision");
		expect(() => mission({ operation: "agree", revision: 2, digest: "A".repeat(64), confirmed: true })).toThrow("digest");
		expect(() => mission({ operation: "agree", revision: 2, digest: digest.slice(1), confirmed: true })).toThrow("digest");
	});

	it("refuses caller-supplied request IDs, foreign fields and oversize terms", () => {
		expect(() => mission({ operation: "propose", expectedRevision: 1, requestId: "forged" })).toThrow("Unknown request field");
		expect(() => mission({ operation: "propose", expectedRevision: 1, digest })).toThrow("Unknown request field");
		expect(() => mission({ operation: "draft", expectedRevision: 0, terms: { creator: "me" } })).toThrow();
		expect(() =>
			mission({ operation: "draft", expectedRevision: 0, terms: { objective: "x".repeat(40_000) } }),
		).toThrow();
	});

	it("keeps approval, reconciliation and purpose operations off the browser surface", () => {
		for (const operation of ["approve-local", "reconcile", "configure-local", "purpose-propose", "purpose-approve-local", "operate-local", "control-local"])
			expect(() => mission({ operation, expectedRevision: 1 }), operation).toThrow();
	});
});
