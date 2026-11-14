// Defines the browser workspace projection independently of private owner storage.
export type Connection = "connected" | "connecting" | "offline";

export interface WorkspaceView {
	name: string;
	version: string;
	installationId: string | null;
	busy: boolean;
	model: { provider: string; modelId: string } | null;
	entries: readonly { id: number; role: "user" | "assistant"; text: string; truncated: boolean; source?: "host" }[];
	text: string;
	textTruncated: boolean;
	historyTruncated: boolean;
	tools: readonly { callId: string; name: string; status: string }[];
}

export interface WorkspaceDetails {
	mission: {
		stage: string;
		objective: string | null;
		scope: string | null;
		missing: readonly string[];
		execution: string;
	};
	memory: { count: number | null; records: readonly { id: string; content: string; source: string }[] };
	channels: readonly { id: string; adapter: string; status: string; detail: string }[];
}

export interface WorkspacePort {
	watch(
		listener: (event: { type: "view"; view: WorkspaceView } | { type: "connection"; state: Connection }) => void,
	): () => void;
	details(): Promise<WorkspaceDetails>;
	send(prompt: string, requestId: string): Promise<{ state: "completed" } | { state: "unknown"; message: string }>;
	cancel(requestId: string): Promise<void>;
	recall(query: string): Promise<WorkspaceDetails["memory"]>;
	forget(id: string, requestId: string): Promise<void>;
	logout(): Promise<void>;
}
