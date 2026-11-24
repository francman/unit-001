// Exercises the production shell assets in a private Chrome profile, without an owner or live gateway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { executable, launchChrome, openTab, stopProcess, until } from "./support/browser.mjs";

test("workspace identity, gateway reconnect, managed review, mobile drawer and Purpose navigation", { skip: !executable, timeout: 45_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-shell-"));
	const assets = {
		"/": ["index.html", "text/html"],
		"/bootstrap.js": ["bootstrap.js", "text/javascript"],
		"/style.css": ["style.css", "text/css"],
	};
	const moduleReady = Promise.withResolvers();
	const sessionRequested = Promise.withResolvers();
	const sessionReady = Promise.withResolvers();
	let csrf = "b".repeat(64);
	const originalId = "a".repeat(64);
	const otherId = "f".repeat(64);
	let sessionId;
	let streamId = originalId;
	let malformedMetadata = false;
	const requests = [];
	const sends = [];
	const eventStreams = new Set();
	let cancellations = 0;
	const agreeRequests = [];
	const digest = "e".repeat(64);
	const review = { missionId: "fixture-mission", revision: 4, digest, authorityRevision: 7, previousReceipt: null };
	const mission = {
		stage: "awaiting_approval", creator: { kind: "human", id: "fixture-creator" },
		authority: "managed-administrator", canAgree: true, agreementValid: false, authorityError: null,
		execution: "not-started", missing: [], tools: [], previousReceipt: null, review,
		plan: null, planError: null, canAgreePlan: false, runnablePurposeBinding: null,
		formation: { agreement: null, draft: { missionId: review.missionId, revision: review.revision, digest, status: "proposed", terms: {
			objective: "Managed mission review sentinel", scope: "Local test", successCriteria: ["Inspect terms"], approvalBoundary: [],
			reviewEveryMs: 60_000, policy: { allowedTools: [], maxCycles: 2, maxRequests: 3, maxRetries: 0, maxConsecutiveNoProgress: 1, deadlineAt: 1_893_456_000_000 },
		} } },
	};
	const view = {
		name: "Test agent", version: "0.0.0", installationId: null, busy: true, model: { provider: "test", modelId: "test" },
		usage: null, entries: [{ id: 1, role: "assistant", text: "Retained history before rollover", truncated: false }],
		tools: [], text: "", textTruncated: false, historyTruncated: false,
	};
	const server = createServer(async (request, response) => {
		const asset = assets[request.url];
		if (asset) {
			if (request.url === "/bootstrap.js") await moduleReady.promise;
			const body = await readFile(join(directory, asset[0]));
			response.writeHead(200, {
				"Content-Type": asset[1],
				...(request.url === "/" ? { "Set-Cookie": "test_cookie=ignored; SameSite=Strict" } : {}),
			}).end(body);
			return;
		}
		if (!request.url?.startsWith("/api/v1/")) return response.writeHead(404).end();
		const { authorization, cookie, origin, "x-unit-csrf": requestCsrf } = request.headers;
		requests.push({ path: request.url, method: request.method, authorization, cookie, requestCsrf });
		const json = (status, value) =>
			response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
		if (request.url === "/api/v1/session" && request.method === "GET") {
			sessionRequested.resolve();
			await sessionReady.promise;
			if (sessionId) response.setHeader("X-Unit-Workspace", sessionId);
			return json(200, malformedMetadata ? { csrfToken: csrf, unexpected: true } : { csrfToken: csrf });
		}
		if (request.url === "/api/v1/events" && request.method === "GET") {
			if (streamId) response.setHeader("X-Unit-Workspace", streamId);
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const shown = streamId === originalId ? view : { ...view, name: "Unverified other owner",
				entries: [{ id: 1, role: "assistant", text: "Unverified history sentinel", truncated: false }] };
			response.write(`event: view\ndata: ${JSON.stringify(shown)}\n\n`);
			eventStreams.add(response);
			response.once("close", () => eventStreams.delete(response));
		} else if (request.url === "/api/v1/requests" && request.method === "POST") {
			if (origin !== `http://127.0.0.1:${request.socket.localPort}` ||
				request.headers["content-type"] !== "application/json") return json(403, {});
			let body = "";
			for await (const chunk of request) body += chunk;
			const { operation, requestId } = JSON.parse(body);
			if (operation.type === "send") sends.push({ prompt: operation.prompt, requestId, csrf: requestCsrf });
			if (requestCsrf !== csrf) return json(403, {});
			const complete = (reply) => json(200, { requestId, state: "completed", response: reply });
			if (operation.type === "cancel") {
				cancellations++;
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ requestId, state: "completed", response: { type: "cancelled" } }));
				for (const stream of eventStreams)
					stream.write(`event: view\ndata: ${JSON.stringify({ ...view, busy: false })}\n\n`);
			} else if (operation.type === "send") {
				return complete({ type: "sent" });
			} else if (operation.type === "mission" && operation.request.operation === "status") {
				return complete({ type: "mission", result: mission });
			} else if (operation.type === "status") {
				return complete({ type: "status", runtime: { configuration: "configured", uptimeMs: 0 }, maintenance: { state: "open" }, inhibited: false });
			} else if (operation.type === "memory" && operation.request.operation === "stats") {
				return complete({ type: "memory", result: { operation: "stats", working: 0, episodic: 0, tombstones: 0,
					pendingCaptures: 0, failedCaptures: 0, consolidation: "idle" } });
			} else if (operation.type === "channels") {
				return complete({ type: "channels", result: { operation: "status", view: { channels: [] } } });
			} else {
				if (operation.type === "mission" && operation.request.operation === "agree") agreeRequests.push(operation);
				response.writeHead(503).end();
			}
		} else {
			response.writeHead(404).end();
		}
	});
	let browser;
	let socket;
	let secondSocket;
	try {
		execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-web.mjs", import.meta.url)), directory], { stdio: "inherit" });
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { browser: launched, debugPort } = await launchChrome(join(directory, "profile"));
		browser = launched;
		const tab = await openTab(debugPort);
		socket = tab.socket;
		const call = tab.call;
		const evaluate = async (expression) => {
			const result = await call("Runtime.evaluate", { expression, returnByValue: true });
			assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
			return result.result.value;
		};
		const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
		const focused = () => evaluate("document.activeElement.id || document.activeElement.dataset.key");
		const resize = (width, height, mobile) => call("Emulation.setDeviceMetricsOverride", { width, height, mobile, deviceScaleFactor: 1 });
		const key = async (name, windowsVirtualKeyCode, modifiers = 0) => {
			const params = { key: name, code: name, windowsVirtualKeyCode, modifiers };
			await call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
			await call("Input.dispatchKeyEvent", { type: "keyUp", ...params });
		};

		await resize(390, 240, true);
		await call("Emulation.setTouchEmulationEnabled", { enabled: true });
		const origin = `http://127.0.0.1:${server.address().port}/`;
		await call("Page.navigate", { url: origin });
		const checking = () => evaluate(`document.querySelector('#app [role="status"]')?.innerText === 'Connecting to your workspace…'`);
		await until(checking);
		moduleReady.resolve();
		await sessionRequested.promise;
		assert.ok(await checking(), "checking stays visible while the request is outstanding");
		sessionReady.resolve();
		await until(() => evaluate(`document.querySelector('#app [role="status"]')?.innerText.includes('Cannot reach the workspace.')`));
		assert.match(await evaluate(`document.querySelector('#app [role="status"]').innerText`), /ssh unit-001.*bob web/);
		assert.deepEqual(requests.map(({ method, path }) => [method, path]), [["GET", "/api/v1/session"]]);
		sessionId = originalId;
		malformedMetadata = true;
		await call("Page.reload");
		await until(() => evaluate(`document.querySelector('#app [role="status"]')?.innerText.includes('Cannot reach the workspace.')`));
		assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
			["GET", "/api/v1/session"], ["GET", "/api/v1/session"],
		], "a missing identity and invalid JSON shape both prevent opening the stream");
		malformedMetadata = false;
		await call("Page.reload");
		const footer = `document.querySelector('footer[aria-label="Status bar"]')`;
		await until(() => evaluate(`${footer}?.innerText.includes('Replying')`));
		assert.equal(await checking(), false);
		assert.equal(await evaluate("document.cookie"), "test_cookie=ignored");
		assert.equal(await evaluate(`document.querySelector('input[type="password"], [data-key="signout"]')`), null);

		const menu = '[data-key="menu"]';
		await click(menu);
		assert.equal(await focused(), "nav-chat");
		assert.ok(await evaluate(`document.querySelector('#sidebar[aria-modal="true"]') && document.querySelector('#main').closest('[inert]') !== null`));
		assert.ok(await evaluate(`(() => {const nav = document.querySelector('#sidebar nav'); return nav.scrollHeight > nav.clientHeight && getComputedStyle(nav).overflowY === 'auto';})()`));
		await evaluate(`document.querySelector('[data-key="nav-close"]').focus()`);
		await key("Tab", 9, 8);
		assert.equal(await focused(), "theme");
		await key("Tab", 9);
		assert.equal(await focused(), "nav-close");
		await key("Escape", 27);
		assert.equal(await focused(), "menu");
		assert.ok(await evaluate(`document.querySelector('#main').closest('[inert]') === null`));

		await click(menu);
		await resize(1024, 600, false);
		await until(() => evaluate(`document.querySelector('#main').closest('[inert]') === null`));
		assert.equal(await focused(), "nav-chat");
		await click("#nav-memory");
		await until(() => evaluate(`!!document.querySelector('#memory-query')`));
		await evaluate(`document.querySelector('#memory-query').focus()`);
		await key("Escape", 27);
		assert.equal(await focused(), "memory-query");
		assert.equal(await evaluate(`${footer}.innerText.includes('Stopping')`), false);
		assert.equal(cancellations, 0);

		await click("#nav-chat");
		await click('[data-key="send"]');
		await until(() => cancellations === 1);
		await until(() => evaluate(`${footer}?.innerText.includes('Ready')`));

		// A stale tab gets one pre-dispatch 403; the replacement view has no history to replay.
		const rolloverDraft = "Keep this across credential rollover";
		await evaluate(`{ const input = document.querySelector('#composer'); input.value = ${JSON.stringify(rolloverDraft)};
			input.dispatchEvent(new Event('input', { bubbles: true })); }`);
		assert.equal(await evaluate(`document.querySelector('#thread').innerText.includes('Retained history before rollover')`), true);
		const oldCsrf = csrf;
		csrf = "d".repeat(64);
		const priorEntries = view.entries;
		view.entries = [];
		view.busy = false;
		await click('[data-key="send"]');
		await until(() => evaluate(`document.body.innerText.includes('Request not sent. Wait for this workspace to reconnect')`));
		assert.equal(await evaluate(`document.querySelector('#composer').value`), rolloverDraft);
		await until(() => evaluate(`!document.querySelector('[data-key="send"]').disabled`));
		assert.equal(await evaluate(`document.querySelector('#composer').value`), rolloverDraft);
		assert.equal(await evaluate(`document.querySelector('#thread').innerText.includes('Retained history before rollover')`), true);
		assert.deepEqual(sends.map(({ prompt, csrf }) => [prompt, csrf]), [[rolloverDraft, oldCsrf]], "reconnect never replays the send");
		await click('[data-key="send"]');
		await until(() => sends.length === 2);
		assert.deepEqual(sends.map(({ prompt, csrf }) => [prompt, csrf]), [[rolloverDraft, oldCsrf], [rolloverDraft, csrf]]);
		assert.notEqual(sends[0].requestId, sends[1].requestId);
		view.entries = priorEntries;
		view.busy = true;

		// New gateway lifetime: the old stream ends and future actions need the new token.
		csrf = "c".repeat(64);
		streamId = null;
		const eventsBeforeRestart = requests.filter(({ path }) => path === "/api/v1/events").length;
		for (const stream of eventStreams) stream.end();
		await until(() => evaluate(`Array.from(document.querySelectorAll('[role="status"]')).some(e => e.innerText.includes('Cannot reach the agent.') && e.innerText.includes('bob web'))`));
		await until(() => requests.filter(({ path }) => path === "/api/v1/events").length === eventsBeforeRestart + 1);
		assert.equal(await evaluate(`document.querySelector('[data-key="send"]').disabled`), true);
		assert.equal(await evaluate(`document.body.innerText.includes('Unverified history sentinel')`), false);
		streamId = originalId;
		await until(() => evaluate(`${footer}?.innerText.includes('Replying')`));
		assert.equal(cancellations, 1, "the previous cancellation was not replayed");
		await click('[data-key="send"]');
		await until(() => cancellations === 2);
		await until(() => evaluate(`${footer}?.innerText.includes('Ready')`));
		for (const stream of eventStreams) stream.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
		await until(() => evaluate(`${footer}?.innerText.includes('Replying')`));

		await click("#nav-about");
		await until(() => evaluate(`document.querySelector('[data-key="about-purpose"]')?.innerText === 'Open Mission'`));
		// A managed host never offers browser Agree, so About lists approval as terminal-only.
		const aboutText = await evaluate(`document.body.innerText`);
		assert.ok(aboutText.includes("Approve a purpose or plan revision.") && !aboutText.includes("Agree to the exact revision you reviewed."));
		await evaluate(`window.initialMissionHeading = null; document.querySelector('[data-key="about-purpose"]').click(); initialMissionHeading = document.querySelector('h1');`);
		assert.equal(await evaluate(`document.querySelector('h1')?.innerText`), "Mission");
		await until(() => evaluate(`initialMissionHeading !== document.querySelector('h1')`));
		await evaluate(`{
			const label = [...${footer}.querySelectorAll('span')].find(span => span.firstChild?.nodeType === Node.TEXT_NODE && span.textContent.startsWith('Replying')).firstChild;
			window.shellTick = { page: document.querySelector('h1'), label, value: label.data };
		}`);
		await until(() => evaluate(`shellTick.label.isConnected && shellTick.label.data !== shellTick.value`));
		assert.ok(await evaluate(`shellTick.page === document.querySelector('h1')`));
		const budgetExpired = new Promise((resolve) => {
			function onMessage(event) {
				if (JSON.parse(event.data).method !== "Emulation.virtualTimeBudgetExpired") return;
				socket.removeEventListener("message", onMessage);
				resolve();
			}
			socket.addEventListener("message", onMessage);
		});
		await call("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 31_000 });
		await budgetExpired;
		assert.ok(await evaluate(`shellTick.page === document.querySelector('h1')`), "the former 30-second refresh does not replace content");
		await call("Emulation.setVirtualTimePolicy", { policy: "pauseIfNetworkFetchesPending" });

		const secondTab = await openTab(debugPort);
		secondSocket = secondTab.socket;
		const second = secondTab.call;
		await second("Page.navigate", { url: origin });
		await until(async () => {
			const { result } = await second("Runtime.evaluate", {
				expression: `${footer}?.innerText.includes('Replying') ?? false`,
				returnByValue: true,
			});
			return result.value === true;
		});
		assert.equal(requests.filter(({ method, path }) => method === "GET" && path === "/api/v1/session").length, 7);
		assert.equal(requests.filter(({ method, path }) => method === "GET" && path === "/api/v1/events").length, 5);
		assert.ok(requests.every(({ authorization, cookie }) => authorization === undefined && cookie === undefined));
		assert.ok(requests.every(({ path }) => ["/api/v1/session", "/api/v1/events", "/api/v1/requests"].includes(path)));

		// Even an affirmative flag in a valid managed projection must not produce browser Agree.
		await click('[data-key="open-mission-draft"]');
		await until(() => evaluate(`!!document.querySelector('[data-key="copy-mission-draft-approve"]')`));
		assert.equal(await evaluate(`document.querySelector('[data-key^="mission-draft-agree-"]')`), null);
		assert.equal(await evaluate(`document.querySelector('[data-scroll="mission-draft"]').innerText.includes("Managed mission review sentinel")`), true);
		assert.equal(agreeRequests.length, 0);

		const setDraft = `const composer = document.querySelector('#composer'); composer.value = "Keep this draft"; composer.dispatchEvent(new Event('input', { bubbles: true }));`;
		await evaluate(`{ ${setDraft} }`);
		const posts = requests.filter(({ method }) => method === "POST").length;
		// Reproduce a switch between matching metadata and the stream on the same browser origin.
		streamId = otherId;
		for (const stream of eventStreams) stream.end();
		await until(() => evaluate(`document.body.innerText.includes('Cannot reach the agent.')`));
		await call("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 4000 });
		await until(() => evaluate(`document.body.innerText.includes('A different workspace answered.')`));
		assert.equal(await evaluate(`document.querySelector('#composer').value`), "Keep this draft");
		assert.equal(await evaluate(`document.querySelector('[data-key="send"]').disabled`), true, "a prior busy view cannot stop the other owner");
		assert.equal(await evaluate(`document.querySelector('[data-key="mission-draft-edit"]').disabled`), true);
		assert.equal(await evaluate(`document.querySelector('[data-key="copy-mission-draft-approve"]')`), null);
		assert.equal(await evaluate(`document.body.innerText.includes('Unverified history sentinel')`), false);
		assert.equal(await evaluate(`document.querySelector('[data-scroll="mission-draft"]').innerText.includes("Managed mission review sentinel")`), true);
		await evaluate(`document.querySelector('#composer').form.requestSubmit()`);
		await click("#nav-mission");
		assert.equal(await evaluate(`document.querySelector('[data-key="copy-mission-approve"]')`), null);
		assert.equal(requests.filter(({ method }) => method === "POST").length, posts);
	} finally {
		moduleReady.resolve();
		sessionReady.resolve();
		secondSocket?.close();
		socket?.close();
		await stopProcess(browser);
		server.close();
		server.closeAllConnections();
		await rm(directory, { recursive: true, force: true });
	}
});
