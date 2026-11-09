// Seeds and verifies a closed database copy for the published old-reader acceptance run.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";

const [mode, file] = process.argv.slice(2);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(file),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		cwd: "/tmp",
		name: "bob",
	},
	context,
);
try {
	if (mode === "seed") {
		faux.setResponses([fauxAssistantMessage("Release codename recorded.")]);
		await agent.ask("The release codename is juniper.", context);
		await agent.idle(context);
		const result = await agent.memory(
			{ operation: "remember", content: "Juniper requires approval", requestId: "release-compat" },
			context,
		);
		await writeFile(`${file}.expected`, JSON.stringify(result));
	} else if (mode === "verify") {
		const expected = JSON.parse(await readFile(`${file}.expected`, "utf8"));
		const recall = await agent.memory({ operation: "recall", query: "Juniper" }, context);
		assert.equal(recall.operation, "recall");
		assert.equal(recall.records[0]?.id, expected.id);
		assert.equal(recall.records[0]?.content, "Juniper requires approval");
		assert.equal(recall.records[0]?.origin, "user");
		assert.equal(recall.records[0]?.tier, "working");
		assert.equal((await agent.memory({ operation: "stats" }, context)).consolidation, "scheduled");
		let observed = "";
		faux.setResponses([
			(request) => {
				observed = JSON.stringify(request.messages);
				return fauxAssistantMessage("Verified.");
			},
		]);
		await agent.ask("Verify old-reader output.", context);
		await agent.idle(context);
		assert.ok(observed.includes("Old reader completed safely."));
		assert.equal((await agent.status(context)).busy, false);
		console.log("new-reader-reopen: memory identity, provenance, prior transcript and old-reader append preserved");
	} else throw new Error("Expected seed or verify");
} finally {
	await agent.close(context);
}
