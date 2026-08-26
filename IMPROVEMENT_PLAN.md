# Standalone permission-layer plan

## Objective

Use this fork as a standalone Pi permission layer rather than as an authorizer for another permission system.

## Behaviour

- Intercept Pi `tool_call` events directly.
- Review `bash`, `edit`, and `write` calls.
- Let all other tools pass through unchanged.
- Support three reviewer outcomes:
  - `allow`: execute the exact call;
  - `redirect`: block the call and send a concrete narrower instruction back to the main model;
  - `escalate`: show Pi's native confirmation UI.
- Allow at most two redirects in one negotiation, including across Pi turns. The third redirect escalates.
- Apply user confirmation to one call only; do not support session approvals.
- Escalate reviewer failures, invalid responses, timeouts, and internal errors. If confirmation is unavailable, block the call.

## Default policy

The extension deterministically allows explicit `edit` and `write` targets
under the agent's session working directory and these personal directories,
recursively:

- `/tmp`, `~/tmp`, `~/.richie`, `~/.pi`, and `~/warchives`.

Shell commands remain subject to review because their write target cannot be
classified safely from the command string. The built-in reviewer policy treats
these as low risk:

- ordinary, non-intrusive network access;
- tools and skills from installed extensions;
- verified user-requested local deletions and bounded changes;
- routine Git operations.

It raises risk for credential exposure or modification, broad privileges, production/shared impact, intrusive network behaviour, destructive operations, and especially destructive remote Git operations.

## Validation

- Test the three reviewer outcomes at the reviewer boundary.
- Test tool filtering, redirect negotiation, escalation, user rejection, and fail-closed behaviour at the Pi `tool_call` boundary.
- Build the package and keep tracked `dist/` files synchronised.
- Bundle `zod` into the tracked runtime distribution so a fresh symlinked checkout needs no `node_modules`.
- Verify the package has no runtime or peer dependency on `@gotgenes/pi-permission-system`.

## Attribution

This project remains an Akhil-owned personal-use adaptation of the MIT-licensed `pi-permission-auto-review` package from mzwing/pi-packages.
