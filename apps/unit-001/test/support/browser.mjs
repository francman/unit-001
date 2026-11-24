// Shares the headless Chromium harness of the real-browser web tests: launch with a private profile, open a tab over the DevTools protocol, poll and stop.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The Chromium binary the real-browser tests use; they skip when it is not set (docs/web-ui.md). */
export const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;

/** Starts headless Chromium with a private profile and waits for its debugging port; `flags` are added to the defaults. */
export async function launchChrome(profile, flags = []) {
	const browser = spawn(
		executable,
		["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, ...flags],
		{ stdio: "ignore" },
	);
	let debugPort;
	try {
		await until(async () => {
			try {
				const [port, endpoint] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
				if (!/^[1-9]\d{0,4}$/.test(port ?? "") || Number(port) > 65_535 || !endpoint?.startsWith("/devtools/browser/")) return false;
				debugPort = port;
				return true;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				return false;
			}
		}, "Chromium debugger");
	} catch (error) {
		// The caller never receives the process, so it would otherwise outlive the failed test.
		await stopProcess(browser);
		throw error;
	}
	return { browser, debugPort };
}

/** Opens a blank tab and returns its socket and a `call(method, params)` that resolves a DevTools command's result. */
export async function openTab(debugPort) {
	const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await once(socket, "open");
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
	const call = (method, params = {}) => {
		const id = ++next;
		const response = Promise.withResolvers();
		pending.set(id, response);
		socket.send(JSON.stringify({ id, method, params }));
		return response.promise;
	};
	return { socket, call };
}

/** Polls until `read` returns a truthy value and returns it; fails with `failure` (text or a function giving it) after `timeoutMs`. */
export async function until(read, failure = "browser state", timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await delay(25);
	}
	throw new Error(typeof failure === "function" ? failure() : `Timed out waiting for ${failure}`);
}

/** Stops a spawned process and waits for it to exit; a process that is absent or already gone is ignored. */
export async function stopProcess(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
}
