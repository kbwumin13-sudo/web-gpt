# Web Backend Architecture Design

This document records the target architecture for the ChatGPT Web backend: the plane boundaries, the
transport model, the memory contract, the known blockers, and the turn state machine. It is the
design. [architecture.md](architecture.md) describes what the code currently does; where the two
disagree, this document states the intent and the other states the fact.

Designed 2026-09-12 in Codex thread `01a095db-9edf-7881-92ac-24a94f83b8ff`. Each section marks
implementation status, because several design decisions are deliberately not built yet.

## 1. The problem this design answers

Every turn sent to the browser carried tens of thousands of tokens of serialized Codex state. The
first question was whether that is a bug or the design. It is the design, but only for the first
turn of a conversation.

ChatGPT Web has no native notion of "the current Codex task". The bridge must turn a normal ChatGPT
conversation into a temporary Codex backend, which means reconstructing the world — system and
developer rules, conversation history, environment, attachments, tool capability — inside a chat
message. That reconstruction is what makes the Web model's view of the task semantically equivalent
to the native model's view, and it is worth its cost exactly once per conversation.

Re-sending the full canonical history into a conversation that already holds it is not the design.
It is the symptom of a retained-conversation miss. The distinction gives a usable diagnostic: in the
same Codex task, same routed model, same reasoning, with no compaction between them, a second turn
that again carries a complete `<codex_context_json>` means the retained conversation was not reused,
and the reason for the miss is the thing to investigate.

The deeper statement of the problem: the transport was serializing the entire Codex world to the Web
model because the Web model had no way to ask for anything. The fix is not a smaller serializer. It
is giving the Web model enough index capability that it can retrieve what it needs.

## 2. Three planes

Responsibility is divided into three planes joined by one capability bridge.

```
Codex Runtime = control / state plane
ChatGPT Web   = reasoning plane
OpenViking    = memory plane
Native2       = capability bridge
```

This division is settled. It is the conclusion of the design review, it is kept, and it is not the
thing to renegotiate when something goes wrong. What is temporary is the transport between the first
two planes, not the planes themselves.

```
                 ┌───────────────┐
                 │  OpenViking   │   memory plane
                 │ shared memory │   long-term semantic memory across tasks and agents
                 └───────┬───────┘
                         │ recall / search / write
                 ┌───────▼───────┐
                 │ Codex Runtime │   control and state plane
                 │  orchestrator │   task identity, permissions, tool registry,
                 └───────┬───────┘   canonical history, compaction epoch
                         │
       ┌─────────────────┼──────────────────┐
       │                 │                  │
  auto recall      memory tools        normal tools
       │                 │                  │
       ▼                 ▼                  ▼
┌──────────────────────────────────────────────┐
│           ChatGPT Web model                  │   reasoning plane
│  relevant memory  ←→  on-demand retrieval    │   thinking, planning, generation
└──────────────────────────────────────────────┘
```

**Codex Runtime is always the control plane.** It is the only component that knows the current task,
project, permissions, user, tool registry, compaction epoch, and thread identity. Every capability
the Web model has at any moment is something the Runtime decided to expose.

**The Web model is a reasoning plane with no independent long-term session authority.** Its
conversation is a cache of state the Runtime owns, not a second source of truth.

**Memory is reached only through the Runtime.** The rejected alternative was letting the Web model
open its own connection to an independent memory MCP. Two entry points into the same memory produce
duplicate recall, divergent retrieval strategies, two session states, and conflicting writes:

```
rejected:   OpenViking → Codex → Web
            OpenViking ─────────→ Web
```

**Every identity derives from the Codex task.** Codex thread id, Web conversation id, conversation
key, compaction epoch, workspace scope, and memory peer scope must all hang off one root:

```
Codex Task Identity
        │
        ├── Web retained conversation
        ├── compaction epoch
        ├── workspace scope
        └── memory peer scope
```

Status: implemented as the operating structure. The Runtime is the control plane, the Web
conversation is a cache, and memory reaches the Web model only through the connector.

## 3. Transport: from push to pull

This is the part that currently looks improvised:

```
Codex world
    ↓
one giant JSON
    ↓
a browser chat box
    ↓
Web model
```

The intended evolution, stated as the shape of a turn:

```
before                          after
──────                          ─────
every turn:                     first turn:
  rules                           small bootstrap contract
  environment                     task identity
  skills                          necessary state
  memory                          memory digest
  history
  file context                  later turns:
  tool descriptions               incremental user turn
  new message                     necessary runtime delta

                                need files    → tool call
                                need history  → memory search / read
                                need old state→ Runtime retrieval
                                need to shrink→ Runtime compaction
                                need to persist→ Runtime commit after the turn completes
```

