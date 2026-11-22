// Pairs and restores bearer sessions for the current browser origin.
export type BrowserSession = { sessionToken: string; csrfToken: string; expiresAt: number };

export type BrowserPairing = { state: "paired"; session: BrowserSession } | { state: "limited" | "wrong" | "unreachable" };

const SESSION_KEY = "unit-001.session";

/** Sends a same-origin API request without cookies or redirects that could resend a write. */
export function browserApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(path, { ...init, cache: "no-store", credentials: "omit", mode: "same-origin", redirect: "error" });
}

/** Redeems the code once and retains only the bearer for future tabs and reloads. */
export async function pairBrowserSession(secret: string): Promise<BrowserPairing> {
	try {
		const response = await browserApiFetch("/api/v1/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 429) return { state: "limited" };
		if (response.status === 401) return { state: "wrong" };
		if (!response.ok) return { state: "unreachable" };
		const value: unknown = await response.json();
		if (!value || typeof value !== "object" || !("sessionToken" in value) || !credential(value.sessionToken))
			return { state: "unreachable" };
		const session = parseSession(value, value.sessionToken);
		if (session.expiresAt <= Date.now()) return { state: "unreachable" };
		try {
			await navigator.locks.request(SESSION_KEY, () => localStorage.setItem(SESSION_KEY, session.sessionToken));
		} catch {
			// If persistence is blocked, the tab that redeemed the code still has the session in memory.
		}
		return { state: "paired", session };
	} catch {
		return { state: "unreachable" };
	}
}

/** Validates this origin's saved bearer and retrieves the tab's in-memory CSRF credential. */
export async function restoreBrowserSession(): Promise<BrowserSession | null> {
	let token: string | null = null;
	try {
		token = localStorage.getItem(SESSION_KEY);
	} catch {
		// A browser that denies storage can still pair in this tab.
	}
	const session = await checkBrowserSession(token);
	if (session === null && token !== null) await clearBrowserSession(token);
	return session;
}

/** Checks the exact bearer that a watch was using, not a newer credential saved by another tab. */
export async function checkBrowserSession(token: string | null, aborted?: AbortSignal): Promise<BrowserSession | null> {
	const timeout = AbortSignal.timeout(10_000);
	const signal = aborted ? AbortSignal.any([aborted, timeout]) : timeout;
	const response = await browserApiFetch("/api/v1/session", {
		headers: token && credential(token) ? { Authorization: `Bearer ${token}` } : undefined,
		signal,
	});
	if (response.status !== 401 && !response.ok) throw new Error("Session check failed.");
	const value: unknown = response.status === 401 ? { authenticated: false } : await response.json();
	signal.throwIfAborted();
	if (value && typeof value === "object" && "authenticated" in value && value.authenticated === false) return null;
	if (!credential(token)) throw new Error("Invalid session response.");
	const session = parseSession(value, token);
	return session.expiresAt > Date.now() ? session : null;
}

/** Removes the bearer only if it is still the one this page used. */
export async function clearBrowserSession(token: string): Promise<void> {
	try {
		// Web Storage's get/remove operations alone do not lock out a writer in another tab.
		await navigator.locks.request(SESSION_KEY, () => {
			if (localStorage.getItem(SESSION_KEY) === token) localStorage.removeItem(SESSION_KEY);
		});
	} catch {
		// Without origin storage and locking, neither this tab nor a pairing can persist changes.
	}
}

function parseSession(value: unknown, sessionToken: string): BrowserSession {
	if (
		!value || typeof value !== "object" ||
		!("authenticated" in value) || value.authenticated !== true ||
		!("csrfToken" in value) || !credential(value.csrfToken) ||
		!("expiresAt" in value) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
	) throw new Error("Invalid session response.");
	return { sessionToken, csrfToken: value.csrfToken, expiresAt: value.expiresAt };
}

function credential(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
