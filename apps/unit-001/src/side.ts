// Owns the Session registry and atomic, replayable main-reply forks.
import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	type ModelRef,
	type Tx,
} from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "./maintenance.ts";
import {
	parseSideRequest,
	positiveId,
	SIDE_LIMIT,
	sideFingerprint,
	type SideChatState,
	type SideResult,
} from "./side-control.ts";

export type SideRow = {
	conversationId: ConversationId;
	parent: { conversationId: ConversationId; at: EntryId };
	title: string;
	createdAt: number;
	creation: { requestId: string; fingerprint: string };
};

export type SideState = { sides: SideRow[] };

export type SideOwner = {
	readonly harness: Harness;
	readonly root: Conversation;
	/** The launch choice overrides historical and persisted model state, including null. */
	readonly model: ModelRef | null;
	readonly requireActive: () => void;
};

/** Current owner-chat membership and creation receipts, shared by the entire Session. */
export const SideDoc = defineDoc<SideState>({
	kind: "unit.side",
	version: 1,
	scope: "session",
	initial: () => ({ sides: [] }),
	checkpointWhen: () => true,
});

/** Initializes an empty legacy registry, validates ancestry and applies the owner's current model to every side, without resuming work. */
export async function initializeSideRegistry(owner: SideOwner, context: Context): Promise<void> {
	await owner.root.commit(async (tx) => {
		const sides = (await tx.doc(SideDoc)).sides;
		await validateRows(tx, owner.root.id, sides);
		// A side keeps the model it was forked under unless reopened here; null must clear it too.
		for (const side of sides) await configureSideModel(tx, side.conversationId, owner.model);
	}, context);
}

/** Executes only owner-internal list/start operations; creation never submits input or enables scheduling. */
export async function controlSides(owner: SideOwner, value: unknown, context: Context): Promise<SideResult> {
	const request = parseSideRequest(value);
	if (request.operation === "list") return listSides(owner, context);
	owner.requireActive();
	const fingerprint = sideFingerprint(request);
	const conversationId = await owner.root.commit(async (tx) => {
		owner.requireActive();
		if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Service is held for maintenance.");
		const registry = await tx.doc(SideDoc);
		await validateRows(tx, owner.root.id, registry.sides);
		const receipt = registry.sides.find((side) => side.creation.requestId === request.requestId);
		if (receipt !== undefined) {
			if (receipt.creation.fingerprint !== fingerprint) throw new Error("Side request ID conflicts with the original start.");
			return receipt.conversationId;
		}
		if (registry.sides.length >= SIDE_LIMIT) throw new Error("This Session already has 16 side chats.");
		for (const id of [owner.root.id, ...registry.sides.map((side) => side.conversationId)]) {
			const live = await tx.doc(LiveDoc, id);
			const inbox = await tx.doc(InboxDoc, id);
			if (live.run !== undefined || inbox.items.length > 0) throw new Error(`Chat ${id} has foreground work.`);
		}
		// scanEntries is fork-aware; tx.entry alone would also accept unrelated Session entries.
		const at = request.from as EntryId; // The request parser validated this wire integer before branding it.
		const source = await tx.scanEntries({ conversationId: owner.root.id, minEntryId: at, maxEntryId: at }, 1);
		if (!canStartSide(source.items[0])) throw new Error("Side source is not a completed main reply.");
		const current = await tx.doc(AgentDoc, owner.root.id);
		const child = await tx.forkConversation(owner.root.id, at, { ownership: { kind: "ownerless" } });
		const agent = await tx.doc(AgentDoc, child.id);
		// Clear every key, not a fixed list, so a field Durable adds later cannot keep a historical value from the fork point.
		for (const key of Object.keys(agent)) delete agent[key as keyof typeof agent];
		Object.assign(agent, copyJson(current));
		await configureSideModel(tx, child.id, owner.model);
		registry.sides.push({
			conversationId: child.id,
			parent: { conversationId: owner.root.id, at },
			title: request.title,
			createdAt: Date.now(),
			creation: { requestId: request.requestId, fingerprint },
		});
		return child.id;
	}, context);
	return { operation: "start", conversationId };
}

/** Allows only main or registered, ancestry-validated sides; unrelated Durable IDs remain unavailable. */
export async function resolveSideConversation(owner: SideOwner, target: unknown, context: Context): Promise<Conversation> {
	const id = await owner.root.commit(async (tx) => {
		const sides = (await tx.doc(SideDoc)).sides;
		await validateRows(tx, owner.root.id, sides);
		if (target === undefined || target === owner.root.id) return owner.root.id;
		if (!positiveId(target)) throw new Error("Chat is unavailable.");
		const side = sides.find((side) => side.conversationId === target);
		if (side === undefined) throw new Error("Chat is unavailable.");
		return side.conversationId;
	}, context);
	const conversation = await owner.harness.conversation(id, context);
	if (conversation === undefined) throw new Error("Chat is unavailable.");
	return conversation;
}

/** Identifies committed normal terminal text answers, excluding tool rounds and host display entries. */
export function canStartSide(entry: EntryRecord | undefined): boolean {
	if (!AssistantEntry.is(entry) || entry.model?.length !== 1) return false;
	const message = entry.model[0];
	return message?.role === "assistant" && message.stopReason === "stop" &&
		!message.content.some((block) => block.type === "toolCall") &&
		message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

async function listSides(owner: SideOwner, context: Context): Promise<SideResult> {
	// Snapshots do not initialize missing documents or enable scheduling, even on a legacy held Session.
	const sides = (await owner.harness.snapshot(SideDoc, context))?.sides ?? [];
	await owner.root.commit((tx) => validateRows(tx, owner.root.id, sides), context);
	const state = async (id: ConversationId): Promise<SideChatState> => {
		const live = await owner.harness.snapshot(LiveDoc, id, context);
		const inbox = await owner.harness.snapshot(InboxDoc, id, context);
		return live?.run !== undefined ? "busy" : (inbox?.items.length ?? 0) > 0 ? "queued" : "idle";
	};
	return {
		operation: "list",
		main: { conversationId: owner.root.id, state: await state(owner.root.id) },
		sides: await Promise.all(sides.map(async (side) => ({
			conversationId: side.conversationId,
			parent: side.parent,
			title: side.title,
			createdAt: side.createdAt,
			state: await state(side.conversationId),
		}))),
	};
}

/** Sets a side's model from the owner's launch choice, clearing it when the owner has none. */
async function configureSideModel(tx: Tx, id: ConversationId, model: ModelRef | null): Promise<void> {
	const agent = await tx.doc(AgentDoc, id);
	if (model === null) delete agent.model;
	else agent.model = { ...model };
}

async function validateRows(tx: Tx, main: ConversationId, sides: readonly SideRow[]): Promise<void> {
	if (sides.length > SIDE_LIMIT) throw new Error("Side registry exceeds its limit.");
	const ids = new Set<ConversationId>([main]);
	const receipts = new Set<string>();
	for (const side of sides) {
		const conversation = await tx.conversation(side.conversationId);
		if (
			ids.has(side.conversationId) || receipts.has(side.creation.requestId) ||
			side.parent.conversationId !== main || conversation === undefined || conversation.owner !== undefined ||
			conversation.parent?.conversationId !== main || conversation.parent.at !== side.parent.at
		) throw new Error("Side registry is inconsistent; stop the owner and review stored chat records.");
		ids.add(side.conversationId);
		receipts.add(side.creation.requestId);
	}
}
