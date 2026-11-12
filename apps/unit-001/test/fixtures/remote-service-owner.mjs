// Runs the real private owner with a deterministic faux model inside the disposable SSH acceptance container.
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";
import { acquireSessionLock } from "../../dist/lock.js";
import { operatorEndpoint, runService, serviceEndpoint } from "../../dist/service.js";

const id = "aa49e3de-4cb1-4caf-9b98-26e4c399c12d";
const directory = "/home/owner/state";
const session = process.argv[2] ?? "default";
const name = process.argv[3] ?? "agent";
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = join(directory, `${session}.sqlite`);
const release = await acquireSessionLock(`${file}.lock`);
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 30 }, () => async (request, options) => {
		await appendFile(join(directory, "provider-calls.jsonl"), `${JSON.stringify(request)}\n`);
		if (JSON.stringify(request).includes("hold-until-released")) {
			while (!(await readFile(join(directory, "release"), "utf8").catch(() => "")))
				await delay(25, undefined, { signal: options?.signal });
		}
		return fauxAssistantMessage([fauxText("Remote faux answer received.")]);
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(file),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		cwd: directory,
		name,
	},
	BACKGROUND_CONTEXT,
);
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
const endpoint = operatorEndpoint(id, session);
await chmod(`/run/unit-001-${id}`, 0o750);
try {
	await runService(
		agent,
		serviceEndpoint(directory, session, "linux"),
		"0.0.7",
		async () => {
			await writeFile(join(directory, `${session}.ready`), "ready");
		},
		controller.signal,
		id,
		endpoint,
	);
} finally {
	await agent.close(BACKGROUND_CONTEXT);
	await release();
}
