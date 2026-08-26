# pie-permission-auto-review-codex

[![npm version](https://img.shields.io/npm/v/pie-permission-auto-review-codex?style=flat&logo=npm&logoColor=white)](https://github.com/akhilsbehl/pie-permission-auto-review-codex) [![CI](https://img.shields.io/github/actions/workflow/status/akhilsbehl/pie-permission-auto-review-codex/release.yml?style=flat&logo=github&label=CI)](https://github.com/akhilsbehl/pie-permission-auto-review-codex) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT)

A [Pi](https://github.com/earendil-works/pi) extension that provides standalone Codex-style permissions for agent `bash`, `edit`, and `write` tool calls.

## How it works

The extension uses Pi's native `tool_call` hook. It does not depend on or register with another permission system.

Path-based write exemptions are enforced in code, not by asking the reviewer
model to recognise trusted directories. Paths are resolved relative to the
session working directory, with path-segment boundaries enforced.

- The reviewer can `allow` a call. Pi executes it without a prompt.
- The reviewer can `redirect` a call. The tool is blocked and the main model receives a concrete narrower instruction.
- After two redirects in one negotiation, the third redirect escalates to the user.
- The reviewer can `escalate` a call. Pi shows its native confirmation dialog.
- Reviewer failures, invalid responses, timeouts, and unavailable configuration escalate. If no UI is available, the call is blocked.
- User confirmation applies to that call only. There are no session approvals.
- Explicit `edit` and `write` targets in the agent's current working directory,
  `/tmp`, `~/tmp`, `~/.richie`, `~/.pi`, and `~/warchives` bypass model review
  deterministically. `bash` remains reviewed because its write target cannot be
  determined safely from the command string.
- Tool calls other than `bash`, `edit`, and `write` pass through unchanged.

Pi already supplies the required UI through `ctx.ui.confirm`; this package does not install a custom TUI.

## Permission review log

Each reviewed `bash`, `edit`, and `write` call is recorded as one JSON object per line in:

```text
~/.pi/agent/runtime/review-permission-logs.jsonl
```

Records are append-only and use schema version `1`. The logger creates the runtime directory with mode `0700` and the file with mode `0600`; logging is best effort and never changes a permission decision. The schema is:

- Common: `schemaVersion`, `timestamp` (ISO 8601), `sessionId`, `event`, and usually `requestId`, `toolCallId`, and `toolName`.
- Request events: `event: permission.tool_call`, `operation`, `requestSummary`, `inputKeys`, `inputSha256`, and `valueSha256`. The summary shows the command or target path, is truncated, and redacts common credential assignments. Tool contents and prompts are not stored.
- Reviewer verdicts: `event: auto_review.decision`, `policy: model-review`, `provider`, `model`, `outcome`, `riskLevel`, `userAuthorization`, `rationale`, `redirect`, and `durationMs`.
- Deterministic decisions: `event: permission.decision`, `policy: deterministic-path`, and `outcome: allow`.
- User escalation: `event: permission.user_decision`, with `policy: user-confirmation` and `outcome` `approved` or `denied`.
- Blocked outcomes: `event: permission.blocked`, with a non-sensitive `reasonCode`.
- Errors: `event: permission.error` or `auto_review.failure`, with `errorCategory`; error messages are not stored.
- Session lifecycle: `permission.session_start` and `permission.session_shutdown` records. The working directory is hashed.

The log is local telemetry, not an audit trail: an attacker who can write to the user's home directory can alter it, and SHA-256 digests can be matched against guessed inputs. It can contain sensitive command paths and model rationales despite redaction. Protect and rotate it as needed.

The tracked runtime bundle includes its only runtime library dependency, `zod`. A fresh checkout can therefore be loaded directly from a symlink without `node_modules`. The package still declares `zod` for normal npm installation and TypeScript declarations.

## Install

```text
Load the local package from the `configs` submodule path.
```

This fork targets Node.js `>=22.19.0`. Provider lookup compatibility is implemented locally; no polyfill package is required.

## Configuration

Extension config is optional. Defaults are:

```json
{
  "provider": "openai-codex",
  "model": "codex-auto-review",
  "reasoning": "low",
  "timeoutMs": 90000,
  "includeBaselinePolicy": true
}
```

Configuration scopes:

| Scope   | Path                                                                    |
| ------- | ----------------------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pie-permission-auto-review-codex/config.json`   |
| Project | `<cwd>/.pi/extensions/pie-permission-auto-review-codex/config.json`    |

Project fields override global fields. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set.

| Field                   | Default             | Description                                  |
| ----------------------- | ------------------- | -------------------------------------------- |
| `provider`              | `openai-codex`      | Pi model-registry provider id                |
| `model`                 | `codex-auto-review` | Model id within the selected provider        |
| `reasoning`             | `low`               | Reasoning level for reviewer calls           |
| `timeoutMs`             | `90000`             | Total budget across retry attempts           |
| `includeBaselinePolicy` | `true`              | Include the built-in operator risk policy    |
| `additionalPolicy`      | omitted             | Optional policy appended to the built-in one |

See the [example config](config/config.example.json) and bundled [JSON Schema](schemas/config.schema.json).

Use `/permission-auto-review` in Pi's interactive TUI to edit and apply global or project config without reloading the session:

```text
/permission-auto-review show
/permission-auto-review path
/permission-auto-review reset [global|project]
/permission-auto-review help
```

`codex-auto-review` is derived from Pi's `openai-codex` provider and reuses the existing Codex login.

## License

[MIT](LICENSE)

## Attribution

This project is an Akhil-owned personal-use adaptation of the MIT-licensed `pi-permission-auto-review` package from [mzwing/pi-packages](https://github.com/mzwing/pi-packages/tree/main/packages/pi-permission-auto-review). See `LICENSE` and `package.json` for attribution.
