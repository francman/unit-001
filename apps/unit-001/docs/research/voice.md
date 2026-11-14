# Voice should connect to the agent's mission owner

Research and implementation proposal for [#45](https://github.com/francman/unit-001/issues/45), checked 2026-11-09. No speech API calls, model downloads, benchmarks, dependencies or production changes were made. Model availability and prices below are public documentation observations, not account entitlements or measured agent performance.

## Decision in under one minute

Start with **hosted streaming speech-to-text → the agent's existing owner → streaming text-to-speech**. Use **Deepgram Flux English and Aura-2** as the first evaluation candidate: one account, integrated turn events, streaming playback controls and published usage rates. Keep provider ports replaceable; evaluate **ElevenLabs Scribe v2 Realtime / v4 Turbo** as the multilingual/voice-quality alternative, and **Cartesia Ink 2 / Sonic 3.6** as the pronunciation and streaming alternative. This is an integration recommendation, not a claim that one provider wins every accuracy or listening test.

Keep the microphone and playback on the human's device. The 512 MB VPS should coordinate bounded streams, final transcripts and receipts—not load a resident speech model by default. Begin with push-to-talk and final-transcript submission. Add continuous listening and interruption only after the basic authority and delivery tests pass.

Voice is an authenticated mission interface. It never grants authority from a speaker's sound, a transcript, or the word “sudo.” the agent's mission continues when the audio client disconnects. Use the same mission approvals, durable owner and cost ledger as other interfaces.

## Shortlist from current primary sources

“Fastest,” accuracy and millisecond figures in vendor documentation are **vendor claims** with different clocks and workloads. No comparable independent end-to-end experiment was run here. First transcript, end-of-turn, first audio byte and audible playback latency must be measured separately.

| Candidate | Verified capability and cost observation | Decision for the agent |
|---|---|---|
| **Deepgram Flux / Aura-2** | [Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart): `flux-general-en` or `flux-general-multi`, `/v2/listen`, 80 ms chunks recommended; integrated end-of-turn and interruption events. Vendor cites about 260 ms end-of-turn. [Aura voices](https://developers.deepgram.com/docs/tts-models): e.g. `aura-2-thalia-en`, seven listed languages. [Streaming controls](https://developers.deepgram.com/docs/tts-streaming-feature-overview) include Flush/Clear/Close. [Rates](https://deepgram.com/pricing): English Flux $0.0077/audio minute; Aura-2 $0.030/1,000 input characters; no PAYG commitment. | **First candidate**, initially English. One credential integration reduces setup and failure paths. Do not import the managed Voice Agent runtime. Flux multilingual's ten languages and Aura's supported voices must be checked against the requested language; no silent English substitution. Flux TTS is a newer alternative at $0.045/1,000 characters, worth evaluating later rather than assuming it improves this first slice. |
| **ElevenLabs Scribe v2 Realtime / Eleven v4 Turbo** | [Current model guide](https://elevenlabs.io/docs/overview/intro): `scribe_v2_realtime`, `eleven_v4_turbo`, 90+ languages; published median transcript/first-audio claims around 150/100 ms exclude application/network latency. [API pricing](https://elevenlabs.io/pricing/api): realtime STT $0.39/hour; v4 Turbo $0.04/1,000 characters. | **Alternative/fallback to evaluate**, particularly multilingual commands and preferred voice. Configure only if needed; do not require a second account for first use. The pricing page and overview disagree on some older Flash latency figures, reinforcing the need to measure our actual path. |
| **Cartesia Ink 2 / Sonic 3.6** | [Ink 2](https://docs.cartesia.ai/build-with-cartesia/stt/latest): stable `ink-2`, five languages and explicit start/update/eager-end/resume/end events. [Sonic 3.6](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest): 44 languages and immutable snapshot `sonic-3.6-2026-08-27`; vendor emphasizes codes and transcript fidelity. [Pricing](https://www.cartesia.ai/pricing): Pro $5/month includes 100,000 shared credits; TTS one credit/character, STT three credits/second. Pro overage $65/million credits. | **Strong evaluation alternative**, especially codes/names and version-pinned playback. A plan credit allowance is shared between STT/TTS, not an independent free pool per feature. Do not compare its full-plan effective rates to another vendor's marginal price without usage assumptions. |
| **AssemblyAI streaming / TTS** | Fetched [model-selection docs](https://www.assemblyai.com/docs/streaming/select-the-speech-model) identify `universal-3-6-pro` as the current default, with 32 languages. [Live pricing](https://www.assemblyai.com/pricing/) lists $0.45/session hour; Universal-Streaming English/six-language models $0.15/session hour. AssemblyAI-TTS-1 is advertised at $15/million input characters. STT 3.7 is labelled coming soon. | **Cost challenger**, not the default without a command/number evaluation. Explicitly select a supported model; ignore stale search snippets saying 3.5 is newest. [Streaming billing](https://www.assemblyai.com/docs/faq/how-does-universal-streaming-session-based-pricing-work) counts the entire connected session, including silence. Avoid an idle always-open connection. |
| **OpenAI transcription / voice** | [Official transcription guide](https://developers.openai.com/api/docs/guides/transcription) recommends `gpt-live-transcribe` for live input and `gpt-transcribe` for files. [Pricing](https://developers.openai.com/api/docs/pricing): $0.017/live minute and $0.0045/file minute respectively. [GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1) supports duplex voice and backend delegation at $0.05/session minute plus backend model/tools. | **Supported alternative and later duplex experiment**. GPT-Live can delegate to an existing backend, but exact owner admission and action approvals must remain in the agent. Do not replace the mission runtime or assume a conversational voice model's spoken agreement authorizes work. |
| **Google / Azure** | [Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3) offers V2 `chirp_3` streaming with regional/language availability checks. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) currently lists `gemini-3.8-flash-tts`, with promotional text/audio token rates changing January 2027. [Azure MAI-Voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices) lists 2.1/2.1-Flash as public preview without an SLA. | **Useful when the organization already uses that cloud**. Do not add its account/IAM stack merely for this first feature. Google Cloud Speech and Gemini Developer API are different billing/auth surfaces; Azure preview is not a production-default commitment. Region-specific Azure rates were not established here, so no invented flat price is quoted. |

The [OpenAI deprecation schedule](https://developers.openai.com/api/docs/deprecations) removes `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` on January 6, 2027, and older Whisper/4o transcription API models on February 26, 2027. Those familiar names are poor defaults for a new November 2026 integration. Recheck notices when coding; changing the model string alone does not preserve event semantics.

For the proposed Deepgram pair, **one hour of submitted English audio plus 10,000 synthesized characters is $0.762 at the listed base rates**: 60×$0.0077 + 10×$0.030. This excludes the agent's model calls, taxes, extras and account-specific rates. It is an illustrative estimate, not a monthly bill. Repeated or interrupted provider work may still be chargeable. Never convert characters to spoken minutes using one universal ratio.

## Local alternatives belong on the device or a measured worker first

| Option | Evidence and deployment consequence |
|---|---|
| **Moonshine Voice** | [Pinned official README](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/README.md) supports on-device streaming across browser/native platforms and now includes STT/TTS. Code and most models are MIT; named legacy non-English/non-streaming models retain a noncommercial license. **First local-device candidate**. Tiny parameter/disk size is not peak RSS or accuracy evidence; exact streaming model/language and license must be pinned before evaluation. |
| **whisper.cpp / faster-whisper** | [Pinned whisper.cpp README](https://github.com/ggml-org/whisper.cpp/blob/bd9e1a12352fa57e448bdea6a0649aa9c24c64aa/README.md) publishes approximate unquantized memory: tiny 273 MB, base 388 MB, small 852 MB. Those are upstream figures, not our VPS measurements. Quantization changes the tradeoff; it does not establish headroom. Prefer client/remote-worker experiments. MIT whisper.cpp/Whisper licensing does not automatically cover every third-party conversion. |
| **NVIDIA Parakeet TDT 0.6B v3** | [Official model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) describes 25 languages; weights are CC-BY-4.0 and the published `.nemo` file is 2.51 GB. A remote ASR worker is plausible; the current VPS is not a default home for this model. The file size is not runtime memory. |
| **Kokoro-82M / Piper** | [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M) has Apache-2.0 weights; the original PyTorch file is 327 MB before runtime/activations. Quantized variants need separate hash/license/runtime review. [Current Piper engine](https://github.com/OHF-Voice/piper1-gpl/tree/0471299744417dae497991f859dd0d3c1daab170) is GPL-3.0, with voice-specific licenses and a maintainer request. **Evaluate local TTS behind a process boundary**, not an automatic new bundled dependency. |
| **Chatterbox** | [Pinned official README](https://github.com/resemble-ai/chatterbox/blob/ab55923c27757c90cfcc407baa57dc25a7d25217/README.md) explicitly says it is retired, unmaintained research since August 2026, despite legacy promotional sections below. MIT availability does not make it a maintained production choice. **Defer**. |

No local model was run or downloaded. This report does not establish that every local option is impossible on 512 MB; it establishes that none has demonstrated sufficient shared-host headroom here. Measure the exact quantization/runtime/voice on the exact device before recommending it. Open-weight inference would run in an authenticated child worker, never become a second mission owner.

## Privacy and reliability settings are part of setup

Use an administrator-approved provider, region, model and voice. Store credentials in the existing private credential mechanism; do not put them in model prompts, subprocess environment, audio metadata, transcript logs or browser code. Existing subscription login does not prove speech-API entitlement. Preserve typed provider/model identifiers in every receipt so a fallback is visible.

Deepgram's [data controls](https://developers.deepgram.com/trust-security/your-data) retain speech content for model improvement by default. The STT/TTS adapters must set `mip_opt_out=true`; the docs describe no content retention after processing with opt-out, while usage metadata remains. Region selection and opt-out are separate. Never quietly drop that parameter on reconnect or fallback.

AssemblyAI [streaming retention](https://support.assemblyai.com/articles/2240096256-does-assemblyai-offer-zero-data-retention) depends on opting out of training. ElevenLabs [Zero Retention Mode](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode) is an enterprise capability, not a universal free-plan default. OpenAI [endpoint data controls](https://developers.openai.com/api/docs/guides/your-data) distinguish abuse monitoring, application state and eligibility. Verify actual account settings before enabling sensitive audio; an unverified setting is unknown, not “private.” Cartesia's account-specific retention guarantee was not established in this assessment and remains a setup-review item.

Do not continuously record the environment. Start with user-held push-to-talk, visible microphone/processing/playback states and an immediate mute. Captured raw audio is ephemeral by default; final submitted text becomes ordinary conversation history under the same disclosure. Synthetic speech must be identified as such. Proactive audio requires an opted-in destination and quiet-hours policy; durable text notifications remain available when no playback client is present.

## Coding definition: reuse the existing owner

### Existing seams and prerequisite

`Agent.submit(text, context, {requestId})` already atomically admits a human prompt and records memory provenance; `watchConversation` exposes structural live/history state; `abort` cancels shared work. `service-view.ts` exposes a bounded text/tool projection. These are real inspected APIs. Pi's public `Models` interface is currently a text/model interface; it does not expose a general STT/TTS contract. Add unit-specific speech adapters rather than patch upstream Pi or treat audio tokens as ordinary text.

`Agent.submit` currently hardcodes human origin. A network speech gateway must **not** call it with an unverified browser/channel-provided identity. Add a host-owned ingress admission seam coordinated with #40/#14 that receives authenticated principal evidence separately from client JSON. Existing `src/missions/state.ts` version-one `unit.mission` remains the mission foundation; voice adds transport receipts, not a new mission document or an automatic migration to agreed authority.

### Components

- `src/voice/types.ts`: closed schemas and proposed adapter types. External wire input validates size, encoding, sequence and tags here.
- `src/voice/stt.ts` and `tts.ts`: provider ports plus Deepgram implementation; schema-checked events normalized once. Keep SDK out of the first slice if Node's existing fetch/WebSocket primitives meet the verified API contract. Installed Node declarations include WebSocket options and binary messages; test the actual bundled runtime before relying on optional header behavior. Deepgram also documents [subprotocol authentication](https://developers.deepgram.com/docs/using-the-sec-websocket-protocol). Never log authorization/protocol secrets.
- `src/voice/admission.ts`: binds a final turn to an authenticated control session and invokes the sole owner's atomic ingress path, using a stable request ID.
- `src/voice/state.ts`: version-one session-scoped keyed turn/delivery receipts through public Durable documents. No independent SQLite writer.
- `src/voice/session.ts`: ephemeral bounded media state; owns STT/TTS sockets, backpressure, cancellation and close. It cannot grant mission authority or call coding tools directly.
- `src/voice/client/`: thin microphone/player client on the human's machine. First acceptance can use recorded PCM and a fake player. A later local browser client uses microphone permission, origin-bound authentication and a local/SSH-pinned transport; the current VPS has no established browser media server, so do not expose a public listener by default.
- Owner service extension: explicit voice-session/control operations over an authenticated gateway, separate bounded media frames from the existing text request framing. Current Unix operator membership intentionally grants coding authority; a remote voice endpoint requires a narrower provisioned binding, not automatic access to that broad socket.

All names below are **proposed**, not existing public exports:

```ts
type AudioFormat = {
  encoding: "pcm_s16le";
  sampleRate: 16000 | 24000;
  channels: 1;
};
type TranscriptEvent =
  | { kind: "partial"; turnId: string; revision: number; text: string }
  | { kind: "final"; turnId: string; revision: number; text: string;
      providerRequestId: string | null }
  | { kind: "speech_started"; turnId: string }
  | { kind: "failed"; reason: "network" | "format" | "quota" | "provider" };
interface SpeechToText {
  open(input: { format: AudioFormat; language: string }, signal: AbortSignal):
    Promise<{ write(frame: Uint8Array): Promise<void>;
      events: AsyncIterable<TranscriptEvent>; close(): Promise<void> }>;
}
interface TextToSpeech {
  speak(input: { deliveryId: string; text: string; voice: string }, signal: AbortSignal):
    AsyncIterable<{ sequence: number; format: AudioFormat; bytes: Uint8Array }>;
}
type TurnIdentity = {
  principalId: string;
  turnId: string;
  transcriptDigest: string;
};
type TurnReceipt = TurnIdentity & (
  | { kind: "finalized"; text: string; providerRef: string | null }
  | { kind: "admitted"; submissionId: string }
  | { kind: "rejected"; reason: "stale_binding" | "conflicting_turn" | "denied" }
);
type PlaybackReceipt =
  | { kind: "queued"; deliveryId: string; sourceEntryId: number }
  | { kind: "generated"; deliveryId: string; providerRef: string | null }
  | { kind: "played"; deliveryId: string; clientAckAt: number }
  | { kind: "interrupted" | "unknown_delivery"; deliveryId: string };
```

### State and authority

Ephemeral session states: `idle → capturing → finalizing → awaiting_confirmation | admitted → playing → idle`; error, mute and disconnect close media and expose an actionable state. Ordinary mission execution is not nested inside this connection lifecycle. Partials are display-only and never execute tools. The first recorded-input prototype uses push-to-talk release and visible text review before submission. That prototype choice is not a mandatory approval for every production utterance: an authenticated final status/read request or routine instruction within approved mission authority can be admitted without another prompt under the configured interface policy. Ambiguous, irreversible or out-of-scope effects use the existing exact-action approval boundary. Eager-turn events must not speculatively perform effects.

Persist a stable `(installation, binding, clientTurnId)` receipt with final-text digest and immutable principal. The owner transaction admits the transcript and records the submission mapping atomically; retries return that mapping. Conflicting text under the same turn ID is rejected. Do not create a second charge or mission because an audio client reconnects. A changed transcript is a new reviewed turn, not an overwrite of an already executed instruction. Store selected language/model and finalization evidence; model-generated synthetic speech cannot masquerade as a human turn.

Finalized text has human origin only when the transport's authenticated human binding establishes it. A parent agent/organization remains a separate origin even if its message arrives as audio. Neither voiceprint nor speaker diarization authenticates the creator. Mission agreement and approvals bind the existing exact mission/action revision, principal, expiry and effect; a spoken generic “yes” is not reusable approval. Administrative credentials, permissions, identity, lifecycle and update changes still require the established privileged path. Memory edits remain normal-operator operations with the existing forget confirmation.

Barge-in first stops/clears playback and marks its delivery interrupted. **It does not abort the agent's mission or roll back an external effect.** A separately authenticated explicit cancellation follows existing task cancellation semantics. Provider Clear/close does not remove samples already queued in the client; flush both sides and test the audible tail. Speak committed owner text by default; do not repeatedly synthesize speculative token revisions. Streaming uncommitted narrative is a later evaluated mode with explicit interruption/correction behavior.

Every media connection has a fresh epoch and every audio chunk carries its delivery ID and sequence. After mute, interruption or reconnect, reject late chunks from an old epoch; never let buffered old speech resume over a newer answer. A client playback acknowledgment establishes only that the application played the samples, not that a person understood them.

### Failure, persistence and cost

The initial schema starts absent. Existing installations remain voice-disabled; upgrade never grants a microphone, provider, recording policy or remote principal. Preserve existing mission/memory documents. Changing provider/retention/auth configuration is administrative and versioned. Migration must never reinterpret old text history as microphone consent.

After a crash, abandon incomplete ephemeral audio with a visible “repeat or review” outcome. Do not retransmit retained recordings or repeat an admitted final turn automatically. Interrupted provider attempts may have costs; record submitted audio duration, connection duration where billed, characters/audio tokens, provider request ID, model/rate snapshot and known/unknown outcome through #42. Failed TTS is not proof of zero charge. A TTS provider completion is not proof that the human heard it. Reconcile a stable delivery ID and client acknowledgment; otherwise report unknown delivery, retaining text. No guaranteed exactly-once sound playback is claimed.

Fallback is optional and administrator-configured. It may change region/retention/cost, so it cannot silently use a new vendor. Before any final transcript was admitted, a fresh bounded user-approved retry can choose a fallback; after admission, reuse the submission receipt. Do not parallel-race speech providers by default, which duplicates disclosure and billing.

Proposed initial limits, **not measured production guarantees**: one active voice session per binding, one STT and one TTS stream; 60-second push-to-talk turn, 10-minute session lease, 2-second ring buffer each direction, 64 KiB maximum control frame and 8,000-character final transcript. PCM16 mono at 16 kHz is 32,000 bytes/second; a two-second input ring is about 64 KB, not a full-session in-memory recording. Output at 24 kHz requires a separately sized ring. Stop accepting audio when backpressure exceeds the cap rather than silently dropping words. Define connect/finalization deadlines and finite retries per provider in the adapter; test stalled sockets and partial results. These are configuration decisions to benchmark before final release, not arbitrary promises to users.

## Ordered implementation slices and acceptance

1. **Contracts and recorded-input prototype.** Add host-bound final-turn admission and durable receipt schemas, fake STT/TTS ports, explicit transcript review and text-only fallback. Reuse #40 principals and #14 policy. Prove final-only execution, replay/conflicting-turn rejection, empty/noise rejection and cross-agent isolation using real SQLite; no network/provider charges.
2. **Deepgram adapter pair.** Implement exact current protocol schemas, opt-out/region/auth controls, usage receipts, finite quotas/timeouts and playback cancellation. Use a local fake WebSocket/HTTP provider for authentication-redaction, malformed events, quota failure, partial/final ordering, disconnect, backpressure and repeat-charge tests. No new SDK dependency unless documented primitives fail a concrete requirement; if needed, exact pin/license/install-script review applies.
3. **Human-device client.** Add push-to-talk, visible final transcript, Send/Cancel, mute, status, synthetic-voice notice and output playback. Prove keyboard accessibility, microphone denial, expiry/reconnect, playback and owner continuity after close. Use an actual client screen/audio loopback plus existing PTY status/control tests—not only parser tests. No public VPS listener is an implicit acceptance condition.
4. **Bounded live turns and proactive delivery.** Add VAD/end-of-turn, full playback interruption, approved notification destinations/quiet hours and optional fallback. Keep uncertain transcript/action approvals separate. Model/tool execution stays in the owner; no second agent loop or imported voice-agent framework.
5. **Local-device/remote-worker option.** Benchmark one pinned Moonshine STT model and a license-reviewed Piper or Kokoro voice behind the same ports. Record cold/warm/peak RSS, real-time factor and power/CPU on the actual device. Enable on the VPS only if measured coexistence/headroom and recovery tests pass.

Evaluation corpus must contain licensed, consented speech for target accents/languages, background noise, silence, names, URLs, dates, currencies, negative instructions (“do not deploy”), unit names and alphanumeric codes. Store licensing/source evidence for fixtures. Report command/critical-slot error and false-admission rates alongside WER, p50/p95 first partial/final transcript/first audio byte/audible playback, interruption tail, reconnect effects, cost and peak RSS. No paid evaluation was run; live comparison requires an explicitly budgeted staging run. Hard action safety tests use deterministic injected transcripts, not stochastic voice quality alone.

Run focused tests, app typecheck/full `npm run check`, packaging and real UID/client checks. Preserve existing request/checkpoint latency gates; speech/network work runs outside model preparation and background projections remain bounded. Measure incremental CPU/RSS and long-session cleanup on the 512 MB host before claiming fit. The research is complete only after review and durable linked publication; none of these features is shipped by this proposal.
