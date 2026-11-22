# Tool evidence and failure reasons in the attached terminal

Problem: a tool card shows only a name and a status, so an operator cannot tell why a call failed or what it did. Example: `[failed] bash` says nothing about the exit code or the command. Putting raw arguments and output in every watch frame would fix that, but it would copy possibly secret text to every observer on every change.

Solution, in two parts with different exposure:

1. **Failure reasons and retry state** are typed, host-generated summaries in the watch frame, so every observer sees them. They carry no tool output and no provider error text.
2. **Tool evidence** (arguments, output, diff) is returned only when an operator explicitly asks for one call. Routine watch frames never carry it.

## Retention and secret boundary

This section is the contract. `src/evidence-redaction.ts`, `src/tool-evidence.ts` and `src/service-view.ts` must stay inside it.

### What is read, and how long it is kept

- Source: committed Durable history of the root conversation only: the assistant entry's tool call (arguments) and the tool-result entry (output, details, diagnostics).
- Nothing new is stored. The owner keeps no copy, cache or log of an evidence reply. The attached terminal keeps the latest reply in memory until it is replaced, hidden with `/evidence close`, cleared by the next prompt it submits, or the client exits. A reply that arrives after a newer `/evidence`, after `/evidence close` or after a submitted prompt is dropped. It is never written to the draft store.
- Lookup window: the newest 200 entries of the root conversation, read in pages of 50 only while serving an explicit request. A call older than that returns `not-found`, which is not proof it never ran.
- The call is selected by its exact call ID, or by a unique prefix of at least 6 characters. An ambiguous prefix returns `ambiguous` and shows nothing. If a provider reuses a call ID, the newest call wins.
- A call with no committed result yet is reported `pending` with its arguments and no output. Running output is not read from the live document.

### What is projected, and the limits

Limits are UTF-8 bytes of the redacted text unless stated. Each field is redacted first, then cut, so a secret cannot be split by the cut. A cut never ends inside a multibyte character, and text cut by UTF-16 length never ends in half of a surrogate pair.

| Item | Limit | Where it appears |
| --- | --- | --- |
| Evidence `arguments` | 2,048 bytes | explicit request only |
| Evidence `output` | 4,096 bytes | explicit request only |
| Evidence `diff` | 4,096 bytes | explicit request only, when the result carries a string `diff` detail (the edit tool does) |

One reply therefore carries at most 10,240 bytes of text. The client validates every field against its limit and rejects the reply otherwise. Each evidence field reports its redacted size before the cut, whether it was truncated, and whether anything was redacted. The reply also says how the call was classified (`redaction`, below) and whether the tool's output was already truncated upstream (`sourceTruncated`: Durable's bash tool keeps only the tail of long output, so context that would identify a secret, such as a PEM header, may be gone).

Adjacent text blocks of the output are joined without a separator, as Durable's output bounder treats them, so a secret spanning two blocks is still one string for redaction. Images are replaced by `[image omitted]`.

Never projected: model thinking, assistant text, other calls, nested calls, usage, image data and any internal Durable document.

### Bounded work

Redaction runs synchronously on the owner, on text a tool controls. Every rule is linear in its input: a match starts at a fixed literal or at the start of a character run, and only the search for the credential syntax before a value is bounded (such as the 128 characters between `mysql` and `-p`). Once the syntax is found, the value is consumed whole however long it is: a quoted value runs to its closing quote or, unterminated, to the end of its line, so no suffix of a long value survives. JWTs are found by reading each dotted base64url run once and redacting the whole run when three consecutive segments form a token, wherever `eyJ` starts inside the run. `test/tool-evidence.test.ts` redacts 1 MB adversarial inputs (long `eyJ` runs without dots, one long dotted run, unterminated quotes after repeated keywords and others) in under 100 ms each. Sizes and structure are checked before any join, copy or match:

- An output or diff longer than 262,144 UTF-16 code units is not read: the field is `[withheld: too large to redact]`. Output with more than 1,024 content blocks is withheld the same way, and image placeholders count toward the size before anything is joined.
- Arguments are walked, not serialized, before redaction. Every key, value and array item is charged one node before it is visited, so redaction, copying and matching stop at the budget however wide an object or array is. Past depth 8, 4,096 nodes or 262,144 characters, the rest is replaced by `[withheld: too deep]` or `[withheld: too large]`. The walk is not constant-cost in an object's width: V8 collects an object's own keys before the first `for…in` iteration, so that step is linear in the number of keys. It is the same order as parsing the stored arguments, which has already happened; a 200,000-key object is withheld in well under 250 ms (`test/tool-evidence.test.ts`).

### What is redacted

Pattern redaction (`redactEvidenceText`) applies to every string. It covers:

