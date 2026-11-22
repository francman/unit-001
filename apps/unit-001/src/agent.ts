import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type Conversation,
	type ConversationWatch,
	createRegistry,
	type Cursor,
	defineEntry,
	defineExtension,
	defineTool,
	type EntryId,
	type EntryRecord,
	type Extension,
	Harness,
	LiveDoc,
	type LiveState,
	type Report,
	type Storage,
	type Submission,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createPowerShellTool } from "@earendil-works/pi-durable/tools";
import {
	createMemoryExtension,
	forgetMemory,
	isMemoryBackgroundTask,
	MemoryDoc,
	MemoryInputEntry,
	type MemoryRelationRequest,
	type MemoryService,
	memoryGraph,
	MemoryRelationsDoc,
	memoryStats,
	reconcileMemoryLayout,
	reconcileMemoryTasks,
	recordMemoryInput,
	rememberMemory,
	scheduleMemoryConsolidation,
} from "unit-memory";
import type { ChannelCommand, ChannelResult } from "./channels/control.ts";
import { ChannelOwner, defaultChannelHost } from "./channels/owner.ts";
import type { CommandSurface } from "./commands/catalog.ts";
import { HostFactEntry, isOperatingSystemQuestion } from "./commands/facts.ts";
import { type CommandInterpretation, type InterpretationUsage, interpretCommand } from "./commands/interpretation.ts";
import { resolveLocalCommand } from "./commands/resolution.ts";
import { ConfigurationError } from "./errors.ts";
import { environmentSecrets } from "./evidence-redaction.ts";
import { recordedCodingTools } from "./file-provenance.ts";
import type { InspectionQuery, InspectionReport } from "./introspection/contract.ts";
import { introspectionExtension } from "./introspection/extension.ts";
import { operatingSystemFacts, renderOperatingSystemFacts } from "./introspection/os.ts";
import { type InspectionReader, ownerInspectionExtension } from "./introspection/owner-extension.ts";
import { inspectAgent } from "./introspection/report.ts";
import { MaintenanceDoc, type MaintenanceResult, type MaintenanceState, validateOperationId } from "./maintenance.ts";
import { type MemoryRequest, type MemoryResult, parseMemoryRequest } from "./memory-control.ts";
import { MissionAdmission } from "./missions/admission.ts";
import type { MissionLocation } from "./missions/authority.ts";
import type { MissionRequest, MissionView } from "./missions/contract.ts";
import { MissionControl } from "./missions/control.ts";
import { missionController } from "./missions/controller.ts";
import { missionDraftTool } from "./missions/draft-tool.ts";
import { MissionOwner } from "./missions/owner.ts";
import { isLoopTask, loopParkedForMaintenance } from "./missions/loop-drain.ts";
import { MissionPurposeDoc } from "./missions/purpose.ts";
import { validLoop } from "./missions/purpose-loop.ts";
import { isMissionHoldTask, MissionDoc, MissionFoundation } from "./missions/state.ts";
import { createRuntimeFacts, orientationExtension, type RuntimeFacts } from "./orientation.ts";
import type { ModelChoice } from "./provider.ts";
import {
	checkSendReplay,
	recordSendReceipt,
	type SendAdmission,
	SendReceiptsDoc,
	sendAdmission,
	sendDigest,
} from "./send-receipt.ts";
import { type ChatHistoryPage, projectChatHistoryPage } from "./service-view.ts";
import type { SideRequest, SideResult } from "./side-control.ts";
import { controlSides, initializeSideRegistry, type SideOwner } from "./side.ts";
import { type EvidenceScope, EVIDENCE_SCAN_ENTRIES, projectToolEvidence, type ToolEvidence } from "./tool-evidence.ts";

export interface AgentOptions {
	readonly storage: Storage;
	readonly name?: string;
	/** The installed unit-001 version, stated in the agent's identity; omitted when the host does not know it. */
	readonly version?: string;
	readonly models: Models;
	readonly model: ModelChoice | null;
	readonly mission?: MissionLocation;
	/** Private host-selected channel credential directory; no credential value enters agent configuration. */
	readonly channelCredentialsDirectory?: string;
	/** The working directory tools run in. */
	readonly cwd: string;
	readonly platform?: NodeJS.Platform;
	/** Further extensions to install, such as memory. */
	readonly extensions?: readonly Extension[];
	readonly onReport?: (report: Report) => void;
	readonly startup?: { readonly kind: "active" | "inhibited" };
}

