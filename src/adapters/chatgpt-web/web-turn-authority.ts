import type { ChatGptSessionBinding } from "./task-scope";

/** One logical Codex execution owns these decisions; browser and broker only report facts. */
export interface WebTurnAuthorityState {
  executionKey: string;
  browserEpoch: number;
  lastBrowserSequence: number;
  submission: "prepared" | "send_activated" | "accepted";
  toolCalls: readonly string[];
  toolBatchRevision: number;
  observedToolBatchRevision: number;
  candidate?: { answer: string; source: "wire" | "dom" | "manual" };
  fenceRevision?: number;
  fenceCommitted?: boolean;
  terminal?: { kind: "final"; answer: string } | { kind: "error" | "cancelled" | "compaction"; reason: string };
  physical: "active" | "released" | "release_failed";
}

export type WebTurnAuthorityEvent =
  | { type: "send_activated" }
  | { type: "submitted" }
  | { type: "tool_batch"; callIds: readonly string[]; revision: number }
  | { type: "tool_boundary_observed"; revision: number }
  | { type: "tool_result"; callId: string }
  | { type: "final_candidate"; answer: string; source: "wire" | "dom" | "manual"; webConversationId?: string }
  | { type: "fence_begun"; revision: number }
  | { type: "fence_committed"; revision: number; committed: boolean }
  | { type: "cancelled"; reason: string }
  | { type: "failed"; reason: string }
  | { type: "compaction_handoff_accepted"; reason: string }
  | { type: "browser_rebound"; browserEpoch: number }
  | { type: "released" }
  | { type: "release_failed"; reason: string };

/** Page/helper facts cross the internal protocol; broker facts remain daemon-local. */
export type WebBrowserFact = Extract<WebTurnAuthorityEvent,
  { type: "final_candidate" | "browser_rebound" | "tool_boundary_observed" }>;

export interface ScopedBrowserFact {
  executionKey: string;
  browserEpoch: number;
  sourceSequence: number;
  event: WebBrowserFact;
}

export type WebTurnEffect =
  | { type: "capture_tool_boundary"; revision: number }
  | { type: "revoke_capability" }
  | { type: "commit_final"; answer: string }
  | { type: "release_browser" };

export function initialWebTurnAuthorityState(executionKey: string): WebTurnAuthorityState {
  if (!executionKey.trim()) throw new Error("Web turn authority requires an execution key");
  return {
    executionKey,
    browserEpoch: 0,
    lastBrowserSequence: 0,
    submission: "prepared",
    toolCalls: [],
    toolBatchRevision: 0,
    observedToolBatchRevision: 0,
    physical: "active",
  };
}

export function reduceWebTurnAuthority(
  state: WebTurnAuthorityState,
  event: WebTurnAuthorityEvent,
): { state: WebTurnAuthorityState; effects: readonly WebTurnEffect[] } {
  const unchanged = () => ({ state, effects: [] as readonly WebTurnEffect[] });
  if (event.type === "released" || event.type === "release_failed") {
    if (state.physical !== "active") return unchanged();
    return { state: { ...state, physical: event.type === "released" ? "released" : "release_failed" }, effects: [] };
  }
  if (event.type === "browser_rebound") {
    if (state.terminal || event.browserEpoch <= state.browserEpoch) return unchanged();
    return { state: { ...state, browserEpoch: event.browserEpoch, lastBrowserSequence: 0 }, effects: [] };
  }
  if (state.terminal) return unchanged();
  if (event.type === "cancelled" || event.type === "failed" || event.type === "compaction_handoff_accepted") {
    return {
      state: { ...state, terminal: { kind: event.type === "cancelled" ? "cancelled"
        : event.type === "failed" ? "error" : "compaction", reason: event.reason } },
      effects: [{ type: "revoke_capability" }, { type: "release_browser" }],
    };
  }
  if (event.type === "send_activated") {
    if (state.submission !== "prepared") throw new Error("A Web turn can authorize Send only once");
    return { state: { ...state, submission: "send_activated" as const }, effects: [] };
  }
  if (event.type === "submitted") {
    if (state.submission !== "send_activated") throw new Error("Web submission requires an authorized Send");
    return { state: { ...state, submission: "accepted" as const }, effects: [] };
  }
  if (event.type === "tool_batch") {
    if (state.submission !== "accepted" || state.toolCalls.length || event.callIds.length === 0
      || new Set(event.callIds).size !== event.callIds.length || event.revision <= state.toolBatchRevision) {
      throw new Error("Web tool batch violated its turn ownership or revision");
    }
    return {
      state: { ...state, toolCalls: [...event.callIds], toolBatchRevision: event.revision,
        candidate: undefined, fenceRevision: undefined, fenceCommitted: false },
      effects: [{ type: "capture_tool_boundary", revision: event.revision }],
    };
  }
  if (event.type === "tool_boundary_observed") {
    if (event.revision !== state.toolBatchRevision) throw new Error("Observed tool boundary revision is stale");
    return { state: { ...state, observedToolBatchRevision: event.revision }, effects: [] };
  }
  if (event.type === "tool_result") {
    if (!state.toolCalls.includes(event.callId)) throw new Error("Web tool result has no outstanding call");
    return { state: { ...state, toolCalls: state.toolCalls.filter(id => id !== event.callId) }, effects: [] };
  }
  if (event.type === "final_candidate") {
    if (state.submission !== "accepted" || state.toolCalls.length || !event.answer.trim()) return unchanged();
    if (state.candidate?.answer === event.answer && state.candidate.source === event.source) return unchanged();
    const candidate = { answer: event.answer, source: event.source };
    if (state.fenceCommitted) return {
      state: { ...state, candidate, terminal: { kind: "final", answer: event.answer } },
      effects: [{ type: "commit_final", answer: event.answer }],
    };
    return { state: { ...state, candidate, fenceRevision: undefined }, effects: [] };
  }
  if (event.type === "fence_begun") {
    if (state.submission !== "accepted" || state.toolCalls.length || event.revision < 0) {
      throw new Error("Cannot begin Web turn completion while tools or submission are unsettled");
    }
    return { state: { ...state, fenceRevision: event.revision }, effects: [] };
  }
  if (event.type === "fence_committed") {
    if (state.fenceRevision !== event.revision) return unchanged();
    if (!event.committed) return { state: { ...state, candidate: undefined, fenceRevision: undefined, fenceCommitted: false }, effects: [] };
    if (!state.candidate) return { state: { ...state, fenceCommitted: true }, effects: [] };
    const answer = state.candidate.answer;
    return { state: { ...state, terminal: { kind: "final", answer } }, effects: [{ type: "commit_final", answer }] };
  }
  return unchanged();
}

