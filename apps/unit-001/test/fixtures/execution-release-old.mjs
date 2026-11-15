// Opens an executed database with the exact published 0.0.7 Agent and production dependencies.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "./dist/agent.js";

const [directory, variant] = process.argv.slice(2);
assert.equal(JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version, "0.0.7");
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage(fauxText("explicit-old-reader-answer"))]);
const models = createModels();
models.setProvider(faux.provider);
const reports = [];
let agent;
try {
	agent = await Agent.open(
		{
			storage: await openNodeSqliteStorage(join(directory, "session.sqlite")),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
			onReport: (report) => reports.push(String(report.error?.message ?? report.message ?? report)),
		},
		context,
	);
	await setTimeout(1000);
	assert.equal(faux.state.callCount, 0, "Old reader must not admit autonomous requests from the new ledger");
	const reply = await agent.ask("Explicit compatibility prompt", context);
	assert.equal(reply.status, "answered");
	assert.equal(reply.text, "explicit-old-reader-answer");
	assert.equal(faux.state.callCount, 1);
	await agent.memory(
		{ operation: "remember", content: "old-reader-compatible-write", requestId: "old-compat-write" },
		context,
	);
	await writeFile(
		join(directory, "old-reader-result.json"),
		JSON.stringify({ variant, opened: true, reports, calls: faux.state.callCount }),
	);
	console.log(
		`Published reader opened ${variant}; no autonomous request; explicit faux prompt and memory write passed.`,
	);
} catch (error) {
	console.log(`Published reader ${variant} failed closed: ${error.message}`);
	await writeFile(
		join(directory, "old-reader-result.json"),
		JSON.stringify({ variant, opened: false, reports, error: error.message, calls: faux.state.callCount }),
	);
	if (faux.state.callCount !== 0) throw error;
} finally {
	await agent?.close(context);
}
