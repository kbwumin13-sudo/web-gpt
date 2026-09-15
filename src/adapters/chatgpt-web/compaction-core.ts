export type CompactionPhase =
  | "new"
  | "source_settling"
  | "fallback_generating"
  | "awaiting_handoff"
  | "committed"
  | "cleaning"
  | "settled";

export interface CompactionSelector {
  namespace: string;
  executionKey: string;
}

export interface CleanupWarning {
  code: "cleanup_warning";
  stage: string;
  message: string;
}

export interface CompactionFailure {
  code: string;
  message: string;
  cause?: unknown;
}

export interface CompactRequest {
  selector: CompactionSelector;
  phase?: Extract<CompactionPhase, "source_settling" | "fallback_generating" | "awaiting_handoff">;
  execute: (signal: AbortSignal) => Promise<string>;
  cleanup?: () => Promise<void>;
}

export interface HandoffSubmission {
  selector: CompactionSelector;
  summary: string;
  replayed?: boolean;
}

export interface CommitAck {
  summary: string;
  replayed: boolean;
  cleanupWarnings: CleanupWarning[];
}

export interface CancelResult {
  cancelled: boolean;
  cleanupOnly: boolean;
  phase: CompactionPhase;
}

export type CompactOutcome =
  | {
      kind: "committed";
      summary: string;
      replayed: boolean;
      cleanupWarnings: CleanupWarning[];
    }
  | {
      kind: "failed";
      error: CompactionFailure;
    };

export interface StructuredCompactionCore {
  compact(request: CompactRequest): Promise<CompactOutcome>;
  submitHandoff(input: HandoffSubmission): Promise<CommitAck>;
  cancel(selector: CompactionSelector): Promise<CancelResult>;
}

export type CompactionEvent =
  | { type: "begin"; phase?: CompactRequest["phase"] }
  | { type: "awaiting_handoff" }
  | { type: "handoff_committed"; summary: string; replayed: boolean }
  | { type: "cleanup_started" }
  | { type: "cleanup_warning"; warning: CleanupWarning }
  | { type: "cleanup_settled" }
  | { type: "failed"; error: CompactionFailure }
  | { type: "cancelled" };

export interface CompactionState {
  phase: CompactionPhase;
  summary?: string;
  replayed: boolean;
  cleanupWarnings: CleanupWarning[];
  failure?: CompactionFailure;
}

/** Pure state transition function for the structured compaction lifecycle. */
export function reduceStructuredCompaction(state: CompactionState, event: CompactionEvent): CompactionState {
  if (state.phase === "committed" || state.phase === "cleaning" || state.phase === "settled") {
    if (event.type === "failed" || event.type === "cancelled") return state;
  }
  switch (event.type) {
    case "begin":
      return { ...state, phase: event.phase ?? "new" };
    case "awaiting_handoff":
      return state.phase === "new" || state.phase === "source_settling" || state.phase === "fallback_generating"
        ? { ...state, phase: "awaiting_handoff" }
        : state;
    case "handoff_committed":
      return state.phase === "committed" || state.phase === "cleaning" || state.phase === "settled"
        ? state
        : {
            ...state,
            phase: "committed",
            summary: state.summary ?? event.summary,
            replayed: state.replayed || event.replayed,
          };
    case "cleanup_started":
      return state.phase === "committed" ? { ...state, phase: "cleaning" } : state;
    case "cleanup_warning":
      return state.phase === "committed" || state.phase === "cleaning"
        ? { ...state, cleanupWarnings: [...state.cleanupWarnings, event.warning] }
        : state;
    case "cleanup_settled":
      return state.phase === "cleaning" || state.phase === "committed"
        ? { ...state, phase: "settled" }
        : state;
    case "failed":
      return state.phase === "committed" || state.phase === "cleaning" || state.phase === "settled"
        ? state
        : { ...state, phase: "new", failure: event.error };
    case "cancelled":
      return state.phase === "committed" || state.phase === "cleaning" || state.phase === "settled"
        ? state
        : { ...state, phase: "new", failure: { code: "cancelled", message: "Compaction cancelled" } };
  }
}

interface Attempt {
  state: CompactionState;
  abort: AbortController;
  promise?: Promise<CompactOutcome>;
}

function selectorKey(selector: CompactionSelector): string {
  if (!selector.namespace.trim() || !selector.executionKey.trim()) {
    throw new Error("Compaction selector requires namespace and exact execution key");
  }
  return `${selector.namespace}:${selector.executionKey}`;
}

