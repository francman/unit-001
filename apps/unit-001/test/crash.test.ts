import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

const fixture = fileURLToPath(new URL("./fixtures/hang.ts", import.meta.url));
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "unit-001-crash-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

/** Starts the fixture and resolves with the process once it is inside its model request. */
async function startHangingProcess(file: string) {
	const child = spawn(process.execPath, [fixture, file, directory], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("REQUESTED")) resolve();
		});
		child.once("exit", () => reject(new Error(`child exited before its request: ${stderr}`)));
	});
	return { child, exited };
}

it("resumes a run after the process is killed without warning", async () => {
	const file = join(directory, "session.sqlite");
	const { child, exited } = await startHangingProcess(file);
	child.kill("SIGKILL"); // no close, no cleanup: a crash
	await exited;

	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
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
	try {
		expect(agent.interrupted).toBe(true);
		expect(await agent.idle(BACKGROUND_CONTEXT)).toBe("Paris.");
		// A retry of the original request finds the submission that survived the crash.
		const again = await agent.submit("Capital of France?", BACKGROUND_CONTEXT, { requestId: "q1" });
		expect((await again.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		expect(faux.state.callCount).toBe(1);
	} finally {
		await agent.close(BACKGROUND_CONTEXT);
	}
}, 30_000);
