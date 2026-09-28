# macOS Web GPT recovery acceptance — 2026-09-28

## Current verdict

**Failed stability gate.** Installed candidate `5.0.7-local.46` has package and process identity
evidence. The prior `.45` fresh-task and retained-task two-hour runs both stopped on their first
round because the automated browser received a Cloudflare challenge; no 20-round run has passed.
`.46` additionally fixes a separate closed-browser-context defect found in a real user chat.
Prior successful paths are carried forward where their implementation is unchanged, following
the user's instruction. Failed rounds remain failures and are never counted as passing.

## Candidate identity and offline gates

- Candidate: `5.0.7-local.46`; installed bundle ID
  `8e41eaa8572d4e2fa8496f9b5f87c521bddcdcc2a4cc7ca068fb41b4938ded1d`.
- `bun run verify`: all 11 stages passed, including typecheck, tests, audits, runtime bundle and
  relocatable runtime smoke. The final source tree, including the retained-session acceptance
  script, passed again; see `output/web-recovery-local46-verify.log`.
- Signed macOS ZIP and DMG: `launcher/artifacts/codex-web-gpt-5.0.7-local.46-mac-arm64.zip` and
  `.dmg`. SHA-256: ZIP `75422a4842e936d209f787dcfda19a8595559e97d47da80186f92643b2d36d5d`,
  DMG `85eee755766250c1c0fc53db888654990693c45d20ed08978f0d48930be4f64c`. Package
  smoke passed and preflight verified code signature and embedded runtime manifest.
- The installed App, stable CLI, gateway and backend report `.46`; the two running services report
  the same bundle ID. The installed App signature verifies, and its embedded runtime manifest
  matches the versioned runtime manifest. See `output/web-recovery-local46-install.log`.
- With the Web backend stopped, the gateway completed a real native `gpt-5.6-luna` response (`OK`,
  nine SSE events). A malformed Web-route request then started the backend on demand without
  opening a ChatGPT browser turn. `scripts/acceptance-native-isolation.ts` reproduced the full
  sequence on `.44`; see `output/web-recovery-local44-native-isolation.log`. `doctor` correctly reports Web as **unverified** until a real
  installed Web turn completes. After the real Light turn and five-way batch, `doctor --json`
  reports `ok: true` and Web readiness `ok`; see `output/web-recovery-local44-doctor-after-web.json`.

## Real acceptance matrix

| Gate | `.46` result, including carried evidence | Evidence / remaining check |
| --- | --- | --- |
| Every account tier, selected model/effort and tool read | Passed, carried | A `.44` five-way batch gave distinct correct answers and successful file-read receipts for all five tiers. `output/web-recovery-local44-parallel-effort-evidence.json` shows browser slider values 0–4. Source routing binds each tier to one value; the parallel snapshot itself does not carry the Codex turn ID. Pro will not be repeated. |
| Coding task and image input | Passed, carried | `.43` created and verified a result file; High identified a red 64×64 image. The stability window will recheck both without Pro. |
| Three-round context and retained compaction | Pending | `.43` Pro third round recalled the fact, but retained handoff stalled and fresh fallback supplied the checkpoint. Retained path remains unproven. |
| Lost browser session and fresh compaction | Pending | `.43` rebuilt a checkpoint after backend restart; the following turn failed on Cloudflare `/backend-api/models` HTTP 403. |
| Two-way and five-way isolation; sixth rejection | Passed, carried | `.43` two-way and `.44` five-way batches passed distinct markers and tool receipts; the sixth was rejected by the five-turn contract. Codex retried that expected rejection five times, but browser diagnostics show five batch pages and no sixth page. Another two-way batch is included in the stability run. |
| Cancellation, interrupted recovery | Passed, carried | `.42` completed a real accepted-prompt interruption, stopped new browser/tool work, released resources and completed the next turn. Cancellation path is unchanged in `.45`. |
| Settings close, idle exit, restart, sleep/wake | Passed, carried | `.44` native isolation, on-demand backend start and service restart passed; gateway stayed up after backend idle exit with Settings closed. `.41` logged real Sleep/FullWake and completed a Web tool read afterward. Sleep handling is unchanged in `.45`. A later three-second lid close only produced Display off/on and is not counted. |
| Two hours / 20 valid real rounds | Failed | The fresh-task script stopped at 0/20 after slot 1 hit Cloudflare. More than an hour later, the retained-task script also stopped at 0/20 on its first Light turn. Both logs preserve their first failure: `output/web-recovery-local45-stability.jsonl` and `output/web-recovery-local45-retained-stability.jsonl`. Neither run used Pro. |
| Installed delivery | Partial | `.46` offline verification, signed package smoke, preflight and installed identity passed. Its closed-context fix has package identity and offline regression evidence; a real accepted Web turn after context loss remains unverified while Cloudflare blocks the browser. Long-running Web stability has not passed. |

## Reproduction commands

Run from this repository with the installed Bun runtime on `PATH`. The commands below use the
installed route and a dedicated temporary workspace; none use the personal Chrome profile.

```sh
bun run verify
bun run app:smoke
bun run scripts/smoke-installed.ts --live-model chatgpt-web/light --live-tool-read
bun run scripts/smoke-installed.ts --live-model chatgpt-web/medium --live-workspace-task
bun run scripts/smoke-installed.ts --live-model chatgpt-web/high --live-image
bun run scripts/smoke-installed.ts --live-model chatgpt-web/light --live-continuity --live-compact
bun run scripts/smoke-installed.ts --live-model chatgpt-web/medium --live-continuity --live-lost-session --live-compact
bun run scripts/acceptance-parallel-live.ts
bun run scripts/acceptance-real-cancel.ts
bun run scripts/acceptance-native-isolation.ts
bun run scripts/acceptance-stability-live.ts --plan
bun run scripts/acceptance-stability-live.ts --run --record output/web-recovery-local45-stability.jsonl
bun run scripts/acceptance-retained-stability.ts --plan
bun run scripts/acceptance-retained-stability.ts --run --record output/web-recovery-local46-retained-stability.jsonl
```

