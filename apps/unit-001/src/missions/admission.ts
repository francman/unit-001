// Reserves mission-paid provider attempts before dispatch and gates every nested tool call.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type {
	CommitOptions,
	ConversationId,
	Harness,
	HookApi,
	TaskId,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHookCall,
	ToolRegistration,
	Tx,
} from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import { releaseAttempt, reserveAttempt, settleAttempt } from "./allowance.ts";
import { type MissionLocation, matchingApproval, readMissionAuthority } from "./authority.ts";
import type { MissionAuthority } from "./contract.ts";
import { type MissionExecution, MissionExecutionDoc } from "./execution-state.ts";
import { operationDenial } from "./loop.ts";
import { MissionPurposeDoc, storedLoop } from "./purpose.ts";
import { type LoopState, listedWork, loopAgreement } from "./purpose-loop.ts";
import { WORK_TOOL } from "./work-tool.ts";

export const MISSION_PROVIDER_PREFIX = "unit-mission:";

// A deferred handle would be polled later without the mission session, outside admission: never ask for one.
type DispatchOptions = { signal: AbortSignal; maxRetries: 0; deferred: undefined };

// One admitted attempt: one-shot work settles against its controller's ledger, a purpose run against its attempt ID.
type Reservation =
	| { kind: "legacy"; controller: TaskId<null>; amount: number; deadlineAt: number }
	| { kind: "loop"; attemptId: string; amount: number; deadlineAt: number };

/** Binds provider admission to the sole owner; ordinary requests keep their existing model service. */
export class MissionAdmission {
	#harness: Harness | undefined;
	#conversation: ConversationId | null = null;
	readonly #loopConversations = new Set<ConversationId>();
	/** Mission tool tasks admitted in this process and not yet settled: a fresh call or an admitted recovery rerun. */
	readonly #admitted = new Map<TaskId, "fresh" | "replay">();
	readonly #location: MissionLocation;
	readonly #now: () => number;

	constructor(location: MissionLocation, now: () => number = Date.now) {
		this.#location = location;
		this.#now = now;
	}

	/** Attaches the owner before its scheduler is resumed. */
	async bind(harness: Harness, context: Context): Promise<void> {
		this.#harness = harness;
		this.#conversation = (await harness.snapshot(MissionExecutionDoc, context))?.current?.conversation ?? null;
		// Every run conversation stays tracked, so a saved call in a finished run still meets a (denying) decision. Raw
		// stored IDs only route calls to that decision, which validates the stored loop before it admits anything.
		const loop = await harness.snapshot(MissionPurposeDoc, context).then(
			(saved) => saved?.loop,
			() => undefined,
		);
		for (const run of loop?.runs ?? []) this.#loopConversations.add(run.conversation);
	}

	/** Tracks the one created conversation before publishing activation; a rolled-back identity has no runnable work. */
	trackConversation(conversation: ConversationId): void {
		this.#conversation = conversation;
	}

	/** Tracks a purpose run conversation from the commit that admits it; without a run record admission denies it. */
	trackLoopConversation(conversation: ConversationId): void {
		this.#loopConversations.add(conversation);
	}

