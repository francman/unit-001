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
	ConversationId,
	Harness,
	HookApi,
	TaskId,
	ToolExecutionResult,
	ToolHookCall,
} from "@earendil-works/pi-durable";
import { MaintenanceDoc } from "../maintenance.ts";
import { type MissionLocation, matchingApproval, readMissionAuthority } from "./authority.ts";
import { type MissionExecution, MissionExecutionDoc } from "./execution-state.ts";

export const MISSION_PROVIDER_PREFIX = "unit-mission:";

type DispatchOptions = { signal: AbortSignal; maxRetries: 0 };

/** Binds provider admission to the sole owner; ordinary requests keep their existing model service. */
export class MissionAdmission {
	#harness: Harness | undefined;
	#conversation: ConversationId | null = null;
	readonly #freshToolIntents = new Set<TaskId>();
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
	}

	/** Tracks the one created conversation before publishing activation; a rolled-back identity has no runnable work. */
	trackConversation(conversation: ConversationId): void {
		this.#conversation = conversation;
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

	/** Blocks direct and nested calls after authority, lifecycle, maintenance or capability changes. */
	async beforeTool(call: ToolHookCall, api: HookApi, context: Context): Promise<{ block: string } | undefined> {
		if (api.conversationId !== this.#conversation) return undefined;
		const execution = (await api.snapshot(MissionExecutionDoc, context))?.current;
		if (!execution || api.conversationId !== execution.conversation) return undefined;
		if (!(await this.authorized(execution))) return { block: "Mission authority is invalid or expired." };
		if ((await api.snapshot(MaintenanceDoc, context))?.current.state === "held")
			return { block: "Maintenance holds mission tools." };
		if (execution.state.status !== "running" || execution.state.phase !== "execution")
			return { block: "Mission admission is closed." };
		if (!execution.agreement.terms.policy.allowedTools.includes(call.name))
			return { block: "Tool is outside the approved mission capabilities." };
		await this.#harness!.commit(async (tx) => {
			const current = (await tx.doc(MissionExecutionDoc)).current;
			if (
				!current ||
				current.controller !== execution.controller ||
				current.state.status !== "running" ||
				current.state.phase !== "execution"
			)
				throw new Error("Mission admission is closed.");
			if ((await tx.doc(MaintenanceDoc)).current.state === "held")
				throw new Error("Maintenance holds mission tools.");
			if (current.agreement.terms.policy.deadlineAt <= this.#now()) throw new Error("Mission deadline reached.");
			if (current.pendingTools.includes(api.taskId))
				throw new Error("An interrupted mission tool needs reconciliation.");
			current.pendingTools.push(api.taskId);
			current.revision++;
		}, context);
		this.#freshToolIntents.add(api.taskId);
		return undefined;
	}

	/** Settles successful tool intents; failed or interrupted effects remain uncertain until host verification. */
	async afterTool(
		_call: ToolHookCall,
		result: ToolExecutionResult,
		api: HookApi,
		context: Context,
	): Promise<undefined> {
		if (api.conversationId !== this.#conversation) return;
		const fresh = this.#freshToolIntents.delete(api.taskId);
		const rejected = result.diagnostics?.some((item) =>
			["blocked", "invalid_arguments", "tool_unavailable"].includes(item.code ?? ""),
		);
		// Only this invocation's pre-dispatch rejection proves no effect; a replay's block cannot settle old intent.
		if (result.isError && !(fresh && rejected)) return;
		await this.#harness!.commit(async (tx) => {
			const current = (await tx.doc(MissionExecutionDoc)).current;
			if (!current || current.conversation !== api.conversationId || !current.pendingTools.includes(api.taskId))
				return;
			current.pendingTools = current.pendingTools.filter((id) => id !== api.taskId);
			current.revision++;
		}, context);
		return undefined;
	}

	/** Covers generation, automatic retries, compaction and deferred polling through the public Models boundary. */
	models(models: Models): Models {
		const dispatch = (
			model: Model<Api>,
			options: { sessionId?: string; signal?: AbortSignal } | undefined,
			start: (options?: DispatchOptions) => AssistantMessageEventStream,
		) => {
			if (!options?.sessionId?.startsWith(MISSION_PROVIDER_PREFIX)) return start();
			const stream = createAssistantMessageEventStream();
			void this.forward(model, options, start, stream);
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

	private async forward(
		model: Model<Api>,
		options: { sessionId?: string; signal?: AbortSignal },
		start: (options?: DispatchOptions) => AssistantMessageEventStream,
		stream: AssistantMessageEventStream,
	): Promise<void> {
		let reservation: { controller: TaskId<null>; amount: number } | null | undefined;
		let dispatched = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			options.signal?.throwIfAborted();
			const harness = this.#harness;
			if (!harness) throw new Error("Mission owner has not opened.");
			const execution = (await harness.snapshot(MissionExecutionDoc, BACKGROUND_CONTEXT))?.current;
			if (!execution || !(await this.authorized(execution)))
				throw new Error("Mission authority is invalid or expired.");
			reservation = await harness.commit(async (tx) => {
				const current = (await tx.doc(MissionExecutionDoc)).current;
				if (
					!current ||
					current.providerSession !== options.sessionId ||
					current.controller !== execution.controller ||
					current.state.status !== "running" ||
					current.state.phase !== "execution"
				)
					throw new Error("Mission admission is closed.");
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
				return { controller: current.controller, amount: amount ?? 0 };
			}, BACKGROUND_CONTEXT);
			if (reservation === null) throw new Error("Estimated mission spend cannot admit this request.");
			options.signal?.throwIfAborted();
			const deadline = new AbortController();
			timer = setTimeout(
				() => deadline.abort(new Error("Mission deadline reached.")),
				Math.max(1, Math.min(2_147_483_647, execution.agreement.terms.policy.deadlineAt - this.#now())),
			);
			timer.unref();
			const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
			dispatched = true;
			const source = start({ signal, maxRetries: 0 });
			for await (const event of source) {
				if (event.type !== "done" && event.type !== "error") stream.push(event);
			}
			const message = await source.result();
			const reserved = reservation;
			await harness.commit(async (tx) => {
				const current = (await tx.doc(MissionExecutionDoc)).current;
				if (!current || !reserved || current.controller !== reserved.controller) return;
				const cost = message.usage.cost.total;
				// A terminal provider error is a receipt, but cannot prove zero billing: retain its ceiling as reserved spend.
				if (
					message.stopReason === "error" ||
					message.stopReason === "aborted" ||
					!Number.isFinite(cost) ||
					cost < 0 ||
					(cost === 0 && (message.usage.totalTokens > 0 || reserved.amount > 0))
				) {
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
			if (message.stopReason === "error" || message.stopReason === "aborted")
				stream.push({ type: "error", reason: message.stopReason, error: message });
			else
				stream.push({
					type: "done",
					reason: message.stopReason === "pending" ? "stop" : message.stopReason,
					message,
				});
			stream.end(message);
		} catch (error) {
			if (reservation && !dispatched && this.#harness) {
				const reserved = reservation;
				await this.#harness
					.commit(async (tx) => {
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
