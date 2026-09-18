# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ authenticated native Search and Image Gen request forwarding
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

Responsibilities split across three planes. Codex Runtime is the control and state plane: it owns
task identity, permissions, the tool registry, canonical history, and the compaction epoch. The
ChatGPT Web conversation is the reasoning plane and holds no independent long-term session
authority — every identity it uses is derived from the Codex task. Long-term memory is a third plane
reachable only through the Runtime. The connector bridges capability between them, and the Runtime
decides what the Web model can see and call at any moment.

That division, the reasoning behind it, and the parts of it that are deliberately not built yet are
recorded in the [architecture design](architecture-design.md). This document describes what the code
currently does.

## Modes

### `browser-only`

- Exposes Instant (`chatgpt-web/light`), Medium, High, and Extra High; each model advertises exactly one
  immutable Codex effort matching its ChatGPT browser mode. Extra High and Pro are separate observed
  account capabilities: the browser probe reports `extraHighAvailable` from an ARIA range of at least
  four effort options and `proAvailable` from at least five, so an account offering four options can
  select `xhigh` without `chatgpt-web/pro` being appended. A configuration written before
  `extraHighAvailable` existed inherits Pro's value, an explicit `false` stays authoritative, and Pro
  without Extra High is rejected as contradictory. `xhigh` shares the medium/high context window,
  whose auto-compact limit is 72,000 tokens so the next turn's system and runtime envelope still fits
  under the measured 90,000-token browser request ceiling.
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same fixed models and attaches the turn-bound connector capability to every available
  effort, from Luna through Pro. There are no effort-specific MCP exclusions.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents one outer Codex turn capability; the MCP server keeps the derived
  binding private and dispatches the requested action immediately.
- When Codex exposes tools behind its code-mode `exec` gateway, the connector discovers their
  runtime registry and can invoke an exact listed name through bridge-owned code. Full mode also
  preserves Codex's native freeform `exec`; its tool registry enforces the same bounded
  `wait_agent` contract as direct and structured calls.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

### Repository DEV driver

The DEV chat is not another provider or browser implementation. It is a synthetic outer-Codex
driver around the same in-process Responses handlers. `dev launcher` starts the packaged launcher
with an explicit `development` profile. That profile has a different core home, sandboxed
`CODEX_HOME`, Electron `userData`, persistent browser partition, descriptor, cookie jar, login,
configuration, chat store, diagnostic store, broker path, tunnel profile, and alias. The normal and
DEV launchers can therefore run at the same time with different ChatGPT accounts.

The working-tree adapter attaches to a tab leased only from that DEV launcher. In Full mode the DEV
launcher owns one persistent, isolated tunnel runtime; a named CLI chat owns only the private turn
broker attached to that tunnel for the command's lifetime. The distinct `Codex Native2 DEV`
connector reaches the same MCP server and turn-token contract without requiring any Responses
daemon or colliding with the production `Codex Native2` connector.

Only the responsibilities normally owned by native Codex are synthetic: named history storage,
turn metadata, tool-result execution, context-threshold scheduling, and installation of compacted
replacement history. Every tool result is an explicit `simulated: true` receipt with
`side_effects_performed: false`; no semantic router guesses a command result.

The driver calls `responseRequest` and `compactRequest` directly. It starts no HTTP server, does not
read or write Codex's route journal or `config.toml`, and does not stop or replace the normal
launcher-owned daemon. A `dev-harness` discriminator prevents the Responses server and production
launcher from starting a Responses daemon for its config. DEV setup stores browser capabilities
and tunnel credentials but performs no Codex integration, system service installation, or port
probe. The DEV launcher supervisor owns only the isolated MCP tunnel. Browser diagnostics, broker
state, thread authority, checkpoints, and named chat state live
under `~/.codex-chatgpt-web-dev` by default.

