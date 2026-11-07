import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { acquireSessionLock } from "../src/lock.ts";
import { requestService, runService, type ServiceView, serviceEndpoint, watchService } from "../src/service.ts";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "u1-svc-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		children.splice(0).map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
					child.kill("SIGKILL");
				}),
		),
	);
	for (const close of cleanup.splice(0).reverse()) await close();
	await rm(directory, { recursive: true, force: true });
});

async function launch(
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
	identity?: { id: string; name: string },
) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const release = await acquireSessionLock(join(directory, "session.sqlite.lock"));
	const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
	const agent = await Agent.open(
		{
			storage,
			models,
			model: { provider: "faux", modelId: "faux-1" },
			cwd: directory,
			...(identity === undefined ? {} : { name: identity.name }),
		},
		BACKGROUND_CONTEXT,
	);
	const controller = new AbortController();
	const path = serviceEndpoint(directory, "default", process.platform);
	let ready!: () => void;
	const listening = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const running = runService(agent, path, "fixture-version", ready, controller.signal, identity?.id ?? null);
	void running.catch(() => {});
	const close = async () => {
		controller.abort();
		try {
			await running;
		} finally {
			try {
				await agent.close(BACKGROUND_CONTEXT);
			} finally {
				await release();
			}
		}
	};
	cleanup.push(close);
	await Promise.race([listening, running]);
	return { agent, faux, storage, path, controller, running, close };
}

const signal = () => new AbortController().signal;
const reply = (text: string) => fauxAssistantMessage([fauxText(text)]);