export type Reply =
	| { readonly status: "answered"; readonly text: string }
	| { readonly status: "failed"; readonly reason: string; readonly detail?: string };

type Message = { readonly role?: string; readonly content?: unknown };

const MemoryOperatorEntry = defineEntry<{
	operation: "remember";
	content: string;
	relations?: MemoryRelationRequest[];
}>("unit.memory.operator");
const CommandInterpretationEntry = defineEntry<{ usage: InterpretationUsage }>("unit.command.interpretation");

function textOf(message: Message | undefined): string | undefined {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return (message.content as readonly { type: string; text?: string }[])
		.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
		.join("");
}

/** The unit-001 agent: one durable root conversation on a Pi Durable harness. */
export class Agent {
	readonly #harness: Harness;
	readonly name: string;
	readonly #root: Conversation;
	readonly #runtime: () => RuntimeFacts;
	readonly #memory: MemoryService;
	readonly #mission: MissionOwner;
	readonly #channels: ChannelOwner;
	readonly #sides: SideOwner;
	readonly #configuration: "configured" | "unconfigured";
	readonly #models: Models;
	readonly #model: ModelChoice | null;
	readonly #inspect: InspectionReader;
	readonly #evidence: EvidenceScope;
	readonly #interpretations = new Map<AbortController, Promise<void>>();
	#inhibited: boolean;
	#closing = false;
	/** True when a run was unfinished at open; it resumes only when execution is not inhibited. */
	readonly interrupted: boolean;

	private constructor(
		harness: Harness,
		root: Conversation,
		interrupted: boolean,
		name: string,
		inhibited: boolean,
		runtime: () => RuntimeFacts,
		memory: MemoryService,
		mission: MissionOwner,
		channels: ChannelOwner,
		configuration: "configured" | "unconfigured",
		models: Models,
		model: ModelChoice | null,
		inspect: InspectionReader,
		evidence: EvidenceScope,
	) {
		this.name = name;
		this.#harness = harness;
		this.#root = root;
		this.interrupted = interrupted;
		this.#inhibited = inhibited;
		this.#runtime = runtime;
		this.#memory = memory;
		this.#mission = mission;
		this.#channels = channels;
		this.#configuration = configuration;
		this.#models = models;
		this.#model = model;
		this.#inspect = inspect;
		this.#evidence = evidence;
		this.#sides = { harness, root, model, requireActive: () => this.requireActive() };
	}