- Control and format characters (replaced by U+FFFD, except newline and tab).
- PEM private-key blocks; `sk-`/`sk-ant-`, `ghp_`-style, `github_pat_`, Slack `xox?-`, AWS `AKIA`/`ASIA`, Google `AIza`, Stripe `sk_live_`/`sk_test_`, npm `npm_`, Hugging Face `hf_` and GitLab `glpat-` tokens; JWTs; `Bearer` tokens.
- `name=value` and `"name": "value"` where the name contains `api key`, `token`, `password`, `passwd` or `secret` (an unquoted value takes the rest of the line, which errs toward hiding).
- `scheme://user:password@` userinfo, and URL query parameters named `access_token`, `token`, `api_key`, `key`, `secret`, `password`, `sig` or `signature`.
- `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` values, as a header line or as a quoted JSON key.
- Quoted JSON or YAML keys `auth`, `credential(s)`, `private_key`/`private-key`, `client_secret`, and kubeconfig `*-key-data` / `*-cert-data` / `*-certificate-data` values.
- The value after `--password`, `--passwd`, `--token`, `--secret`, `--api-key`, `--auth`, `--access-token` and `--client-secret`; `curl -u USER:PASS`, `--user USER:PASS` and `--proxy-user USER:PASS`; and the `-pPASSWORD` of `mysql`, `mysqldump`, `mysqladmin` and `mariadb`.
- Literal values of the owner process's environment variables, when the value is at least 8 characters and the name has a part such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL(S)`, `AUTH`, `AUTHORIZATION` or `COOKIE`. They are collected once when the owner opens. `GIT_AUTHOR_NAME` is not matched.

Arguments are redacted leaf by leaf before serialization, so JSON escaping cannot hide a known value, and arrays are visited. A value under a key whose name contains `key`, `token`, `secret`, `password`, `passwd`, `auth`, `credential` or `cookie` becomes `[redacted]`.

### Withholding by provenance

Pattern redaction cannot understand an arbitrary file format, so what a credential file produced is withheld entirely. Withholding follows the file the call used when it ran, not how its arguments are spelled and not what the path resolves to later:

- **Recording at execution** (`src/file-provenance.ts`): the agent installs Durable's `coding-tools` with `read`, `write` and `edit` wrapped. The wrapper gives the tool an environment that notes every content operation (open, read, write, append, truncate) with three facts:
  - `path`: the absolute path the tool used, after Durable's own resolution and its read variants (Unicode normalization, curly apostrophe, narrow no-break space).
  - `resolved`: the file the content moved through. Durable opens a file by path and checks nothing about it, so no check by path before or after can say which file it opened: an alias retargeted during the operation and restored after passes both. The wrapper therefore runs the operations Durable's file tools use (`openBinaryReader` for `read`, `readTextFile` and `writeFile` for `edit` and `write`) on a handle it opens itself, and names that handle's file. On Linux the name comes from the descriptor (`/proc/self/fd`). On macOS, `realpath` proposes a path, and opening it with no symbolic link followed in any component (`O_NOFOLLOW_ANY`) must reach the same device and inode as the handle. Durable's reader is opened on the descriptor's own path (`/dev/fd/N`, `/proc/self/fd/N`), so it reads the very file the handle holds. Where identity cannot be read from a handle (a container or remote environment, another platform, an operation not bound this way, a handle the wrapper could not open), the operation runs as Durable's own and the record says `resolved: null`.
  - `credential`: the decision when the call ran. The path, or the resolved file, was a credential location under the credential roots as they resolved at that moment.

  The record (at most 8 files) is stored in the result's `details` under `unitFiles`, which models never see; a call that throws reports it before its error settles the result.
