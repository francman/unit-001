// Reads the existing private owner protocol without loading providers, tools or application storage.
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

/** Converts only the updater's three admitted operations into private owner requests. */
export function controlRequest(args) {
	if (args.length === 1 && args[0] === "service-status") return { type: "status" };
	if (args[1] !== "--operation-id" || typeof args[2] !== "string" || args[2].length < 1 || args[2].length > 200)
		throw new Error("Invalid owner control operation identity.");
	if (args.length === 3 && args[0] === "maintenance-release")
		return { type: "maintenance-release", operationId: args[2] };
	if (args.length === 5 && args[0] === "maintenance-enter" && args[3] === "--timeout-ms" && /^\d+$/.test(args[4])) {
		const timeoutMs = Number(args[4]);
		if (Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30000)
			return { type: "maintenance-enter", operationId: args[2], timeoutMs };
	}
	throw new Error("Unsupported owner control operation.");
}

/** Reads one bounded newline-delimited response within a total deadline; it never opens agent files. */
export function readOwnerControl(endpoint, args, timeoutMs) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 35000)
		throw new Error("Owner control timeout must be between 1 and 35000 ms.");
	const request = controlRequest(args);
	return readOwnerFrame(endpoint, request, timeoutMs, 16 * 1024).then((response) => {
		if (response?.type !== (request.type === "status" ? "status" : "maintenance"))
			throw new Error("Unexpected owner control response.");
		return response;
	});
}

/**
 * Sends one frame to the private owner socket and parses its first reply line. One total deadline bounds the
 * exchange, so a reply trickling in under the management lock cannot hold the lock past the caller's limit.
 */
export function readOwnerFrame(endpoint, frame, timeoutMs, maxBytes) {
	return new Promise((resolveResponse, reject) => {
		const socket = createConnection(endpoint);
		const chunks = [];
		let size = 0;
		let settled = false;
		const finish = (error, response) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolveResponse(response);
		};
		const timer = setTimeout(() => finish(new Error("Owner control deadline expired.")), timeoutMs);
		socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
		socket.once("error", (error) => finish(error));
		socket.once("end", () => finish(new Error("Owner closed before a complete control response.")));
		socket.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) return finish(new Error(`Owner control response exceeds ${maxBytes / 1024} KiB.`));
			chunks.push(chunk);
			if (!chunk.includes(10)) return;
			try {
				const bytes = Buffer.concat(chunks);
				const response = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString("utf8"));
				if (response?.type === "error") throw new Error(response.message);
				finish(null, response);
			} catch (error) {
				finish(error);
			}
		});
	});
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	if (process.getuid?.() === 0) throw new Error("Run private owner controls as the installation account.");
	const [id, timeout, ...args] = process.argv.slice(2);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? ""))
		throw new Error("Invalid owner control installation identity.");
	console.log(
		JSON.stringify(
			await readOwnerControl(`/var/lib/unit-001/agents/${id}/control/default.sock`, args, Number(timeout)),
		),
	);
}
