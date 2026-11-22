// Runs the real browser gateway and SQLite owner with synthetic data for manual browser acceptance.
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineEntry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../src/agent.ts";
import { acquireSessionLock } from "../../src/lock.ts";
import { runService, serviceEndpoint } from "../../src/service.ts";
import { localServiceClient } from "../../src/service-client.ts";
import { createWebGateway } from "../../src/web/gateway.ts";
import { runWebWorkspace } from "../../src/web/launcher.ts";

const [directory, portText, assetsDirectory, ownerLabel] = process.argv.slice(2);
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
	fauxAssistantMessage([fauxText("Verified browser answer after gateway restart.")]),
]);
const models = createModels();
models.setProvider(faux.provider);
// Seed the database and close the harness before the real owner opens it.
const model = { provider: "faux", modelId: "faux-1" };
const seed = await Harness.open(await openNodeSqliteStorage(file), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
try {
	const root = await seed.root(BACKGROUND_CONTEXT, { agent: { model } });
	const hidden = defineEntry<{ detail: string }>("fixture.browser.hidden");
	await root.commit(async (tx) => {
		for (let index = 1; index <= 28; index++) {
			// Two pages' worth of hidden records guarantees an empty continuation even if startup trims the live window.
			if (index === 9) {
				for (let gap = 0; gap < 40; gap++) {
					await tx.appendEntry(hidden, root.id, { data: { detail: "Not a chat message" } });
				}
			}
			const text = `${ownerLabel ? `${ownerLabel}: ` : ""}Retained browser message ${index}${index === 1 ? ": oldest SQLite sentinel" : ""}`;
			if (index % 2 === 1)
				await tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content: text, timestamp: index }] });
			else await tx.appendEntry(AssistantEntry, root.id, { model: [fauxAssistantMessage([fauxText(text)])] });
		}
	}, BACKGROUND_CONTEXT);
} finally {
	await seed.close(BACKGROUND_CONTEXT);
}
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(file),
		models,
		model,
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
// Stable across gateway lifetimes, distinct for each fixture owner regardless of the browser origin.
const workspaceId = createHash("sha256").update(endpoint).digest("hex");
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
let restart: AbortController | undefined;
const requestRestart = () => restart?.abort();
process.on("SIGUSR2", requestRestart);
try {
	await Promise.race([owner, listening]);
	// Reopen only the browser gateway, retaining the owner and its SQLite state.
	while (!controller.signal.aborted) {
		restart = new AbortController();
		const signal = AbortSignal.any([controller.signal, restart.signal]);
		if (assetsDirectory) await runIsolatedWorkspace(assetsDirectory, signal);
		else await runWebWorkspace(endpoint, port, (text) => process.stdout.write(text), signal);
	}
} finally {
	process.off("SIGUSR2", requestRestart);
	controller.abort();
	await owner;
	await agent.close(BACKGROUND_CONTEXT);
	await release();
	process.stdout.write(`Faux calls: ${faux.state.callCount}\n`);
}

// Isolated browser checks can serve their own production build without touching the shared web-dist.
async function runIsolatedWorkspace(directory: string, signal: AbortSignal): Promise<void> {
	const origin = `http://127.0.0.1:${port}`;
	const assets = new Map<string, { contentType: string; body: Uint8Array }>();
	for (const [path, filename, contentType] of [
		["/", "index.html", "text/html; charset=utf-8"],
		["/bootstrap.js", "bootstrap.js", "text/javascript; charset=utf-8"],
		["/style.css", "style.css", "text/css; charset=utf-8"],
	]) {
		assets.set(path, { contentType, body: await readFile(join(directory, filename)) });
	}
	const gateway = createWebGateway({ client: localServiceClient(endpoint), origin, assets, workspaceId });
	try {
		await new Promise<void>((resolve, reject) => {
			gateway.server.once("error", reject);
			gateway.server.listen(port, "127.0.0.1", resolve);
		});
		process.stdout.write(`Browser workspace: ${origin}\n`);
		if (!signal.aborted)
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	} finally {
		await gateway.close();
	}
}
