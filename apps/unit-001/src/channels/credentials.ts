// Keeps channel credentials in an owner-private directory outside durable documents and model inputs.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { channelObject } from "./contract.ts";

/** Owner-private storage is not isolation from the same UID's coding tools; grants remain separately root-owned. */
export class ChannelCredentials {
	readonly #directory: string;

	constructor(directory: string) {
		this.#directory = directory;
	}

	/** Reads a fixed credential reference without returning it through any public registry projection. */
	async read(reference: string): Promise<Record<string, unknown> | null> {
		const path = await this.path(reference);
		let file;
		try {
			file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error("Channel credentials unavailable.");
		}
		try {
			const info = await file.stat();
			if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 8192)
				throw new Error("Untrusted channel credential file.");
			const buffer = Buffer.alloc(8193);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > 8192) throw new Error("Oversize channel credentials.");
			return channelObject(JSON.parse(buffer.subarray(0, length).toString("utf8")));
		} finally {
			await file.close();
		}
	}

	/** Atomically stores a credential under a host-derived reference; no token enters SQLite or tool output. */
	async write(reference: string, value: Record<string, unknown>): Promise<void> {
		const path = await this.path(reference);
		const data = `${JSON.stringify(value)}\n`;
		if (Buffer.byteLength(data) > 8192) throw new Error("Oversize channel credentials.");
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(data);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
			const directory = await open(this.#directory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async path(reference: string): Promise<string> {
		if (!/^[a-zA-Z0-9_-]{1,100}$/.test(reference)) throw new Error("Invalid channel credential reference.");
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		const info = await lstat(this.#directory);
		if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
			throw new Error("Untrusted channel credential directory.");
		return join(this.#directory, `${reference}.json`);
	}
}