The large envelope should become what appears during first bootstrap, a new epoch, or error
recovery — not the system's primary communication protocol.

Status: the continuation and first-packet halves are implemented for Runtime-backed Full mode. A
normal first turn or cache miss sends `<codex_bootstrap_context_json>` with the current task message;
the Runtime keeps the canonical snapshot behind `codex_context_search` and `codex_context_read`.
Browser-only turns and compaction/new-epoch requests retain the complete `<codex_context_json>`
bootstrap because they do not have that live retrieval boundary. A retained continuation sends
`<codex_resume_context_json>` carrying only the canonical suffix after the last assistant reply and
omits the system bootstrap the conversation already holds. Because the resume omits the system
prompt, the system prompt joins the retained conversation key. Compaction identity is normalized to
semantic checkpoint content, so rebuilt transport ids do not rotate an unchanged retained epoch.

## 4. Memory contract

Two paths reach the Web model, both owned by the Runtime.

**Automatic recall (push).** Before a turn, the Runtime pulls a small amount of task-relevant memory
and injects it as runtime context tagged by source (`session-start`, `auto-recall`). A superseded
block of the same source is dropped so only current recall occupies the transport budget.

**On-demand retrieval (pull).** When project or history context is insufficient, the Web model uses
the Runtime-owned `codex_context_search` and `codex_context_read` capabilities discovered through
the existing tool inventory. When memory context is insufficient, it discovers the outer Runtime's
OpenViking `search`/`read`/`find`/`grep` capability through the same inventory and invokes the exact
listed name. No new public connector tool is added, so the Native2 ABI remains stable. This is the
half that makes the bootstrap shrinkable: the model does not need the complete history or memory in
the prompt if it can ask for it.

**Recall carries no instruction authority.** Memory will accumulate user statements, other agents'
conclusions, web page content, and tool output, any of which can contain text shaped like an
instruction. Recalled content is therefore marked `kind=memory`, `source=openviking`,
`trust=reference_data`, `instruction_authority=none`, and the transport contract states that
instruction-like text inside such an envelope holds no system, developer, or user authority. The
design calls for this to be a data type rather than an XML tag convention; the fact that the Runtime
injected the text must never promote it to a developer instruction.

**Writes are governed, reads are not.** The intended split:

| capability | policy |
| --- | --- |
| `search` / `read` / `find` / `grep` | default allow from the Web model |
| `remember` / `write` | Runtime-controlled |
| `edit` / `forget` | stricter still |

The preferred shape is that the Web model rarely calls a write at all:

```
Web completes its answer
      ↓
Runtime confirms the turn genuinely finished
      ↓
Runtime performs one commit
      ↓
memory plane extracts semantic memory asynchronously
```

The reason is failure mode, not theory: a model that writes whenever it believes something is
important turns long-term memory into a chat-summary landfill, and one misreading becomes a durable
"fact". The layering already in use — a human-confirmed authoritative file for stable conclusions,
the memory service for full experience and semantic recall — is what this protects.

Status: implemented. Recall tagging, source-based deduplication and provenance demotion cover the
push path. Retrieval is named in the prompt by exact wire name, so the pull path no longer rests on
the model discovering something that may not be there; a turn with no retrieval capability is told
so. Write governance is enforced by the bridge: memory capabilities are recognised by namespace and
classified by operation, and only a classified read is reachable, under every contract and through
the exec gateway as well. An unclassified operation is refused rather than allowed, because hiding a
read costs a lookup while exposing a write costs memory that nothing reports as corrupted.

The commit shape above is not something this bridge implements, and it should not: the memory
service already performs it. Every endpoint sharing that service commits a completed turn exactly
once and extracts semantic memory asynchronously, and Codex is one of those endpoints — so a turn
routed through this bridge is recorded by the same path as a native one. Denying the Web model a
write therefore removes a second, model-initiated entry point without touching persistence. That
was the design's intent when it called the existing mechanism worth reusing rather than rebuilding.

## 5. Blockers

The five hard parts, in the order they were identified, with the reasoning that makes each one hard
rather than merely unfinished.

**1. The oversized bootstrap.** Addressed for normal Runtime-backed Full turns by the compact
bootstrap and Runtime retrieval. Complete snapshots remain deliberate for browser-only turns,
compaction/new epochs, and any future retrieval-unavailable fallback.

