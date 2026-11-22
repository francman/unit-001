// #72: The rollback qualification's stored-memory assertions refuse the states they exist to catch.
// Run: node --test test/rollback/checks.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertConversionPreserved, assertRelationsLive } from "./checks.mjs";

function live(id, revision = 1) {
	return { state: "live", id, revision, content: id };
}

function relation(id, from, to) {
	return { id, kind: "supports", from: { id: from, revision: 1 }, to: { id: to, revision: 1 } };
}

function stored(consolidation) {
	return {
		memory: { revision: 7, records: { a: live("a"), b: live("b") }, receipts: {}, captures: {}, consolidation },
		relations: { relations: { ab: relation("ab", "a", "b") } },
	};
}

describe("conversion of stored version-2 memory", () => {
	it("accepts a conversion that kept every field", () => {
		assertConversionPreserved(stored({ state: "scheduled", taskId: 13 }), stored({ state: "scheduled", taskId: 13 }));
	});

	it("refuses a consolidation rescheduled under a new task, which a stats view still reports as scheduled", () => {
		assert.throws(
			() =>
				assertConversionPreserved(stored({ state: "scheduled", taskId: 13 }), stored({ state: "scheduled", taskId: 20 })),
			/stored consolidation status and task/,
		);
	});

	it("refuses a consolidation dropped to idle", () => {
		assert.throws(
			() => assertConversionPreserved(stored({ state: "scheduled", taskId: 13 }), stored({ state: "idle" })),
			/stored consolidation status and task/,
		);
	});

	it("refuses a lost relation", () => {
		const after = stored({ state: "idle" });
		after.relations.relations = {};
		assert.throws(() => assertConversionPreserved(stored({ state: "idle" }), after), /every stored relation/);
	});
});

describe("stored relations after an older writer", () => {
	it("accepts relations whose endpoints are live at their pinned revisions", () => {
		const { memory, relations } = stored({ state: "idle" });
		assertRelationsLive(memory, relations);
	});

	it("refuses an endpoint forgotten at its pinned revision", () => {
		const { memory, relations } = stored({ state: "idle" });
		memory.records.b = { state: "forgotten", id: "b", revision: 1 };
		assert.throws(() => assertRelationsLive(memory, relations), /endpoint b is live/);
	});

	it("refuses an endpoint changed since it was pinned, and a missing one", () => {
		const { memory, relations } = stored({ state: "idle" });
		memory.records.b = live("b", 2);
		assert.throws(() => assertRelationsLive(memory, relations), /endpoint b is live/);
		delete memory.records.b;
		assert.throws(() => assertRelationsLive(memory, relations), /endpoint b is live/);
	});
});
