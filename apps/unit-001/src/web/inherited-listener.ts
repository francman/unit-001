// Validates the systemd descriptor before the web gateway adopts it.
import { fstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { ConfigurationError } from "../errors.ts";

const webListenerFd = 3;
const unixPathMax = 108;

/** Returns the single inherited Linux Unix stream listener bound at the exact configured pathname. */
export async function readInheritedWebListener(expectedPath: string): Promise<number> {
	if (process.platform !== "linux") throw new ConfigurationError("Inherited web listeners require Linux.");
	if (
		process.env.LISTEN_PID !== String(process.pid) ||
		process.env.LISTEN_FDS !== "1" ||
		process.env.LISTEN_FDNAMES !== "unit-001-web"
	) {
		throw new ConfigurationError("Expected one inherited descriptor named unit-001-web for this process.");
	}
	const pathBytes = Buffer.from(expectedPath, "utf8");
	if (
		!expectedPath.startsWith("/") ||
		!expectedPath.isWellFormed() ||
		pathBytes.length > unixPathMax ||
		pathBytes.includes(0) ||
		pathBytes.includes(10)
	) {
		throw new ConfigurationError("Expected an absolute Unix socket pathname representable in /proc/self/net/unix.");
	}

	// Check fd 3 before opening procfs, since open could otherwise fill a vacant descriptor.
	const listener = fstatSync(webListenerFd, { bigint: true });
	if (!listener.isSocket() || !matchesUnixListener(await readUnixTable(), listener.ino, pathBytes.toString("latin1"))) {
		throw new ConfigurationError(`Inherited fd 3 must be a listening Unix stream socket bound at ${expectedPath}.`);
	}
	const current = fstatSync(webListenerFd, { bigint: true });
	if (!current.isSocket() || current.dev !== listener.dev || current.ino !== listener.ino) {
		throw new ConfigurationError("Inherited fd 3 changed during validation.");
	}
	return webListenerFd;
}

const unixTableLimit = 1024 * 1024;

async function readUnixTable(): Promise<string> {
	const file = await open("/proc/self/net/unix", "r");
	try {
		const buffer = Buffer.allocUnsafe(unixTableLimit + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
			if (bytesRead === 0) return buffer.toString("latin1", 0, offset);
			offset += bytesRead;
		}
		throw new ConfigurationError("The /proc/self/net/unix socket table exceeds the validation limit.");
	} finally {
		await file.close();
	}
}

const unixHeader = "Num       RefCount Protocol Flags    Type St Inode Path\n";
const unixRow = /^[0-9a-f]+: [0-9A-F]{8} 00000000 ([0-9A-F]{8}) ([0-9A-F]{4}) ([0-9A-F]{2}) +(\d+)(?: (.*))?$/s;

function matchesUnixListener(table: string, inode: bigint, expectedPath: string): boolean {
	if (!table.startsWith(unixHeader) || !table.endsWith("\n")) return false;
	const expectedInode = String(inode);
	let offset = unixHeader.length;
	let previousPathStart = -Infinity;
	let matched = false;
	const lines = table.slice(offset, -1).split("\n");
	for (const [index, line] of lines.entries()) {
		const lineEnd = offset + line.length;
		offset = lineEnd + 1;
		const row = unixRow.exec(line);
		if (!row) continue;
		const [, flags, type, state, rowInode, path] = row;
		if (rowInode === expectedInode) {
			// Linux prints raw pathname bytes. An embedded newline can make a different socket's name look like a row.
			if (lineEnd - previousPathStart <= unixPathMax) return false;
			// Linux prints __SO_ACCEPTCON for listeners, 0001 for SOCK_STREAM, and 01 for the listening row's state.
			if (matched || flags !== "00010000" || type !== "0001" || state !== "01" || path !== expectedPath) {
				return false;
			}
			// Prove the end of the row as well: a longer bound name could begin with the expected path and a newline.
			const nextLine = lines[index + 1];
			if (nextLine !== undefined && path.length + 1 + nextLine.length <= unixPathMax) return false;
			matched = true;
		}
		if (path !== undefined) previousPathStart = lineEnd - path.length;
	}
	return matched;
}
