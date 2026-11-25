// A private browser preview with independently settleable Memory requests.
import { mountWorkspace } from "../../web/shell.ts";

const requests = { details: [], graph: [], recall: [], forget: [] };
const defer = (name, ...args) => {
	const request = Promise.withResolvers();
	requests[name].push({ ...request, args });
	return request.promise;
};
const records = [
	{ id: "first", content: "First weekly digest memory", source: "creator/semantic" },
	{ id: "second", content: "Second weekly digest memory", source: "creator/semantic" },
];
const memory = (count, records = []) => ({ count, stats: null, records });
const details = (count, records) => ({ owner: null, mission: { run: null, formationAvailable: false }, memory: memory(count, records), channels: [] });
const graph = (rows) => ({
	nodes: rows.map(({ id, content }) => ({
		id, content, truncated: false, kind: "fact", tier: "working", origin: "user", importance: 0.5,
		createdAt: 1, conversation: "preview",
	})),
	edges: [],
	total: rows.length,
	limited: false,
});
const view = {
	name: "Bob", version: "0.0.0-test", installationId: "memory-preview", busy: false, model: null,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { kind: "estimate", usd: 0 } },
	entries: [], text: "", textTruncated: false, historyTruncated: false, tools: [],
};
const unmount =mountWorkspace(document.querySelector("#app"), {
	// Reads, Search and Forget wait for the first view, which marks the connection as up (5321c51ee).
	watch: (listener) => {
		listener({ type: "view", view });
		return () => undefined;
	},
	details: () => defer("details"),
	memoryGraph: () => defer("graph"),
	recall: (query) => defer("recall", query),
	forget: (id, requestId) => defer("forget", id, requestId),
}, { preview: true, section: "memory" });

window.memoryPreview = { requests, records, memory, details, graph, unmount };
