// Keeps the unconfigured browser entry honest until protected owner provisioning is integrated.
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Workspace mount element is missing.");
const panel = document.createElement("main");
panel.className = "bootstrap-panel";
const label = document.createElement("p");
label.className = "eyebrow";
label.textContent = "UNIT-001 / BROWSER WORKSPACE";
const title = document.createElement("h1");
title.textContent = "Owner connection pending.";
const description = document.createElement("p");
description.className = "muted";
description.textContent =
	"This interface is an implementation preview. Protected browser pairing and the live owner adapter are not integrated yet. Use the existing terminal interface to reach your agent.";
panel.append(label, title, description);
root.append(panel);