The ChatGPT connector name is also the public MCP ABI identity. The direct turn-token contract uses
`Codex Native2`; the retired `Codex Native` identity is never selected or refreshed in place. Setup
migrates known legacy local configuration to the new name, clears prior verification state, and
requires the user to create the new connector. Browser verification accepts the exact new identity,
reports a specific migration error when only the legacy identity is visible, and never falls back to
the legacy connector. Future public schema changes require another explicit connector identity.
Repository DEV mode uses `Codex Native2 DEV` so the same ChatGPT account can keep both production
and development connectors installed without renaming, refreshing, or deleting either one.

## Browser lifecycle

The backend owns the managed Chrome profile and up to five task-bound browser tabs for automatic
production turns. Each task/model/effort/compaction epoch owns one exact browser lease; sequential
native messages reuse that surface, while each message receives a fresh turn-bound MCP token and
keeps all of its MCP tool rounds inside one ChatGPT response. Compaction asks the same retained Web
agent for a one-shot structured checkpoint, waits for the response and physical helper cleanup,
then closes the old surface. The next epoch gets a new Temporary Chat. Model messages never copy
state between tabs. Launcher-owned manual/DEV compatibility mode uses the same lease rules inside
its private Electron partition. Closing a running tab destroys its page and terminates that browser
turn. A sixth concurrent turn fails explicitly; the cap avoids excessive parallel traffic that could
trigger account abuse controls.

Browser submission and response binding use ChatGPT's logical `data-turn-id`, not the
`conversation-turn-N` display index, which can change during rendering. The submission baseline
includes the persistent `data-turn-id-container` wrappers of virtualized history. Remounting old
messages therefore cannot count as a new submission or another user's turn. Missing or duplicate
logical identities fail explicitly; accepted messages are never resent to repair their DOM.

Automatic production sign-in uses the backend-managed Chrome profile and persists only its validated
storage state. Manual/DEV sign-in uses the persistent Electron partition; ChatGPT login pages and
allowed identity-provider popups are adopted into a temporary `WebContentsView` inside the launcher.
After the provider returns to ChatGPT, the active host requires both a server-authenticated session
and the Temporary Chat composer, then closes the temporary auth view. There is no browser-profile
handoff, cookie import, CDP login port, or temporary session-transfer directory.

Automatic Full-mode first turns and normal cache misses receive a compact
`<codex_bootstrap_context_json>` envelope containing the current task message. The omitted canonical
system/developer/history records remain in the Runtime broker and are retrieved on demand through
`codex_context_search` and `codex_context_read`, exposed via the existing
`codex_tool_inventory`/`codex_tool_call` ABI. A retained continuation instead receives
`<codex_resume_context_json>`, carrying only the canonical suffix after its last assistant reply
and omitting the system bootstrap that conversation already holds. Browser-only turns and
compaction/new-epoch requests still receive the complete `<codex_context_json>` bootstrap because
they have no equivalent live retrieval boundary. Full Codex history stays canonical on the Runtime
side: the retained ChatGPT conversation is a cache, never a source of truth, so losing it degrades
to a new compact bootstrap rather than corrupting state. Image bytes stay out of the JSON and are
attached natively with stable references; earlier images remain addressable in the same Temporary
Chat, so a resume does not resend them. The runtime does not create a context JSONL file, upload a
synthetic context document, include prompt hashes, or silently truncate the envelope. Attachment
acceptance and send readiness are verified before the turn begins.

Retention is measured rather than assumed. Every turn that expected a retained conversation records
a hit, or a miss naming each key component that rotated — and `conversation_lost` when nothing
rotated, which means the surface itself is gone rather than the identity having changed. Turns
excluded by design are counted apart, since they never attempted retention. `/healthz` reports the
totals, the resulting rate, and the per-cause breakdown.

The rate itself has no target, because most misses are correct: a thread has to start, a new epoch
has to open a new conversation, and a user switching model or reasoning should rotate it. The number
with a target is `unexplained_misses`, which counts only `conversation_lost` — a key that did not
change while its conversation disappeared — and the target is zero. A falling hit rate whose misses
are all explained means the workload changed; one with unexplained misses means something is
dropping conversations.

