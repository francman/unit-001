// Verifies #65 against a real SQLite owner and Unix operator socket with no paid provider.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { acquireSessionLock } from "../src/lock.ts";
import { requestService, runService, serviceEndpoint } from "../src/service.ts";
import { runWebWorkspace } from "../src/web/launcher.ts";
import { freePort, sessionHeaders } from "./helpers/web.ts";

it("#65 serves packaged assets from the sole owner, streams, deduplicates and forgets explicitly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "u1-web-"));
	const file = join(directory, "session.sqlite");
	const release = await acquireSessionLock(`${file}.lock`);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("Verified browser answer.")])]);
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
	const operatorDirectory = join(directory, "operator");
	await mkdir(operatorDirectory, { mode: 0o750 });
	await chmod(operatorDirectory, 0o750);
	const operator = join(operatorDirectory, "default.sock");
	const stopOwner = new AbortController();
	let ownerReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		ownerReady = resolve;
	});
	const owner = runService(
		agent,
		serviceEndpoint(directory, "default", process.platform),
		"fixture",
		ownerReady,
		stopOwner.signal,
		null,
		operator,
	);
	void owner.catch(() => {});
	const stopWeb = new AbortController();
	let web: Promise<number> | undefined;
	let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		await Promise.race([ready, owner]);
		const port = await freePort();
		let printed = "";
		let webReady!: () => void;
		const listening = new Promise<void>((resolve) => {
			webReady = resolve;
		});
		web = runWebWorkspace(
			operator,
			port,
			(text) => {
				printed += text;
				webReady();
			},
			stopWeb.signal,
		);
		await Promise.race([listening, web]);
		const origin = `http://127.0.0.1:${port}`;
		expect(printed).toContain(`Browser workspace: ${origin}`);
		const page = await (await fetch(origin)).text();
		expect(page).toContain("bootstrap.js");
		const bundle = await (await fetch(`${origin}/bootstrap.js`)).text();
		expect(bundle).not.toContain("unitPreview");
		expect(bundle).toContain("/api/v1/events");
		expect((await fetch(`${origin}/preview.js`)).status).toBe(404);
		const metadata = await fetch(`${origin}/api/v1/session`);
		const workspaceId = metadata.headers.get("x-unit-workspace");
		expect(workspaceId).toMatch(/^[a-f0-9]{64}$/);
		const session = (await metadata.json()) as { csrfToken: string };
		expect(session).toEqual({ csrfToken: expect.stringMatching(/^[a-f0-9]{64}$/) });
		const headers = sessionHeaders(origin, session.csrfToken);
		const call = async (requestId: string, operation: unknown) => {
			const response = await fetch(`${origin}/api/v1/requests`, {
				method: "POST",
				headers,
				body: JSON.stringify({ requestId, operation }),
			});
			expect(response.status).toBe(200);
			return await response.json();
		};
		const events = await fetch(`${origin}/api/v1/events`, { headers });
		expect(events.headers.get("x-unit-workspace")).toBe(workspaceId);
		stream = events.body!.getReader();
		expect(new TextDecoder().decode((await stream.read()).value)).toContain("event: view");
		const send = { type: "send", prompt: "Give the verified answer." };
		expect(await call("browser-send", send)).toEqual({
			requestId: "browser-send",
			state: "completed",
			response: { type: "sent" },
		});
		await call("browser-send", send);
		expect(faux.state.callCount).toBe(1);
		const remembered = await requestService(
			operator,
			{ type: "memory", request: { operation: "remember", content: "violet browser memory", requestId: "seed" } },
			new AbortController().signal,
		);
		if (remembered.type !== "memory" || remembered.result.operation !== "remember")
			throw new Error("Expected seed memory");
		expect(await call("recall", { type: "memory", request: { operation: "recall", query: "violet" } })).toMatchObject({
			response: { result: { records: [{ id: remembered.result.id }] } },
		});
		const graph = { type: "memory", request: { operation: "graph" } };
		expect(await call("graph", graph)).toMatchObject({
			state: "completed",
			response: {
				type: "memory",
				result: {
					operation: "graph",
					nodes: [
						{
							id: remembered.result.id,
							content: "violet browser memory",
							truncated: false,
							kind: "fact",
							tier: "working",
							origin: "user",
							conversation: expect.stringMatching(/^[a-f0-9]{12}$/),
						},
					],
					edges: [],
					total: 1,
					limited: false,
				},
			},
		});
		expect(
			(
				await fetch(`${origin}/api/v1/requests`, {
					method: "POST",
					headers: { ...headers, "X-Unit-CSRF": "wrong" },
					body: JSON.stringify({ requestId: "wrong-csrf-graph", operation: graph }),
				})
			).status,
		).toBe(403);
		expect(
			await call("forget", {
				type: "memory",
				request: { operation: "forget", id: remembered.result.id, confirmed: true },
			}),
		).toMatchObject({ response: { result: { removed: true } } });
		expect(await call("graph-after-forget", graph)).toMatchObject({
			response: { result: { operation: "graph", nodes: [], edges: [], total: 0, limited: false } },
		});
		await expect(acquireSessionLock(`${file}.lock`)).rejects.toThrow("already running");
		stopWeb.abort();
		await web;
		await expect(fetch(`${origin}/api/v1/session`)).rejects.toThrow();
		expect(faux.state.callCount).toBe(1);
	} finally {
		await stream?.cancel().catch(() => {});
		stopWeb.abort();
		await web;
		stopOwner.abort();
		await owner;
		await agent.close(BACKGROUND_CONTEXT);
		await release();
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);
