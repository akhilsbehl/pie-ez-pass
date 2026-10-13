# pie-ez-pass

A [Pi](https://github.com/earendil-works/pi) extension providing native **sys1** (classifier) or **sys2** (generative) review for `bash`, and deterministic path rules for `edit` and `write`.

These are manually selected alternatives, not a pipeline or automatic fallback. Both provider/model pairs remain configured when `reviewer` switches. Neither path changes Pi's conversation model, login, model scope, or defaults.

## How it works

The extension uses Pi's `tool_call` hook and local `ctx.ui.confirm` dialog. This dialog is the entire human permission system; there is no external permission service.

- Permanent rules run first when configuration is valid.
- Unmatched Bash uses only the configured `reviewer: "sys1" | "sys2"`.
- sys1 calls `ctx.modelRegistry.classify()` with one native choice question, `permission_decision`. A valid `ACCEPT` choice executes regardless of confidence. An `ESCALATE` choice **also executes when `probabilities.ESCALATE` is below `sys1_escalate_threshold`**; at or above the threshold it escalates. Confidence is never treated as probability. Missing/unknown choices or malformed required probabilities fail closed.
- sys2 calls `ctx.modelRegistry.streamSimple(...).result()` and parses a strict `{outcome: "ACCEPT" | "ESCALATE", rationale}` assessment. Output is limited to 256 tokens. Rationale is one short sentence bounded approximately to 256 tokens (1024 UTF-8 bytes, using four bytes/token because Pi exposes no model-independent tokenizer). The complete validated escalation rationale is shown to the human, with no separate 600-character cut-off.
- Both paths own up to three attempts in a single total deadline (default 30,000 ms), including discovery/auth, provider work, response handling and waits. Provider failures wait 250 ms then 1000 ms; malformed answers retry immediately. Native provider retries are disabled. sys2 parsing retries include bounded targeted feedback; sys1 reissues the same typed question.
- `ACCEPT` executes the unchanged call. `ESCALATE`, unavailable models/auth, provider/parser/reviewer failures, and invalid configuration request human confirmation. Human approval executes; rejection or a confirmation error blocks. No UI means escalation blocks.
- Unmatched `edit` and `write` go directly to the human, never either model path. Other tools pass through unchanged.
- Approval is only for the current call; there are no session approvals.
- Effective global/project config is re-read on every reviewed call; the reviewer generation is rebuilt only when it changes. Replacement and shutdown cancel the prior generation.

Both paths preserve the same strongly ACCEPT-biased safety policy. Only transcript records with `source=user` establish explicit authorization. Native classifier state is a JSON object containing the complete bounded policy/evidence text, with native choice/probability output instructions instead of a chat JSON contract. Native adapter parsing and transport differ from the former classifier integration; identical predictions are not promised.

### Authentication and model availability

Pi handles request-time authentication, endpoint overrides, headers and provider environment. Configure providers with `/login`, Pi environment variables, `models.json`, or provider extensions; ez-pass does not read keys or auth files itself. Discovery is operation-specific and auth-filtered, including classifiers that cannot use subscription login credentials. Availability does not prove quota, entitlement, reachability or model quality. Authentication loss escalates the selected path; it never selects another path/provider or disables deterministic rules.

The hidden `openai-codex/codex-auto-review` option remains selectable when Pi has an authenticated compatible `openai-codex-responses` template. A real catalog entry takes precedence; otherwise the existing narrow alias synthesis supplies its model metadata to the native runtime. No arbitrary model synthesis is allowed. Live service acceptance of this hidden ID is not tested here.

### Images and evidence budgets

Review remains text-only, even if the selected classifier supports images. Existing transcript rendering replaces image blocks with `[image omitted]`; raw image bytes are not sent in classifier `images` or chat messages. Other surrounding text remains evidence. This change adds no image understanding.

Transcript budgets are unchanged: first/latest user evidence, at most 40 retained entries, separate approximate 10,000-token message/tool budgets, 2000-token message-entry and 1000-token tool-entry limits. Action details keep their 10,000-token budget, omission markers and retry feedback limits.

### Permanent rules

User-owned global `config.json` may define `rules.allow.commands`, `rules.allow.paths`, `rules.block.commands`, and `rules.block.paths`. Project config cannot define rules. Bash uses command rules only; edit/write use only their explicit `path`. Command patterns are case-sensitive, trimmed, anchored to the full command, and `*` is the only wildcard. Commands containing `;`, `&`, `|`, a newline, carriage return, backtick, `$(`, `<(`, or `>(` bypass permanent command rules and go to model review; this intentionally includes quoted or escaped-looking operators. Path roots are recursive absolute paths, `~/...`, or exact `$CWD` (session-start working directory), and match lexical spelling and freshly resolved symlink targets, including nonexistent descendants below an existing ancestor.

The most-specific matching rule wins symmetrically. Exact command patterns beat wildcards; wildcard specificity uses more non-`*` characters, then fewer `*`. Narrower path roots beat broader roots. An equal allow/block tie requires a human and blocks without UI.

## Permission review log

Best-effort, append-only, privacy-reduced JSONL telemetry stays at:

```text
~/.pi/agent/runtime/review-permission-logs.jsonl
```

Model records identify `reviewer` and `policy` as `sys1` or `sys2`, with provider/model identities, uppercase outcomes, attempts, duration and failure phase/category. Native preparation errors encoded in results use `provider-error`; unavailable auth discovered before dispatch uses `auth-unresolved`. No vendor-text parsing decides permissions. Human decisions remain separately named. Input/value bodies are hashed, previews bounded and common secrets redacted. Directory/file modes are `0700`/`0600`. Logging never changes permissions and is not a tamper-proof audit trail.

The confirmation coordination event remains `pie-ez-pass:permission-confirmation:v1` with exact `{requestId, active}` payloads around the dialog. Normal operation remains silent.

## Install

Load the package from npm or this repository/submodule using Pi's extension configuration. The tracked `dist/` bundle includes `zod`; host Pi packages remain external. Node.js `>=22.19.0` is required.

Development dependencies target **Pi 1.1.0**, the latest npm release verified for pi-ai, pi-coding-agent and pi-tui on 2026-10-12. The peer support range is `>=1.1.0 <1.2.0`; checks run against exactly 1.1.0. Older Pi versions are unsupported. No old transport dependency remains.

## Configuration (breaking change)

`reviewer` is mandatory in the **effective** configuration; it has no silent default. Example with both default model selections:

```json
{
  "$schema": "https://raw.githubusercontent.com/akhilsbehl/pie-ez-pass/refs/heads/master/schemas/config.schema.json",
  "reviewer": "sys1",
  "sys1_provider": "openrouter",
  "sys1_model": "typesafe/jev-1.13",
  "sys1_escalate_threshold": 0.6,
  "sys2_provider": "openai-codex",
  "sys2_model": "codex-auto-review",
  "sys2_reasoning": "low",
  "timeoutMs": 30000,
  "rules": { "allow": { "commands": [], "paths": [] }, "block": { "commands": [], "paths": [] } }
}
```

| Scope | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/pie-ez-pass/config.json` |
| Project | `<session-start-cwd>/.pi/extensions/pie-ez-pass/config.json` |

`PI_CODING_AGENT_DIR` replaces the global agent directory. Each project field overrides its global field independently. Both model pairs, `sys1_escalate_threshold` (0–1 inclusive, default 0.6), `sys2_reasoning` (default `low`), `timeoutMs` (integer 1–300000), and optional `additionalPolicy` can be layered. Global-only rules default to empty; the mandatory safety policy is retained and additional policy appended. Configured defaults do not prove availability, and an unavailable inactive model does not invalidate config.

**Old keys (`use_jev`, `jev_escalate_confidence_threshold`, `provider`, `model`, `reasoning`) now fail validation. There are no migration paths or exported legacy aliases.** Loading means reading/validating/merging in memory, not rewriting files. Update existing files manually before using settings; malformed layers cannot be edited through the command. Only explicit Save writes the selected layer, without materializing inherited defaults or rewriting the other layer.

The [example config](config/config.example.json) retains suggested read/test/build allows, path roots and high-risk blocks. Users must manually copy desired rules into global config; the extension never seeds live config. See the [JSON Schema](schemas/config.schema.json) for the effective configuration contract.

### Settings command

```text
/ez-pass
/ez-pass show
/ez-pass path
/ez-pass help
```

Settings waits for idle, requires TUI, selects global/project scope, and edits a draft until explicit Save. Escape/Cancel writes nothing. Both model rows remain visible. Each opens a combined searchable provider/model picker for its operation, using public Pi UI/TUI APIs. Search matches provider, model ID (including slashes), combined identity and display name. Rows show `model-id [provider-id]`; selected details show the full identity. Discovery and selection auth checks are bounded to 15 seconds and cancelled on close.

Only auth-available models are selectable; unavailable configured values stay visible as status without replacement. Empty lists suggest `/login`. The picker has no unrestricted custom-value entry; advanced models must be registered in Pi. Inherit stays reachable regardless of search (Tab shortcut) and removes both selected-layer pair fields. Selection updates provider/model atomically; unrelated partial overrides retain field-level semantics. New choices are auth-rechecked before Save. No inference probes, login flow, conversation-default shortcut or model-scope changes occur.

`show` reloads current config, reports canonical values and separate field origins, and adds typed availability (`available`, `available-hidden-alias`, `unavailable-auth`, `unknown-model`, `discovery-error`). `path` displays logical paths without resolving/retargeting symlinks. No reset/delete command exists. Global symlink saves update the target while preserving the link; other saves use temp-file rename and optimistic source-conflict detection.

## Development

Run `npm run typecheck`, **`npm run build`, then `npm test`** (public-package tests import tracked dist). Keep generated `dist/` synchronized. Tests use fake native models/providers, never external inference.

## License and attribution

[MIT](LICENSE). This project is an Akhil-owned personal-use adaptation of the MIT-licensed `pi-permission-auto-review` package from [mzwing/pi-packages](https://github.com/mzwing/pi-packages/tree/main/packages/pi-ez-pass). Preserve that attribution when redistributing.
