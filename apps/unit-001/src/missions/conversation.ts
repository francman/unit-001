// Creates the bounded, task-owned conversation a mission run, research child or review turn executes in.
import { randomUUID } from "node:crypto";
import { AgentDoc, type ConversationId, ProviderDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { ModelChoice } from "../provider.ts";

/** What one mission conversation may do; admission recognises its requests by the provider session `prefix`. */
export type MissionConversationTerms = {
	model: ModelChoice;
	/** The enabled tools, exactly these. */
	tools: readonly string[];
	/** The tools offered to the model, exactly these; `null` leaves Durable's default (every enabled, non-deferred tool). */
	modelTools: readonly string[] | null;
	maxTurns: number;
	prefix: string;
};

/**
 * Creates one conversation owned by `taskId` with these terms and a fresh provider session, in the caller's commit;
 * nothing is submitted. The caller tracks the conversation with admission in the same commit.
 */
export async function createMissionConversation(
	tx: Tx,
	taskId: TaskId,
	terms: MissionConversationTerms,
): Promise<{ id: ConversationId; providerSession: string }> {
	const conversation = await tx.createConversation({ ownership: { kind: "task", taskId } });
	const agent = await tx.doc(AgentDoc, conversation.id);
	agent.model = terms.model;
	// Own arrays: Durable appends loaded tools to the stored lists, which must never alias a constant or each other.
	agent.tools = [...terms.tools];
	if (terms.modelTools !== null) agent.modelTools = [...terms.modelTools];
	agent.maxTurns = terms.maxTurns;
	const providerSession = `${terms.prefix}${randomUUID()}`;
	(await tx.doc(ProviderDoc, conversation.id)).sessionId = providerSession;
	return { id: conversation.id, providerSession };
}