Because a resume deliberately omits the system prompt, the retained conversation key includes it
alongside thread, model, reasoning, and compaction epoch. Changed system instructions rotate the
key, and the next browser turn reconstructs from canonical Codex state instead of silently
continuing a conversation that was built under different rules.

Post-compaction Codex requests may retain the current environment item while omitting sandbox and
workspace fields from client metadata. Such a claim is accepted for the same thread only when it
matches the authority already proven for that thread; it can refresh that authority but never
change it.

Initial Launcher setup asks which interaction mode to install and defaults to With Automation. The
same choice remains available in Settings; changing it uses the transactional setup path, replaces
the installed catalog, and requires a Codex restart. Zero Risk never reads or mutates the ChatGPT DOM.
For a new Full-mode ChatGPT chat the adapter provides the compact bootstrap; for an exactly retained
chat it provides an incremental prompt containing only the Codex suffix after the last assistant
reply. Browser-only and compaction paths use the complete compiled prompt. The Launcher chooses
between those prompts from its own retained-tab ownership and writes the selected text to the system
clipboard. The user has thirty seconds to paste, select the visible
ChatGPT model, effort, and Zero Risk connector, send, and confirm Sent; a manual compaction handoff
allows two minutes. Sent ends that confirmation deadline. Waiting for the first MCP bind is part of
the live turn, which remains subject to explicit cancellation and runtime-owner cleanup.
The pasted task carries one opaque `request_id` for routing concurrent requests. Start/completion
sequencing lives in the Zero Risk MCP server metadata, not in user-authored imperative text; the
per-tab nonce used to validate the Launcher confirmation never leaves the local runtime.

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.
Top-level `model_context_window` raises only the proxied native rows' advertised maximum, allowing
Codex to apply its own configured context override without clamping. Routed ChatGPT Web models
retain their measured adapter-owned limits.

Bigger Context partitions complete ordered records against each message's available token and
composer budgets. Inert stages carry text; the final message also carries all retained attachments,
the execution contract and any output schema. Their reserves are deducted before partitioning,
then preflight checks the actual compiled messages and total transaction. The selected execution
effort, attachment references and three-part maximum remain unchanged.

In Full mode, routed compaction v1/v2 uses the exact retained source agent and a one-shot MCP control
capability that accepts only the bound checkpoint; it cannot claim or invoke the ordinary Codex tool
environment. Zero Risk always advertises a fixed three-times compaction interval without enabling
Bigger Context multipart transport. At that boundary its active ChatGPT response receives the
checkpoint instruction as an MCP result, returns the compacted context through its bound completion
control, and ends. The old manual chat is retired; the next compacted Codex request owns a fresh
Temporary Chat and its locally compiled prompt is copied to the clipboard. A missing Automatic
retained source falls back to a dedicated read-only Temporary Chat built from canonical Codex
history; a missing Zero Risk source uses the same explicit manual checkpoint contract. An invalid or
ambiguous handoff still fails explicitly. Browser-only mode
uses the same read-only summarization path, then returns the native replacement-history shape expected
by Codex. A prompt-level checkpoint marker is translated into a visible Codex trace item;
every later tool action in the same turn continues to present the current turn capability. Visible
ChatGPT status rows become reasoning summaries, while stable prose between rows becomes native
Codex commentary.

## Wire observation

Turn decisions are read from the rendered DOM: whether a submission was accepted, which reply is
this turn's, whether generation is still running, whether a block is reasoning or the answer,
whether the turn ended. Each of those is an inference over a private, unversioned presentation
layer, and each fails silently — a classification error returns an empty answer and raises nothing.
Measured over this repository's history, the three files holding that logic account for 119 of the
changes made by fix commits, against 5 for the Zero Risk path, which reads no DOM at all.

ChatGPT's own client does not infer any of it. It streams each turn over `fetch`, and the facts the
DOM path derives are fields in that stream. A page-side observer reads the same bytes:

- **Nothing is forged.** The page's client builds and sends every request, so anti-automation
  tokens, headers, and TLS characteristics remain exactly what ChatGPT produced. This observes
  traffic; it never synthesises it.
