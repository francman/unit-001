// Pairs a browser with a local operator gateway before mounting the live workspace.
import { type BrowserSession, pairBrowserSession, restoreBrowserSession } from "./client-auth.ts";
import { browserWorkspacePort } from "./port.ts";
import { mountWorkspace } from "./shell.ts";
import { renderPairing } from "./views/pairing.ts";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Workspace mount element is missing.");
const mount = root;

async function start(): Promise<void> {
	const session = await restoreBrowserSession();
	if (session !== null) {
		mountWorkspace(mount, browserWorkspacePort(session));
		return;
	}
	let paired: BrowserSession;
	renderPairing(mount, {
		onPaired: () => mountWorkspace(mount, browserWorkspacePort(paired)),
		async submit(code) {
			const result = await pairBrowserSession(code);
			if (result.state === "paired") paired = result.session;
			return result.state;
		},
	});
}

function unreachable(): void {
	mount.textContent = "Cannot reach the operator gateway. Restart the web command and reload.";
}

void start().catch(unreachable);
