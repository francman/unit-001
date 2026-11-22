// Fetches same-origin gateway metadata; the token is kept only in page memory.

export type GatewaySession = { workspaceId: string; csrfToken: string };

export class WorkspaceChanged extends Error {}

/** Checks the opaque endpoint identity before consuming a session or event body. */
export function requireWorkspaceIdentity(response: Response, expected?: string): string {
	const id = response.headers.get("X-Unit-Workspace");
	if (id === null || id.length !== 64 || /[^a-f0-9]/.test(id)) throw new Error("Invalid workspace identity.");
	if (expected !== undefined && id !== expected) throw new WorkspaceChanged();
	return id;
}

/** Sends a same-origin API request without cookies or redirects that could resend a write. */
export function browserApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(path, { ...init, cache: "no-store", credentials: "omit", mode: "same-origin", redirect: "error" });
}

/** Reads the current gateway's identity and CSRF candidate; the stream must confirm the identity before use. */
export async function readGatewaySession(aborted?: AbortSignal, expectedWorkspaceId?: string): Promise<GatewaySession> {
	const timeout = AbortSignal.timeout(10_000);
	const signal = aborted ? AbortSignal.any([aborted, timeout]) : timeout;
	const response = await browserApiFetch("/api/v1/session", { signal });
	if (!response.ok) throw new Error("Gateway metadata is unavailable.");
	let workspaceId: string;
	try {
		workspaceId = requireWorkspaceIdentity(response, expectedWorkspaceId);
	} catch (error) {
		void response.body?.cancel().catch(() => {});
		throw error;
	}
	const value: unknown = await response.json();
	signal.throwIfAborted();
	if (
		!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).length !== 1 || !("csrfToken" in value) ||
		typeof value.csrfToken !== "string" || !value.csrfToken || /[^!-~]/.test(value.csrfToken)
	) throw new Error("Invalid gateway metadata.");
	return { workspaceId, csrfToken: value.csrfToken };
}
