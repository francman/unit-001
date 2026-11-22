// Opens the live workspace after identifying the gateway; the stream must confirm it before actions are enabled.
import { readGatewaySession } from "./client-auth.ts";
import { browserWorkspacePort } from "./port.ts";
import { mountWorkspace } from "./shell.ts";
import { workspaceRecovery } from "./state.ts";

const root = document.querySelector<HTMLElement>("#app");
const startup = root?.querySelector<HTMLElement>("#startup-status");
if (!root || !startup) throw new Error("Workspace mount element is missing.");

void readGatewaySession().then(
	(session) => mountWorkspace(root, browserWorkspacePort(session)),
	() => {
		startup.textContent = `Cannot reach the workspace. ${workspaceRecovery} Then reload this page.`;
	},
);
