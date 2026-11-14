# Command resolution

An unknown command currently stops at usage or becomes an ordinary coding-agent prompt. A typo such as `/memroy` should suggest `/memory` without loading a provider. A question such as “What operating system are you running?” should report observed host facts without asking a model.

## Resolution order

1. Match a declared command or alias for the current interface. `brain` aliases read-only memory statistics; additional operands still pass the ordinary memory parser and its confirmation rules.
2. Rank local catalog entries using fixed alias/keyword matching and bounded edit distance. Return at most three suggestions. Unknown flags and subcommands stay local, with the recognized command's usage. A suggestion never executes.
3. Only an unresolved command request can ask the running owner for one tool-free interpretation. The owner must have a selected catalog model, complete authentication, ordinary operator permission and no maintenance hold. Missing setup never selects a provider or launches setup implicitly.

Ordinary conversation remains ordinary conversation. Only explicit CLI command input and slash commands use inference. Known OS questions take an independent deterministic route before conversation generation. Mission agreement gates autonomous work, not already-authorized ordinary operator conversation or command suggestions.

## Catalog and trust

`commands/catalog.ts` owns typed IDs, interface availability, canonical invocations, aliases, help summaries and effect classifications. The `remote` entry leads to the existing SSH profile parser. Local ranking is deterministic and versioned; neither model output nor user input creates a command definition.

The inference request contains one bounded command-shaped token and the available public catalog only: no operands, paths, history, credentials, private files, tool definitions or arbitrary command execution. Explicit CLI session or data-directory overrides keep unresolved commands local rather than asking a different owner. One response may identify existing command IDs and a short explanation. Reject tool calls, unknown IDs, malformed output and oversized responses. No retries. A timeout ends interpretation. Record observed request usage separately from conversation usage; unavailable billing remains unknown.

CLI and terminal suggestions show canonical commands. Choosing a suggestion puts that command in the editor; submitting it still runs the normal parser, authorization and confirmation. Privileged commands remain administrator operations. No shell command string is constructed.

## Deterministic host answers

Use the same `operatingSystemFacts` collector as the read-only inspection tool. Report source, observation time, namespace scope and unavailable evidence. Do not infer distribution from the kernel.

Store a data-only typed host entry containing the original input, answer and provenance. The terminal projection labels this as host evidence; no provider/model message or token usage is fabricated. Commit through the existing owner, without waking suspended work. A receipt binds request ID to original input and saved answer; check existing ordinary submissions before handling a retried ID, so upgrades do not change previously admitted requests.

## Verification

Faux model spies prove zero calls for exact commands, aliases, local suggestions, missing setup and OS facts. Ambiguous configured requests make one bounded call. Malformed or hostile responses never execute. Restart tests preserve host replies and request identity; maintenance and administrator tests preserve existing gates. Real 80×24 and 40×12 terminal runs exercise suggestion display, selection, cancellation and terminal restoration. All checks run locally; no paid runtime calls or GitHub Actions.
