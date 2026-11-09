// Provides a local scripted service peer so actual attached terminal behavior needs no provider or storage.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { main, processRuntime } from "../../dist/cli.js";
import { runRichAttach } from "../../dist/terminal-ui.js";

const directory = process.env.UNIT_001_HOME;
if (!directory) throw Error("Fixture needs an isolated data directory");
await mkdir(directory, { recursive: true, mode: 0o700 });
const managed = process.argv[3] === "managed" || process.argv[3] === "unavailable";
const unavailable = process.argv[3] === "unavailable";
const endpoint = managed ? join(directory, "control", "default.sock") : join(directory, "default.sock");
await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
if (managed)
	await writeFile(
		join(directory, "auth.json"),
		"Invalid credential fixture: an attached client must not read this file.",
	);
const sockets = new Set();
const watchers = new Set();
let tick = 0;
let view = {
	pid: 42,
	version: "0.0.4",
	name: "agent",
	installationId: "terminal-fixture",
	model: { provider: "faux", modelId: "terminal-model" },
	usage: null,
	entries: [
		{ id: 1, role: "user", text: "Review the deployment.", truncated: false },
		{
			id: 2,
			role: "assistant",
			text: "## Deployment review\n\nThe service is ready. Use **setup** to connect a provider.\n\n```bash\nsudo agent setup\n```",
			truncated: false,
		},
	],
	busy: process.argv[2] === "busy",
	text: "",
	textTruncated: false,
	tools: [
		{ callId: "read", name: "read", status: "succeeded" },
		{ callId: "check", name: "bash", status: "failed" },
	],
	historyTruncated: false,
};
const publish = () => {
	for (const watcher of watchers) watcher.write(`${JSON.stringify({ type: "view", view })}\n`);
};
const server = createServer((socket) => {
	sockets.add(socket);
	socket.on("error", () => {});
	socket.on("close", () => {
		sockets.delete(socket);
		watchers.delete(socket);
	});
	socket.once("data", async (data) => {
		const request = JSON.parse(data.toString().split("\n")[0]);
		await appendFile(join(directory, "requests.jsonl"), `${JSON.stringify(request)}\n`);
		if (request.type === "watch") {
			watchers.add(socket);
			publish();
		} else if (request.type === "cancel") {
			view = { ...view, busy: false, text: "" };
			publish();
			socket.end(`${JSON.stringify({ type: "cancelled" })}\n`);
		} else if (request.type === "send") {
			if (request.prompt === "fail") {
				socket.end(`${JSON.stringify({ type: "error", message: "Fixture provider unavailable" })}\n`);
			} else {
				view = {
					...view,
					entries: [
						...view.entries,
						{ id: 3, role: "user", text: request.prompt, truncated: false },
						{ id: 4, role: "assistant", text: "Fixture answer received.", truncated: false },
					],
				};
				publish();
				socket.end(
					`${JSON.stringify({ type: "reply", reply: { status: "answered", text: "Fixture answer received." } })}\n`,
				);
			}
		} else throw Error("Unsupported fixture request");
	});
});
if (!unavailable) await new Promise((resolve) => server.listen(endpoint, resolve));
const interval = setInterval(() => {
	if (!view.busy) return;
	view = { ...view, text: `Live fixture update ${++tick}` };
	publish();
}, 100);
try {
	const signal = new AbortController().signal;
	process.exitCode = managed
		? await main(
				[],
				{
					...processRuntime(),
					managed: { id: "11111111-1111-1111-1111-111111111111", name: "agent", state: directory },
				},
				signal,
			)
		: await runRichAttach(endpoint, new ProcessTerminal(), signal, {
				colorMode: process.env.NO_COLOR === undefined ? "color" : "monochrome",
			});
} finally {
	clearInterval(interval);
	for (const socket of sockets) socket.destroy();
	if (server.listening) await new Promise((resolve) => server.close(resolve));
}
