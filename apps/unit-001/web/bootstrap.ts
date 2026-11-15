// Pairs a browser with a local operator gateway before mounting the live workspace.
import { mountWorkspace } from "./app.ts";
import { browserWorkspacePort } from "./port.ts";

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
	const panel = document.createElement("main");
	panel.className = "bootstrap-panel";
	const title = document.createElement("h1");
	title.textContent = "Connect to your agent.";
	const description = document.createElement("p");
	description.textContent =
		"Enter the one-time pairing code from the operator terminal. Pairing grants conversation and coding access, including memory inspection.";
	const form = document.createElement("form");
	const input = document.createElement("input");
	input.type = "password";
	input.autocomplete = "off";
	input.className = "search-input";
	input.setAttribute("aria-label", "Pairing code");
	input.required = true;
	const button = document.createElement("button");
	button.type = "submit";
	button.className = "primary-button";
	button.textContent = "Connect";
	const notice = document.createElement("p");
	notice.setAttribute("role", "status");
	form.append(input, button, notice);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		button.disabled = true;
		void (async () => {
			try {
				const response = await fetch("/api/v1/session", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ secret: input.value }),
				});
				input.value = "";
				if (response.status === 429) {
					notice.textContent =
						"This pairing code was consumed or invalid attempts were limited. Use the valid code, or restart the operator web command for a fresh one.";
					button.disabled = false;
					return;
				}
				if (!response.ok) throw new Error("Pairing failed.");
				await start();
			} catch {
				notice.textContent =
					"Pairing failed. Check the code. Restart the operator web command for a fresh code after expiry or sign out.";
				button.disabled = false;
			}
		})();
	});
	panel.append(title, description, form);
	mount.replaceChildren(panel);
}

void start().catch(() => {
	mount.textContent = "Cannot reach the operator gateway. Restart the web command and reload.";
});
