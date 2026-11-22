// Drives the Memory page against deferred preview reads in a private Chromium profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;

test("Memory settles only current reads and keeps the pending Forget dialog locked", { skip: !executable, timeout: 20000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "unit-memory-preview-"));
	const profile = join(directory, "browser");
	const index = join(directory, "index.html");
	let browser, socket;
	try {
		await build({
			entryPoints: [fileURLToPath(new URL("fixtures/web-memory-preview.mjs", import.meta.url))],
			bundle: true,
			outfile: join(directory, "preview.js"),
		});
		await writeFile(index, '<!doctype html><meta charset="utf-8"><div id="app"></div><script src="preview.js"></script>');
		browser = spawn(executable, ["--headless=new", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
			stdio: "ignore",
		});
		await once(browser, "spawn");
		const debugPort = await until(async () => {
			try {
				return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				return false;
			}
		}, "Chromium debugger");
		const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
		socket = new WebSocket(target.webSocketDebuggerUrl);
		await once(socket, "open");
		const pending = new Map();
		let sequence = 0;
		socket.addEventListener("message", (event) => {
			const reply = JSON.parse(event.data);
			const call = pending.get(reply.id);
			if (!call) return;
			pending.delete(reply.id);
			if (reply.error) call.reject(new Error(reply.error.message));
			else call.resolve(reply.result);
		});
		const call = (method, params) => {
			const response = Promise.withResolvers();
			pending.set(++sequence, response);
			socket.send(JSON.stringify({ id: sequence, method, params }));
			return response.promise;
		};
		const page = async (expression) => {
			const result = await call("Runtime.evaluate", { expression, returnByValue: true });
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
			return result.result.value;
		};
		const click = (selector) => page(`document.querySelector(${JSON.stringify(selector)}).click()`);
		const button = (key) => `[data-key="${key}"]`;
		const has = (text) => page(`document.body.innerText.includes(${JSON.stringify(text)})`);
		const exists = (key) => page(`!!document.querySelector(${JSON.stringify(button(key))})`);
		const fill = (query) => page(`{
			const input = document.querySelector('#memory-query');
			input.value = ${JSON.stringify(query)};
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}`);
		const search = async (query) => {
			await fill(query);
			await click(button("memory-search"));
		};
		const settle = (kind, index, value) => page(`{
			const { requests, records, memory, details, graph } = window.memoryPreview;
			requests.${kind}[${index}].${value === undefined ? 'reject(new Error("Unavailable"))' : `resolve(${value})`};
		}`);
		await call("Page.navigate", { url: pathToFileURL(index).href });
		await until(() => page("!!window.memoryPreview"), "Memory preview");

		await search("old query");
		await search("weekly");
		assert.deepEqual(await page("memoryPreview.requests.recall.map(({ args }) => args[0])"), ["old query", "weekly"]);
		await fill("unfinished draft");
		await settle("recall", 1, "memory(2, records)");
		assert.equal(await exists("forget-first"), true, "a match renders before details arrive");
		assert.equal(await has("Results for “weekly”"), true, "results are labelled with the submitted query, not the input draft");
		assert.equal(await has("Nothing matched"), false);
		await settle("recall", 0);
		assert.equal(await has("Search failed."), false, "an older failure cannot replace successful matches");

		await click("#nav-memory");
		await click("#nav-memory");
		await settle("details", 2, "details(2)");
		await settle("details", 1);
		await settle("details", 0, "details(99)");
		assert.equal(await has("keeps 2 memories"), true, "the latest details supply the count");
		assert.equal(await has("keeps 99 memories"), false);
		assert.equal(await exists("forget-first"), true, "details cannot overwrite the matches");

		await search("previous successful query");
		await search("latest failed query");
		await settle("recall", 3);
		await settle("recall", 2, "memory(2, records)");
		assert.equal(await has("Search failed."), true, "an earlier success cannot replace the current failure");
		await search("weekly");
		await settle("recall", 4, "memory(2, records)");
		await settle("graph", 2, "graph(records)");
		await click(button("graph-mode-list"));
		assert.equal(await exists("list-open-first"), true);
		await click("#nav-memory"); // Start a read newer than the graph on screen, but older than Forget.

		await click(button("forget-first"));
		await click(button("dialog-forget"));
		assert.equal(await page(`document.querySelector('${button("dialog-keep")}').disabled`), true);
		assert.equal(await page("document.querySelector('dialog').open"), true);
		await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		assert.equal(await page("document.querySelector('dialog').open"), true, "Escape cannot dismiss pending Forget");
		await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 });
		await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 });
		assert.equal(await page("document.querySelector('dialog').open"), true, "the backdrop cannot dismiss pending Forget");
		await click(button("forget-second")); // Model an opener callback already queued before the dialog became modal.
		assert.equal(await page("document.querySelector('dialog blockquote')?.textContent"), "First weekly digest memory");
		await click(button("dialog-forget"));
		assert.deepEqual(await page("memoryPreview.requests.forget.map(({ args }) => args[0])"), ["first"]);

		await settle("forget", 0, '{ state: "completed" }');
		assert.equal(await page("document.querySelector('dialog').open"), false);
		assert.equal(await page("document.activeElement.id"), "memory-query");
		assert.equal(await exists("forget-first"), false);
		assert.equal(await exists("forget-second"), true, "Forget preserves remaining search matches");
		assert.equal(await exists("list-open-first"), false);
		await settle("graph", 3, "graph(records)");
		await settle("graph", 1);
		assert.equal(await exists("list-open-first"), false, "a pre-Forget graph cannot restore the removed node");
		assert.equal(await exists("list-open-second"), true);
		assert.equal(await has("The memory map could not be refreshed."), false, "an old graph failure cannot set a notice");
		await settle("details", 3, "details(2)");
		assert.equal(await has("keeps 1 memory"), true, "pre-Forget details cannot restore the old count");

		// Start a search, then Forget from the graph while its read is still pending.
		await search("weekly");
		await click(button("list-open-second"));
		await click(button("graph-forget-second"));
		await click(button("dialog-forget"));
		await settle("forget", 1, '{ state: "unknown", message: "" }');
		assert.equal(await has("Forget outcome not confirmed."), true);
		await click(button("dialog-forget"));
		assert.equal(
			await page("memoryPreview.requests.forget[1].args[1] === memoryPreview.requests.forget[2].args[1]"),
			true,
			"explicit retry in the same confirmation reuses the request ID",
		);
		await settle("forget", 2, '{ state: "completed" }');
		await settle("recall", 5, "memory(1, [records[1]])");
		assert.equal(await exists("forget-second"), false, "a pre-Forget search cannot restore a forgotten match");
		assert.equal(await page("memoryPreview.requests.recall[6].args[0]"), "weekly", "the pending query is reread after successful Forget");
		await settle("recall", 6, "memory(0)");
		assert.equal(await has("Nothing matched"), true);
	} finally {
		socket?.close();
		if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
			const exited = once(browser, "exit");
			browser.kill();
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

async function until(read, label) {
	for (let attempt = 0; attempt < 120; attempt++) {
		const value = await read();
		if (value) return value;
		await delay(25);
	}
	assert.fail(`Timed out waiting for ${label}`);
}