- **Nothing is perturbed.** The response passes through a `TransformStream` rather than being
  `clone()`d or `tee()`d. There is no second consumer and therefore no added backpressure:
  observation happens on the page's own read. A body the page never reads is never observed, which
  is correct, because those are bytes the user never saw either.
- **Nothing propagates.** Every observation path is guarded, and the host refuses any record that
  does not match the expected shape — the binding is an entry point from a remote origin.

Framing is decoded to the WHATWG event-stream rules, which are public and therefore implemented
exactly. The payload schema above it is private, so it is written to *recognise* rather than to
assume: a frame matching no known shape becomes an explicit `unrecognized` event naming its keys,
and a patch the fold cannot apply is counted rather than approximated. `/healthz` reports both
tallies under `wire_observation`; their target is zero, and a non-zero value names the shape still
to be understood instead of leaving a wrong answer to be discovered by a user.

The observer currently holds no authority. Every turn is still decided by the DOM path, and the two
conclusions are compared per turn so the disagreement rate is measured before anything depends on
it. The comparison is shaped around the failure that motivated it: `dom_empty` — the DOM found
nothing while the stream carried a reply — is its own outcome rather than part of a generic
mismatch, because that is the signature of the silent failure. Comparisons record lengths, not text.

Raw transcripts are what turn a live failure into an offline regression test, and are also verbatim
copies of a conversation. They are therefore written only when `CODEX_CHATGPT_WEB_WIRE_TRANSCRIPTS`
is set, into an owner-only directory, pruned to a bounded window. The counters need no content and
are always on.

## Memory plane

Codex Runtime is the only control plane for long-term memory. The browser never opens its own
connection to a memory service; a second independent entry point would produce duplicate recall,
divergent retrieval strategies, two session states, and conflicting writes. Memory reaches the Web
model along two Runtime-owned paths:

- **Push.** Runtime-injected `<openviking-context>` blocks are recognised by source
  (`session-start`, `auto-recall`) and compiled as runtime context. A superseded block of the same
  source is dropped, so only the current recall occupies the transport budget.
- **Pull.** The retrieval capabilities registered for the turn are named in the prompt by their exact
  wire names, so retrieval is something the model depends on rather than discovers. A turn with none
  is told so explicitly, because silence would leave an empty search looking like an empty memory.
  Deeper capabilities remain discoverable through `codex_tool_inventory` and invocable by exact name
  with `codex_tool_call`, instead of requiring all such context to be preloaded into the prompt.

Recalled memory carries explicit provenance — `kind=memory`, `source=openviking`,
`trust=reference_data`, `instruction_authority=none` — and the shared contract states that
instruction-like text inside such an envelope holds no system, developer, or user instruction
authority. Recall is data, not an instruction channel, regardless of the fact that the Runtime
injected it.

Memory retrieval availability is counted per turn and reported on `/healthz` with the last observed
capability set, so a harness that stopped registering retrieval is distinguishable from one that
never did, and from a memory that is simply empty. The bridge reports what the Runtime exposes; it
cannot supply a capability that was never registered.

Memory writes stay with the Runtime, and the bridge enforces it. A memory capability is recognised by
its namespace and classified by its operation; only a classified read is reachable by the Web model.
The filter applies under every contract, before the contract-specific ones, and covers capabilities
discovered through the exec gateway as well — otherwise hiding a write from the registry would move
it one call deeper rather than out of reach. A write that is named directly fails with the same
"not available in this turn" error as any other hidden capability.

An operation that matches neither classification is refused rather than allowed. The asymmetry is
deliberate: hiding a read costs a lookup the model can make another way, while exposing a write costs
long-term memory that nothing will announce as corrupted. Writes remain available to the Runtime,
which is what "Runtime-controlled" means — the capability is not removed, only the Web model's
ability to initiate it. Persistence does not depend on that ability: the memory service commits each
completed turn once on its own, through the same path a native Codex turn takes, so denying the Web
model a write closes a second entry point rather than stopping anything from being remembered.

## Turn recovery

