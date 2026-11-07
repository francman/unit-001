// Runs a headless faux agent so tests can signal it during a real persisted request.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../src/agent.ts";
import { acquireSessionLock } from "../../src/lock.ts";
import { runService, serviceEndpoint } from "../../src/service.ts";

const directory = process.argv[2];
const file = join(directory, "session.sqlite");
const release = await acquireSessionLock(`${file}.lock`);
const faux = fauxProvider();
faux.setResponses([
	(_request, options) =>
		new Promise((_resolve, reject) => {
			process.stdout.write("REQUESTED\n");
			options?.signal?.addEventListener("abort", () => reject(new Error("closing")), { once: true });
		}),
]);
const models = createModels();
models.setProvider(faux.provider);
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(file),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		cwd: directory,
	},
	BACKGROUND_CONTEXT,
);
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
try {
	await runService(
		agent,
		serviceEndpoint(directory, "default", process.platform),
		"fixture-version",
		() => process.stdout.write("READY\n"),
		controller.signal,
	);
} finally {
	await agent.close(BACKGROUND_CONTEXT);
	await release();
}
