# pie-permission-auto-review-codex

A [Pi](https://github.com/earendil-works/pi) extension providing Codex-style review for `bash`, `edit`, and `write` tool calls.

## How it works

The extension uses Pi's `tool_call` hook and Pi's local `ctx.ui.confirm` UI. This local dialog is the entire human permission system; no external permission service is involved.

- Reviewer outcome `ACCEPT` returns `{}` and the unchanged call executes without interruption.
- Reviewer outcome `ESCALATE` opens the local confirmation dialog. Human approval returns `{}`; rejection returns a blocking result and enforces that decision.
- Provider, parser, reviewer, and configuration failures use the same local confirmation flow.
- Without an interactive UI (`ctx.hasUI === false`), escalation and failures fail closed.
- Approval applies only to the current call; there are no session approvals.
- Other tools pass through unchanged.

### Deterministic write acceptance

Explicit `edit` and `write` paths under the session-start working directory, `/tmp`, `~/tmp`, `~/.richie`, `~/.pi`, and `~/warchives` bypass model review and are accepted deterministically. Relative paths resolve against the session-start working directory, and path-segment boundaries are enforced. `bash` always remains reviewed because command strings cannot safely establish a write target.

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
  "timeoutMs": 90000
}
```

| Scope | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/pie-permission-auto-review-codex/config.json` |
| Project | `<cwd>/.pi/extensions/pie-permission-auto-review-codex/config.json` |

Project fields override global fields. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set. Supported fields are `provider`, `model`, `reasoning`, `timeoutMs`, and optional `additionalPolicy`. The primary safety prompt is mandatory; additional policy is appended to it. See [example config](config/config.example.json) and [JSON Schema](schemas/config.schema.json).

Use the interactive settings command to edit and immediately apply configuration:

```text
/permission-auto-review
/permission-auto-review show
/permission-auto-review path
/permission-auto-review reset [global|project]
/permission-auto-review help
```

Global config symlinks are supported: saving updates the target while preserving the symlink. `codex-auto-review` derives from Pi's `openai-codex` provider and reuses the existing Codex login.

## Development

Run `npm run typecheck`, `npm test`, and `npm run build`. Generated `dist/` files are tracked.

## License and attribution

[MIT](LICENSE). This project is an Akhil-owned personal-use adaptation of the MIT-licensed `pi-permission-auto-review` package from [mzwing/pi-packages](https://github.com/mzwing/pi-packages/tree/main/packages/pi-permission-auto-review). Preserve that attribution when redistributing.
