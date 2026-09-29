# Native stability candidate `.66` — acceptance record

Date: 2026-09-29. Status: **installed candidate; full Web acceptance blocked**.

## Package and installation

- Source commit: `abd60aeff2975b51cd64a5566004dddc7b08d15f` on `codex/native-stability`.
- Candidate: `5.0.7-local.66`, bundle ID `b5073a88d9d8830253cb2a27afc3c83c7b5c7aa20c9e3e2daccd0f9821d372c7`.
- Signed ZIP: `launcher/artifacts/codex-web-gpt-5.0.7-local.66-mac-arm64.zip`, SHA-256 `85b3dfe1f6777634b9d2f5af0c5972ee7fdb3202bf0703e62b96314fda180ede`.
- Signed package validation and `install-local-candidate.ts --check` passed. The candidate was installed with its gate closed, then released after bundle and process checks. The stable CLI and configuration point to `.66`.
- The native gateway retained PID `96465` and its `.64` bundle throughout both backend upgrades. It reported `.66` as `backend_build` after cutover; the `.66` backend reported an open deployment gate and no active turns.
- The prevalidated `.65` App is archived at `~/.codex-chatgpt-web/app-archive/Codex Web GPT-before-5.0.7-local.66.app`; its configuration is saved under `~/.codex-chatgpt-web/recovery/before-local-5.0.7-local.66/`. The installer has transaction rollback with a persisted send-intent check. A post-install downgrade has not been exercised and must recheck unresolved intents before changing the stable entrypoint.

## Checks completed

| Gate | Result | Evidence |
| --- | --- | --- |
| Full source/launcher verification | Passed before the installer-only fix | `bun run verify` at `535f3d3`: 11 stages passed; 1148 source tests passed, 1 platform skip; 315 launcher tests passed, 1 skip; both audits, types, runtime bundle and release smoke passed. The final installer changes are covered by the next row. |
| Successive backend-only upgrade regression | Passed | 11 service lifecycle tests and typecheck after fixing idle-backend gateway verification. Actual `.65`→`.66` cutover passed. |
| Installed model routing | Passed | `smoke-installed.ts` without a live turn listed the native Luna route and five Web model routes. |
| Native continuity across backend stop/start | Passed | `acceptance-native-isolation.ts` on `.66`: exact native answer `OK`, 9 response events; native request did not restart the stopped Web backend; an invalid Web request then started the `.66` backend on demand. |
| Recorded wire replay | Passed with bounded fallback | 19 existing private recordings replayed offline; 15 produced a complete answer with no unapplied patch. Two old empty conclusions now recover complete answers. Four recordings remain incomplete and must not be promoted to final output. Measurements only are in `output/wire-replay-66.json`; raw conversations remain outside the repository. |
| Unresolved send intents | None observed | Read-only journal inspection found 0 unresolved intents immediately after installation. This is a point-in-time check. |

## Live Web gate

The single `.65` installed live-tool attempt reached the dedicated Chrome profile but ChatGPT answered `/backend-api/models` with a Cloudflare HTTP 403 challenge before prompt submission. The browser trace was `2ffffed6ff5b`; Codex turn ID was `01a0eb9a-ac2d-74c1-b710-fc6dd3f95e47`. No local tool receipt or task artifact was produced. Codex issued one implicit retry; the runtime stopped it before another browser tab opened. Backend health recorded `cloudflare_challenge`. The attempt is preserved in `/tmp/codex-native-stability-smoke.log` and the private browser diagnostics for that trace.

The `.66` package was **not** sent through ChatGPT again after that external challenge. Its `doctor` reports Web readiness `unverified`, while the local routing and native checks above pass. Consequently the required same-package 2-hour / 20-valid-turn run, ≥10 actual local tool calls with artifact, retained and fresh compaction, live concurrency/cancellation, commentary timing, final local links and one Pro check remain **unverified**. This candidate is not certified for daily Web use by the agreed completion rule.

When the external challenge no longer blocks the existing profile, the implementation agent should run `scripts/acceptance-native-task.ts --run` on the installed bundle, then `scripts/acceptance-retained-stability.ts --run` for the 2-hour window with the Mac awake on AC power, plus the focused installed cancellation/isolation checks. These must record exact thread/turn IDs, tool receipts and artifacts against this same bundle. No cookie reset, login experiment or Cloudflare challenge loop is part of the recovery path.
