// #72: Assertions the rollback qualification makes on stored memory, kept apart from the fixture steps so
// test/rollback/checks.test.mjs can prove each one refuses the state it exists to catch.
import assert from "node:assert/strict";

/**
 * Asserts that converting stored version-2 memory kept every field of the documents it came from. Example: the stored
 * consolidation is `scheduled` with task 13. If conversion lost it, the owner's open schedules task 20, and a stats
 * view still says "scheduled"; only the stored task identity shows the sleeping task was orphaned.
 */
export function assertConversionPreserved(before, after) {
	assert.deepEqual(after.memory.consolidation, before.memory.consolidation, "stored consolidation status and task");
	assert.deepEqual(after.memory, before.memory, "every stored memory field");
	assert.deepEqual(after.relations, before.relations, "every stored relation");
}

/**
 * Asserts that every stored relation's endpoints are live at their pinned revisions. A revision match alone is not
 * enough: a forgotten record keeps an id and a revision, and an older writer may tombstone without bumping it.
 */
export function assertRelationsLive(memory, relations) {
	for (const relation of Object.values(relations.relations))
		for (const end of [relation.from, relation.to]) {
			const record = memory.records[end.id];
			assert.deepEqual(
				{ id: end.id, state: record?.state, revision: record?.revision },
				{ id: end.id, state: "live", revision: end.revision },
				`relation ${relation.id} endpoint ${end.id} is live at its pinned revision`,
			);
		}
}