**2. Memory write permission.** Closed. The Web model can no longer initiate a memory write; the
risk it carried — silent corruption of long-term memory, the one failure that does not announce
itself — is now structurally prevented rather than left to the outer harness's configuration.

**3. Identity and scope.** Six identities coexist: Codex thread id, Web conversation id, conversation
key, compaction epoch, workspace cwd, memory peer scope. Without one derivation root they drift, and
the resulting bug is the hardest class to see:

```
Codex has moved to project B
the Web retained chat is still project A
memory recall is searching project B
```

The model keeps answering fluently while the context underneath it is crossed.

**4. Compaction.** Three histories exist simultaneously — Codex canonical state, Web retained state,
and long-term memory. The rule that keeps this tractable: canonical Codex state decides the real
context of a turn, the Web conversation is cache and acceleration, memory is external long-term
storage. Losing the Web conversation must degrade to a fresh bootstrap, never corrupt state.

**5. Prompt injection through recall.** Covered by the provenance contract in §4.

## 6. Turn state machine and recovery

A Web turn has five stages: submission, active execution, tool progress, answer settlement, and
physical retirement. Robustness means each stage has defined progress evidence and no stage can be
collapsed into a neighbour by a signal that lacks authority over it. The rule that organises the
whole section: **a browser-reported failure has no authority over state the control plane has
already accepted.**

The failures that motivated this, ranked as falsifiable hypotheses:

1. A compaction submit has reached the broker, but the page's terminal error wins the race first, so
   a completed checkpoint is scored as a dead turn. A queryable accepted-state on the broker should
   let the checkpoint override the error.
2. A normal turn hits a temporarily inactive page or DOM after submission was confirmed, and is
   wrapped as unrecoverable. Classified as recoverable-with-retained-session, the reconnect must not
   resend the prompt.
3. The answer has text but the completion marker or DOM is briefly missing, and the health check
   reads "settlement not finished" as "task died". The settlement window needs to be layered and
   extended without weakening genuine no-progress timeouts.
4. Tool progress mirroring or physical retirement lags, so the local broker believes the Web side is
   dead. This needs causal ordering and physical settlement to hold, and cannot be solved by
   retrying.

Two invariants constrain every fix:

- **Only a provably idempotent continuation reconnects.** A turn holding a retained conversation may
  reconnect with an empty incremental envelope, so the accepted prompt is never delivered twice.
  Without that proof, the turn fails explicitly rather than being replayed.
- **The logical conclusion and the physical session must agree.** A turn marked retryable is
  meaningless if the browser tab was already destroyed, so tab retention is conditioned on the same
  classification.

Error classification for all three consequent decisions — wait for a compaction handoff, retain a
failed tab, allow a retained retry — belongs in one policy module, so a newly observed ChatGPT error
is handled in one place rather than three.