A browser-reported failure has no authority over state the control plane has already accepted. Three
decisions follow from one classification in `recovery-policy.ts`, so a new ChatGPT error code is
handled in one place instead of three: whether to wait for a compaction handoff, whether to retain a
failed tab, and whether a retained retry is allowed.

- **Compaction handoff.** A structured checkpoint that has crossed the MCP boundary is recorded by a
  short-lived broker tombstone. A page-terminal error arriving afterwards defers to the checkpoint
  instead of winning the `Promise.race` and killing the local compact. The external token keeps its
  one-shot semantics — a second submit still returns invalid/consumed. The grace window covers only
  upstream errors that can genuinely arrive alongside an MCP submit; timeouts, missing resources,
  cancellation, and "Stopped thinking" fail immediately.
- **Post-submit failures.** An unclassified exception after submission is a structured error rather
  than an automatic dead turn. A turn holding a retained conversation may reconnect, and the retry
  sends an empty incremental envelope so the accepted prompt is never delivered twice. A turn with no
  retained conversation still returns a non-retryable error. Only a provably idempotent continuation
  reconnects; nothing is blindly replayed.
- **Physical agreement.** The Launcher retains a failed tab only when `retainForRetry` is set and the
  connector is bound, so the adapter's retryable conclusion and the real ChatGPT session stay
  consistent. Other failures still release the tab.
- **Bounded reconnection.** Reconnecting is allowed once. A conversation whose responses keep
  erroring is not repaired by sending it more messages — each retry only appends another user turn
  to a chat that answers none of them — so after the allowance is spent the retained conversation is
  released before the next lease. The Launcher then leases a fresh Temporary Chat, and the worker's
  existing choice between the continuation prompt and the full bootstrap does the rest. Failing to
  release costs only the rebuild and leaves the ordinary resume in place, since an unreachable
  Launcher must not turn a recoverable retry into a dead turn.

Verification status: confirmed by live logged-in runs on 2026-09-13, including the rebuild path.

The first run established both the recovery and its limit. A transient "Something went wrong" was
reconnected within one second and the turn completed, and a structured compaction handoff was
accepted with the next epoch opening on a new conversation. Then the post-compaction turn failed
three consecutive resumes into one conversation, each within ten seconds, while its user turns grew
from one to three and its assistant replies stayed at one. Codex spent its retry budget and the task
ended with no answer.

The second run, after bounding reconnection, hit the same failures at the same points and finished.
The opening turn failed, resumed, failed again, then released the conversation and rebuilt on a fresh
one that retrieved context and completed. Compaction was accepted as before. The post-compaction turn
— the one that had ended the first run — failed once on its new-epoch bootstrap, released, rebuilt,
and completed. Message sizes distinguish the paths without ambiguity: a resume carried 1,884
characters against the bootstrap's 3,560, and each rebuild returned to full bootstrap size.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode uses the configured Chrome executable for backend-owned sign-in and model turns,
without a tunnel. Full mode separately downloads the official pinned
`openai/tunnel-client` build for the current OS/architecture and verifies it against the release
SHA-256 manifest.

A build says which source produced it. The runtime manifest records the commit, whether that tree
had uncommitted changes, and when the build ran; `/healthz`, `codex-chatgpt-web --build`, `doctor`,
and the Launcher's first log record of each session all report it. Because a daemon keeps serving
the build it started with, reinstalling a runtime changes nothing until that process restarts —
both sides report the bundle they are running, so `doctor` decides that mismatch rather than
leaving "the fix does not work" indistinguishable from "the fix is not running". The identity lives
in the manifest rather than inside the bundle, because `bundleId` hashes the bundle's own files and
an embedded timestamp would change that hash on every build; the manifest is excluded from the
hash, so a build stays reproducible while still naming itself.

On first launch, the embedded runtime is checked against a deterministic manifest covering every
file path, size, and SHA-256 before any launcher port or window opens. The source, transactional
temporary copy, and final destination are all validated before the private versioned directory is
accepted under the application home. Daemon and MCP commands use that durable copy, which is
required because Linux AppImage mount paths are temporary and must never be persisted in Codex or
tunnel configuration.

