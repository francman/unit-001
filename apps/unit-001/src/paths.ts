import { posix, win32 } from "node:path";
import { UsageError } from "./errors.ts";

export const APP_NAME = "unit-001";
export const HOME_VARIABLE = "UNIT_001_HOME";

export interface PathEnvironment {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
}

function pathFor(platform: NodeJS.Platform): typeof posix {
	return platform === "win32" ? win32 : posix;
}

/**
 * Where the agent keeps its sessions: `UNIT_001_HOME` if set, else the platform's per-user data directory
 * (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` or `~/.local/share` elsewhere).
 */
export function dataDirectory({ platform, env, home }: PathEnvironment): string {
	const path = pathFor(platform);
	const override = env[HOME_VARIABLE];
	if (override !== undefined && override !== "") return path.resolve(override);
	if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_NAME);
	if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_NAME);
	// The XDG spec says a relative value is invalid and must be ignored.
	const xdg = env.XDG_DATA_HOME;
	const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
	return path.join(base, APP_NAME);
}

// Letters, digits, dot, underscore, and hyphen, starting and ending alphanumeric (or underscore or hyphen at the end):
// no separators, no leading dot, and no trailing dot, which Windows silently drops.
const SESSION_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
// Device names Windows reserves in every directory, with or without an extension.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** A session name that is a safe file name on every supported platform. */
export function validateSessionName(name: string): string {
	if (!SESSION_NAME.test(name) || WINDOWS_RESERVED.test(name)) {
		throw new UsageError(
			`Invalid session name "${name}": use 1 to 64 letters, digits, dots, underscores, or hyphens, not ending in a dot or naming a reserved device.`,
		);
	}
	return name;
}

/** The SQLite file holding one named session. */
export function sessionFile(directory: string, name: string, platform: NodeJS.Platform): string {
	return pathFor(platform).join(directory, "sessions", `${validateSessionName(name)}.sqlite`);
}

/** The file holding stored sign-ins and keys, next to the sessions. */
export function credentialsFile(directory: string, platform: NodeJS.Platform): string {
	return pathFor(platform).join(directory, "auth.json");
}