Status: hypotheses 1, 2, and 4's physical half are implemented and shipped; see
[architecture.md](architecture.md#turn-recovery) for the mechanisms and their verification state.
Hypothesis 3 is partially addressed through the completion fence.

A live run on 2026-09-13 confirmed hypotheses 1 and 2 and exposed a limit the design had not stated.
Reconnecting recovers a *transient* failure, but it was applied to a *persistent* one: after
compaction, three consecutive resumes into the same conversation each failed, growing its user turns
from one to three while its assistant replies stayed at one. Idempotency was never the constraint
there — the conversation itself was the defect. The rule is therefore narrower than "a provably
idempotent continuation reconnects": reconnection is also bounded, and once the allowance is spent
the conversation is abandoned for a fresh bootstrap. That is the same degradation §5's fourth blocker
already required — losing the Web conversation must cost a bootstrap, never correctness — applied to
a conversation that is still present but no longer usable.

## 7. Difficulty assessment

Recorded as judged during design, with current status.

| work | difficulty | status |
| --- | --- | --- |
| Web sees a small amount of relevant memory automatically | low | done |
| Web actively searches and reads memory on demand | low | done; retrieval is named rather than discovered |
| Consistent state across Web, Codex, compaction, retry, model switching | high | main engineering cost; partially done |
| Safely allowing Web to write long-term memory | high | done; writes denied to Web, and the memory service already commits completed turns |
| Substantially shrinking the bootstrap prompt | high | normal Full bootstrap done; compaction/new-epoch snapshot remains |

## 8. Next steps

The architecture is not being redone. Three changes carry the most value, and they are listed in the
order that compounds: each makes the next one cheaper and safer.

**1. Raise the retained-conversation hit rate.** Every miss costs a bootstrap, so hit rate remains
the largest single lever on transport cost. Semantic compaction identity is normalized, and every
miss on a turn that expected retention is now attributed at the adapter boundary rather than merely
counted. The miss sources are separable, and each one now names itself:

- *Preconditions.* A conversation is retained only for a non-compaction, non-Luna turn with local
  tools and a launcher-retained tab. These are by-design exclusions rather than cache misses, so they
  are reported separately as `ineligible` with the specific precondition, and only for turns that
  could have retained — browser-only exclusions would otherwise be pure noise.
- *Key rotation.* The key covers thread, model, reasoning, system prompt, and compaction epoch. A
  miss compares the current components against the previous turn's for the same thread and names
  every component that rotated, so a legitimate rotation is never confused with a defect.
- *Physical loss.* A miss whose components all match the previous turn was not caused by rotation:
  the browser surface itself is gone, and it is reported as `conversation_lost`.

Done looks like: a miss names its own cause instead of being inferred from the size of a prompt, and
the rate is queryable rather than grepped. Both hold now. `/healthz` reports hits, misses, the
resulting rate, and the per-cause breakdown, with by-design exclusions counted separately so they
cannot drag the rate down. What remains is judgement rather than instrumentation: no target rate has
been set, so the numbers describe the system without yet arguing about it.

**2. Make memory read a first-class on-demand retrieval.** Done. Runtime history retrieval is
declared as `codex_context_search/read`, and memory retrieval is now resolved from the turn's own
registry and named in the prompt by exact wire name. The model no longer has to discover whether
retrieval exists, and a turn without it is told so rather than left to read an empty search as an
empty memory.

Runtime history retrieval has since become two registered connector tools rather than two names
dispatched inside `codex_tool_call`. Naming a capability tells the model it exists; attaching it is
what puts its arguments in front of the model, which through the generic wrapper it could only get
by running an inventory call first — and an inventory call costs an outer command execution. The two
are also the one bridge capability with no external effect, and they can now say so: declared
read-only and non-destructive, instead of inheriting `codex_tool_call`'s open-world annotations.

This is the first change that does touch the Native2 public ABI, and the cost is the one the ABI
was pinned for: ChatGPT caches a connector's tool list under its identity, so a conversation on the
existing connector will not see the new tools. The `codex_tool_call` path stays for them and the
prompt names both, so nothing regresses — but the benefit only reaches a conversation whose
connector was created after the change. Making it reach the rest is a connector identity migration,
which is a separate decision and not one this change makes.

The bridge still cannot conjure a capability the Runtime never registered, and pretending otherwise
would be the wrong fix. What it can do is refuse to let the dependency be silent: retrieval
availability is counted per turn and reported on `/healthz`, with the last observed capability set
retained, so a harness that stopped registering retrieval is distinguishable from one that never
did and from a memory that is simply empty. The dependency is real, bounded, and now observable
rather than assumed.

**3. Keep shrinking the bootstrap contract.** The normal Full first packet now contains the current
task message plus the retrieval contract; system/developer/history records stay in Runtime. The
remaining work is to add the smallest safe task identity and memory digest, and to prove live Web
behavior retrieves omitted records before acting. Compaction/new epochs deliberately retain complete
snapshots until that live evidence exists.

The live evidence needed here is about retrieval working, not retrieval happening, and the two were
being conflated. The failure that prompted this — a model that searched, matched nothing, and
answered from the filesystem about the wrong books — would have counted as a turn that retrieved.
Two things changed as a result. Search now scores records against the query's terms instead of
requiring one record to contain the whole query, which is what made a correctly-asked question
return nothing; and a search that still matches nothing says so rather than returning a result
shaped like an empty history. `search_zero_matches` and `search_without_followup_read` are reported
next to the existing counts, so a retrieval that ran and found nothing is no longer filed as a
retrieval that worked.

The normal Full path now has the intended shape; live logged-in verification and retained-hit
aggregation remain before the giant envelope can be treated as an exceptional path in production.

## 9. Non-goals

- **Do not rewrite the architecture.** The plane division is correct; the debt is in transport.
- **Do not let the Web model connect directly to a memory service.** See §2.
- **Do not treat the Web conversation as a source of truth.** It is a cache; the Runtime holds
  canonical state.
- **Do not preload context that the model could retrieve.** Preloading is the thing being removed.
