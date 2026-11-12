// #14: Copy into an untouched published 0.0.7 app and run with that release's bundled Linux Node.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "./dist/agent.js";

assert.equal(JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version, "0.0.7");
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("Published rollback reader remains operational.")]);
const models = createModels();
models.setProvider(faux.provider);
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(process.argv[2]),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		cwd: "/tmp",
	},
	context,
);
try {
	assert.equal((await agent.ask("Report a synthetic rollback result", context)).status, "answered");
	await agent.idle(context);
	assert.equal(faux.state.callCount, 1);
	await agent.memory(
		{ operation: "remember", content: "Rollback reader appended evidence", requestId: "rollback-append" },
		context,
	);
	const held = await agent.enterMaintenance("mission-rollback-fixture", 1000, context);
	assert.equal(held.result, "drained");
	await agent.releaseMaintenance("mission-rollback-fixture", context);
	assert.equal((await agent.status(context)).busy, false);
	console.log("published0.0.7 open, faux answer, memory append and maintenance passed");
} finally {
	await agent.close(context);
}