function failureFrom(error: unknown): CompactionFailure {
  return {
    code: error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "compaction_failed",
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

/** In-process bounded implementation. It intentionally has no disk persistence. */
export class InProcessStructuredCompactionCore implements StructuredCompactionCore {
  private readonly attempts = new Map<string, Attempt>();
  private readonly journal: CompactionEvent[] = [];

  constructor(private readonly maxAttempts = 256, private readonly maxEvents = 2_048) {}

  begin(selector: CompactionSelector, phase?: CompactRequest["phase"]): void {
    const key = selectorKey(selector);
    const attempt = this.attempts.get(key) ?? {
      state: { phase: "new", replayed: false, cleanupWarnings: [] },
      abort: new AbortController(),
    };
    this.attempts.set(key, attempt);
    this.reduce(attempt, { type: "begin", phase });
  }

  fail(selector: CompactionSelector, error: unknown): void {
    const attempt = this.attempts.get(selectorKey(selector));
    if (!attempt) return;
    this.reduce(attempt, { type: "failed", error: failureFrom(error) });
  }

  recordCleanupWarning(selector: CompactionSelector, warning: CleanupWarning): void {
    const attempt = this.attempts.get(selectorKey(selector));
    if (!attempt) return;
    this.reduce(attempt, { type: "cleanup_warning", warning });
  }

  compact(request: CompactRequest): Promise<CompactOutcome> {
    const key = selectorKey(request.selector);
    const existing = this.attempts.get(key);
    if (existing?.promise) return existing.promise;
    const attempt: Attempt = existing ?? {
      state: { phase: "new", replayed: false, cleanupWarnings: [] },
      abort: new AbortController(),
    };
    this.attempts.set(key, attempt);
    this.reduce(attempt, { type: "begin", phase: request.phase });
    const promise = Promise.resolve().then(async (): Promise<CompactOutcome> => {
      try {
        const summary = await request.execute(attempt.abort.signal);
        if (attempt.abort.signal.aborted || attempt.state.failure) {
          throw attempt.state.failure ?? new DOMException("Compaction cancelled", "AbortError");
        }
        const ack = await this.submitHandoff({ selector: request.selector, summary });
        if (request.cleanup) await this.cleanup(request.selector, request.cleanup);
        return {
          kind: "committed",
          summary: ack.summary,
          replayed: ack.replayed,
          cleanupWarnings: [...this.state(request.selector).cleanupWarnings],
        };
      } catch (error) {
        const current = this.state(request.selector);
        if (current.phase === "committed" || current.phase === "cleaning" || current.phase === "settled") {
          return {
            kind: "committed",
            summary: current.summary!,
            replayed: current.replayed,
            cleanupWarnings: [...current.cleanupWarnings],
          };
        }
        const failure = failureFrom(error);
        this.reduce(attempt, { type: "failed", error: failure });
        return { kind: "failed", error: failure };
      }
    });
    attempt.promise = promise;
    this.pruneAttempts();
    return promise;
  }

  async submitHandoff(input: HandoffSubmission): Promise<CommitAck> {
    const key = selectorKey(input.selector);
    const attempt = this.attempts.get(key) ?? {
      state: { phase: "new", replayed: false, cleanupWarnings: [] },
      abort: new AbortController(),
    };
    this.attempts.set(key, attempt);
    const summary = input.summary.trim();
    if (!summary) throw new Error("Compaction handoff summary is empty");
    const state = attempt.state;
    if (state.failure) throw new Error(`Compaction attempt is no longer writable: ${state.failure.message}`);
    if (state.phase === "committed" || state.phase === "cleaning" || state.phase === "settled") {
      if (state.summary !== summary) {
        const warning: CleanupWarning = {
          code: "cleanup_warning",
          stage: "commit",
          message: "A duplicate compaction attempt produced a different summary; the committed result was preserved",
        };
        this.reduce(attempt, { type: "cleanup_warning", warning });
      }
      return {
        summary: state.summary!,
        replayed: true,
        cleanupWarnings: [...attempt.state.cleanupWarnings],
      };
    }
    this.reduce(attempt, { type: "awaiting_handoff" });
    this.reduce(attempt, { type: "handoff_committed", summary, replayed: input.replayed === true });
    return { summary, replayed: input.replayed === true, cleanupWarnings: [] };
  }

  async cancel(selector: CompactionSelector): Promise<CancelResult> {
    const attempt = this.attempts.get(selectorKey(selector));
    if (!attempt) return { cancelled: false, cleanupOnly: false, phase: "new" };
    const phase = attempt.state.phase;
    if (phase === "committed" || phase === "cleaning" || phase === "settled") {
      return { cancelled: false, cleanupOnly: true, phase };
    }
    if (!attempt.abort.signal.aborted) attempt.abort.abort(new DOMException("Compaction cancelled", "AbortError"));
    this.reduce(attempt, { type: "cancelled" });
    return { cancelled: true, cleanupOnly: false, phase: attempt.state.phase };
  }

  async cleanup(selector: CompactionSelector, action: () => Promise<void>): Promise<CleanupWarning[]> {
    const attempt = this.attempts.get(selectorKey(selector));
    if (!attempt || attempt.state.phase !== "committed") return [];
    this.reduce(attempt, { type: "cleanup_started" });
    try {
      await action();
    } catch (error) {
      this.reduce(attempt, {
        type: "cleanup_warning",
        warning: {
          code: "cleanup_warning",
          stage: "retained_conversation",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    this.reduce(attempt, { type: "cleanup_settled" });
    return [...attempt.state.cleanupWarnings];
  }

  state(selector: CompactionSelector): CompactionState {
    const attempt = this.attempts.get(selectorKey(selector));
    return attempt?.state ?? { phase: "new", replayed: false, cleanupWarnings: [] };
  }

  journalSnapshot(): readonly CompactionEvent[] {
    return [...this.journal];
  }

  private reduce(attempt: Attempt, event: CompactionEvent): void {
    attempt.state = reduceStructuredCompaction(attempt.state, event);
    this.journal.push(event);
    while (this.journal.length > this.maxEvents) this.journal.shift();
  }

  private pruneAttempts(): void {
    if (this.attempts.size <= this.maxAttempts) return;
    for (const [key, attempt] of this.attempts) {
      if (this.attempts.size <= this.maxAttempts) break;
      if (attempt.state.phase === "settled" || attempt.state.failure) this.attempts.delete(key);
    }
  }
}
