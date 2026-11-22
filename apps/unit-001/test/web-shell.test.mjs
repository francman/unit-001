// Exercises the production shell assets in a private Chrome profile, without an owner or live gateway.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;

test("workspace startup and bearer restore, Escape, mobile drawer, elapsed label and Purpose navigation", { skip: !executable, timeout: 45_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-web-shell-"));
	const assets = {
		"/": ["index.html", "text/html"],
		"/bootstrap.js": ["bootstrap.js", "text/javascript"],
		"/style.css": ["style.css", "text/css"],
	};
	const moduleReady = Promise.withResolvers();
	const sessionRequested = Promise.withResolvers();
	const sessionReady = Promise.withResolvers();
	const token = "a".repeat(64);
	const csrf = "b".repeat(64);
	const bearer = `Bearer ${token}`;
	const expiry = Date.now() + 1_800_000;
	const requests = [];
	let paired = false;
	let cancellations = 0;
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
		const { authorization, cookie } = request.headers;
		requests.push({ path: request.url, method: request.method, authorization, cookie });
		const authenticated = paired && authorization === bearer;
		const json = (status, value) =>
			response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
		if (request.url === "/api/v1/session") {
			if (request.method === "POST") {
				let body = "";
				for await (const chunk of request) body += chunk;
				if (paired || authorization || JSON.parse(body).secret !== "fixture-code") return json(401, {});
				paired = true;
				return json(200, { authenticated: true, sessionToken: token, csrfToken: csrf, expiresAt: expiry });
			}
			sessionRequested.resolve();
			await sessionReady.promise;
			return json(200, authenticated ? { authenticated: true, csrfToken: csrf, expiresAt: expiry } : { authenticated: false });
		}
		if (!authenticated) return json(401, {});
		if (request.method === "POST" && request.headers["x-unit-csrf"] !== csrf) return json(403, {});
		if (request.url === "/api/v1/logout") {
			paired = false;
			return json(200, { authenticated: false });
		} else if (request.url === "/api/v1/events") {
			const view = {
				name: "Test agent", version: "0.0.0", installationId: null, busy: true, model: { provider: "test", modelId: "test" },
				usage: null, entries: [], tools: [], text: "", textTruncated: false, historyTruncated: false,
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
		} else if (request.url === "/api/v1/requests") {
			let body = "";
			for await (const chunk of request) body += chunk;
			const { operation, requestId } = JSON.parse(body);
			if (operation.type === "cancel") {
				cancellations++;
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ requestId, state: "completed", response: { type: "cancelled" } }));
			} else {
				response.writeHead(503).end();
			}
		} else {
			response.writeHead(404).end();
		}
	});
	let browser;
	let socket;
	let restoredSocket;
	try {
		execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-web.mjs", import.meta.url)), directory], { stdio: "inherit" });
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`], { stdio: "ignore" });
		let debugPort;
		await until(async () => {
			try {
				const [port, endpoint] = (await readFile(join(directory, "profile", "DevToolsActivePort"), "utf8")).split("\n");
				if (!/^[1-9]\d{0,4}$/.test(port ?? "") || Number(port) > 65_535 || !endpoint?.startsWith("/devtools/browser/"))
					return false;
				debugPort = port;
				return true;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				return false;
			}
		});
		const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
		socket = new WebSocket(target.webSocketDebuggerUrl);
		await once(socket, "open");
		const call = debugCommands(socket);
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
		const checking = () => evaluate(`document.querySelector('#app [role="status"]')?.innerText === 'Checking your session…'`);
		await until(checking);
		moduleReady.resolve();
		await sessionRequested.promise;
		assert.ok(await checking(), "checking stays visible while the request is outstanding");
		sessionReady.resolve();
		await until(() => evaluate("document.querySelector('#pairing-code') !== null"));
		await evaluate(`document.querySelector('#pairing-code').value = 'fixture-code'; document.querySelector('[data-key="pairing-connect"]').click()`);
		const footer = `document.querySelector('footer[aria-label="Status bar"]')`;
		await until(() => evaluate(`${footer}?.innerText.includes('Replying')`));
		assert.equal(await checking(), false);
		assert.equal(await evaluate("document.cookie"), "test_cookie=ignored");
		assert.deepEqual(requests.filter((request) => request.path === "/api/v1/session").slice(0, 2), [
			{ path: "/api/v1/session", method: "GET", authorization: undefined, cookie: undefined },
			{ path: "/api/v1/session", method: "POST", authorization: undefined, cookie: undefined },
		]);

		const menu = '[data-key="menu"]';
		await click(menu);
		assert.equal(await focused(), "nav-chat");
		assert.ok(await evaluate(`document.querySelector('#sidebar[aria-modal="true"]') && document.querySelector('#main').closest('[inert]') !== null`));
		assert.ok(await evaluate(`(() => {const nav = document.querySelector('#sidebar nav'); return nav.scrollHeight > nav.clientHeight && getComputedStyle(nav).overflowY === 'auto';})()`));
		await evaluate(`document.querySelector('[data-key="nav-close"]').focus()`);
		await key("Tab", 9, 8);
		assert.equal(await focused(), "signout");
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

		await click("#nav-about");
		await until(() => evaluate(`document.querySelector('[data-key="about-purpose"]')?.innerText === 'Open Mission'`));
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
		await click("#nav-chat");
		await click('[data-key="send"]');
		await until(() => cancellations === 1);

		const restoredTab = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
		restoredSocket = new WebSocket(restoredTab.webSocketDebuggerUrl);
		await once(restoredSocket, "open");
		const restored = debugCommands(restoredSocket);
		await restored("Page.navigate", { url: origin });
		await until(async () => {
			const { result } = await restored("Runtime.evaluate", {
				expression: `${footer}?.innerText.includes('Replying') ?? false`,
				returnByValue: true,
			});
			return result.value === true;
		});
		assert.deepEqual(requests.filter((request) => request.path === "/api/v1/session").slice(2), [
			{ path: "/api/v1/session", method: "GET", authorization: bearer, cookie: undefined },
		]);
		assert.equal(requests.filter((request) => request.path === "/api/v1/events").length, 2);
		await click('[data-key="signout"]');
		await until(() => evaluate("document.body.innerText.includes('Signed out.')"));
		assert.equal(paired, false);
		assert.deepEqual(requests.filter(({ path, cookie, authorization }) =>
			cookie !== undefined || (path !== "/api/v1/session" && authorization !== bearer)), []);
		assert.ok(requests.every(({ path }) => !path.includes("?") && !path.includes(token)));
		await restored("Page.reload");
		await until(async () => {
			const { result } = await restored("Runtime.evaluate", {
				expression: "document.querySelector('#pairing-code') !== null",
				returnByValue: true,
			});
			return result.value === true;
		});
		assert.deepEqual(requests.filter((request) => request.path === "/api/v1/session").at(-1), {
			path: "/api/v1/session", method: "GET", authorization: undefined, cookie: undefined,
		});
	} finally {
		moduleReady.resolve();
		sessionReady.resolve();
		restoredSocket?.close();
		socket?.close();
		if (browser?.exitCode === null && browser.signalCode === null) {
			const exited = once(browser, "exit");
			browser.kill("SIGTERM");
			await exited;
		}
		server.close();
		server.closeAllConnections();
		await rm(directory, { recursive: true, force: true });
	}
});

function debugCommands(socket) {
	let next = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const call = pending.get(message.id);
		if (!call) return;
		pending.delete(message.id);
		if (message.error) call.reject(new Error(message.error.message));
		else call.resolve(message.result);
	});
	return (method, params = {}) => {
		const id = ++next;
		const call = Promise.withResolvers();
		pending.set(id, call);
		socket.send(JSON.stringify({ id, method, params }));
		return call.promise;
	};
}

async function until(predicate) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(25);
	}
	assert.fail("Timed out waiting for browser state");
}
