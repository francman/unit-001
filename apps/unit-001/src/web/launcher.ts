// Starts a private browser client as the authorized operator, never as the agent owner.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ConfigurationError } from "../errors.ts";
import { localServiceClient } from "../service-client.ts";
import { createWebGateway } from "./gateway.ts";

/** Serves packaged browser assets until interrupted; restarting provisions a new one-time code. */
export async function runWebWorkspace(
	endpoint: string,
	port: number,
	write: (text: string) => void,
	signal: AbortSignal,
): Promise<number> {
	if (signal.aborted) return 130;
	const client = localServiceClient(endpoint);
	const status = await client.request({ type: "status" }, signal);
	if (status.type !== "status") throw new ConfigurationError("The operator owner is unavailable.");
	const assets = new Map<string, { contentType: string; body: Uint8Array }>();
	for (const [path, contentType] of [
		["/", "text/html; charset=utf-8"],
		["/bootstrap.js", "text/javascript; charset=utf-8"],
		["/style.css", "text/css; charset=utf-8"],
	] as const) {
		const file = path === "/" ? "index.html" : path.slice(1);
		const body = await readFile(new URL(`../../web-dist/${file}`, import.meta.url)).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				throw new ConfigurationError(
					"Browser assets are missing. Build the application workspace or reinstall a complete signed release.",
				);
			},
		);
		assets.set(path, { contentType, body });
	}
	const secret = randomBytes(32).toString("base64url");
	const origin = `http://127.0.0.1:${port}`;
	const gateway = createWebGateway({ client, origin, secret, assets });
	try {
		await new Promise<void>((resolve, reject) => {
			gateway.server.once("error", reject);
			gateway.server.listen(port, "127.0.0.1", () => {
				gateway.server.off("error", reject);
				resolve();
			});
		});
		write(
			`Browser workspace: ${origin}\nOne-time pairing code: ${secret}\nPairing grants this operator's conversation and coding authority. Keep the code private.\nSession lasts 30 minutes. Restart this command to pair again. Ctrl+C detaches the web workspace; agent work continues.\n`,
		);
		if (!signal.aborted)
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return 0;
	} finally {
		await gateway.close();
	}
}
