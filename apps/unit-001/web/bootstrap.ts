// Pairs a browser with a local operator gateway before mounting the live workspace.
import { browserWorkspacePort } from "./port.ts";
import { mountWorkspace } from "./shell.ts";
import { renderPairing } from "./views/pairing.ts";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Workspace mount element is missing.");
const mount = root;

async function start(): Promise<void> {
	const response = await fetch("/api/v1/session", { cache: "no-store" });
	const session: unknown = await response.json();
	if (
		typeof session === "object" &&
		session !== null &&
		"authenticated" in session &&
		session.authenticated === true &&
		"csrfToken" in session &&
		typeof session.csrfToken === "string"
	) {
		mountWorkspace(mount, browserWorkspacePort(session.csrfToken));
		return;
	}
	renderPairing(mount, {
		onPaired: () => void start().catch(unreachable),
		async submit(code) {
			try {
				const reply = await fetch("/api/v1/session", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ secret: code }),
				});
				if (reply.status === 429) return "limited";
				return reply.ok ? "paired" : "wrong";
			} catch {
				return "unreachable";
			}
		},
	});
}

function unreachable(): void {
	mount.textContent = "Cannot reach the operator gateway. Restart the web command and reload.";
}

void start().catch(unreachable);