	/** Opens the session, resuming unfinished work only outside startup inhibition and persistent maintenance holds. */
	static async open(options: AgentOptions, context: Context): Promise<Agent> {
		const name = options.name ?? "agent";
		const runtime = createRuntimeFacts(name, options.model);
		const memory = createMemoryExtension();
		const registry = createRegistry();
		const missionLocation = options.mission ?? {
			kind: "developer-local" as const,
			directory: options.cwd,
			session: "default",
		};
		const missionAdmission = new MissionAdmission(missionLocation);
		const missionExecution = missionController(missionAdmission, options.cwd);
		const channelDirectory = options.channelCredentialsDirectory ?? join(options.cwd, ".unit-channels");
		const channels = defaultChannelHost(missionLocation, channelDirectory);
		const credentialRoots = ["/etc/unit-001", channelDirectory];
		registry.install(recordedCodingTools(credentialRoots));
		if ((options.platform ?? process.platform) === "win32") {
			registry.install(defineExtension({ name: "powershell", tools: [createPowerShellTool()] }));
		}
		registry.install(orientationExtension(runtime, options.version));
		registry.install(introspectionExtension());
		let inspect!: InspectionReader;
		registry.install(ownerInspectionExtension((query, ctx) => inspect(query, ctx)));
		registry.install(channels.extension);
		registry.install(memory.extension);
		registry.install(MissionFoundation);
		registry.install(missionExecution.extension);
		let mission!: MissionOwner;
		registry.install(
			defineExtension({
				name: "unit.mission.inspection",
				tools: [
					defineTool({
						name: "unit_mission_status",
						description:
							"Inspect the saved mission draft/agreement and approval provenance; this never starts autonomous work.",
						parameters: Type.Object({}),
						replay: "safe",
						execute: async (_args, _api, ctx) => ({
							output: [{ type: "text", text: JSON.stringify(await mission.inspect(ctx)) }],
						}),
					}),
					missionDraftTool((request, ctx) => mission.handle(request, ctx)),
				],
			}),
		);
		for (const extension of options.extensions ?? []) registry.install(extension);

		const harness = await Harness.open(
			options.storage,
			{
				models: missionAdmission.models(options.models),
				registry,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
				...(options.onReport === undefined ? {} : { onReport: options.onReport }),
			},
			context,
		);
		try {
			// Before anything reads memory: stored memory must be in the layout every supported reader opens.
			await reconcileMemoryLayout(harness, context);
			await missionAdmission.bind(harness, context);
			const root = await harness.root(context, { agent: options.model === null ? {} : { model: options.model } });
			// The model is stored with the session; this launch's choice wins, so changing provider keys never strands it.
			const stored = (await root.agent(context)).model;
			if (
				options.model !== null &&
				(stored?.provider !== options.model.provider || stored.modelId !== options.model.modelId)
			) {
				await root.configure({ model: options.model }, context);
			}
			const interrupted = (await harness.snapshot(LiveDoc, root.id, context))?.run !== undefined;
			const held = await harness.commit(async (tx) => {
				await tx.doc(MissionDoc);
				return (await tx.doc(MaintenanceDoc)).current.state === "held";
			}, context);
			const inhibited = options.startup?.kind === "inhibited" || held;
			const formation = new MissionControl(harness, missionLocation, [
				...new Set(
					registry
						.snapshot()
						.tools()
						.map((item) => item.tool.name),
				),
			]);
			mission = new MissionOwner(
				harness,
				formation,
				missionLocation,
				registry,
				missionAdmission,
				missionExecution,
				options.model,
				options.cwd,
			);
			await mission.initialize(context);
			const channelOwner = new ChannelOwner(harness, channels);
			const inspectionHost = {
				harness,
				runtime,
				mission,
				channels: channelOwner,
				tools: registry
					.snapshot()
					.tools()
					.map((item) => item.tool.name),
				workspace: options.cwd,
				implementationRoot: fileURLToPath(new URL("../", import.meta.url)),
			};
			inspect = (query, ctx) => inspectAgent(query, inspectionHost, ctx);
			const agent = new Agent(
				harness,
				root,
				interrupted,
				name,
				inhibited,
				runtime,
				memory,
				mission,
				channelOwner,
				options.model === null ? "unconfigured" : "configured",
				options.models,
				options.model,
				inspect,
				{ cwd: options.cwd, secrets: environmentSecrets(), credentialRoots },
			);
			await initializeSideRegistry(agent.#sides, context);
			const legacy = (await harness.snapshot(MissionDoc, context))?.current ?? null;
			const pending = options.model === null ? await harness.inspect(context) : undefined;
			const canSchedule =
				pending === undefined ||
				(pending.submissions.length === 0 &&
					pending.tasks.every((task) => isMemoryBackgroundTask(task.record) || isMissionHoldTask(task.record, legacy)));
			if (!inhibited && canSchedule) {
				await mission.initialize(context, "permitted");
				await root.commit((tx) => reconcileMemoryTasks(tx, root.id, Date.now()), context);
				memory.recall.prepare(
					await harness.snapshot(MemoryDoc, context),
					await harness.snapshot(MemoryRelationsDoc, context),
				);
				harness.resume();
			}
			return agent;
		} catch (error) {
			await harness.close(context).catch(() => {});
			memory.close();
			throw error;
		}
	}

	/**
	 * Durably admits a prompt and returns without waiting for the answer. A `requestId` makes a retry after a restart
	 * find the same submission instead of submitting twice; a fresh one is bound to the exact prompt, so a retry with
	 * different text is refused. A retry of an ID admitted without a receipt (before receipts, or evicted) is refused
	 * too: nothing left can show that its prompt matches, and answering it could return another prompt's reply.
	 */
	async submit(text: string, context: Context, options: { readonly requestId?: string } = {}): Promise<Submission> {
		this.requireActive();
		if (this.#configuration === "unconfigured")
			throw new ConfigurationError(
				`No provider is configured. Run ${this.name} setup (sudo for a managed installation), then restart the owner. Mission drafting remains available without a provider.`,
			);
		const { requestId } = options;
		const id = await this.#root.commit(async (tx) => {
			if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Service is held for maintenance.");
			let fresh: ((id: SubmissionId) => void) | undefined;
			if (requestId !== undefined) {
				const digest = sendDigest(text);
				const receipts = await tx.doc(SendReceiptsDoc, this.#root.id);
				// Read before admission writes, which would create the submission this checks for.
				const admitted = (await tx.submissionByRequest(this.#root.id, requestId)) !== undefined;
				checkSendReplay(receipts, requestId, digest, admitted);
				if (!admitted) fresh = (id) => recordSendReceipt(receipts, requestId, digest, id);
			}
			const id = await this.#root.submit(tx, {
				type: "input",
				content: text,
				entry: { kind: MemoryInputEntry.kind, data: { origin: "human" } },
				...(requestId === undefined ? {} : { requestId }),
			});
			fresh?.(id);
			await recordMemoryInput(tx, this.#root.id, id, "human", text);
			return id;
		}, context);
		const submission = await this.#harness.submission(id, context);
		if (submission === undefined) throw new Error("Admitted submission is unavailable.");
		return submission;
	}

	/** Submits a prompt and waits for its answer. */
	async ask(text: string, context: Context, options: { readonly requestId?: string } = {}): Promise<Reply> {
		if (options.requestId !== undefined || isOperatingSystemQuestion(text)) {
			const factual = await this.hostFactReply(text, context, options.requestId);
			if (factual !== undefined) return { status: "answered", text: factual };
		}
		const settled = await (await this.submit(text, context, options)).wait(context);
		if (settled.status === "done" && settled.type === "input") {
			const entry = await this.#root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			return { status: "answered", text: textOf(entry?.model?.[0] as Message | undefined) ?? "" };
		}
		const reason = settled.status === "unanswered" ? settled.reason : settled.status;
		const detail =
			settled.detail === undefined
				? undefined
				: typeof settled.detail === "string"
					? settled.detail
					: JSON.stringify(settled.detail);
		return { status: "failed", reason, ...(detail === undefined ? {} : { detail }) };
	}

	private async hostFactReply(text: string, context: Context, requestId?: string): Promise<string | undefined> {
		const recognized = isOperatingSystemQuestion(text);
		// Collect outside the storage transaction; retry receipts remain authoritative over this observation.
		const facts = recognized ? await operatingSystemFacts() : undefined;
		return this.#root.commit(async (tx) => {
			if (requestId !== undefined) {
				const previous = await tx.submissionByRequest(this.#root.id, requestId);
				if (previous !== undefined) {
					if (previous.type !== "write" || previous.status !== "done") return undefined;
					const entry = await tx.entry(HostFactEntry, previous.entry);
					if (entry === undefined) return undefined;
					if (entry.data.input !== text) throw new Error("Host request ID conflicts with the original input.");
					return entry.data.text;
				}
			}
			if (facts === undefined) return undefined;
			this.requireActive();
			if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Service is held for maintenance.");
			const answer = renderOperatingSystemFacts(facts);
			await tx.appendEntry(HostFactEntry, this.#root.id, { data: { role: "user", text, input: text, facts: null } });
			const entry = await tx.appendEntry(HostFactEntry, this.#root.id, {
				data: { role: "assistant", text: answer, input: text, facts },
			});
			// Display-only admission intentionally avoids submit()/wait(), which resume suspended scheduler work.
			await tx.createSubmission({
				conversationId: this.#root.id,
				type: "write",
				status: "done",
				entry: entry.id,
				...(requestId === undefined ? {} : { requestId }),
			});
			return answer;
		}, context);
	}

	/** Suggests existing commands without coding tools or execution; only unresolved input can use the configured model. */
	async resolveCommand(
		input: string,
		surface: CommandSurface,
		context: Context,
		signal: AbortSignal,
	): Promise<CommandInterpretation> {
		if (resolveLocalCommand(input, surface).kind !== "unresolved")
			return interpretCommand(input, surface, this.#models, this.#model, signal);
		this.requireActive();
		const controller = new AbortController();
		let finish = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		// Register before the first await so maintenance cannot declare an in-flight request drained.
		this.#interpretations.set(controller, done);
		try {
			if ((await this.#harness.snapshot(MaintenanceDoc, context))?.current.state === "held")
				throw new Error("Service is held for maintenance.");
			const result = await interpretCommand(
				input,
				surface,
				this.#models,
				this.#model,
				AbortSignal.any([signal, controller.signal]),
			);
			const usage = result.usage;
			if (usage !== null)
				await this.#root.commit(
					(tx) => tx.appendEntry(CommandInterpretationEntry, this.#root.id, { data: { usage } }),
					context,
				);
			return result;
		} finally {
			this.#interpretations.delete(controller);
			finish();
		}
	}

	/** Waits for the conversation to go idle, and returns the answer a resumed run ended with, if it ended in one. */
	async idle(context: Context): Promise<string | undefined> {
		this.requireActive();
		await this.#root.waitForIdle(context);
		const { items } = await this.#root.entries({}, 1, undefined, context);
		const newest = items[0];
		return newest !== undefined && AssistantEntry.is(newest)
			? textOf(newest.model?.[0] as Message | undefined)
			: undefined;
	}

	/** Calls `listener` with each committed live state: streamed answer text and tool rounds. Returns a stop function. */
	async watch(listener: (live: LiveState | undefined) => void, context: Context): Promise<() => Promise<void>> {
		const watch = await this.#harness.watchDoc(LiveDoc, this.#root.id, context);
		if (watch === undefined) return async () => {};
		listener(watch.value);
		watch.start(async (call) => {
			if (call.kind === "value") listener(call.value);
		});
		return async () => {
			await watch.stop();
		};
	}

	/** Watches bounded transcript and live state through this session's sole storage owner. */
	watchConversation(context: Context): Promise<ConversationWatch> {
		return this.#root.watch(context, { min: 20, max: 20 });
	}

	/** Reads one bounded page from the retained root transcript, even while execution is held or inhibited. */
	async chatHistory(before: number | null, context: Context): Promise<ChatHistoryPage> {
		if (before === 1) return { entries: [], nextBefore: null };
		const page = await this.#root.entries(
			{
				order: "descending",
				// The wire validates positive safe integers, and Durable takes an inclusive entry ID bound.
				...(before === null ? {} : { maxEntryId: (before - 1) as EntryId }),
			},
			20,
			undefined,
			context,
		);
		return projectChatHistoryPage(page);
	}

	/**
	 * Aborts all work in the chat: the current run, its tools and every queued input, whoever sent them. Durable has no
	 * public operation that aborts only an observed run in one decision, so this is deliberately chat-wide.
	 */
	abort(context: Context): Promise<void> {
		this.requireActive();
		return this.#root.abort(context);
	}

	/**
	 * Reports whether a send was admitted in this chat under `requestId`, from committed state only. It never waits on,
	 * resumes or admits work, and works while held or inhibited. `digest` (of the client's prompt) checks the binding.
	 */
	async admission(requestId: string, digest: string | undefined, context: Context): Promise<SendAdmission> {
		const found = await this.#harness.commit(async (tx) => {
			const record = await tx.submissionByRequest(this.#root.id, requestId);
			if (record?.type !== "write" || record.status !== "done") return { record };
			return { record, hostInput: (await tx.entry(HostFactEntry, record.entry))?.data.input };
		}, context);
		if (found.record === undefined) return sendAdmission(undefined, undefined, undefined, digest);
		// A receipt commits with its submission, so reading it after the submission cannot miss a fresh one.
		const receipts = (await this.#harness.snapshot(SendReceiptsDoc, this.#root.id, context))?.receipts;
		const receipt = receipts !== undefined && Object.hasOwn(receipts, requestId) ? receipts[requestId] : undefined;
		return sendAdmission(found.record, receipt, found.hostInput, digest);
	}

	async close(context: Context): Promise<void> {
		this.#closing = true;
		await this.#channels.drain();
		for (const controller of this.#interpretations.keys()) controller.abort();
		await Promise.all(this.#interpretations.values());
		try {
			await this.#harness.close(context);
		} finally {
			this.#memory.close();
		}
	}

	/** Reads or changes session memory through its sole storage owner, without model calls. */
	async memory(request: MemoryRequest, context: Context): Promise<MemoryResult> {
		const input = parseMemoryRequest(request);
		if (input.operation === "stats") {
			const stats = memoryStats(
				await this.#harness.snapshot(MemoryDoc, context),
				await this.#harness.snapshot(MemoryRelationsDoc, context),
			);
			return { operation: "stats", ...stats, consolidation: stats.consolidation.state };
		}
		if (input.operation === "graph")
			return {
				operation: "graph",
				...memoryGraph(
					await this.#harness.snapshot(MemoryDoc, context),
					await this.#harness.snapshot(MemoryRelationsDoc, context),
				),
			};
		if (input.operation === "recall") {
			const state = await this.#harness.snapshot(MemoryDoc, context);
			const relations = await this.#harness.snapshot(MemoryRelationsDoc, context);
			return {
				operation: "recall",
				records: this.#memory.recall.recall(state, relations, input.query, { topK: 5, now: Date.now() }).map((record) => ({
					id: record.id,
					content: record.content,
					origin: record.provenance.origin,
					tier: record.tier.kind,
					score: record.score,
				})),
			};
		}
		this.requireActive();
		return this.#root.commit(async (tx) => {
			if ((await tx.doc(MaintenanceDoc)).current.state === "held") throw new Error("Service is held for maintenance.");
			const state = await tx.doc(MemoryDoc);
			if (input.operation === "forget")
				return {
					operation: "forget",
					removed: forgetMemory(
						state,
						{ writeKey: `operator:${input.requestId}`, id: input.id },
						await tx.doc(MemoryRelationsDoc),
					),
				};
			if (input.operation === "remember") {
				const writeKey = `operator:${input.requestId}`;
				const receipt = state.receipts[writeKey];
				if (receipt !== undefined) {
					if (receipt.kind !== "remember") throw new Error("Memory request ID already belongs to forget.");
					return { operation: "remember", id: receipt.memoryId };
				}
				const entry = await tx.appendEntry(MemoryOperatorEntry, this.#root.id, {
					data: {
						operation: "remember",
						content: input.content,
						...(input.relations === undefined ? {} : { relations: [...input.relations] }),
					},
				});
				const id = rememberMemory(
					state,
					{
						writeKey,
						content: input.content,
						relations: input.relations,
						now: Date.now(),
						provenance: {
							origin: "user",
							conversationId: this.#root.id,
							entryIds: [entry.id],
							derivation: "explicit",
						},
					},
					input.relations?.length ? await tx.doc(MemoryRelationsDoc) : undefined,
				);
				await scheduleMemoryConsolidation(tx, this.#root.id, Date.now());
				return { operation: "remember", id };
			}
			const taskId = await reconcileMemoryTasks(tx, this.#root.id, Date.now());
			if (taskId === undefined) throw new Error("No pending memories need consolidation.");
			return { operation: "sleep", taskId };
		}, context);
	}

	/** Resolves when storage closes or fails, so a host can stop advertising a failed agent. */
	get closed() {
		return this.#harness.closed;
	}

	/** Reads or drafts the mission through this owner; protected host receipts remain the only managed approval source. */
	mission(request: MissionRequest, context: Context): Promise<MissionView> {
		if (request.operation !== "status") this.requireActive();
		return this.#mission.handle(request, context);
	}

	/** Lists or starts registered side chats through this owner, without submitting input or invoking a model. */
	side(request: SideRequest, context: Context): Promise<SideResult> {
		return controlSides(this.#sides, request, context);
	}

	/** Inspects channels or resumes exact creator-granted setup without granting permission or opening another writer. */
	channels(request: ChannelCommand, context: Context): Promise<ChannelResult> {
		if (request.operation !== "status") this.requireActive();
		return this.#channels.request(request, context);
	}

	/** Reports whether the conversation has an unfinished foreground run. */
	async status(context: Context): Promise<{
		readonly busy: boolean;
		readonly inhibited: boolean;
		readonly maintenance: MaintenanceState;
		readonly runtime: RuntimeFacts;
	}> {
		return {
			runtime: this.#runtime(),
			busy: (await this.#harness.snapshot(LiveDoc, this.#root.id, context))?.run !== undefined,
			inhibited: this.#inhibited,
			maintenance: (await this.#harness.snapshot(MaintenanceDoc, context))?.current ?? {
				protocol: 1,
				state: "open",
				operationId: null,
			},
		};
	}

	/** Holds admissions and drains foreground work; durable memory tasks finish/checkpoint when the owner closes. */
	async enterMaintenance(operationId: string, timeoutMs: number, context: Context): Promise<MaintenanceResult> {
		validateOperationId(operationId);
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
			throw new Error("Maintenance timeout must be an integer from 0 to 30000 ms.");
		await this.#harness.commit(async (tx) => {
			const document = await tx.doc(MaintenanceDoc);
			const state = document.current;
			if (state.state === "held" && state.operationId !== operationId)
				throw new Error("Another maintenance operation holds this session.");
			document.current = { protocol: 1, state: "held", operationId };
		}, context);
		const deadline = performance.now() + timeoutMs;
		for (const controller of this.#interpretations.keys()) controller.abort();
		this.#channels.abort();
		for (;;) {
			const inspection = await this.#harness.inspect(context);
			const legacy = (await this.#harness.snapshot(MissionDoc, context))?.current ?? null;
			// An unreadable or invalid purpose document identifies no run work, so anything it would own stays busy.
			const loop = validLoop((await this.#harness.snapshot(MissionPurposeDoc, context).catch(() => undefined))?.loop);
			if (
				inspection.tasks.every(
					(task) =>
						isMemoryBackgroundTask(task.record) ||
						isMissionHoldTask(task.record, legacy) ||
						isLoopTask(task, loop),
				) &&
				// Drain only: a parked loop never permits scheduling of a model-null or inhibited owner.
				loopParkedForMaintenance(inspection, loop) &&
				inspection.submissions.length === 0 &&
				this.#interpretations.size === 0 &&
				this.#channels.pending === 0
			) {
				return { type: "maintenance", protocol: 1, state: "held", operationId, result: "drained" };
			}
			if (performance.now() >= deadline)
				return { type: "maintenance", protocol: 1, state: "held", operationId, result: "deferred" };
			await setTimeout(Math.min(25, Math.max(1, deadline - performance.now())));
		}
	}

	/** Releases only the matching persistent hold, then explicitly enables scheduling. */
	async releaseMaintenance(operationId: string, context: Context): Promise<MaintenanceResult> {
		validateOperationId(operationId);
		await this.#harness.commit(async (tx) => {
			const document = await tx.doc(MaintenanceDoc);
			const state = document.current;
			if (state.state !== "held" || state.operationId !== operationId)
				throw new Error("Maintenance operation does not own this hold.");
			document.current = { protocol: 1, state: "open", operationId: null };
		}, context);
		await this.#root.commit((tx) => reconcileMemoryTasks(tx, this.#root.id, Date.now()), context);
		this.#memory.recall.prepare(
			await this.#harness.snapshot(MemoryDoc, context),
			await this.#harness.snapshot(MemoryRelationsDoc, context),
		);
		this.#inhibited = false;
		const inspection = this.#configuration === "unconfigured" ? await this.#harness.inspect(context) : undefined;
		const legacy = (await this.#harness.snapshot(MissionDoc, context))?.current ?? null;
		if (
			inspection === undefined ||
			(inspection.submissions.length === 0 &&
				inspection.tasks.every(
					(task) => isMemoryBackgroundTask(task.record) || isMissionHoldTask(task.record, legacy),
				))
		) {
			await this.#mission.initialize(context, "permitted");
			this.#harness.resume();
		}
		return { type: "maintenance", protocol: 1, state: "open", operationId: null };
	}

	private requireActive(): void {
		if (this.#closing) throw new Error("Agent is closing.");
		if (this.#inhibited) throw new Error("Service execution is inhibited for maintenance.");
	}

	/** Reads one bounded owner/host report without changing state, resuming work or invoking a provider. */
	inspect(query: InspectionQuery, context: Context): Promise<InspectionReport> {
		return this.#inspect(query, context);
	}

	/** Projects one call's bounded redacted evidence from the newest entries; read-only and only on explicit request. */
	async toolEvidence(callId: string, context: Context): Promise<ToolEvidence> {
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		while (entries.length < EVIDENCE_SCAN_ENTRIES) {
			const page = await this.#root.entries({}, 50, cursor, context);
			entries.push(...page.items);
			if (page.next === undefined) break;
			cursor = page.next;
		}
		return projectToolEvidence(entries, callId, this.#evidence);
	}
}
