// Copy into the untouched published artifact's app directory; run with its bundled Linux Node in Docker.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "./dist/agent.js";

assert.equal(JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version, "0.0.5");
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
let observed = "";
faux.setResponses([
	(request) => {
		observed = JSON.stringify(request.messages);
		return fauxAssistantMessage("Old reader completed safely.");
	},
]);
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
	assert.equal((await agent.ask("What is the release codename?", context)).status, "answered");
	await agent.idle(context);
	assert.ok(observed.includes("The release codename is juniper."));
	assert.equal((await agent.status(context)).busy, false);
	console.log("published-0.0.5-reader: open, prior transcript, faux request, append, idle passed");
} finally {
	await agent.close(context);
}