describe.skipIf(process.platform === "win32")("headless local service", () => {
	it("exposes durable maintenance controls while rejecting new admissions", async () => {
		// #18: Only the owner changes the session gate; clients never open a second SQLite writer.
		const service = await launch([reply("Allowed")]);
		expect(
			await requestService(
				service.path,
				{ type: "maintenance-enter", operationId: "update", timeoutMs: 0 },
				signal(),
			),
		).toEqual({ type: "maintenance", protocol: 1, state: "held", operationId: "update", result: "drained" });
		expect(await requestService(service.path, { type: "send", prompt: "Blocked" }, signal())).toMatchObject({
			type: "error",
		});
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({
			maintenance: { state: "held", operationId: "update" },
		});
		expect(
			await requestService(service.path, { type: "maintenance-release", operationId: "wrong" }, signal()),
		).toMatchObject({ type: "error" });
		expect(
			await requestService(service.path, { type: "maintenance-release", operationId: "update" }, signal()),
		).toEqual({ type: "maintenance", protocol: 1, state: "open", operationId: null });
		expect(await requestService(service.path, { type: "send", prompt: "Allowed" }, signal())).toMatchObject({
			type: "reply",
		});
		expect(service.faux.state.callCount).toBe(1);
	});
	it("keeps the second watcher alive through queued prompts and a tool round after the first detaches", async () => {
		// #21: structural snapshots retain committed answers even when intermediate updates fold.
		let resume!: () => void;
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const service = await launch([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" }, { id: "read-1" })], {
					stopReason: "toolUse",
				});
			},
			reply("First complete tail."),
			reply("Second complete tail."),
		]);
		const submit = service.agent.submit.bind(service.agent);
		let admitted = 0;
		vi.spyOn(service.agent, "submit").mockImplementation(async (...args) => {
			const submission = await submit(...args);
			admitted++;
			return submission;
		});
		const first = new AbortController();
		const second = new AbortController();
		let firstReady = false;
		const views: ServiceView[] = [];
		const watchingFirst = watchService(
			service.path,
			() => {
				firstReady = true;
			},
			first.signal,
		);
		const watchingSecond = watchService(
			service.path,
			(view) => {
				views.push(view);
			},
			second.signal,
		);
		try {
			await expect.poll(() => firstReady && views.length > 0).toBe(true);
			first.abort();
			await watchingFirst;
			const one = requestService(service.path, { type: "send", prompt: "First" }, signal());
			await expect.poll(() => views.at(-1)?.busy).toBe(true);
			const two = requestService(service.path, { type: "send", prompt: "Second" }, signal());
			await expect.poll(() => admitted).toBe(2);
			resume();
			await Promise.all([one, two]);
			await expect
				.poll(() =>
					views
						.at(-1)
						?.entries.filter(({ role }) => role === "assistant")
						.map(({ text }) => text),
				)
				.toEqual(["First complete tail.", "Second complete tail."]);
		} finally {
			resume();
			first.abort();
			second.abort();
			await Promise.all([watchingFirst, watchingSecond]);
		}
	});

	it("stops a watch acquired after its socket has already disconnected", async () => {
		// #21: terminal loss during subscription acquisition cannot retain an orphaned watch.
		const service = await launch([]);
		const original = service.agent.watchConversation.bind(service.agent);
		let subscription: Awaited<ReturnType<typeof original>> | undefined;
		let resume!: () => void;
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		vi.spyOn(service.agent, "watchConversation").mockImplementation(async (context) => {
			subscription = await original(context);
			await gate;
			return subscription;
		});
		const controller = new AbortController();
		const watching = watchService(service.path, () => {}, controller.signal);
		await expect.poll(() => subscription !== undefined).toBe(true);
		controller.abort();
		await watching;
		resume();
		await expect(subscription?.closed).resolves.toMatchObject({ kind: "stopped" });
	});
	it("streams initial and committed final transcript without acquiring another session owner", async () => {
		// #21: attaching observes the service's owner instead of opening its database again.
		const service = await launch([reply("A final answer with its complete tail.")]);
		const controller = new AbortController();
		const views: ServiceView[] = [];
		const watching = watchService(
			service.path,
			(view) => {
				views.push(view);
			},
			controller.signal,
		);
		try {
			await expect.poll(() => views.length).toBeGreaterThan(0);
			await expect(acquireSessionLock(join(directory, "session.sqlite.lock"))).rejects.toThrow("already running");
			await requestService(service.path, { type: "send", prompt: "Answer." }, signal());
			await expect.poll(() => views.at(-1)?.entries.at(-1)?.text).toBe("A final answer with its complete tail.");
			expect(views.at(-1)?.entries.map(({ role }) => role)).toEqual(["user", "assistant"]);
		} finally {
			controller.abort();
			await watching;
		}
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
	});

	it("detaching a mid-run watcher preserves work and separate cancel remains effective", async () => {
		// #21: losing an SSH terminal must never abort autonomous work.
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const service = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
		]);
		const original = service.agent.watchConversation.bind(service.agent);
		let subscription: Awaited<ReturnType<typeof original>> | undefined;
		vi.spyOn(service.agent, "watchConversation").mockImplementation(async (context) => {
			subscription = await original(context);
			return subscription;
		});
		const sending = requestService(service.path, { type: "send", prompt: "Wait." }, signal());
		await started;
		const controller = new AbortController();
		const views: ServiceView[] = [];
		const watching = watchService(
			service.path,
			(view) => {
				views.push(view);
			},
			controller.signal,
		);
		await expect.poll(() => views[0]?.busy).toBe(true);
		controller.abort();
		await watching;
		await expect(subscription?.closed).resolves.toMatchObject({ kind: "stopped" });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: true });
		await requestService(service.path, { type: "cancel" }, signal());
		expect(await sending).toMatchObject({ type: "reply", reply: { status: "failed" } });
	});

	it("drops a backed-up terminal without preventing controls", async () => {
		// #21: socket backpressure cannot make the durable agent wait for a terminal.
		const service = await launch([]);
		const queued = vi.spyOn(Socket.prototype, "writableLength", "get").mockReturnValue(2 * 1_048_576);
		try {
			await expect(watchService(service.path, () => {}, signal())).rejects.toThrow("disconnected");
		} finally {
			queued.mockRestore();
		}
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
	});

	it.each(['{"type":"view","view":{}}\n', "x".repeat(1_048_577), ""])(
		"rejects invalid, oversized, and disconnected watch streams",
		async (wire) => {
			const path = join(directory, "wire.sock");
			const server = createServer((socket) => socket.once("data", () => socket.end(wire)));
			await new Promise<void>((resolve) => server.listen(path, resolve));
			try {
				await expect(watchService(path, () => {}, signal())).rejects.toThrow();
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);
	it("reports cached installed identity without reading manifests on each status", async () => {
		// #19: readiness must identify the selected installation, not merely an available socket.
		const identity = { id: "11111111-1111-1111-1111-111111111111", name: "bob" };
		const service = await launch([], identity);
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({
			name: "bob",
			installationId: identity.id,
		});
	});
	it("answers without terminal input and protects its socket", async () => {
		const service = await launch([reply("Paris.")]);
		expect((await stat(join(directory, "control"))).mode & 0o777).toBe(0o700);
		expect((await stat(service.path)).mode & 0o777).toBe(0o600);
		expect(await requestService(service.path, { type: "status" }, signal())).toEqual({
			type: "status",
			pid: process.pid,
			version: "fixture-version",
			name: "agent",
			installationId: null,
			busy: false,
			inhibited: false,
			maintenance: { protocol: 1, state: "open", operationId: null },
		});
		expect(
			await requestService(service.path, { type: "send", prompt: "Capital of France?", requestId: "q1" }, signal()),
		).toEqual({ type: "reply", reply: { status: "answered", text: "Paris." } });
		expect(
			await requestService(service.path, { type: "send", prompt: "Capital of France?", requestId: "q1" }, signal()),
		).toEqual({ type: "reply", reply: { status: "answered", text: "Paris." } });
		expect(service.faux.state.callCount).toBe(1);
	});

	it("shutdown preserves an admitted run for reopening", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const service = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("closing")), { once: true });
				}),
		]);
		const sending = requestService(
			service.path,
			{ type: "send", prompt: "Capital?", requestId: "pending" },
			signal(),
		);
		void sending.catch(() => {});
		await started;
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: true });
		await service.close();
		await expect(sending).rejects.toThrow(/disconnected/);
		const reopened = await launch([reply("Paris.")]);
		expect(reopened.agent.interrupted).toBe(true);
		expect(await reopened.agent.idle(BACKGROUND_CONTEXT)).toBe("Paris.");
		expect(
			await requestService(reopened.path, { type: "send", prompt: "Capital?", requestId: "pending" }, signal()),
		).toEqual({ type: "reply", reply: { status: "answered", text: "Paris." } });
		expect(reopened.faux.state.callCount).toBe(1);
	});

	it("client disconnect does not abort durable work; cancel does", async () => {
		let requested!: () => void;
		const started = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const service = await launch([
			(_request, options) =>
				new Promise((_resolve, reject) => {
					requested();
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
		]);
		const client = new AbortController();
		const sending = requestService(service.path, { type: "send", prompt: "Wait." }, client.signal);
		void sending.catch(() => {});
		await started;
		client.abort();
		await expect(sending).rejects.toBeDefined();
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: true });
		expect(await requestService(service.path, { type: "cancel" }, signal())).toEqual({ type: "cancelled" });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
	});

	it("rejects malformed local wire input without invoking the model", async () => {
		const service = await launch([]);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = createConnection(service.path, () => socket.write('{"type":"send","prompt":4}\n'));
			let text = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				text += chunk;
			});
			socket.once("end", () => resolve(text));
			socket.once("error", reject);
		});
		expect(JSON.parse(response)).toEqual({ type: "error", message: "Invalid service prompt." });
		expect(service.faux.state.callCount).toBe(0);
	});

	it("rejects oversized wire input and continues serving valid controls", async () => {
		const service = await launch([]);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = createConnection(service.path, () => socket.write("x".repeat(65_537)));
			let text = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				text += chunk;
			});
			socket.once("end", () => resolve(text));
			socket.once("error", reject);
		});
		expect(JSON.parse(response)).toEqual({ type: "error", message: "Service request exceeds 64 KiB." });
		expect(await requestService(service.path, { type: "status" }, signal())).toMatchObject({ busy: false });
		expect(service.faux.state.callCount).toBe(0);
	});

	it("propagates a storage failure and removes its endpoint", async () => {
		const service = await launch([reply("unused")]);
		const failure = new Error("disk failed");
		vi.spyOn(service.storage, "commit").mockRejectedValueOnce(failure);
		const sending = requestService(service.path, { type: "send", prompt: "hi" }, signal());
		void sending.catch(() => {});
		await expect(service.running).rejects.toBe(failure);
		await Promise.allSettled([sending]);
		expect(await service.agent.closed).toMatchObject({ kind: "failed", error: failure });
		cleanup.pop();
		await expect(service.close()).rejects.toBe(failure);
		await expect(stat(service.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		{ stopSignal: "SIGTERM", exitCode: 0 },
		{ stopSignal: "SIGKILL", exitCode: null },
	] as const)("$stopSignal during a model request preserves it for reopening", async ({ stopSignal, exitCode }) => {
		const fixture = fileURLToPath(new URL("./fixtures/service-owner.ts", import.meta.url));
		const child = spawn(process.execPath, [fixture, directory], { stdio: ["ignore", "pipe", "pipe"] });
		children.push(child);
		let output = "";
		let errors = "";
		const waiters: { marker: string; resolve: () => void; reject: (error: Error) => void }[] = [];
		child.stderr?.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.stdout?.on("data", (chunk) => {
			output += String(chunk);
			for (const waiter of waiters) if (output.includes(waiter.marker)) waiter.resolve();
		});
		child.once("exit", () => {
			for (const waiter of waiters) if (!output.includes(waiter.marker)) waiter.reject(new Error(errors));
		});
		const until = (marker: string) =>
			new Promise<void>((resolve, reject) => {
				if (output.includes(marker)) resolve();
				else waiters.push({ marker, resolve, reject });
			});
		await until("READY");
		const path = serviceEndpoint(directory, "default", process.platform);
		const sending = requestService(path, { type: "send", prompt: "Capital?", requestId: "signal" }, signal());
		void sending.catch(() => {});
		await until("REQUESTED");
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		child.kill(stopSignal);
		expect(await exited).toBe(exitCode);
		await expect(sending).rejects.toThrow(/disconnected/);
		const service = await launch([reply("Paris.")]);
		expect(service.agent.interrupted).toBe(true);
		expect(await service.agent.idle(BACKGROUND_CONTEXT)).toBe("Paris.");
		expect(
			await requestService(service.path, { type: "send", prompt: "Capital?", requestId: "signal" }, signal()),
		).toMatchObject({ type: "reply", reply: { text: "Paris." } });
		expect(service.faux.state.callCount).toBe(1);
	});

	it("stops advertising readiness when the harness closes unexpectedly", async () => {
		const service = await launch([]);
		await service.agent.close(BACKGROUND_CONTEXT);
		await expect(service.running).rejects.toThrow("Agent closed unexpectedly.");
		cleanup.pop();
		await expect(service.close()).rejects.toThrow("Agent closed unexpectedly.");
		await expect(stat(service.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
