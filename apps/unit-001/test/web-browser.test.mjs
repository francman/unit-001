// Exercises #65 in a real Chromium browser through its native debug protocol, without a test dependency.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;

test(
	"#65 live browser pairing, outcomes, focus, stable forget, responsive layout and sign-out",
	{ skip: !executable, timeout: 30000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "unit-web-browser-"));
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const port = reservation.address().port;
		await new Promise((resolve) => reservation.close(resolve));
		const origin = `http://127.0.0.1:${port}`;
		const owner = spawn(
			process.execPath,
			[
				"--conditions=source",
				fileURLToPath(new URL("fixtures/web-workspace.ts", import.meta.url)),
				join(directory, "owner"),
				String(port),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "",
			errors = "";
		owner.stdout.on("data", (chunk) => {
			output += chunk;
		});
		owner.stderr.on("data", (chunk) => {
			errors += chunk;
		});
		const browser = spawn(
			executable,
			[
				"--headless=new",
				"--no-first-run",
				"--no-default-browser-check",
				"--remote-debugging-port=0",
				`--user-data-dir=${directory}/browser`,
			],
			{ stdio: "ignore" },
		);
		let socket;
		const stop = async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		};
		try {
			await until(
				() => /One-time pairing code: ([A-Za-z0-9_-]+)/.test(output),
				() => errors,
			);
			const secret = /One-time pairing code: ([A-Za-z0-9_-]+)/.exec(output)[1];
			let debugPort;
			await until(async () => {
				try {
					debugPort = (await readFile(join(directory, "browser/DevToolsActivePort"), "utf8")).split("\n")[0];
					return true;
				} catch {
					return false;
				}
			});
			const target = await (
				await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })
			).json();
			socket = new WebSocket(target.webSocketDebuggerUrl);
			await once(socket, "open");
			let next = 0;
			const waiting = new Map();
			socket.addEventListener("message", (event) => {
				const value = JSON.parse(event.data);
				if (value.id) {
					const call = waiting.get(value.id);
					waiting.delete(value.id);
					if (value.error) call?.reject(new Error(value.error.message));
					else call?.resolve(value.result);
				}
			});
			const call = (method, params = {}) =>
				new Promise((resolve, reject) => {
					const id = ++next;
					waiting.set(id, { resolve, reject });
					socket.send(JSON.stringify({ id, method, params }));
				});
			const evaluate = async (expression) => {
				const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
				if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
				return result.result.value;
			};
			const has = (text) => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
			const click = (text) =>
				evaluate(
					`(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(text)});if(!button)throw Error('Missing button');button.click();})()`,
				);
			const fill = (selector, text) =>
				evaluate(
					`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
				);
			await call("Page.enable");
			await call("Emulation.setDeviceMetricsOverride", {
				width: 1440,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await call("Page.navigate", { url: origin });
			await until(() => has("Connect to your agent."));
			await fill('input[aria-label="Pairing code"]', "wrong");
			await click("Connect");
			await until(() => has("Pairing failed."));
			await fill('input[aria-label="Pairing code"]', secret);
			await click("Connect");
			await until(() => has("Your agent, in view."));
			await until(() => evaluate(`!document.querySelector('button.primary-button')?.disabled`));
			await fill("#composer", "Give a browser answer");
			await click("Send message");
			await until(() => has("Verified browser answer."));
			assert.equal(await evaluate(`document.querySelectorAll('.message-content img').length`), 0);
			assert.equal(await evaluate(`window.injected===undefined`), true);
			await click("Memory");
			await fill("#memory-query", "violet");
			await click("Search");
			await until(() => has("Violet browser acceptance memory"));
			await evaluate(
				`window.originalFetch=window.fetch;window.forgetCalls=[];window.fetch=async(...args)=>{const body=JSON.parse(args[1]?.body??'{}');if(body.operation?.request?.operation==='forget'){window.forgetCalls.push(body.requestId);if(window.forgetCalls.length===1)return Response.json({state:'unknown',requestId:body.requestId});}return window.originalFetch(...args);}`,
			);
			await click("Forget");
			await click("Forget memory");
			await until(() => has("Forget outcome not confirmed."));
			await click("Forget memory");
			await until(() => has("Memory forgotten. Conversation history was retained."));
			assert.equal(
				await evaluate(`window.forgetCalls.length===2&&window.forgetCalls[0]===window.forgetCalls[1]`),
				true,
			);
			await click("Workspace");
			await fill("#composer", "Wait until cancelled");
			await click("Send message");
			await until(() => has("Cancel current work"));
			await click("Memory");
			await fill("#memory-query", "focus survives owner cancellation");
			await evaluate(
				`document.querySelector('#memory-query').focus();document.querySelector('#memory-query').setSelectionRange(2,2)`,
			);
			await evaluate(
				`(async()=>{const session=await (await window.originalFetch('/api/v1/session')).json();await window.originalFetch('/api/v1/requests',{method:'POST',headers:{'Content-Type':'application/json','X-Unit-CSRF':session.csrfToken},body:JSON.stringify({requestId:crypto.randomUUID(),operation:{type:'cancel'}})});})()`,
			);
			await until(() => has("The owner could not complete this request."));
			assert.equal(
				await evaluate(`document.activeElement?.id==='memory-query'&&document.activeElement.selectionStart===2`),
				true,
			);
			await click("Workspace");
			assert.equal(await has("Delivery not confirmed"), false);
			await evaluate(
				`window.fetch=async(...args)=>args[0]==='/api/v1/requests'?new Response('{}',{status:400}):window.originalFetch(...args)`,
			);
			await fill("#composer", "Known rejection");
			await click("Send message");
			await until(() => has("The gateway rejected this request before dispatch."));
			assert.equal(await has("Delivery not confirmed"), false);
			await evaluate(`window.fetch=window.originalFetch`);
			const desktop = await call("Page.captureScreenshot", { format: "png" });
			await writeFile(join(directory, "desktop.png"), Buffer.from(desktop.data, "base64"));
			await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
			assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
			const mobile = await call("Page.captureScreenshot", { format: "png" });
			await writeFile(join(directory, "mobile.png"), Buffer.from(mobile.data, "base64"));
			await click("Sign out");
			await until(() => has("Signed out. Your agent keeps running."));
			assert.equal(await has("Verified browser answer."), false);
			console.log(`Browser acceptance screenshots: ${directory}`);
		} finally {
			socket?.close();
			await stop(browser);
			await stop(owner);
			// Keep screenshots when requested, without retaining the synthetic SQLite state.
			await rm(join(directory, "owner"), { recursive: true, force: true });
			await rm(join(directory, "browser"), { recursive: true, force: true });
			if (process.env.UNIT_001_KEEP_BROWSER_EVIDENCE !== "1") await rm(directory, { recursive: true, force: true });
		}
	},
);

async function until(predicate, failure = () => "Timed out waiting for browser state.") {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await setTimeout(25);
	}
	throw new Error(failure());
}