	/** Reads the protected authority for an admission decision; unreadable or untrusted authority admits nothing. */
	readAuthority(): Promise<MissionAuthority | null> {
		return readMissionAuthority(this.#location).catch(() => null);
	}

	/** Checks the current protected receipt before each mission admission, including restored work. */
	async authorized(
		execution: Pick<MissionExecution, "agreement"> & Partial<Pick<MissionExecution, "intent">>,
	): Promise<boolean> {
		try {
			const authority = await readMissionAuthority(this.#location);
			const agreement = execution.agreement;
			const intent = authority?.executionIntent;
			if (
				this.#location.kind === "managed" &&
				(!intent ||
					!execution.intent ||
					intent.requestId !== execution.intent.requestId ||
					intent.sequence !== execution.intent.sequence)
			)
				return false;
			if (
				intent &&
				(intent.action === "pause" ||
					intent.action === "stop" ||
					intent.missionId !== agreement.missionId ||
					intent.agreementDigest !== agreement.digest ||
					intent.agreementRevision !== agreement.revision ||
					intent.authorityRevision !== authority?.revision)
			)
				return false;
			return (
				authority !== null &&
				agreement.terms.policy.deadlineAt > this.#now() &&
				matchingApproval(
					authority,
					agreement.approval.receiptId,
					agreement.missionId,
					agreement.revision,
					agreement.terms,
				) !== undefined
			);
		} catch {
			return false;
		}
	}

	/**
	 * Records a mission call's intent only under the current decision, read in the same commit: authority, lifecycle,
	 * maintenance, capability, and no earlier intent left unresolved.
	 */
	async beforeTool(call: ToolHookCall, api: HookApi, context: Context): Promise<{ block: string } | undefined> {
		if (this.#loopConversations.has(api.conversationId)) {
			const denial = await this.#harness!.commit(async (tx) => {
				const loop = await storedLoop(tx);
				const denial = await this.#loopDenial(tx, loop, api, call.name);
				if (denial !== undefined) return denial;
				const run = loop!.runs.find((item) => item.conversation === api.conversationId)!;
				if (run.pendingTools.includes(api.taskId)) return "An interrupted mission tool needs reconciliation.";
				run.pendingTools.push(api.taskId);
				this.#admitted.set(api.taskId, "fresh");
				return undefined;
			}, context);
			return denial === undefined ? undefined : { block: denial };
		}
		if (api.conversationId !== this.#conversation) return undefined;
		const denial = await this.#harness!.commit(async (tx) => {
			const current = (await tx.doc(MissionExecutionDoc)).current;
			const held = (await tx.doc(MaintenanceDoc)).current.state === "held";
			const denial = await this.#denial(current, api, call.name, held);
			if (denial !== undefined) return denial;
			if (current!.pendingTools.includes(api.taskId)) return "An interrupted mission tool needs reconciliation.";
			current!.pendingTools.push(api.taskId);
			current!.revision++;
			// Marked inside the commit, so a parallel sibling's admission never sees this intent as unresolved.
			this.#admitted.set(api.taskId, "fresh");
			return undefined;
		}, context);
		return denial === undefined ? undefined : { block: denial };
	}

	/**
	 * Wraps an approved mission action so no effect it commits outlives the decision that admitted it. Durable reruns a
	 * replay-safe tool from its saved `execute` checkpoint without `beforeTool`, so a recovered rerun first meets the
	 * current decision; every mission call's own commits then re-check it in the same transaction as the effect.
	 * Every other conversation keeps the tool unchanged.
	 */
	guard(tool: ToolRegistration): ToolRegistration {
		return {
			...tool,
			execute: async (args, api, context) => {
				if (this.#loopConversations.has(api.conversationId)) return this.#guardLoop(tool, args, api, context);
				if (api.conversationId !== this.#conversation) return tool.execute(args, api, context);
				if (this.#admitted.get(api.taskId) !== "fresh") {
					const execution = (await api.snapshot(MissionExecutionDoc, context))?.current;
					const held = (await api.snapshot(MaintenanceDoc, context))?.current.state === "held";
					const denial = await this.#effectDenial(execution, api, tool.name, held);
					if (denial !== undefined) {
						// Not proof of no effect: the interrupted attempt may have run, so afterTool keeps its intent pending.
						const message = `Tool ${tool.name} was interrupted and may have partially run; it is not run again: ${denial}`;
						return {
							output: [{ type: "text", text: message }],
							isError: true,
							diagnostics: [{ severity: "error", code: "interrupted", message }],
						};
					}
					this.#admitted.set(api.taskId, "replay");
				}
				return tool.execute(args, this.#gated(api, tool.name), context);
			},
		};
	}

	/**
	 * The purpose-run counterpart of `guard`: a recovered call first meets the current decision, and every commit the
	 * call makes (the work tool's fence included) re-checks it inside that transaction, authority read included.
	 */
	async #guardLoop(
		tool: ToolRegistration,
		args: Parameters<ToolRegistration["execute"]>[0],
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		const decide = async (tx: Tx) => this.#loopDenial(tx, await storedLoop(tx), api, tool.name, { pending: true });
		if (this.#admitted.get(api.taskId) !== "fresh") {
			// A read-only transaction: nothing commits, the decision is read on the Session line like an effect's.
			const denial = await api.commit(decide, context);
			if (denial !== undefined) {
				const message = `Tool ${tool.name} was interrupted and may have partially run; it is not run again: ${denial}`;
				return {
					output: [{ type: "text", text: message }],
					isError: true,
					diagnostics: [{ severity: "error", code: "interrupted", message }],
				};
			}
			this.#admitted.set(api.taskId, "replay");
		}
		const commit = <T>(change: (tx: Tx) => T | Promise<T>, inner: Context, options?: CommitOptions) =>
			api.commit(
				async (tx): Promise<T> => {
					const denial = await decide(tx);
					// Throwing rolls the effect back; the intent stays pending, since earlier work may have run.
					if (denial !== undefined) throw new Error(`Mission effect not committed: ${denial}`);
					return change(tx);
				},
				inner,
				options,
			);
		return tool.execute(args, Object.create(api, { commit: { value: commit } }), context);
	}

	/**
	 * The decision for one purpose-run action, read inside the caller's transaction: the run is admitted and executing,
	 * the action is the run's work tool, no hold, no unresolved sibling, and protected authority (read now) still opens
	 * this operation. With `pending`, the call's own intent must also still be pending. A stored loop that failed
	 * validation (`undefined`) admits nothing.
	 */
	async #loopDenial(
		tx: Tx,
		loop: LoopState | undefined,
		call: Pick<HookApi, "conversationId" | "taskId">,
		name: string,
		options: { pending?: true } = {},
	): Promise<string | undefined> {
		if (!loop) return "Mission purpose records are invalid.";
		const run = loop.runs.find((item) => item.conversation === call.conversationId);
		if (!run || run.state.status !== "running" || run.state.phase !== "execution") return "Mission admission is closed.";
		if (name !== WORK_TOOL) return "Tool is outside the approved purpose capability.";
		if ((await tx.doc(MaintenanceDoc)).current.state === "held") return "Maintenance holds mission tools.";
		if (options.pending && !run.pendingTools.includes(call.taskId)) return "Mission admission is closed.";
		if (run.pendingTools.some((id) => id !== call.taskId && !this.#admitted.has(id)))
			return "An interrupted mission tool needs reconciliation.";
		const denial = operationDenial(await this.readAuthority(), loop, run.sequence, this.#now());
		return denial === undefined ? undefined : `Mission authority is closed: ${denial}.`;
	}

	/** The tool's api with `commit` fenced: the effect commits only if its decision still holds inside that commit. */
	#gated(api: ToolExecutionApi, name: string): ToolExecutionApi {
		const commit = <T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions) =>
			api.commit(
				async (tx): Promise<T> => {
					const current = (await tx.doc(MissionExecutionDoc)).current;
					const held = (await tx.doc(MaintenanceDoc)).current.state === "held";
					const denial = await this.#effectDenial(current, api, name, held);
					// Throwing rolls the effect back; afterTool keeps the intent uncertain, since earlier work may have run.
					if (denial !== undefined) throw new Error(`Mission effect not committed: ${denial}`);
					return change(tx);
				},
				context,
				options,
			);
		// Durable's api is a plain object of closures and getters; delegating keeps its getters live.
		return Object.create(api, { commit: { value: commit } });
	}

	/** The decision for an admitted intent: it must still be pending, and the current decision must still allow it. */
	async #effectDenial(
		execution: MissionExecution | null | undefined,
		call: Pick<HookApi, "conversationId" | "taskId">,
		name: string,
		held: boolean,
	): Promise<string | undefined> {
		return (
			(await this.#denial(execution, call, name, held)) ??
			(execution!.pendingTools.includes(call.taskId) ? undefined : "Mission admission is closed.")
		);
	}

	/**
	 * The current admission decision for one mission action, shared by fresh calls, recovered reruns and their commits.
	 * Protected authority lives outside storage: callers that hold a transaction read it under that transaction, so a
	 * publication completed before the read closes the effect, and the owner's acknowledging commit orders after it.
	 */
	async #denial(
		execution: MissionExecution | null | undefined,
		call: Pick<HookApi, "conversationId" | "taskId">,
		name: string,
		held: boolean,
	): Promise<string | undefined> {
		if (!execution || execution.conversation !== call.conversationId) return "Mission admission is closed.";
		if (!(await this.authorized(execution))) return "Mission authority is invalid or expired.";
		if (held) return "Maintenance holds mission tools.";
		if (execution.state.status !== "running" || execution.state.phase !== "execution")
			return "Mission admission is closed.";
		if (!execution.agreement.terms.policy.allowedTools.includes(name))
			return "Tool is outside the approved mission capabilities.";
		// An intent no call in this process is running has an unknown outcome; nothing new runs beside it.
		if (execution.pendingTools.some((id) => id !== call.taskId && !this.#admitted.has(id)))
			return "An interrupted mission tool needs reconciliation.";
		return undefined;
	}

	/** Settles successful tool intents; failed or interrupted effects remain uncertain until host verification. */
	async afterTool(
		_call: ToolHookCall,
		result: ToolExecutionResult,
		api: HookApi,
		context: Context,
	): Promise<undefined> {
		const loopRun = this.#loopConversations.has(api.conversationId);
		if (!loopRun && api.conversationId !== this.#conversation) return;
		const fresh = this.#admitted.get(api.taskId) === "fresh";
		try {
			const rejected = result.diagnostics?.some((item) =>
				["blocked", "invalid_arguments", "tool_unavailable"].includes(item.code ?? ""),
			);
			// Only this invocation's pre-dispatch rejection proves no effect; a replay's block cannot settle old intent.
			if (result.isError && !(fresh && rejected)) return;
			await this.#harness!.commit(async (tx) => {
				if (loopRun) {
					// An invalid stored loop settles nothing: the intent stays pending, which only keeps admission closed.
					const run = (await storedLoop(tx))?.runs.find((item) => item.conversation === api.conversationId);
					if (run) run.pendingTools = run.pendingTools.filter((id) => id !== api.taskId);
					return;
				}
				const current = (await tx.doc(MissionExecutionDoc)).current;
				if (!current || current.conversation !== api.conversationId || !current.pendingTools.includes(api.taskId))
					return;
				current.pendingTools = current.pendingTools.filter((id) => id !== api.taskId);
				current.revision++;
			}, context);
		} finally {
			// Released only after settling, so a running sibling never sees a settling success as unresolved.
			this.#admitted.delete(api.taskId);
		}
		return undefined;
	}

	/** Covers generation, automatic retries and compaction; a mission request never leaves a deferred handle to poll. */
	models(models: Models): Models {
		const dispatch = (
			model: Model<Api>,
			options: { sessionId?: string; signal?: AbortSignal } | undefined,
			start: (options?: DispatchOptions) => AssistantMessageEventStream,
		) => {
			if (!options?.sessionId?.startsWith(MISSION_PROVIDER_PREFIX)) return start();
			const stream = createAssistantMessageEventStream();
			void this.forward(models, model, options, start, stream);
			return stream;
		};
		return {
			getProviders: models.getProviders.bind(models),
			getProvider: models.getProvider.bind(models),
			getModels: models.getModels.bind(models),
			getModel: models.getModel.bind(models),
			getModelsOfType: models.getModelsOfType.bind(models),
			getModelOfType: models.getModelOfType.bind(models),
			getAllModels: models.getAllModels.bind(models),
			refresh: models.refresh.bind(models),
			checkAuth: models.checkAuth.bind(models),
			getAvailable: models.getAvailable.bind(models),
			getAvailableOfType: models.getAvailableOfType.bind(models),
			getAllAvailable: models.getAllAvailable.bind(models),
			getAuth: models.getAuth.bind(models),
			login: models.login.bind(models),
			logout: models.logout.bind(models),
			stream: (model, transcript, options) =>
				dispatch(model, options, (guard) => models.stream(model, transcript, requestOptions(options, guard))),
			complete: (model, transcript, options) =>
				dispatch(model, options, (guard) =>
					models.stream(model, transcript, requestOptions(options, guard)),
				).result(),
			streamSimple: (model, transcript, options) =>
				dispatch(model, options, (guard) => models.streamSimple(model, transcript, requestOptions(options, guard))),
			completeSimple: (model, transcript, options) =>
				dispatch(model, options, (guard) =>
					models.streamSimple(model, transcript, requestOptions(options, guard)),
				).result(),
			streamDeferred: (model, handle, options) =>
				dispatch(model, options, (guard) => models.streamDeferred(model, handle, requestOptions(options, guard))),
			fetchDeferred: (model, handle, options) =>
				dispatch(model, options, (guard) =>
					models.streamDeferred(model, handle, requestOptions(options, guard)),
				).result(),
			cancelDeferred: models.cancelDeferred.bind(models),
			generateImages: models.generateImages.bind(models),
			classify: models.classify.bind(models),
		};
	}

	/**
	 * Reserves one purpose-run attempt in the caller's commit: the exact run owning this provider session, executing,
	 * no hold, protected authority read now, then the lifetime allowance charged with this attempt's own record.
	 */
	async #reserveLoop(tx: Tx, sessionId: string | undefined, model: Model<Api>): Promise<Reservation> {
		const loop = await storedLoop(tx);
		if (!loop) throw new Error("Mission purpose records are invalid.");
		const run = loop.runs.find((item) => item.providerSession === sessionId);
		if (!run || run.state.status !== "running" || run.state.phase !== "execution")
			throw new Error("Mission admission is closed.");
		const denial = operationDenial(await this.readAuthority(), loop, run.sequence, this.#now());
		if (denial !== undefined) throw new Error(`Mission authority is closed: ${denial}.`);
		if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Maintenance holds mission requests.");
		const agreement = loopAgreement(loop, run.purposeRevision)!;
		const reserved = reserveAttempt(
			loop,
			run,
			listedWork(agreement, run.workId)!,
			agreement.terms.lifetime,
			requestCostCeiling(model),
		);
		if ("denial" in reserved) throw new Error(reserved.denial);
		return {
			kind: "loop",
			attemptId: reserved.attempt.attemptId,
			amount: reserved.attempt.ceiling ?? 0,
			deadlineAt: agreement.terms.lifetime.deadlineAt,
		};
	}

	private async forward(
		models: Models,
		model: Model<Api>,
		options: { sessionId?: string; signal?: AbortSignal },
		start: (options?: DispatchOptions) => AssistantMessageEventStream,
		stream: AssistantMessageEventStream,
	): Promise<void> {
		let reservation: Reservation | null | undefined;
		let dispatched = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			options.signal?.throwIfAborted();
			const harness = this.#harness;
			if (!harness) throw new Error("Mission owner has not opened.");
			reservation = await harness.commit(async (tx): Promise<Reservation | null> => {
				const current = (await tx.doc(MissionExecutionDoc)).current;
				if (current?.providerSession !== options.sessionId) return this.#reserveLoop(tx, options.sessionId, model);
				if (
					!current ||
					current.providerSession !== options.sessionId ||
					current.state.status !== "running" ||
					current.state.phase !== "execution"
				)
					throw new Error("Mission admission is closed.");
				// Read under the reservation commit, as for tool effects: a completed publication closes this attempt.
				if (!(await this.authorized(current))) throw new Error("Mission authority is invalid or expired.");
				if ((await tx.doc(MaintenanceDoc)).current.state === "held")
					throw new Error("Maintenance holds mission requests.");
				const policy = current.agreement.terms.policy;
				if (policy.deadlineAt <= this.#now() || current.requests >= policy.maxRequests)
					throw new Error("Mission request limit or deadline reached.");
				if (current.unknownRequests !== 0) throw new Error("An interrupted mission request needs reconciliation.");
				if (current.pendingTools.length !== 0) throw new Error("An interrupted mission tool needs reconciliation.");
				const amount = requestCostCeiling(model);
				if (
					policy.maxEstimatedCost !== undefined &&
					(amount === null || current.estimatedCost + current.reservedCost + amount > policy.maxEstimatedCost)
				) {
					current.state = { status: "blocked", reason: "estimated_spend_limit" };
					current.revision++;
					return null;
				}
				current.requests++;
				current.unknownRequests++;
				current.reservedCost += amount ?? 0;
				current.revision++;
				return {
					kind: "legacy",
					controller: current.controller,
					amount: amount ?? 0,
					deadlineAt: policy.deadlineAt,
				};
			}, BACKGROUND_CONTEXT);
			if (reservation === null) throw new Error("Estimated mission spend cannot admit this request.");
			options.signal?.throwIfAborted();
			const deadline = new AbortController();
			timer = setTimeout(
				() => deadline.abort(new Error("Mission deadline reached.")),
				Math.max(1, Math.min(2_147_483_647, reservation.deadlineAt - this.#now())),
			);
			timer.unref();
			const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
			dispatched = true;
			const source = start({ signal, maxRetries: 0, deferred: undefined });
			for await (const event of source) {
				if (event.type !== "done" && event.type !== "error") stream.push(event);
			}
			const received = await source.result();
			// A provider that defers anyway: Durable would poll the handle without the mission session, outside admission.
			// Cancel it and end the attempt as an unpriced error; the remote work may be billed, so the reservation stays.
			if (received.stopReason === "deferred" && received.deferred)
				await models.cancelDeferred(model, received.deferred).catch(() => {});
			const { deferred: _handle, ...settled } = received;
			// Only a stop, length or tool-use reason is the provider's terminal receipt. A stream can also close with a
			// partial ("pending") result, which proves nothing about what the provider did: it is passed on as an error
			// and settles nothing.
			const terminal = terminalReason(received.stopReason);
			const message: AssistantMessage =
				received.stopReason === "deferred"
					? { ...settled, stopReason: "error", errorMessage: "Mission requests cannot be deferred; it was cancelled." }
					: received.stopReason === "pending"
						? { ...settled, stopReason: "error", errorMessage: "The provider response ended without a stop reason." }
						: received;
			const reserved = reservation;
			const cost = message.usage.cost.total;
			// A terminal provider error is a receipt, but cannot prove zero billing: retain its ceiling as reserved spend.
			const unpriced =
				message.stopReason === "error" ||
				message.stopReason === "aborted" ||
				!Number.isFinite(cost) ||
				cost < 0 ||
				(cost === 0 && (message.usage.totalTokens > 0 || reserved.amount > 0));
			await harness.commit(async (tx) => {
				// Settled by its exact attempt ID: a delayed or duplicate receipt can touch only its own attempt, once.
				if (reserved.kind === "loop") {
					// An error, abort or partial response may be a dropped transport after the provider received the
					// request: it stays reserved, charged and blocking until verified evidence or an acknowledgment.
					if (terminal === undefined) return;
					const loop = await storedLoop(tx);
					if (loop) settleAttempt(loop, reserved.attemptId, unpriced ? null : cost);
					return;
				}
				// A terminal provider error is a receipt here; a partial response is none, so the request stays unknown.
				if (received.stopReason === "pending") return;
				const current = (await tx.doc(MissionExecutionDoc)).current;
				if (!current || current.controller !== reserved.controller) return;
				if (unpriced) {
					current.unknownRequests--;
					current.unpricedResponses++;
					current.revision++;
					return;
				}
				current.estimatedCost += cost;
				current.reservedCost = Math.max(0, current.reservedCost - reserved.amount);
				current.unknownRequests--;
				current.revision++;
			}, BACKGROUND_CONTEXT);
			if (terminal !== undefined) stream.push({ type: "done", reason: terminal, message });
			else
				stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			stream.end(message);
		} catch (error) {
			if (reservation && !dispatched && this.#harness) {
				const reserved = reservation;
				await this.#harness
					.commit(async (tx) => {
						// Provably never sent: the attempt's request and reservation are returned.
						if (reserved.kind === "loop") {
							const loop = await storedLoop(tx);
							if (loop) releaseAttempt(loop, reserved.attemptId);
							return;
						}
						const current = (await tx.doc(MissionExecutionDoc)).current;
						if (!current || current.controller !== reserved.controller) return;
						current.unknownRequests--;
						current.reservedCost = Math.max(0, current.reservedCost - reserved.amount);
						current.revision++;
					}, BACKGROUND_CONTEXT)
					.catch(() => {});
			}
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : "Mission request denied.",
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
		} finally {
			clearTimeout(timer);
		}
	}
}

function terminalReason(reason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" | undefined {
	return reason === "stop" || reason === "length" || reason === "toolUse" ? reason : undefined;
}

function requestCostCeiling(model: Model<Api>): number | null {
	const rates = [model.cost, ...(model.cost.tiers ?? [])];
	const input = Math.max(...rates.flatMap((rate) => [rate.input, rate.cacheRead, rate.cacheWrite, rate.input * 2]));
	const output = Math.max(...rates.map((rate) => rate.output));
	if (
		![input, output, model.contextWindow, model.maxTokens].every(Number.isFinite) ||
		input < 0 ||
		output < 0 ||
		input + output === 0
	)
		return null;
	return (model.contextWindow * input + model.maxTokens * output) / 1_000_000;
}

function requestOptions<T extends object>(options: T | undefined, guard: DispatchOptions | undefined): T | undefined {
	// Both overrides belong to the shared provider options; provider-specific fields retain their exact generic shape.
	return guard ? ({ ...options, ...guard } as T) : options;
}
