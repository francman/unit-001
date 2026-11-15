// #17: Runs the actual configured owner with a local abortable faux provider, never real credentials or network.
import { readFile, rm, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";
import { acquireSessionLock } from "../../dist/lock.js";
import { operatorEndpoint, runService, serviceEndpoint } from "../../dist/service.js";

globalThis.fetch = async () => {
	throw new Error("Network is forbidden in managed mission acceptance");
};
const id = "11111111-1111-4111-8111-111111111111";
const state = `/var/lib/unit-001/agents/${id}`;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown.abort());
const faux = fauxProvider();
faux.setResponses(
	Array.from({ length: 12 }, () => async (_input, options) => {
		const marker = `${state}/workspace/request-count`;
		const count = Number(await readFile(marker, "utf8").catch(() => "0")) + 1;
		await writeFile(marker, String(count));
		if (await readFile(`${state}/workspace/retry-once`, "utf8").catch(() => "")) {
			await rm(`${state}/workspace/retry-once`);
			return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Persist a bounded retry" });
		}
		await new Promise((_resolve, reject) =>
			options.signal.addEventListener("abort", () => reject(new Error("Fixture drained")), { once: true }),
		);
		return fauxAssistantMessage("unreachable");
	}),
);
const models = createModels();
models.setProvider(faux.provider);
const release = await acquireSessionLock(`${state}/default.sqlite.lock`);
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(`${state}/default.sqlite`),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		name: "bob",
		cwd: `${state}/workspace`,
		mission: { kind: "managed", installationId: id, session: "default" },
	},
	context,
);
try {
	await runService(
		agent,
		serviceEndpoint(state, "default", "linux"),
		"mission-fixture",
		async () => {
			await writeFile(`${state}/owner-ready`, String(process.pid));
		},
		shutdown.signal,
		id,
		operatorEndpoint(id, "default"),
	);
} finally {
	await agent.close(context);
	await release();
}
