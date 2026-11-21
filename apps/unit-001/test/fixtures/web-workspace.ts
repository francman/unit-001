// Runs the real browser gateway and SQLite owner with synthetic data for manual browser acceptance.
import { chmod, chown, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../src/agent.ts";
import { acquireSessionLock } from "../../src/lock.ts";
import { runService, serviceEndpoint } from "../../src/service.ts";
import { runWebWorkspace } from "../../src/web/launcher.ts";

const [directory, portText] = process.argv.slice(2);
if (!directory || !portText) throw new Error("Supply a temporary directory and loopback port.");
const port = Number(portText);
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = join(directory, "session.sqlite");
const release = await acquireSessionLock(`${file}.lock`);
const faux = fauxProvider();
faux.setResponses([
	// The long tail makes the conversation overflow its pane, so layout checks run with a real thread scrollbar.
	fauxAssistantMessage([
		fauxText(
			[
				'Verified browser answer. <img src=x onerror="window.injected=true">',
				...Array.from({ length: 40 }, (_, line) => `Acceptance paragraph ${line + 1}: text that fills the conversation pane.`),
			].join("\n\n"),
		),
	]),
	(_request, options) =>
		new Promise((_resolve, reject) =>
			options?.signal?.addEventListener("abort", () => reject(new Error("fixture cancellation")), { once: true }),
		),
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
await agent.memory(
	{ operation: "remember", content: "Violet browser acceptance memory", requestId: "browser-seed" },
	BACKGROUND_CONTEXT,
);
await agent.memory(
	{ operation: "remember", content: "Amber graph acceptance memory", requestId: "browser-graph-seed" },
	BACKGROUND_CONTEXT,
);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
const operatorDirectory = join(directory, "operator");
await mkdir(operatorDirectory, { mode: 0o750 });
await chmod(operatorDirectory, 0o750);
await chown(operatorDirectory, process.getuid!(), process.getgid!());
const endpoint = join(operatorDirectory, "default.sock");
let ready!: () => void;
const listening = new Promise<void>((resolve) => {
	ready = resolve;
});
const owner = runService(
	agent,
	serviceEndpoint(directory, "default", process.platform),
	"browser-fixture",
	ready,
	controller.signal,
	null,
	endpoint,
);
void owner.catch(() => {});
try {
	await Promise.race([owner, listening]);
	await runWebWorkspace(endpoint, port, (text) => process.stdout.write(text), controller.signal);
} finally {
	controller.abort();
	await owner;
	await agent.close(BACKGROUND_CONTEXT);
	await release();
	process.stdout.write(`Faux calls: ${faux.state.callCount}\n`);
}