- **File tools at request time**: if the arguments spell a credential path, a recorded file says `credential: true`, or any recorded file (as used or as resolved) is a credential location under today's roots, the reply says `withheld: credential-path`. The execution-time decision stands, so a root retargeted since cannot clear it; today's roots can only add to it. If there is no usable record (a pending call, an entry from before recording, a malformed or incomplete record, a record without the `credential` decision, a file that was not established), or a recorded path now resolves to a different file than recorded, the reply says `withheld: unverified-file`: the file cannot be established, so nothing it may have produced is shown. A recorded file removed since keeps its record. When withheld, the output and diff are not shown and every argument except `path` becomes `[withheld]` (for `write` and `edit` the others, `content`, `oldText`, `newText` and `edits`, are the file's content; at most 16 argument names are kept). A verified, ordinary file reports `redaction: classified`.
- **Opaque tools** (`bash`, `powershell` and every other tool): a shell command can open any file whatever it spells, and quoting such as `.e""nv` defeats any spelling check. Their output is shown with pattern redaction and the reply says `Redaction: pattern-only (source unclassified)`. As a floor, a call whose argument strings or keys spell a credential location is withheld (`credential-path`), and so is one whose arguments are too large, too wide or too deep to scan.
- **Historical entries** of file tools carry no record and are withheld as `unverified-file`. Opaque tools are unchanged.
- Credential roots are compared as spelled and as resolved through their nearest existing ancestor, both when the call runs and at request time, so a root that does not exist yet (or sits under a symlinked directory such as macOS `/etc`) still matches.

Credential locations: `.env`, `*.env` and `.env.*` (so `.env.example` too), `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `auth.json` (this includes the agent's own sign-in file in its data directory), `hosts.yml` (GitHub CLI), `*.tfstate`, `kubeconfig`, `*credentials` and `*credentials.json`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`; anything under `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`, `.unit-channels/` or `.docker/config.json`; and anything under the installation's `/etc/unit-001/` (its `environment` file holds provider keys) or the agent's channel credential directory.

### Honest limit

Redaction is best effort. A secret in a shape no rule recognizes, in the output of an opaque tool that did not spell a credential location, can still appear in an explicit reply; the reply labels such output `pattern-only`. A file tool's record names the file its handle held, and classification is by location: a hard link to a credential file, or a credential file itself renamed into an ordinary directory while the call ran, is named by that ordinary location, as a copy of it would be. That is why the reply is explicit, operator-only, bounded, unstored and unlogged. Operators can read redacted arguments and output of any tool call in the shared session, including calls another operator, a mission or a channel started. The browser workspace has no operation for evidence (its operation set is closed).

Watch frames are different: they reach every attached terminal and, through the web gateway's event stream, browser observers. So they carry only the typed summaries below, never free-form text from a tool or provider, and the gateway forwards only the browser contract's fields (`web/contract.ts` `WorkspaceView`), so failure reasons and retry state stay out of the browser entirely.

## Request and access

- Owner request `tool-evidence` with `callId` and no other field, answered with `tool-evidence`. It is read-only, needs no model call, and is allowed on the operator socket and the administrator socket. It does not change storage, resume work, or touch cancel/detach behavior. It is not part of the model's `unit_inspect` scopes, so the model cannot request it.
- Rich interface: `/evidence [CALL_ID]`. With no argument it uses the newest tool card. `/evidence close` hides the shown evidence. Tool cards show the first 12 characters of the call ID so it can be copied.
- Plain interface (`attach --plain`): `/evidence [CALL_ID]` prints the same lines to stderr; tool lines include the failure summary.
- The foreground source session uses the same controller and owner method without a socket.

## Failure reasons and retry state in frames

Every watch frame may carry, in addition to the existing fields, these typed values. The client renders a fixed English summary for each; only validated numbers and the call ID prefix are interpolated.

- `tools[].reason` (failed tools only): a code from the failed result's first error diagnostic. Durable's harness and built-in tools write these codes; only messages they generate themselves are parsed, and only when at most 128 characters:
  - `exit_code` with `exitCode` (from `Command exited with code N`): "Exited with code N."
  - `timeout` with optional `seconds` (from `Command timed out after N seconds`; `N` may be fractional, as the shell tool accepts, and must be positive and at most 2,147,483.647 seconds or it is dropped), `aborted`, `not_found` (`ENOENT:`), `permission_denied` (`EACCES:`/`EPERM:`), `unavailable` (`tool_unavailable`), `blocked`, `invalid_arguments`.
  - `unknown` for everything else: "Tool failed; run /evidence ID for details."
  - No output of any call is read for the frame, and no error text is copied into it.
- `failure`: why the newest run ended without an answer: Durable's reason code (`model_error`, `no_model`, `aborted`, `reset`, `faulted`, `orphaned`, `interrupted`, `restart_limit`, `nothing_to_answer`, `turn_limit`), plus `problem` for `model_error` and `turns` for `turn_limit`. It stays until a later run starts; the interface hides it while the owner is busy.
- `retry`: while the provider request waits for another attempt: the attempt number, when it happens (epoch milliseconds, shown as UTC time) and `problem`.
- `problem` classifies the provider error from a bounded 512-character prefix: `rate_limited` (429, rate limit), `auth` (401/403, authentication), `overloaded` (529/503, overloaded), `network` (connection errors) or `unknown`. The text itself is dropped.

The client parser accepts only these closed shapes and rejects free-form strings, unknown codes and extra keys. Because they are in the frame, a second terminal attached later sees the same reason and retry state as the terminal that submitted the work. The initiating terminal's own `Unanswered: ...` notice comes from its send reply, not from the frame, and is unchanged, as are script `send` output, detach and cancel.

At 40 columns the card shows the call ID prefix and the summary on a second line, each cut to the width. The transcript follows its newest line, so a long evidence block shows its end first; PageUp reaches its header.

## Cost on the hot path

The frame adds, per failed tool in the 20-entry window, one lookup of its error diagnostic's code and at most one match over its message of 128 characters or less. The result is cached per committed entry in a `WeakMap`, so a later frame with the same entries does no work for it. The run failure and retry are classified once per live-document object from a 512-character prefix, also through a `WeakMap`. No tool output is read, and no redaction, environment walk or history scan happens per frame. Evidence lookup reads up to 200 entries and resolves each credential root and each recorded file of the selected call (at most 8) once, and happens only for an explicit request. Recording costs a file tool two `realpath` calls per content operation.
