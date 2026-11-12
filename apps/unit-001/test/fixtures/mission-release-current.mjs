// #14: Seed and verify a closed mission-v2 database around an exact published rollback reader.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";

const [mode, file] = process.argv.slice(2);
assert.ok(mode === "seed" || mode === "verify");
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(file),
		models: createModels(),
		model: null,
		cwd: dirname(file),
		mission: { kind: "developer-local", directory: dirname(file), session: "default" },
		name: "bob",
	},
	context,
);
try {
	if (mode === "seed") {
		await agent.mission(
			{
				operation: "configure-local",
				creator: { kind: "human", id: "rollback-fixture", uid: process.getuid() },
				ceiling: {
					allowedTools: ["read"],
					maxCycles: 3,
					maxRequests: 4,
					maxRetries: 1,
					maxConsecutiveNoProgress: 2,
					maxDurationMs: 600000,
				},
			},
			context,
		);
		await agent.mission(
			{
				operation: "draft",
				expectedRevision: 0,
				requestId: "draft",
				terms: {
					objective: "Inspect the rollback fixture",
					scope: "Only the fixture",
					successCriteria: ["Return recorded evidence"],
					policy: {
						allowedTools: ["read"],
						maxCycles: 2,
						maxRequests: 3,
						maxRetries: 0,
						maxConsecutiveNoProgress: 1,
						deadlineAt: Date.now() + 300000,
					},
					approvalBoundary: [],
					reviewEveryMs: 1000,
				},
			},
			context,
		);
		const proposal = await agent.mission(
			{ operation: "propose", expectedRevision: 1, requestId: "propose" },
			context,
		);
		const agreed = await agent.mission(
			{
				operation: "approve-local",
				expectedRevision: 1,
				digest: proposal.formation.draft.digest,
				requestId: "approve",
			},
			context,
		);
		assert.equal(agreed.agreementValid, true);
		assert.equal(agreed.execution, "not-implemented");
		await writeFile(`${file}.expected`, JSON.stringify(agreed.formation));
		await agent.memory(
			{
				operation: "remember",
				content: "Rollback fixture retains its original evidence",
				requestId: "before-rollback",
			},
			context,
		);
	} else {
		const expected = JSON.parse(await readFile(`${file}.expected`, "utf8"));
		const restored = await agent.mission({ operation: "status" }, context);
		assert.deepEqual(restored.formation, expected);
		assert.equal(restored.agreementValid, true);
		assert.equal(restored.execution, "not-implemented");
		const recall = await agent.memory({ operation: "recall", query: "rollback fixture" }, context);
		assert.equal(recall.operation, "recall");
		assert.ok(recall.records.some((record) => record.content === "Rollback fixture retains its original evidence"));
		assert.ok(recall.records.some((record) => record.content === "Rollback reader appended evidence"));
		assert.equal((await agent.status(context)).runtime.configuration, "unconfigured");
		console.log("current mission agreement, approval provenance, memory and old-reader append preserved");
	}
} finally {
	await agent.close(context);
}
