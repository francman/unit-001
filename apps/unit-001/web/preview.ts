// Provides synthetic, isolated browser acceptance data; never bundled into the live gateway.
import { mountWorkspace } from "./app.ts";
import type { Connection, WorkspaceDetails, WorkspacePort, WorkspaceView } from "./contract.ts";

let listener: Parameters<WorkspacePort["watch"]>[0] | null = null;
let view: WorkspaceView = {
	name: "Agent",
	version: "preview",
	installationId: "sample-unit",
	busy: false,
	model: null,
	entries: [
		{ id: 1, role: "user", text: "What is your mission?", truncated: false },
		{
			id: 2,
			role: "assistant",
			text: "My saved mission is to maintain the project release feed. I can inspect its agreement and report current activity.\n\nAutonomous mission execution is not implemented yet; I will not claim that background work has happened.",
			truncated: false,
		},
	],
	text: "",
	textTruncated: false,
	historyTruncated: false,
	tools: [],
};
const details: WorkspaceDetails = {
	mission: {
		stage: "agreed",
		objective: "Keep the release feed useful.",
		scope: "Monitor approved project sources and prepare concise updates for the creator.",
		missing: [],
		execution: "not-implemented",
	},
	memory: {
		count: 2,
		records: [
			{
				id: "sample-1",
				content: "The creator prefers concise updates with links to the source.",
				source: "Creator preference",
			},
			{
				id: "sample-2",
				content: "Security changes require explicit creator authorization.",
				source: "Saved operating boundary",
			},
		],
	},
	channels: [
		{
			id: "Project updates",
			adapter: "telegram",
			status: "awaiting_authorization",
			detail: "Setup is proposed. Creator authorization is required before this channel can be used.",
		},
	],
};
let unknown = false;
const port: WorkspacePort = {
	watch(callback) {
		listener = callback;
		queueMicrotask(() => callback({ type: "view", view }));
		return () => {
			listener = null;
		};
	},
	async details() {
		return details;
	},
	async send(prompt, requestId) {
		if (unknown) return { state: "unknown", message: requestId };
		view = {
			...view,
			entries: [...view.entries, { id: view.entries.length + 1, role: "user", text: prompt, truncated: false }],
			busy: true,
			text: "This is an isolated preview response. No model was called.",
		};
		listener?.({ type: "view", view });
		return { state: "completed" };
	},
	async cancel() {
		view = { ...view, busy: false, text: "" };
		listener?.({ type: "view", view });
	},
	async recall(query) {
		return {
			count: details.memory.count,
			records: details.memory.records.filter((record) => record.content.toLowerCase().includes(query.toLowerCase())),
		};
	},
	async forget(id) {
		details.memory = {
			count: (details.memory.count ?? 0) - 1,
			records: details.memory.records.filter((record) => record.id !== id),
		};
	},
	async logout() {
		listener?.({ type: "connection", state: "offline" });
	},
};
declare global {
	interface Window {
		unitPreview: {
			connection(state: Connection): void;
			view(next: Partial<WorkspaceView>): void;
			unknown(value: boolean): void;
		};
	}
}
window.unitPreview = {
	connection(state) {
		listener?.({ type: "connection", state });
	},
	view(next) {
		view = { ...view, ...next };
		listener?.({ type: "view", view });
	},
	unknown(value) {
		unknown = value;
	},
};
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Workspace mount element is missing.");
mountWorkspace(root, port, { preview: true });