/** Reject late browser observations by exact execution, epoch and monotonic source sequence. */
export class WebTurnAuthority {
  private current: WebTurnAuthorityState;
  private publishedText = "";
  private publishedSource: "wire" | "dom" | "manual" | undefined;
  private binding?: ChatGptSessionBinding;

  constructor(executionKey: string) {
    this.current = initialWebTurnAuthorityState(executionKey);
  }

  snapshot(): WebTurnAuthorityState {
    return this.current;
  }

  output(): string {
    return this.publishedText;
  }

  outputSource(): "wire" | "dom" | "manual" | undefined {
    return this.publishedSource;
  }

  attachBinding(binding: ChatGptSessionBinding): void {
    if (this.binding && JSON.stringify(this.binding) !== JSON.stringify(binding)) {
      throw new Error("Web turn session binding changed while its execution was active");
    }
    this.binding = binding;
  }

  sessionBinding(): ChatGptSessionBinding | undefined {
    return this.binding ? structuredClone(this.binding) : undefined;
  }

  /** The browser may choose a source, but this is the one append-only publication point. */
  publishText(delta: string, source: "wire" | "dom" | "manual"): void {
    if (this.current.terminal?.kind === "cancelled" || this.current.terminal?.kind === "error") {
      throw new Error("A terminal Web turn cannot publish late text");
    }
    if (!delta) return;
    this.publishedText += delta;
    this.publishedSource = source;
  }

  dispatch(event: WebTurnAuthorityEvent): readonly WebTurnEffect[] {
    const outcome = reduceWebTurnAuthority(this.current, event);
    this.current = outcome.state;
    if (event.type === "browser_rebound" && this.binding && outcome.state.browserEpoch === event.browserEpoch) {
      this.binding = { ...this.binding, browserGeneration: event.browserEpoch };
    }
    return outcome.effects;
  }

  observe(fact: ScopedBrowserFact): readonly WebTurnEffect[] {
    if (fact.executionKey !== this.current.executionKey
      || fact.browserEpoch !== this.current.browserEpoch
      || !Number.isSafeInteger(fact.sourceSequence)
      || fact.sourceSequence <= this.current.lastBrowserSequence) return [];
    if (this.current.submission === "accepted" && fact.event.type === "final_candidate"
      && fact.event.webConversationId && this.binding) {
      const prior = this.binding.webConversationId;
      if (prior && prior !== fact.event.webConversationId) {
        throw new Error("Web conversation identity changed inside one Codex execution");
      }
      this.binding = { ...this.binding, webConversationId: fact.event.webConversationId };
    }
    const outcome = reduceWebTurnAuthority(this.current, fact.event);
    this.current = { ...outcome.state, lastBrowserSequence: fact.sourceSequence };
    return outcome.effects;
  }
}
