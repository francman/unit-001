// Creates or verifies executed state for the published-reader compatibility probe; faux provider only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";

const [operation, directory, variant] = process.argv.slice(2);
assert.ok(operation === "seed" || operation === "verify");
assert.ok(["waiting", "paused", "completed"].includes(variant));
await mkdir(directory, { recursive: true, mode: 0o700 });
const faux = fauxProvider();
faux.setResponses([
	variant === "completed"
		? fauxAssistantMessage(fauxToolCall("write", { path: "proof.txt", content: "verified-proof" }), {
				stopReason: "toolUse",
			})
		: fauxAssistantMessage([], { stopReason: "error", errorMessage: "fixture retry" }),
]);
const models = createModels();
models.setProvider(faux.provider);
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
		models,
		model: operation === "seed" ? { provider: "faux", modelId: "faux-1" } : null,
		cwd: directory,
		startup: { kind: operation === "seed" ? "active" : "inhibited" },
		mission: { kind: "developer-local", directory, session: "default" },
	},
	context,
);
const project = (view) => ({
	agreement: view.formation.agreement,
	execution: view.execution,
	policyRevision: view.policyRevision,
	runtime:
		view.runtime === null
			? null
			: Object.fromEntries(Object.entries(view.runtime).filter(([key]) => key !== "observedAt")),
});
const controller = async (view) => {
	const report = await agent.inspect({ scope: "tasks" }, context);
	return report.data.tasks.find((task) => task.id === view.runtime?.controller) ?? null;
};
try {
	if (operation === "seed") {
		await agent.mission(
			{
				operation: "configure-local",
				creator: { kind: "human", id: "fixture", uid: process.getuid() },
				ceiling: {
					allowedTools: ["write"],
					maxCycles: 4,
					maxRequests: 6,
					maxRetries: 2,
					maxConsecutiveNoProgress: 4,
					maxDurationMs: 3_600_000,
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
					objective: "Produce an independently verified fixture",
					scope: "Disposable compatibility workspace",
					successCriteria: [`sha256:${createHash("sha256").update("verified-proof").digest("hex")}:proof.txt`],
					approvalBoundary: [],
					reviewEveryMs: 300_000,
					policy: {
						allowedTools: ["write"],
						maxCycles: 4,
						maxRequests: 6,
						maxRetries: 2,
						maxConsecutiveNoProgress: 4,
						deadlineAt: Date.now() + 3_500_000,
					},
				},
			},
			context,
		);
		const proposal = await agent.mission(
			{ operation: "propose", expectedRevision: 1, requestId: "propose" },
			context,
		);
		await agent.mission(
			{
				operation: "approve-local",
				expectedRevision: 1,
				digest: proposal.formation.draft.digest,
				requestId: "approve",
			},
			context,
		);
		await agent.mission(
			{ operation: "control-local", action: "start", expectedPolicyRevision: 0, requestId: "start" },
			context,
		);
		const target = variant === "completed" ? "completed" : "waiting";
		let view;
		for (let attempt = 0; attempt < 500; attempt++) {
			view = await agent.mission({ operation: "status" }, context);
			if (view.execution === target) break;
			await setTimeout(10);
		}
		assert.equal(view.execution, target);
		if (variant === "paused")
			view = await agent.mission(
				{ operation: "control-local", action: "pause", expectedPolicyRevision: 1, requestId: "pause" },
				context,
			);
		assert.equal(view.execution, variant);
		assert.equal(faux.state.callCount, 1);
		await writeFile(
			join(directory, "expected.json"),
			JSON.stringify({ ...project(view), controller: await controller(view) }),
			{ mode: 0o600 },
		);
		console.log(`Seeded ${variant} execution ledger with one actual faux request.`);
	} else {
		const view = await agent.mission({ operation: "status" }, context);
		assert.deepEqual(
			{ ...project(view), controller: await controller(view) },
			JSON.parse(await readFile(join(directory, "expected.json"), "utf8")),
		);
		assert.equal(faux.state.callCount, 0);
		console.log(
			`Current reader retained exact ${variant} agreement, ledger, counters and evidence after old-reader probe.`,
		);
	}
} finally {
	await agent.close(context);
}
