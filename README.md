# pie-ez-pass

A [Pi](https://github.com/earendil-works/pi) extension providing Codex-style review for `bash`, `edit`, and `write` tool calls.

## How it works

The extension uses Pi's `tool_call` hook and Pi's local `ctx.ui.confirm` UI. This local dialog is the entire human permission system; no external permission service is involved.

- Reviewer outcome `ACCEPT` returns `{}` and the unchanged call executes without interruption.
- Reviewer outcome `ESCALATE` opens the local confirmation dialog. Human approval returns `{}`; rejection returns a blocking result and enforces that decision.
- Provider, parser, reviewer, and configuration failures use the same local confirmation flow.
- Without an interactive UI (`ctx.hasUI === false`), escalation and failures fail closed.
- Approval applies only to the current call; there are no session approvals.
- Other tools pass through unchanged.

### Permanent rules

User-owned global `config.json` may define `rules.allow.commands`, `rules.allow.paths`, `rules.block.commands`, and `rules.block.paths`. Project config cannot define rules. Bash uses command rules only; edit/write use only their explicit `path`. Command patterns are case-sensitive, trimmed, anchored to the full command, and `*` is the only wildcard. Commands containing `;`, `&`, `|`, a newline, carriage return, backtick, `$(`, `<(`, or `>(` always go to model review before any permanent command rule is considered; this intentionally includes quoted or escaped-looking operators. Path roots are recursive absolute paths, `~/...`, or exact `$CWD` (the session-start working directory), and match both their lexical spelling and freshly resolved symlink target (including nonexistent descendants below an existing ancestor).

For both commands and paths, the most-specific matching rule wins symmetrically. Exact command patterns beat wildcard patterns; wildcard specificity uses more non-`*` characters, then fewer `*`. Narrower path roots beat broader roots. A remaining equal allow/block tie requires explicit human confirmation and blocks without UI.

## Permission review log

Best-effort, append-only, privacy-reduced JSONL telemetry is written to:

```text
~/.pi/agent/runtime/review-permission-logs.jsonl
```

Records cover tool requests, uppercase reviewer outcomes (`ACCEPT`/`ESCALATE`), separately named human decisions, failures, deterministic acceptance, and session lifecycle. Input/value bodies are hashed; summaries are truncated and common credential assignments redacted. The directory and file are created with modes `0700` and `0600`. Logging never changes a permission decision and is local telemetry, not a tamper-proof audit trail.

## Install

Load the package from npm or from this repository/submodule using Pi's extension configuration. The tracked `dist/` bundle can be loaded directly and includes its runtime `zod` dependency. Node.js `>=22.19.0` is required.

## Configuration

Defaults:

```json
{
  "provider": "openai-codex",
  "model": "codex-auto-review",
  "reasoning": "low",
  "timeoutMs": 90000,
  "rules": { "allow": { "commands": [], "paths": [] }, "block": { "commands": [], "paths": [] } }
}
```

| Scope | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/pie-ez-pass/config.json` |
| Project | `<cwd>/.pi/extensions/pie-ez-pass/config.json` |

Project model/reviewer fields override global fields; permanent `rules` are accepted only from global config. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set. Supported model/reviewer fields are `provider`, `model`, `reasoning`, `timeoutMs`, and optional `additionalPolicy`; global config additionally supports `rules`. Missing rule arrays default to empty. The [example config](config/config.example.json) contains restrained suggested read/test/build allows, suggested path roots, and a small set of high-risk Bash blocks; users must manually copy the rules they want into their live global config. The extension never seeds or rewrites the live user config. The primary safety prompt is mandatory; additional policy is appended to it. See the [JSON Schema](schemas/config.schema.json).

Use the interactive settings command to edit and immediately apply configuration:

```text
/ez-pass
/ez-pass show
/ez-pass path
/ez-pass reset [global|project]
/ez-pass help
```

Global config symlinks are supported: saving updates the target while preserving the symlink. `codex-auto-review` derives from Pi's `openai-codex` provider and reuses the existing Codex login.

## Development

Run `npm run typecheck`, `npm test`, and `npm run build`. Generated `dist/` files are tracked.

## License and attribution

[MIT](LICENSE). This project is an Akhil-owned personal-use adaptation of the MIT-licensed `pi-permission-auto-review` package from [mzwing/pi-packages](https://github.com/mzwing/pi-packages/tree/main/packages/pi-ez-pass). Preserve that attribution when redistributing.
