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
import { assertFreshWebAssets } from "../scripts/build-web-freshness.mjs";

const executable = process.env.UNIT_001_BROWSER_EXECUTABLE;
const fixtureAssets = process.env.UNIT_001_TEST_WEB_ASSETS;

test(
	"#65 code-free browser startup, retained history, outcomes, focus, stable forget, responsive layout and workspace continuity",
	{ skip: !executable, timeout: 90000 },
	async () => {
		await assertFreshWebAssets(fixtureAssets);
		const directory = await mkdtemp(join(tmpdir(), "unit-web-browser-"));
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const port = reservation.address().port;
		await new Promise((resolve) => reservation.close(resolve));
		const origin = `http://127.0.0.1:${port}`;
		let output = "",
			errors = "";
		function startOwner(folder, label = "") {
			const child = spawn(
				process.execPath,
				[
					"--conditions=source",
					fileURLToPath(new URL("fixtures/web-workspace.ts", import.meta.url)),
					join(directory, folder),
					String(port),
					fixtureAssets ?? "",
					label,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			child.stdout.on("data", (chunk) => { output += chunk; });
			child.stderr.on("data", (chunk) => { errors += chunk; });
			return child;
		}
		const owner = startOwner("owner");
		let replacement;
		const browser = spawn(
			executable,
			[
				"--headless=new",
				"--no-first-run",
				"--no-default-browser-check",
				// Classic scrollbars, as on Windows, Linux and macOS with always-visible scrollbars: the alignment
				// checks below must hold with a scrollbar taking width from the thread.
				"--disable-features=OverlayScrollbar",
				"--remote-debugging-port=0",
				`--user-data-dir=${directory}/browser`,
			],
			{ stdio: "ignore" },
		);
		let socket;
		const stop = async (child) => {
			if (!child || child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		};
		try {
			await until(
				() => output.includes(`Browser workspace: ${origin}`),
				() => errors,
			);
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
			// Only visible buttons: the closed phone menu keeps its nav buttons in the DOM, hidden.
			const click = (text) =>
				evaluate(
					`(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.offsetParent!==null&&el.textContent===${JSON.stringify(text)});if(!button)throw Error('Missing button');button.click();})()`,
				);
			const measure = () =>
				evaluate(`(()=>{
					const rect=(el)=>{if(!el)return null;const {left,right,top,bottom,width,height}=el.getBoundingClientRect();return {left,right,top,bottom,width,height};};
					const visible=(el)=>el!==null&&el.offsetParent!==null;
					const composer=document.querySelector('#composer');
					const purpose=document.querySelector('[data-key="purpose"]');
					const thread=document.querySelector('#thread');
					return {
						thread:{gutter:thread.offsetWidth-thread.clientWidth,overflowing:thread.scrollHeight>thread.clientHeight},
						innerWidth,
						innerHeight,
						scrollWidth:document.documentElement.scrollWidth,
						composer:rect(composer),
						composerScroll:{scrollHeight:composer.scrollHeight,clientHeight:composer.clientHeight},
						card:rect(composer.parentElement),
						form:rect(composer.closest('form')),
						column:rect(document.querySelector('#thread [data-column]')),
						purpose:visible(purpose)?rect(purpose):null,
						rail:visible(document.querySelector('[aria-label="Activity"]')),
					};
				})()`);
			const fill = (selector, text) =>
				evaluate(
					`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
				);
			await call("Page.enable");
			// Record CSP violations from before the first script runs; the page must raise none.
			await call("Page.addScriptToEvaluateOnNewDocument", {
				// Capture real gateway snapshots and replay variants through the same fetched byte stream.
				source: String.raw`
					window.cspViolations = [];
					window.historyReads = [];
					window.sentByBrowser = [];
					window.postsByBrowser = 0;
					document.addEventListener("securitypolicyviolation", (event) =>
						window.cspViolations.push(event.violatedDirective + " " + event.blockedURI));
					const nativeFetch = window.fetch.bind(window);
					window.fetch = async (path, init) => {
						const operation = path === "/api/v1/requests" && typeof init?.body === "string" ? JSON.parse(init.body).operation : null;
						if (operation) window.postsByBrowser++;
						if (operation?.type === "send") window.sentByBrowser.push(operation.prompt);
						const response = await nativeFetch(path, init);
						if (operation?.type === "chat-history")
							window.historyReads.push({ before: operation.before, status: response.status, result: await response.clone().json() });
						if (path !== "/api/v1/events" || !response.ok || !response.body) return response;
						const encoder = new TextEncoder();
						const decoder = new TextDecoder();
						const prefix = "event: view\ndata: ";
						let pending = "";
						const stream = response.body.pipeThrough(new TransformStream({
							start(controller) {
								window.emitSse = (event, value) =>
									controller.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(value) + "\n\n"));
							},
							transform(chunk, controller) {
								pending += decoder.decode(chunk, { stream: true });
								for (let end; (end = pending.indexOf("\n\n")) !== -1; ) {
									const frame = pending.slice(0, end);
									if (frame.startsWith(prefix)) window.lastView = JSON.parse(frame.slice(prefix.length));
									pending = pending.slice(end + 2);
								}
								controller.enqueue(chunk);
							},
						}));
						return new Response(stream, { status: response.status, headers: response.headers });
					};
				`,
			});
			await call("Emulation.setDeviceMetricsOverride", {
				width: 1440,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await call("Page.navigate", { url: origin.replace("127.0.0.1", "localhost") });
			await until(() => has("Origin is not permitted."));
			assert.equal(await has(origin), true);
			await call("Page.navigate", { url: origin });
			await until(() => evaluate(`document.querySelector('#composer')!==null`));
			await evaluate(`window.beforeHistoryReload = true`);
			await call("Page.reload");
			await until(() => evaluate(`!window.beforeHistoryReload && window.lastView?.historyTruncated && document.querySelector('#composer') !== null`));
			assert.equal(await evaluate(`document.querySelector('input[type="password"], [data-key="signout"]')`), null);
			assert.deepEqual(await evaluate(`[localStorage.length, sessionStorage.length]`), [0, 0], "a clean profile stores no gateway credentials");
			const sentinel = "Retained browser message 1: oldest SQLite sentinel";
			const transcript = () =>
				evaluate(`[...document.querySelectorAll('#thread article')].flatMap(row => [...row.innerText.matchAll(/Retained browser message (\\d+)/g)].map(match => Number(match[1])))`);
			const range = (first, count) => Array.from({ length: count }, (_, index) => first + index);
			const recent = await transcript();
			assert.ok(recent.length > 0 && recent.length <= 20, "the reload shows a bounded live window");
			assert.deepEqual(recent, range(29 - recent.length, recent.length), "the live window ends with the newest row");
			assert.equal(await has(sentinel), false);
			assert.deepEqual(await evaluate(`window.historyReads`), [], "no retained page was requested before activation");
			const earlier = `document.querySelector('[data-key="load-earlier"]')`;
			let cursor = await evaluate(`window.lastView.entries[0].id`);
			let total = recent.length;
			let sawEmptyContinuation = false;
			let sawFullPage = false;
			for (let pageIndex = 0; cursor !== null && pageIndex < 8; pageIndex++) {
				await until(() => evaluate(`${earlier}?.offsetParent != null && ${earlier}.getAttribute('aria-disabled') === 'false'`));
				await evaluate(`{ const button = ${earlier}; button.focus(); button.click(); }`);
				await until(() => evaluate(`window.historyReads.length === ${pageIndex + 1}`), () => `No POST result for history page ${pageIndex + 1}`);
				const { before, status, result } = await evaluate(`window.historyReads[${pageIndex}]`);
				assert.equal(before, cursor, "the next request uses the returned exclusive cursor");
				assert.equal(status, 200);
				assert.equal(result.state, "completed");
				assert.equal(result.response.type, "chat-history");
				const { entries, nextBefore } = result.response.page;
				assert.ok(entries.length <= 5, "each read returns at most five display rows");
				assert.ok(entries.every((row, index) => row.id < before && (index === 0 || entries[index - 1].id < row.id)), "page IDs are ascending below the request bound");
				if (nextBefore !== null) {
					assert.ok(Number.isSafeInteger(nextBefore) && nextBefore > 0 && nextBefore < before, "the cursor advances");
					if (entries.length === 0) sawEmptyContinuation = true;
				}
				if (entries.length === 5) sawFullPage = true;
				cursor = nextBefore;
				total += entries.length;
				await until(async () => (await transcript()).length === total);
				assert.deepEqual(await transcript(), range(29 - total, total), "each page prepends in order, without duplicate rows");
			}
			assert.equal(cursor, null, "the final page declares exhaustion");
			assert.equal(sawEmptyContinuation, true, "a hidden raw page advances without adding visible rows");
			assert.equal(sawFullPage, true, "the earlier transcript takes multiple bounded pages");
			assert.deepEqual(await transcript(), range(1, 28), "the complete retained transcript is ordered and deduplicated");
			await until(() => evaluate(`${earlier}?.offsetParent === null`));
			assert.equal(await evaluate(`document.activeElement.id`), "thread", "exhaustion returns focus to the thread");
			assert.equal(await has(sentinel), true);
			await fill("#composer", "Give a browser answer");
			await click("Send message");
			await until(() => has("Verified browser answer."));
			assert.equal(await evaluate(`document.querySelectorAll('#thread img').length`), 0);
			assert.equal(await evaluate(`window.injected===undefined`), true);
			// Counts what the map subscribes to outside its own frame (theme observer, media listeners) and the animation frames it asks for.
			await evaluate(`(()=>{
				const observers=new Set(),listeners=new Set();
				window.subs={observers:()=>observers.size,media:()=>listeners.size,frames:0};
				const observe=MutationObserver.prototype.observe,disconnect=MutationObserver.prototype.disconnect;
				MutationObserver.prototype.observe=function(target,options){if(target===document.documentElement&&options?.attributeFilter?.includes('data-theme'))observers.add(this);return observe.call(this,target,options)};
				MutationObserver.prototype.disconnect=function(){observers.delete(this);return disconnect.call(this)};
				const add=MediaQueryList.prototype.addEventListener,remove=MediaQueryList.prototype.removeEventListener;
				MediaQueryList.prototype.addEventListener=function(type,listener,options){if(type==='change')listeners.add(listener);return add.call(this,type,listener,options)};
				MediaQueryList.prototype.removeEventListener=function(type,listener,options){if(type==='change')listeners.delete(listener);return remove.call(this,type,listener,options)};
				const raf=window.requestAnimationFrame.bind(window);
				window.requestAnimationFrame=(callback)=>{window.subs.frames++;return raf(callback)};
			})()`);
			const subscriptions = () => evaluate(`({observers:window.subs.observers(),media:window.subs.media()})`);
			const beforeMap = await subscriptions();
			await click("Memory");
			// The memory map is a canvas: both seeded memories are nodes, a real click opens the details, Focus shows fewer
			// memories, the keyboard reaches them too, and Forget from the details works.
			const mapLabel = () => evaluate(`document.querySelector('[data-graph] canvas')?.getAttribute('aria-label')??''`);
			await until(async () => (await mapLabel()).startsWith("Map of 2 memories"));
			assert.equal(await evaluate(`document.querySelector('[data-graph]').getAttribute('aria-label').startsWith('Memory graph: 2 memories')`), true);
			// Swiping on the canvas scrolls the Memory page before opting into graph gestures.
			await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 600, deviceScaleFactor: 1, mobile: true });
			await call("Emulation.setTouchEmulationEnabled", { enabled: true });
			const memoryScroll = () => evaluate(`document.querySelector('[data-scroll="memory"]').scrollTop`);
			const swipe = await evaluate(`(()=>{
				const frame = document.querySelector('[data-graph]').getBoundingClientRect();
				const x = Math.round(frame.left + frame.width / 2), y = Math.round(Math.min(frame.top + 120, innerHeight - 24));
				return { x, y, onGraph: Boolean(document.elementFromPoint(x, y)?.closest('[data-graph]')) };
			})()`);
			assert.equal(swipe.onGraph, true, "the default swipe starts over the visible canvas");
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-gestures]').getAttribute('aria-pressed')`), "false");
			const scrollBefore = await memoryScroll();
			await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: swipe.x, y: swipe.y }] });
			for (let step = 1; step <= 5; step++) {
				await call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: swipe.x, y: swipe.y - step * 20 }] });
			}
			await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await until(async () => (await memoryScroll()) > scrollBefore, () => "the default graph swipe did not scroll the Memory page");
			await call("Emulation.setTouchEmulationEnabled", { enabled: false });
			await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
			await evaluate(`document.querySelector('[data-scroll="memory"]').scrollTo(0, 0)`);
			// The map forms first (two memories only appear: too few for a brain); everything below starts once that is over.
			const formed = () => evaluate(`document.querySelector('[data-graph]')?.dataset.formed==='true'`);
			const shaped = () => evaluate(`document.querySelector('[data-graph]')?.dataset.shaped`);
			await until(formed);
			assert.equal(await shaped(), "false", "two memories do not form a brain");
			// The frame itself and everything in it: no style attribute, which the page's CSP would block.
			const styled = () => evaluate(`document.querySelectorAll('[data-graph][style], [data-graph] [style]').length`);
			assert.equal(await styled(), 0, "the graph and its frame set no style attributes");
			assert.equal(await evaluate(`window.cspViolations.length`), 0, "the canvas map raises no CSP violation");
			// While the map is in the page it watches the theme and the media queries; the other pages must not carry them (codex review).
			await until(async () => (await subscriptions()).observers === beforeMap.observers + 1);
			const onMap = await subscriptions();
			assert.equal(onMap.media >= beforeMap.media + 3, true, `the map listens to the color scheme, reduced motion and pixel ratio: ${JSON.stringify([beforeMap, onMap])}`);
			await click("Chat");
			await until(async () => {
				const away = await subscriptions();
				return away.observers === beforeMap.observers && away.media === beforeMap.media;
			});
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 2 memories"));
			await until(async () => (await subscriptions()).observers === beforeMap.observers + 1);
			// Coming back to the page does not play the animation again: the map is formed at once and stays formed
			// (the animation sets this to false while it runs, for at least 680 ms).
			for (let sample = 0; sample < 30; sample++) {
				assert.equal(await formed(), true, "the map is formed again as soon as the page is, and does not replay its animation");
				await setTimeout(25);
			}
			// Nodes are solid blobs on the canvas; thin lines pass no thickness test and the few pixels of label text are too small to count. Returns page coordinates.
			const nodePoints = () =>
				evaluate(`(()=>{const c=document.querySelector('[data-graph] canvas');const box=c.getBoundingClientRect();const w=c.width,h=c.height;
					const back=getComputedStyle(document.querySelector('[data-graph] .text-canvas')).color.match(/[\\d.]+/g).map(Number);
					const d=c.getContext('2d').getImageData(0,0,w,h).data;
					const solid=(x,y)=>{if(x<0||y<0||x>=w||y>=h)return false;const i=(y*w+x)*4;return d[i+3]>=120&&Math.abs(d[i]-back[0])+Math.abs(d[i+1]-back[1])+Math.abs(d[i+2]-back[2])>60};
					const core=new Uint8Array(w*h);
					for(let y=3;y<h-3;y++)for(let x=3;x<w-3;x++)if(solid(x,y)&&solid(x+3,y)&&solid(x-3,y)&&solid(x,y+3)&&solid(x,y-3))core[y*w+x]=1;
					const seen=new Uint8Array(w*h);const points=[];
					for(let i=0;i<w*h;i++){if(!core[i]||seen[i])continue;let n=0,cx=0,cy=0;const stack=[i];seen[i]=1;while(stack.length){const j=stack.pop();const jx=j%w,jy=(j-jx)/w;n++;cx+=jx;cy+=jy;for(const k of [j+1,j-1,j+w,j-w]){if(k<0||k>=w*h||seen[k]||!core[k])continue;seen[k]=1;stack.push(k)}}
					if(n>=8)points.push({x:box.x+(cx/n)*box.width/w,y:box.y+(cy/n)*box.height/h})}
					return points})()`);
			const mouse = (type, x, y) => call("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
			const clickAt = async ({ x, y }) => {
				await mouse("mouseMoved", x, y);
				await mouse("mousePressed", x, y);
				await mouse("mouseReleased", x, y);
			};
			// The layout animates for a couple of seconds; wait until the nodes stop moving before aiming at them. Fresh points after every fit or move.
			const settledPoints = async (count) => {
				// A pointer resting on a node dims the others; park it outside the map.
				await mouse("mouseMoved", 2, 2);
				// Drawing is done once no frame is asked for (a theme change or a remount repaints first).
				await until(async () => (await framesWhileIdle()) <= 1, () => "the map keeps asking for frames");
				let found = await nodePoints();
				for (let attempt = 0; attempt < 40; attempt++) {
					await setTimeout(250);
					const again = await nodePoints();
					const still = again.length === found.length && again.every((point, index) => Math.hypot(point.x - found[index].x, point.y - found[index].y) < 0.5);
					found = again;
					if (still) break;
				}
				assert.equal(found.length, count, `${count} nodes are drawn on the canvas, found ${JSON.stringify(found)}`);
				return found;
			};
			const press = (key, code, windowsVirtualKeyCode, text) => (async () => {
				for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) });
			})();
			const enter = () => press("Enter", "Enter", 13, "\r");
			const previewText = () => evaluate(`document.querySelector('[data-graph] .pointer-events-none')?.textContent??''`);
			const liveText = () => evaluate(`document.querySelector('[data-graph] [role=status]')?.textContent??''`);
			// Which control has focus: its key or id, "frame" for the map, else the tag name.
			const activeName = () => evaluate(`(()=>{const a=document.activeElement;return a?.dataset?.key||a?.id||(a?.hasAttribute('data-graph')?'frame':a?.tagName)})()`);
			const focusKey = (key) => evaluate(`document.querySelector('[data-key=${JSON.stringify(key)}]').focus()`);
			const detailsHidden = () => evaluate(`document.querySelector('#graph-details')?.hidden===true`);
			// Memories by their text, as the hover line shows it; moves the pointer off the nodes afterwards.
			const memoryAt = async (point) => {
				await mouse("mouseMoved", point.x, point.y);
				await until(async () => (await previewText()) !== "");
				const shown = await previewText();
				await mouse("mouseMoved", 2, 2);
				await until(async () => (await previewText()) === "");
				return shown;
			};
			const drag = async (from, steps) => {
				await mouse("mouseMoved", from.x, from.y);
				await until(async () => (await previewText()) !== "", () => "the pressed point does not reach a painted memory");
				await evaluate(`{
					window.dragCaptured = false;
					document.querySelector('[data-graph]').addEventListener('gotpointercapture', () => { window.dragCaptured = true; }, { once: true });
				}`);
				await mouse("mousePressed", from.x, from.y);
				for (let step = 1; step <= steps; step++)
					await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + step * 12, y: from.y + step * 8, button: "left", buttons: 1 });
				assert.equal(await evaluate(`window.dragCaptured`), true, "the graph owns the active pointer during the drag");
			};
			// Animation frames the map asks for in a quiet half second: none once everything has settled.
			const framesWhileIdle = async () => {
				const before = await evaluate(`window.subs.frames`);
				await setTimeout(500);
				return (await evaluate(`window.subs.frames`)) - before;
			};
			let points = await settledPoints(2);
			// Hover shows the memory's line and lights it.
			await mouse("mouseMoved", points[0].x, points[0].y);
			await until(() => evaluate(`(document.querySelector('[data-graph] .pointer-events-none')?.textContent??'').includes('graph acceptance memory')||(document.querySelector('[data-graph] .pointer-events-none')?.textContent??'').includes('browser acceptance memory')`));
			await mouse("mouseMoved", 2, 2);
			await until(async () => (await previewText()) === "");
			// A pixel-ratio change with the same CSS box (a window moved to another screen) redraws at the new resolution while idle (codex review).
			// The frame is 448 px tall for any viewport up to about 690 px, so a 620 to 600 px viewport change leaves its CSS box alone, and the
			// browser reports a pixel-ratio change through its media queries only together with some viewport update.
			await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 620, deviceScaleFactor: 1, mobile: false });
			await until(() => evaluate(`document.querySelector('[data-graph]').clientHeight===448`));
			points = await settledPoints(2);
			const names = [await memoryAt(points[0]), await memoryAt(points[1])];
			assert.notEqual(names[0], names[1], "the two nodes are two different memories");
			await until(async () => (await framesWhileIdle()) <= 1, () => "no frames are requested while the map rests");
			const boxBefore = await evaluate(`(()=>{const box=document.querySelector('[data-graph]').getBoundingClientRect();return [box.width,box.height]})()`);
			await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 600, deviceScaleFactor: 2, mobile: false });
			await until(() => evaluate(`(()=>{const c=document.querySelector('[data-graph] canvas');return c.width===Math.round(c.clientWidth*2)&&c.height===Math.round(c.clientHeight*2)})()`));
			assert.deepEqual(await evaluate(`(()=>{const box=document.querySelector('[data-graph]').getBoundingClientRect();return [box.width,box.height]})()`), boxBefore, "only the pixel ratio changed, not the frame's CSS box");
			const sharp = await nodePoints();
			assert.equal(sharp.length, 2, "both nodes are drawn after the pixel ratio changed");
			for (const point of sharp) assert.equal(points.some((old) => Math.hypot(old.x - point.x, old.y - point.y) < 1.5), true, "drawing and pointer agree at the new pixel ratio");
			assert.equal(await memoryAt(points[0]), names[0], "a pointer position from before the change still reaches the same node");
			await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
			await until(() => evaluate(`(()=>{const c=document.querySelector('[data-graph] canvas');return c.width===c.clientWidth&&c.height===c.clientHeight&&c.clientHeight>600})()`));
			points = await settledPoints(2);
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-gestures]').getAttribute('aria-pressed')`), "false");
			await click("Graph gestures");
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-gestures]').getAttribute('aria-pressed')`), "true");
			// A redraw of the page during a drag (the shell redraws on state changes, here a theme change) moves the frame and drops the pointer capture.
			// The drag must end there: frames stop, and the next gesture works (codex review, high).
			await drag(points[0], 4);
			await evaluate(`document.querySelector('[data-key=theme]').click()`);
			await setTimeout(2800);
			await until(async () => (await framesWhileIdle()) <= 1, () => "frames stop although the button is still held after the page was redrawn");
			await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: points[0].x + 48, y: points[0].y + 32, button: "left", buttons: 0, clickCount: 1 });
			await mouse("mouseMoved", 2, 2);
			for (let again = 0; again < 2; again++) await evaluate(`document.querySelector('[data-key=theme]').click()`);
			points = await settledPoints(2);
			await clickAt(points[0]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.hidden===false`));
			await until(async () => (await framesWhileIdle()) <= 1, () => "the map is at rest after the second gesture");
			await evaluate(`document.querySelector('[data-graph]').focus()`);
			await press("Escape", "Escape", 27);
			await until(detailsHidden);
			// Leaving the page during a drag ends it too, and the map comes back usable.
			points = await settledPoints(2);
			await drag(points[1], 4);
			await click("Chat");
			await setTimeout(300);
			await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: points[1].x + 48, y: points[1].y + 32, button: "left", buttons: 0, clickCount: 1 });
			await mouse("mouseMoved", 2, 2);
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 2 memories"));
			points = await settledPoints(2);
			await until(async () => (await framesWhileIdle()) <= 1, () => "no frames are requested after returning to the map");
			await clickAt(points[1]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.hidden===false`));
			await evaluate(`document.querySelector('[data-graph]').focus()`);
			await press("Escape", "Escape", 27);
			await until(detailsHidden);
			// Reclosing Details recenters the view. Identify Amber on the new paint before clicking its node.
			points = await settledPoints(2);
			const hoveredNames = [await memoryAt(points[0]), await memoryAt(points[1])];
			const amber = hoveredNames.findIndex((name) => name.includes("Amber graph acceptance memory"));
			assert.notEqual(amber, -1, `Amber is reachable on the recentered graph: ${JSON.stringify(hoveredNames)}`);
			await clickAt(points[amber]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.innerText.includes('Amber graph acceptance memory')`));
			// One mind: the conversation is only a fact in the details, never a control.
			assert.equal(await evaluate(`document.querySelector('#graph-details')?.innerText.includes('Conversation 1')`), true);
			assert.equal(await has("Highlight conversation"), false);
			// The selection is announced in the map's polite live region.
			await until(() => evaluate(`document.querySelector('[data-graph] [role=status]')?.textContent.includes('Details are open')`));
			// Focus shows the memory with what is near it: fewer memories than the whole map, then all again. Real keys, and keyboard focus
			// stays on the equivalent control after each rebuild of the bar and the panel (codex review).
			await focusKey("graph-focus");
			await enter();
			await until(async () => (await mapLabel()).startsWith("Map of 1 memory"));
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-focus-off]')!==null`), true);
			assert.equal(await activeName(), "graph-focus", "Focus keeps keyboard focus on its button");
			await focusKey("graph-depth-2");
			await enter();
			await until(() => evaluate(`document.querySelector('[data-key=graph-depth-2]')?.getAttribute('aria-pressed')==='true'`));
			assert.equal(await activeName(), "graph-depth-2", "a depth button keeps keyboard focus");
			await focusKey("graph-focus-off");
			await enter();
			await until(async () => (await mapLabel()).startsWith("Map of 2 memories"));
			assert.equal(await activeName(), "graph-details", "Clear focus moves keyboard focus to the still-open details");
			await focusKey("graph-close");
			await enter();
			await until(detailsHidden);
			assert.equal(await activeName(), "frame", "closing the details returns keyboard focus to the map");
			// Keyboard: Enter on the map starts moving between memories, an arrow key moves to the other memory, Enter opens it.
			// Which memory is which comes from the hover line; the direction from where the two nodes are now.
			const memories = ["Amber graph acceptance memory", "Violet browser acceptance memory"];
			const whose = (text) => memories.findIndex((memory) => text.includes(memory));
			points = await settledPoints(2);
			const shown = [await memoryAt(points[0]), await memoryAt(points[1])];
			assert.deepEqual(shown.map(whose).sort(), [0, 1], `the nodes are the two seeded memories: ${JSON.stringify(shown)}`);
			const pointOf = (memory) => points[shown.findIndex((text) => whose(text) === memory)];
			await evaluate(`document.querySelector('[data-graph]').focus()`);
			await enter();
			await until(async () => /related/.test(await liveText()));
			const first = await liveText();
			const start = whose(first);
			assert.notEqual(start, -1, `the keyboard started on a seeded memory: ${first}`);
			const from = pointOf(start);
			const to = pointOf(1 - start);
			const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
			const arrow = horizontal ? (to.x > from.x ? ["ArrowRight", 39] : ["ArrowLeft", 37]) : to.y > from.y ? ["ArrowDown", 40] : ["ArrowUp", 38];
			await press(arrow[0], arrow[0], arrow[1]);
			await until(async () => whose(await liveText()) === 1 - start);
			const second = await liveText();
			assert.notEqual(second, first, "the arrow key moved the keyboard to the other memory");
			await enter();
			await until(() => evaluate(`document.querySelector('#graph-details')?.innerText.includes(${JSON.stringify(memories[1 - start])})`));
			await until(async () => /Details are open/.test(await liveText()) && whose(await liveText()) === 1 - start);
			assert.equal(await evaluate(`window.cspViolations.length`), 0, "no CSP violation after the keyboard flow");
			// List shares Focus with Graph, but not its canvas gesture controls. Tab reaches rows and the details return focus to their opener.
			await click("List");
			await until(() => evaluate(`document.querySelector('[data-key^="list-open-"]')!==null`));
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-gestures]').offsetParent`), null, "List hides canvas-only gestures");
			await focusKey("graph-focus");
			await enter();
			const listCount = () => evaluate(`document.querySelectorAll('[data-key^="list-open-"]').length`);
			await until(async () => (await listCount()) === 1);
			await focusKey("graph-focus-off");
			await enter();
			await until(async () => (await listCount()) === 2);
			await focusKey("graph-mode-list");
			for (let tabs = 0; tabs < 60 && !(await activeName()).startsWith("list-open-"); tabs++) await press("Tab", "Tab", 9);
			assert.equal((await activeName()).startsWith("list-open-"), true, `Tab reaches a List row, focus is on ${await activeName()}`);
			const rowLabel = await evaluate(`document.activeElement.getAttribute('aria-label')`);
			await enter();
			await until(() => evaluate(`document.activeElement?.id==='graph-details'`));
			const opened = memories.findIndex((memory) => rowLabel.includes(memory.slice(0, 20)));
			assert.equal(await evaluate(`document.querySelector('#graph-details').innerText.includes(${JSON.stringify(memories[opened])})`), true, "the row's memory is the one in the details");
			await press("Tab", "Tab", 9);
			assert.equal(await evaluate(`document.activeElement.closest('#graph-details')!==null`), true, "Tab continues inside the opened details");
			await focusKey("graph-close");
			await enter();
			await until(detailsHidden);
			assert.equal(await evaluate(`document.activeElement.dataset.key?.startsWith('list-open-')&&document.activeElement.getAttribute('aria-label')===${JSON.stringify(rowLabel)}`), true, "closing the details returns focus to the row it came from");
			await click("Graph");
			await until(() => evaluate(`document.querySelector('[data-graph]')!==null`));
			await until(async () => (await mapLabel()).startsWith("Map of 2 memories"));
			// Forget while Focus is active: the focus view, its depth controls and the open details all close, the live region clears and the other memory is still reachable (codex review).
			points = await settledPoints(2);
			const nowShown = [await memoryAt(points[0]), await memoryAt(points[1])];
			await clickAt(points[nowShown.findIndex((text) => whose(text) === 0)]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.innerText.includes('Amber graph acceptance memory')`));
			assert.equal(await styled(), 0, "the graph still sets no style attributes");
			await focusKey("graph-focus");
			await enter();
			await until(async () => (await mapLabel()).startsWith("Map of 1 memory"));
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-depth-1]')!==null`), true, "the depth controls show while Focus is active");
			await click("Forget");
			await click("Forget memory");
			await until(() => evaluate(`document.querySelector('[data-key=graph-focus-off]')===null`));
			assert.equal(await evaluate(`document.querySelector('[data-key=graph-depth-1]')===null&&document.querySelector('[data-key=graph-depth-2]')===null`), true, "the depth controls close with the focus view");
			await until(detailsHidden);
			assert.equal(await liveText(), "", "the live region is cleared for a memory that is gone");
			assert.equal(await has("Amber graph acceptance memory"), false);
			const survivors = await settledPoints(1);
			// The map stopped reserving room for the closed panel: the one memory sits in the middle of the frame, not 152 px to the left of it.
			const middle = await evaluate(`(()=>{const box=document.querySelector('[data-graph]').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()`);
			assert.equal(Math.hypot(survivors[0].x - middle.x, survivors[0].y - middle.y) < 25, true, `the memory is centered in the frame, found ${JSON.stringify([survivors[0], middle])}`);
			await clickAt(survivors[0]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.innerText.includes('Violet browser acceptance memory')`));
			await evaluate(`document.querySelector('[data-graph]').focus()`);
			await press("Escape", "Escape", 27);
			await until(detailsHidden);
			assert.equal(await mapLabel(), "Map of 1 memory and 0 relations");
			// A memory whose text is literal markup is shown as text in the map's hover line, the details and the List, never parsed.
			await evaluate(`(()=>{window.nativeFetch=window.fetch;window.graphExtra=true;window.fetch=async(...args)=>{const response=await window.nativeFetch(...args);let operation=null;try{operation=JSON.parse(args[1]?.body??'{}').operation??null}catch{}if(!window.graphExtra||operation?.type!=='memory'||operation.request?.operation!=='graph')return response;const body=await response.clone().json();const graph=body.response.result;graph.nodes=[...graph.nodes,{id:'markup-literal',content:'<img src=x onerror="window.pwned=1"> and <b>bold</b>',truncated:false,kind:'fact',tier:'episodic',origin:'tool',importance:0.5,createdAt:1,conversation:'0123456789ab'}];graph.total=graph.nodes.length;graph.limited=false;return Response.json(body)}})()`);
			await click("Chat");
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 2 memories"));
			points = await settledPoints(2);
			const markupAt = [await memoryAt(points[0]), await memoryAt(points[1])].findIndex((text) => text.includes("<img src=x"));
			assert.notEqual(markupAt, -1, "the hover line shows the markup memory as text");
			await clickAt(points[markupAt]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.innerText.includes('<img src=x onerror="window.pwned=1">')`));
			await click("List");
			await until(() => evaluate(`document.querySelector('[data-key^="list-open-"]')!==null`));
			assert.equal(await has("<b>bold</b>"), true, "the List shows the markup memory as text");
			assert.equal(await evaluate(`document.querySelector('section[aria-labelledby=memory-map-title]').querySelectorAll('img, b').length`), 0, "no markup element was created from memory text");
			assert.equal(await evaluate(`window.pwned===undefined`), true);
			await click("Graph");
			await until(() => evaluate(`document.querySelector('[data-graph]')!==null`));
			await evaluate(`window.graphExtra=false;window.fetch=window.nativeFetch`);
			await click("Chat");
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 1 memory"));
			assert.equal(await styled(), 0, "the graph still sets no style attributes");
			assert.equal(await evaluate(`window.cspViolations.length`), 0, "no CSP violation after the whole map flow");
			// Many memories form a brain. The reader adds a chain of memories to the map's data, as many as `window.manyCount`.
			await evaluate(
				`(()=>{window.nativeFetch=window.fetch;window.manyCount=14;window.graphMany=true;window.fetch=async(...args)=>{const response=await window.nativeFetch(...args);let operation=null;try{operation=JSON.parse(args[1]?.body??'{}').operation??null}catch{}if(!window.graphMany||operation?.type!=='memory'||operation.request?.operation!=='graph')return response;const body=await response.clone().json();const graph=body.response.result;const extra=Array.from({length:window.manyCount},(_,i)=>({id:'many-'+i,content:'Synthetic memory '+i,truncated:false,kind:['fact','preference','decision','observation'][i%4],tier:i%5===0?'episodic':'working',origin:'tool',importance:0.5,createdAt:1000+i,conversation:'0123456789ab'}));graph.nodes=[...graph.nodes,...extra];graph.edges=[...graph.edges,...extra.slice(1).map((node,i)=>i%3===0?{from:node.id,to:extra[i].id,kind:'relates',derivation:'explicit'}:{from:node.id,to:extra[i].id,kind:'summary'})];graph.total=graph.nodes.length;graph.limited=false;return Response.json(body)}})()`,
			);
			await click("Chat");
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 15 memories"));
			await until(formed);
			assert.equal(await shaped(), "true", "fifteen memories form a brain");
			await mouse("mouseMoved", 2, 2);
			await until(async () => (await framesWhileIdle()) <= 1, () => "the formed brain keeps asking for frames");
			const extent = (list) => {
				const xs = list.map((point) => point.x);
				const ys = list.map((point) => point.y);
				return { x0: Math.min(...xs), y0: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
			};
			const mean = (list) => list.reduce((sum, point) => sum + point.y, 0) / list.length;
			let brain = await nodePoints();
			assert.equal(brain.length >= 14, true, `the brain draws its memories on the canvas, found ${brain.length}`);
			// Roughly 5:4 side view, the front (left) higher on screen than the underside.
			const box = extent(brain);
			assert.equal(box.width / box.height > 1 && box.width / box.height < 1.6, true, `the memories sit in a brain-shaped box, ${box.width.toFixed(0)} x ${box.height.toFixed(0)}`);
			const front = brain.filter((point) => point.x < box.x0 + box.width / 3);
			const underside = brain.filter((point) => point.y > box.y0 + (box.height * 2) / 3);
			assert.equal(front.length > 0 && underside.length > 0 && mean(front) < mean(underside), true, "the front of the brain is above its underside");
			// A dragged memory goes back to its place once it is let go, and does not stay where it was dropped.
			const dragged = brain[Math.floor(brain.length / 2)];
			await drag(dragged, 10);
			await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragged.x + 120, y: dragged.y + 80, button: "left", buttons: 0, clickCount: 1 });
			await mouse("mouseMoved", 2, 2);
			await until(async () => (await framesWhileIdle()) <= 1, () => "the brain does not come to rest after a drag");
			brain = await nodePoints();
			assert.equal(Math.min(...brain.map((point) => Math.hypot(point.x - dragged.x, point.y - dragged.y))) <= 4, true, "the dragged memory returned to its place in the brain");
			// Focus shows a few memories, which are not a brain; showing all forms the brain again.
			await clickAt(brain[0]);
			await until(() => evaluate(`document.querySelector('#graph-details')?.hidden===false`));
			await focusKey("graph-focus");
			await enter();
			await until(async () => (await shaped()) === "false", () => "Focus keeps the brain");
			await focusKey("graph-focus-off");
			await enter();
			await until(async () => (await shaped()) === "true", () => "showing all memories does not form the brain again");
			await until(formed);
			await focusKey("graph-close");
			await enter();
			await until(detailsHidden);
			// Reduced motion shows the finished brain at once and asks for next to no frames.
			await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
			await evaluate(`window.manyCount=16`);
			await click("Chat");
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 17 memories"));
			assert.equal(await formed(), true, "with reduced motion the brain is formed as soon as the map shows");
			assert.equal(await shaped(), "true");
			const reducedFrames = await evaluate(`window.subs.frames`);
			await setTimeout(500);
			assert.equal((await evaluate(`window.subs.frames`)) - reducedFrames <= 3, true, "reduced motion draws the map without an animation");
			// A pointer resting on a memory dims the others; park it outside the map and let the redraw finish before scanning.
			await mouse("mouseMoved", 2, 2);
			await until(async () => (await framesWhileIdle()) <= 1, () => "the finished brain keeps asking for frames");
			const finished = await nodePoints();
			assert.equal(finished.length >= 16, true, `the finished brain is drawn, found ${finished.length} of 17 memories`);
			await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
			await evaluate(`window.graphMany=false;window.fetch=window.nativeFetch`);
			await click("Chat");
			await click("Memory");
			await until(async () => (await mapLabel()).startsWith("Map of 1 memory"));
			assert.equal(await evaluate(`window.cspViolations.length`), 0, "no CSP violation after the brain flow");
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
			const noticeShownAt = Date.now();
			assert.equal(
				await evaluate(`window.forgetCalls.length===2&&window.forgetCalls[0]===window.forgetCalls[1]`),
				true,
			);
			// About is the last page: identity and the terminal-only control rules render from the live owner.
			await click("About");
			await until(() => has("Data and privacy"));
			// Group headings are styled uppercase, so innerText upper-cases them; compare the heading without case.
			assert.equal(await has("needs a terminal on the computer it runs on"), true);
			assert.equal(await evaluate(`document.body.innerText.toLowerCase().includes('only a terminal can')`), true);
			await click("Chat");
			await fill("#composer", "Wait until cancelled");
			await click("Send message");
			// The visible word and the screen-reader suffix are separate spans, so check the button's text, not innerText.
			await until(() =>
				evaluate(`[...document.querySelectorAll('button')].some(el=>el.offsetParent!==null&&el.textContent==='Cancel chat')`),
			);
			// Typing while the run streams must keep the same textarea, focus and selection, and the rail stays mounted.
			await evaluate(
				`(()=>{const input=document.querySelector('#composer');window.composerNode=input;input.focus();input.value='typed during the run';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(3,3);})()`,
			);
			await setTimeout(400);
			assert.equal(
				await evaluate(
					`document.querySelector('#composer')===window.composerNode&&document.activeElement===window.composerNode&&window.composerNode.selectionStart===3&&document.querySelector('[data-activity-body]')!==null`,
				),
				true,
			);
			await click("Memory");
			await fill("#memory-query", "focus survives owner cancellation");
			await evaluate(
				`document.querySelector('#memory-query').focus();document.querySelector('#memory-query').setSelectionRange(2,2)`,
			);
			await evaluate(
				`(async()=>{
					const {csrfToken}=await (await window.originalFetch('/api/v1/session',{credentials:'omit'})).json();
					const reply=await window.originalFetch('/api/v1/requests',{
						method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','X-Unit-CSRF':csrfToken},
						body:JSON.stringify({requestId:crypto.randomUUID(),operation:{type:'cancel'}}),
					});
					if(!reply.ok)throw Error('Authorized fixture cancellation failed: '+reply.status);
				})()`,
			);
			await until(() => has("The owner could not complete this request."));
			assert.equal(
				await evaluate(`document.activeElement?.id==='memory-query'&&document.activeElement.selectionStart===2`),
				true,
			);
			await click("Chat");
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
			// The "Memory forgotten" notice expires after 6 s with a full redraw; let it pass so it cannot replace the composer mid-check.
			await setTimeout(Math.max(0, noticeShownAt + 6500 - Date.now()));
			// Below 1440 the Activity rail is hidden, so these checks read the elements that stay visible.
			await call("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
			await until(() => evaluate(`innerWidth===1024`));
			// Rewrites what the owner reports in the status and mission replies, so a details refresh can change warnings.
			await evaluate(
				`window.reported={};window.fetch=async(...args)=>{const response=await window.originalFetch(...args);let operation=null;try{operation=JSON.parse(args[1]?.body??'{}').operation??null}catch{}if(!operation)return response;const body=await response.clone().json();const reply=body.response;if(operation.type==='status'){if(window.reported.held)reply.maintenance={...reply.maintenance,state:'held'};if(window.reported.unconfigured)reply.runtime={...reply.runtime,configuration:'unconfigured'};}if(operation.type==='mission'&&window.reported.objective){reply.result.formation.agreement=null;reply.result.formation.draft={missionId:'fixture-mission',revision:1,status:'editing',digest:null,terms:{objective:window.reported.objective}};}return Response.json(body)}`,
			);
			// Opens Chat (a full redraw that focuses a fresh composer), then reports new details while that composer is focused.
			const refreshWhileTyping = async (reported, draft) => {
				await evaluate(
					`(()=>{window.reported=${JSON.stringify(reported)};const chat=[...document.querySelectorAll('button')].find(el=>el.offsetParent!==null&&el.textContent==='Chat');chat.click();const input=document.querySelector('#composer');window.composerNode=input;input.focus();input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(2,5);})()`,
				);
			};
			const frame = () =>
				evaluate(`(()=>{
					const visible=[...document.querySelectorAll('button')].filter(el=>el.offsetParent!==null);
					const status=visible.find(el=>el.textContent.startsWith('Status'));
					const purpose=document.querySelector('[data-key="purpose"]');
					const input=document.querySelector('#composer');
					return {
						hold:document.body.innerText.includes('Messages you send will wait.'),
						setup:document.body.innerText.includes('No model is configured. '),
						purpose:purpose===null?null:purpose.textContent,
						count:status?status.dataset.waiting:null,
						sameNode:input===window.composerNode,
						focused:document.activeElement===window.composerNode,
						selection:[window.composerNode.selectionStart,window.composerNode.selectionEnd],
						draft:window.composerNode.value,
					};
				})()`);
			// Regression: warnings, purpose line and attention counts follow a details refresh that lands while the composer is focused.
			await refreshWhileTyping({ held: true, unconfigured: true, objective: "Keep the Harbor dependencies secure." }, "held draft");
			await until(async () => (await frame()).hold);
			assert.deepEqual(await frame(), {
				hold: true,
				setup: true,
				purpose: "PurposeKeep the Harbor dependencies secure.",
				count: "2",
				sameNode: true,
				focused: true,
				selection: [2, 5],
				draft: "held draft",
			});
			await refreshWhileTyping({}, "cleared draft");
			await until(async () => !(await frame()).hold);
			assert.deepEqual(await frame(), {
				hold: false,
				setup: false,
				purpose: null,
				count: "0",
				sameNode: true,
				focused: true,
				selection: [2, 5],
				draft: "cleared draft",
			});
			// Regression: a model change that arrives on the event stream updates the setup banner; the stream is replayed here.
			await evaluate(`(()=>{
				const input=document.querySelector('#composer');
				window.composerNode=input;input.focus();input.setSelectionRange(4,7);
				window.emitSse('view',{...window.lastView,model:null});
			})()`);
			await until(() => has("No model is configured. "));
			assert.equal(await evaluate(`(()=>{
				const input=window.composerNode;
				return document.querySelector('#composer')===input&&document.activeElement===input&&input.selectionStart===4&&input.selectionEnd===7;
			})()`), true);
			await evaluate(`window.emitSse('view',window.lastView)`);
			await until(async () => !(await has("No model is configured. ")));
			// Regression: a banner change that leaves the setup Copy button in place keeps keyboard focus on it.
			// Reports no model, focuses the setup Copy button, then a details refresh toggles only the maintenance hold.
			await refreshWhileTyping({ unconfigured: true }, "");
			await until(async () => (await frame()).setup);
			const copyFocus = () =>
				evaluate(`(()=>{const active=document.activeElement;return {inBanner:active?.closest('[data-owner-banners]')!==null&&active?.closest('[data-owner-banners]')!==undefined,label:active?.textContent??null}})()`);
			await evaluate(`(()=>{document.querySelector('[data-owner-banners] button').focus();window.reported={unconfigured:true,held:true};})()`);
			assert.deepEqual(await copyFocus(), { inBanner: true, label: "Copy" }, "the setup Copy button is focused before the refresh");
			await evaluate(
				`(()=>{for(const busy of [true,false])window.emitSse('view',{...window.lastView,busy});})()`,
			);
			await until(async () => (await frame()).hold);
			assert.deepEqual(await copyFocus(), { inBanner: true, label: "Copy" });
			await refreshWhileTyping({}, "");
			await until(async () => !(await frame()).hold);
			// Leaves an objective reported for the layout checks below, which then also measure the purpose line.
			await refreshWhileTyping({ objective: "Keep the Harbor dependencies secure." }, "");
			await until(async () => (await frame()).purpose !== null);
			// Regression: a reconnect keeps a long draft scrolled where it was. The replayed connection events update the page twice.
			await fill("#composer", Array.from({ length: 30 }, (_, line) => `Draft line ${line + 1}`).join("\n"));
			await setTimeout(150);
			const scrolled = await evaluate(`(()=>{
				const input=document.querySelector('#composer');
				window.composerNode=input;input.focus();input.setSelectionRange(0,0);
				input.scrollTop=Math.floor((input.scrollHeight-input.clientHeight)/2);
				window.draftScroll={top:input.scrollTop,height:input.clientHeight};
				return window.draftScroll;
			})()`);
			assert.equal(scrolled.top > 0, true, "the draft is scrolled before the redraw");
			await evaluate(
				`(()=>{window.emitSse('connecting',{});window.emitSse('view',window.lastView);})()`,
			);
			// The composer is patched in place, never rebuilt: the same textarea keeps its offset, size, focus and selection.
			await setTimeout(250);
			assert.deepEqual(
				await evaluate(`(()=>{const input=document.querySelector('#composer');return {replaced:input!==window.composerNode,top:input.scrollTop,height:input.clientHeight,focused:document.activeElement===input,selection:[input.selectionStart,input.selectionEnd]}})()`),
				{ replaced: false, top: scrolled.top, height: scrolled.height, focused: true, selection: [0, 0] },
			);
			// Layout at each breakpoint; the last size (390) is also the one the mobile screenshot shows.
			for (const [width, height, mobile] of [
				[1440, 900, false],
				[1920, 1080, false],
				[1024, 768, false],
				[390, 844, true],
			]) {
				await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
				await until(() => evaluate(`innerWidth===${width}`));
				await fill("#composer", "");
				await setTimeout(150);
				const empty = await measure();
				assert.equal(empty.scrollWidth <= empty.innerWidth, true, `${width}: horizontal scroll`);
				// Hermes's composer: one line when empty, at every width.
				assert.equal(empty.composer.height >= 28 && empty.composer.height <= 44, true, `${width}: empty composer is ${empty.composer.height}px`);
				assert.equal(empty.rail, width >= 1440, `${width}: Activity rail visibility`);
				if (width !== 390) {
					// A real, classic thread scrollbar must be in play, or the alignment check proves nothing.
					assert.equal(empty.thread.overflowing, true, `${width}: the conversation overflows its pane`);
					assert.equal(empty.thread.gutter > 0, true, `${width}: the thread has a classic scrollbar`);
					// The purpose line shows below 1440 once details report an objective.
					assert.equal(empty.purpose !== null, width < 1440, `${width}: purpose line visibility`);
					for (const [label, other] of [["message", empty.column], ["purpose", empty.purpose]]) {
						if (!other) continue;
						const aligned = Math.abs(other.left - empty.form.left) <= 1 && Math.abs(other.right - empty.form.right) <= 1;
						assert.equal(aligned, true, `${width}: ${label} column ${other.left}-${other.right} vs composer ${empty.form.left}-${empty.form.right}`);
					}
				}
				await fill("#composer", Array.from({ length: 30 }, (_, line) => `Draft line ${line + 1}`).join("\n"));
				await setTimeout(150);
				const full = await measure();
				const limit = width === 390 ? Math.min(150, 0.3 * height) : 150;
				assert.equal(Math.abs(full.composer.height - limit) <= 1, true, `${width}: 30-line draft is ${full.composer.height}px, limit ${limit}`);
				assert.equal(full.composerScroll.scrollHeight > full.composerScroll.clientHeight, true, `${width}: draft scrolls inside the textarea`);
				assert.equal(full.card.top >= 0 && full.card.bottom <= full.innerHeight, true, `${width}: composer card stays in the viewport`);
				assert.equal(full.scrollWidth <= full.innerWidth, true, `${width}: horizontal scroll with a long draft`);
			}
			// Mission page: headings in order, no button that acts, no horizontal scroll at 1440 and 390 px.
			const missionPage = () =>
				evaluate(`(()=>{
					document.querySelector('[data-key="nav-mission"]').click();
					const page=document.querySelector('[data-scroll="mission"]');
					const buttons=[...page.querySelectorAll('button')].filter(el=>el.offsetParent!==null).map(el=>el.textContent.trim());
					return {
						title:page.querySelector('h1')?.textContent??null,
						headings:[...page.querySelectorAll('h2')].map(el=>el.textContent.replace(/\\d+$/,'')),
						buttons,
						scrollWidth:document.documentElement.scrollWidth,
						innerWidth,
						text:page.innerText,
					};
				})()`);
			for (const [width, height, mobile] of [
				[1440, 900, false],
				[390, 844, true],
			]) {
				await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
				await until(() => evaluate(`innerWidth===${width}`));
				await evaluate(`document.querySelector('[data-key="nav-status"]').click()`);
				const mission = await missionPage();
				assert.equal(mission.title, "Mission");
				const order = ["Purpose", "Current work", "Evidence", "History", "From a terminal"];
				const seen = mission.headings.filter((name) => order.includes(name));
				assert.deepEqual(seen, order.filter((name) => seen.includes(name)), `${width}: Mission headings are in order`);
				assert.equal(seen.includes("Purpose") && seen.includes("History") && seen.includes("From a terminal"), true, `${width}: Purpose, History and terminal sections exist`);
				for (const label of mission.buttons) assert.doesNotMatch(label, /^(Join|Approve|Accept|Leave|Start)\b/, `${width}: no button that acts: ${label}`);
				assert.equal(mission.scrollWidth <= mission.innerWidth, true, `${width}: Mission has horizontal scroll`);
			}
			assert.deepEqual(await evaluate(`window.cspViolations`), []);
			const mobile = await call("Page.captureScreenshot", { format: "png" });
			await writeFile(join(directory, "mobile.png"), Buffer.from(mobile.data, "base64"));
			// On a phone the sidebar opens from the top bar's Menu button and closes on navigation.
			await click("Menu");
			await click("Memory");
			assert.equal(await evaluate(`document.querySelector('#sidebar').offsetParent===null`), true, "the menu closes after navigating");

			await click("Menu");
			await click("Chat");
			const draftAfterRestart = "Reply after the browser gateway restarts";
			await fill("#composer", draftAfterRestart);
			await evaluate(`window.composerBeforeRestart = document.querySelector('#composer')`);
			const sendsBeforeRestart = await evaluate("window.sentByBrowser");
			const workspaceHeader = async () => (await fetch(`${origin}/api/v1/session`)).headers.get("X-Unit-Workspace");
			const ownerId = await workspaceHeader();
			assert.match(ownerId, /^[a-f0-9]{64}$/);
			assert.equal(owner.kill("SIGUSR2"), true, "restart only the fixture gateway");
			await until(() => has("Cannot reach the agent."));
			await until(() => output.split(`Browser workspace: ${origin}`).length === 3, () => errors);
			await until(() => evaluate(`document.querySelector('footer[aria-label="Status bar"]').innerText.includes('Connected')`));
			assert.equal(await workspaceHeader(), ownerId, "a gateway restart keeps the owner's endpoint identity");
			assert.equal(await evaluate("window.composerBeforeRestart === document.querySelector('#composer')"), true);
			assert.equal(await evaluate("document.querySelector('#composer').value"), draftAfterRestart);
			assert.equal(await has("Verified browser answer."), true, "owner state survives the gateway restart");
			assert.deepEqual(await evaluate("window.sentByBrowser"), sendsBeforeRestart, "reconnecting does not send or replay anything");
			await click("Send message");
			await until(() => has("Verified browser answer after gateway restart."));
			assert.deepEqual(await evaluate("window.sentByBrowser"), [...sendsBeforeRestart, draftAfterRestart]);

			const wrongOwnerDraft = "This unsent draft belongs to the first owner";
			await fill("#composer", wrongOwnerDraft);
			await stop(owner);
			await until(() => has("Cannot reach the agent."));
			const postsBeforeSwitch = await evaluate("window.postsByBrowser");
			replacement = startOwner("peer", "Second owner");
			await until(() => output.split(`Browser workspace: ${origin}`).length === 4, () => errors);
			const replacementId = await workspaceHeader();
			assert.match(replacementId, /^[a-f0-9]{64}$/);
			assert.notEqual(replacementId, ownerId);
			await until(() => has("A different workspace answered."));
			assert.equal(await evaluate("window.composerBeforeRestart === document.querySelector('#composer')"), true);
			assert.equal(await evaluate("document.querySelector('#composer').value"), wrongOwnerDraft);
			assert.equal(await evaluate(`document.querySelector('[data-key="send"]').disabled`), true);
			await evaluate(`document.querySelector('#composer').form.requestSubmit()`);
			assert.equal(await evaluate("window.postsByBrowser"), postsBeforeSwitch);
			assert.equal(await has("Verified browser answer after gateway restart."), true);
			assert.equal(await has("Second owner: Retained browser message 28"), false);

			await call("Page.reload");
			await until(() => has("Second owner: Retained browser message 28"));
			assert.equal(await has("Verified browser answer after gateway restart."), false);
			assert.equal(await evaluate("document.querySelector('#composer').value"), "");
			assert.deepEqual(await evaluate("window.sentByBrowser"), [], "a deliberate reload starts fresh and never sends the old draft");
			console.log(`Browser acceptance screenshots: ${directory}`);
		} finally {
			socket?.close();
			await stop(browser);
			await stop(owner);
			await stop(replacement);
			// Keep screenshots when requested, without retaining the synthetic SQLite state.
			await rm(join(directory, "owner"), { recursive: true, force: true });
			await rm(join(directory, "peer"), { recursive: true, force: true });
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