Terminal-managed Codex mode now uses a headless `BackendHost` behind an independent native gateway.
The gateway owns the stable Codex route on `nativeGatewayPort` (17841 by default), forwards native
Codex requests directly to the official backend, and stays available in its own macOS LaunchAgent.
The Web Responses backend owns `port` (17842 by default), so stopping it cannot remove native
Codex network access. Web requests arriving at the gateway start or reuse the backend. The Web
LaunchAgent is loaded as an on-demand job with `RunAtLoad=false` and `KeepAlive=false`; Codex
`SessionStart` and `UserPromptSubmit` hooks kick it when a routed task needs it. `codex-chatgpt-web
backend` owns tunnel startup, tunnel readiness, the Responses listener, and ordered shutdown.
Session leases are refreshed by Codex and released by `SessionEnd`; a lease records the Codex host
PID and remains valid while that host is alive, while an owner that exits is pruned automatically.
After 120 seconds with no lease or active turn, the Backend Host exits. This path is independent of
Electron, so closing Settings does not affect a Codex task. Existing standalone tunnel LaunchAgents are drained and removed during setup migration;
the backend owns both processes after migration. Automatic setup initiated from Desktop selects
`managed-chrome`, and login state is stored in the backend browser profile. Codex and the service
both use the stable `~/.codex-chatgpt-web/bin/codex-chatgpt-web` entry when a packaged runtime is
available, so runtime upgrades do not require rewriting every command to a versioned directory.

Launcher-owned mode remains as a compatibility path for Zero Risk and other browser surfaces that
still require the embedded BrowserHost. In that path the launcher remains the process supervisor,
starts the optional tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and
then waits for its versioned health payload. Native login items or an owner-local XDG autostart file
may still launch that compatibility UI. Manual interaction remains the final BrowserHost migration
item; automatic production setup and turns already use the headless backend. Production Desktop
opens the login/setup guide and settings; Browser, Activity, and manual interaction surfaces remain
available only to the development profile or legacy compatibility configuration.

ChatGPT Web direct conversations use the separate `Codex Reader` MCP contract when configured. It
exposes only explicitly authorized project listing, file listing, file reads, text search, and Git
status. It never reuses a Codex turn token and never exposes shell, patch, or project authorization
tools to the Web conversation. Authorize a project with `codex-chatgpt-web reader authorize PATH`.

GUI apps and launchd do not inherit the proxy selected in macOS System Settings, and `tunnel-client`
reads Go's standard proxy environment, so the active HTTPS proxy is derived from `scutil` and passed
to the backend's tunnel and runtime children and written into its launchd definition. An explicitly supplied proxy
variable always wins, loopback is added to `NO_PROXY`, and no credentials are read or forwarded.
Tunnel readiness prefers the local `health_url_file` reported by `runtimes list` over a remote
`runtimes status` round trip, so readiness does not depend on the same network path being up; that
file must be a small, owner-only, non-symlink regular file holding an authenticated loopback URL
before it is used. Stop and restart also wait for the listener port to be released after launchd
unloads, so the next bootstrap cannot race the old process.

Quitting honours the background-runtime preference. An ordinary close request hides the window when
the preference is on, while user-initiated quit paths — Command-Q, SIGINT, SIGTERM, and the tray
Quit item — force teardown. Shutdown restores the Codex bridge route before stopping the supervisor,
so a quit cannot leave Codex pointed at a runtime that is no longer listening.

Only three paths force: SIGINT, SIGTERM, and the tray Quit item. An AppleScript quit and a window
close both arrive through `before-quit`, which requests an unforced quit, so with the preference on
they hide the window and leave the runtime serving. That is the intended behaviour, and it is
indistinguishable from a hang if only process counts are watched: the app, tunnel, and listener all
remain up. A forced quit stops the app, tunnel, and daemon together, with no orphaned children.

