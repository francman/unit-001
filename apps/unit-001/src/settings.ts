// Stores the chosen default model alongside this agent's credentials and sessions.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "./errors.ts";
import { parseModelSpec } from "./provider.ts";

/** Reads a saved model; absent settings leave provider detection unchanged. */
export async function readDefaultModel(directory: string): Promise<string | undefined> {
	let text: string;
	try {
		text = await readFile(join(directory, "settings.json"), "utf8");
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	// Settings are user-editable disk input; malformed values must not select a different provider silently.
	const message = "Invalid agent settings.json. Run setup again to choose a default model.";
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ConfigurationError(message);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("model" in value) ||
		typeof value.model !== "string"
	)
		throw new ConfigurationError(message);
	try {
		parseModelSpec(value.model);
	} catch {
		throw new ConfigurationError(message);
	}
	return value.model;
}

/** Atomically saves the validated setup selection without storing credentials in settings. */
export async function saveDefaultModel(directory: string, model: string): Promise<void> {
	parseModelSpec(model);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, model })}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, join(directory, "settings.json"));
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
