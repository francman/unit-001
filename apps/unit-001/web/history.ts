// Tracks earlier chat pages independently of the live watch window.
import type { WorkspaceView } from "./contract.ts";

export type ChatEntries = WorkspaceView["entries"];

export type ChatHistory =
	| { kind: "unstarted" }
	| { kind: "ready"; before: number }
	| { kind: "loading" | "failed"; before: number | null }
	| { kind: "exhausted" };

/** Adds a sorted live window or earlier page. Live projections win overlaps, including pages requested with no bound. */
export function mergeChatEntries(current: ChatEntries, incoming: ChatEntries, source: "live" | "page"): ChatEntries {
	if (!incoming.length) return current;
	if (!current.length) return incoming;
	let low = 0;
	let high = current.length;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (current[mid].id < incoming[0].id) low = mid + 1;
		else high = mid;
	}

	// On token updates, the closed rows usually haven't changed. Don't rebuild the accumulated transcript then.
	let i = low;
	let j = 0;
	while (j < incoming.length && i < current.length) {
		const old = current[i];
		const row = incoming[j];
		if (old.id > row.id) break;
		if (old.id === row.id) {
			if (source === "live" && (old.text !== row.text || old.role !== row.role || old.truncated !== row.truncated || old.source !== row.source)) break;
			j++;
		}
		i++;
	}
	if (j === incoming.length) return current;

	const merged = current.slice(0, i);
	while (j < incoming.length) {
		const row = incoming[j++];
		while (i < current.length && current[i].id < row.id) merged.push(current[i++]);
		if (current[i]?.id === row.id) {
			const old = current[i++];
			merged.push(source === "live" ? row : old);
		} else {
			merged.push(row);
		}
	}
	while (i < current.length) merged.push(current[i++]);
	return merged;
}