A forced teardown is also bounded rather than merely guarded. The supervisor's force fallback runs
from a `catch`, which a hang never reaches, so a stop that never settled would leave the fallback
unreachable and the quit pending forever. The forced path therefore carries a deadline, turning a
hang into a rejection that reaches the fallback stopping the owned tunnel and daemon directly. A stop
that is merely slow still finishes on its own terms, and an unforced stop still fails closed without
being force-stopped, so setup keeps its drain contract. The waits for an in-flight start and for
recovery tasks to settle are separately bounded, since a stop terminates those children anyway and
must not wait out a start that is stuck. This is protection against a latent failure mode, not a
repair of an observed one.

Setup keeps Codex's built-in `openai` provider. It routes Responses through the local daemon with
`openai_base_url`, while pinning `experimental_realtime_webrtc_call_base_url` to Codex's official
ChatGPT endpoint so Voice session creation never falls through to the Responses-only bridge. Both
assignments are journaled and restored exactly on disconnect or uninstall; a conflicting existing
Voice route requires explicit `--replace-codex-route` ownership. A config whose line ending is a
lone carriage return is written back byte for byte, but TOML forbids a bare carriage return, so
every parse site normalises `\r` to `\n` first. The parse result is only ever used to compare owned
definitions and never to produce output, so restoration stays byte exact; without that
normalisation, a CR-only config installs but can never be verified, deactivated, or uninstalled.

A CC Switch `model_providers.custom` block may remain alongside this route, but selecting it with a
top-level `model_provider = "custom"` would bypass the local gateway and is intentionally not part
of the production route.

The daemon forwards the authenticated official model catalog and appends only the routed models
owned by the `chatgpt-web/` namespace; no static catalog is installed. Subagent protocol selection
is explicit, and new installations default to Compatibility V1 because it is the only surface
portable across native and routed Web backends:

- **Compatibility V1** pins every delegation-capable native and routed row to V1 and atomically
  manages `multi_agent = true`, `multi_agent_v2 = false`, and `[agents].max_depth` of at least 2 so
  a routed child can spawn a routed grandchild. The integration journal preserves the user's prior
  scalar, structured-feature, and agent-depth lines and restores them byte-for-byte on disconnect,
  native-mode selection, or uninstall. The ChatGPT connector projects `wait_agent` as an explicit
  10-second polling contract: terminal semantics stay native, while every non-terminal poll releases
  the serialized MCP channel so Web children can run their own harness tools.
- **Native** preserves every official native row and gives routed rows the selected template's
  protocol surface. Under MultiAgent V2, Web-origin `spawn_agent`, `send_message`, and
  `followup_task` calls include Codex's explicit `encrypted_function_args: []` plaintext marker.
  A genuinely encrypted native-to-Web payload is rejected with one HTTP 400 before a browser is
  opened; it is never turned into an SSE disconnect/retry loop.

Catalog metadata alone never claims to change an existing task's protocol. Codex pins the protocol
when a task starts, and its global `multi_agent_v2` override wins over per-model metadata. Switching
protocol therefore requires restarting Codex and starting a new task. Model choice, effort,
context, and service tiers are otherwise unchanged.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports HTTP, browser, and Codex session-lease counters:

- active HTTP requests, including native compaction, Search, and Image Gen forwarding;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results;
- active Codex session leases refreshed by `UserPromptSubmit` and released by `SessionEnd`.

The lifecycle operation proceeds only when both turn counters are zero. The Backend Host owns tunnel
shutdown for terminal-managed mode; the launcher compatibility supervisor uses the same contract
for Launcher-owned mode. Both paths flush state and exit through authenticated lifecycle control.
If the contract is unavailable, malformed, non-idle, or cannot be completed, the operation fails
closed and restores the drained runtime when possible. An unexpected child exit is recovered with a
bounded restart budget; a crash loop becomes an explicit launcher error.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Treat recalled memory as reference data. Runtime injection never raises it to system, developer, or
  user instruction authority.
- Replay only a provably idempotent continuation. A turn already accepted by a retained conversation
  reconnects with an empty incremental envelope; anything else fails explicitly rather than being
  sent twice.
- Derive proxy configuration from the system without reading or forwarding credentials, and keep
  loopback out of the proxied path.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