For an isolated, synthetic long-history compaction check, use
`bun run scripts/acceptance-hierarchical-live.ts --execute --profile <separate-verified-profile>`.
Its deterministic 60-record fixture must complete every leaf and retain `AZURE-731` in the merged
summary. The pre-install real run passed three leaves plus merge; see
`output/web-recovery-hierarchical-index-full.log`.

## Failure and recovery record

For a future visible Cloudflare challenge, run the installed
`codex-chatgpt-web clear-challenge`. In `.45` it opens an ordinary Chrome window bound to the
dedicated profile and the same proxy. A human completes any check, confirms ChatGPT works, then
quits that dedicated Chrome completely. The command then verifies the composer and account model
controls; its success is only browser readiness, so one real installed Web turn still must pass.
Do not repeat automated Web turns while the challenge remains. The installer retains the prior
App, runtime and private configuration for a controlled rollback if the installed candidate
needs to be withdrawn.

- `.43` at 2026-09-28 02:16–02:18 CST: the retained Pro handoff had a 200 conversation stream with
  one tool call and no visible assistant turn. The backend classified the stalled retained turn,
  then delivered a fresh checkpoint; Codex's next turn recalled the prior phrase. The retained
  path itself failed its dedicated gate.
- `.43` at 2026-09-28 02:23 CST: after backend restart and fresh checkpoint, ChatGPT answered
  `/backend-api/models` with a Cloudflare challenge (HTTP 403). The exact Codex turn failed;
  Codex attempted five automatic sampling retries. `.44` adds a bounded terminal HTTP response
  for immediate replays and passes its offline regression test.
- `.44` at 2026-09-28 02:55 CST: a cold-start Light turn still reached a visible Cloudflare human
  verification page. The first Codex retry received terminal HTTP 400 `cloudflare_challenge`
  before another browser tab opened, so the other four automatic retries were suppressed. The
  requested answer was not produced. In the same dedicated profile, `clear-challenge` showed a
  checkbox but timed out after the user tried it repeatedly. The stored profile had clearance
  cookies for `.chatgpt.com`, `.cloudflare.com` and `.auth.openai.com`; those cookies did not make
  the challenge pass. A direct, ordinary Chrome launch with that same profile and proxy is the
  next manual control. The user completed a manual answer there and exited; the next `.44` automatic
  Light turn also completed its exact answer without a retry. The cause of that transition is not
  proven by timing alone.
- `.44` at about 03:05 CST: the five account tiers each completed a distinct real tool read in
  parallel. `output/web-recovery-local44-parallel.log` records exact turn IDs, final lengths and
  five markers. The sixth failed at the configured limit; five Codex sampling retries did not
  create another browser page or tool receipt. Remaining real gates still block release.
- `.45` changes only the installed manual `clear-challenge` flow: it opens ordinary Chrome with
  the verified dedicated profile and matching proxy, waits for the human to exit it, then checks
  composer and model controls in the same profile. The ordinary-Chrome step and subsequent real
  automatic turn both succeeded before this change; the newly orchestrated CLI flow has passed
  source tests but has not been exercised end-to-end without a human present.
- `.45` at 03:31–03:32 CST: the first scheduled Light tool read was blocked by Cloudflare's visible
  human check, about 26 minutes after the five-way batch. Codex made one immediate retry, which
  `.45` rejected before opening a second browser page. The stability driver recorded 0/20 and
  stopped without retrying the failed slot. This candidate is not production ready.
- `.45` at 04:38–04:39 CST: after more than one hour without an automated Web probe, the
  retained-task stability script attempted only its first Light turn. The same visible human check
  blocked it before any answer. The script closed its App Server client and recorded 0/20; no
  further slots were submitted. A longer cooldown alone has not restored this browser path.
  `doctor --json` subsequently reported build and proxy `ok`, Web readiness `challenged`, and
  overall `ok: false`; see `output/web-recovery-local45-doctor-final.json`.
- Later on 2026-09-28, thread `01a0e61b-54c4-7151-b002-57e1a930c23e` had three
  `cloudflare_challenge` turns and then two **different** failures at 11:46–11:47 CST:
  `newPage: Target page, context or browser has been closed`. Each later trace reached
  `browser_page` and retried page creation about six times without sending a prompt. The worker
  cached a resolved persistent-context promise without checking `context.isClosed()` before
  `newPage()`. `.46` repairs that pre-submission state, reopens once and turns a second failure
  terminally; offline regression tests cover a stale context, a close during `newPage`, and
  cancellation while opening. The outside event that closed Chrome was not observed.
- The installer wrote the prior private configuration to
  `~/.codex-chatgpt-web/recovery/before-local-5.0.7-local.46/config.json`, kept the prior App at
  `~/.codex-chatgpt-web/app-archive/Codex Web GPT-before-5.0.7-local.46.app`, and retained the
  `.45` runtime under `~/.codex-chatgpt-web/versions/`. The rollback materials were checked on
  disk. Installation failures restore all three
  along with the stable CLI link and services. The original pre-recovery `.34` scene remains in
  `~/.codex-chatgpt-web/recovery/before-web-recovery-20260927-153948/`; it is a diagnostic
  rollback point, not a known-working release.

Do not describe this candidate as ready until every pending matrix row passes on the same installed
bundle and the stability log ends with `STABILITY_LIVE_OK`.
