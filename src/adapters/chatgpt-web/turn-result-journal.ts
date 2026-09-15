import { createHash } from "node:crypto";
import type { AdapterEvent } from "../../types";

export interface TurnResultRecord {
  readonly executionKey: string;
  readonly answer: string;
  readonly events: readonly AdapterEvent[];
  readonly reasoning: readonly string[];
  readonly fingerprint: string;
  createdAt: number;
}

export type TurnResultRecordOutcome =
  | { kind: "recorded"; record: TurnResultRecord }
  | { kind: "duplicate"; record: TurnResultRecord }
  | { kind: "conflict"; existing: TurnResultRecord };

/**
 * An in-process, bounded journal for terminal Responses results.
 *
 * The journal is deliberately independent from browser sessions. A browser epoch can be
 * released while its final answer remains replayable under the exact native execution key.
 */
export class TurnResultJournal {
  private readonly records = new Map<string, TurnResultRecord>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  record(
    executionKey: string,
    answer: string,
    events: readonly AdapterEvent[] = [],
    reasoning: readonly string[] = [],
  ): TurnResultRecordOutcome {
    if (!executionKey.trim()) throw new Error("Turn result execution key is required");
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer) throw new Error("Turn result answer is required");
    this.prune();
    const fingerprint = resultFingerprint(normalizedAnswer, events, reasoning);
    const existing = this.records.get(executionKey);
    if (existing) {
      existing.createdAt = Date.now();
      return existing.fingerprint === fingerprint
        ? { kind: "duplicate", record: existing }
        : { kind: "conflict", existing };
    }
    if (this.records.size >= this.maxEntries) this.evictOldest();
    const record: TurnResultRecord = {
      executionKey,
      answer: normalizedAnswer,
      events: structuredClone(events),
      reasoning: [...reasoning],
      fingerprint,
      createdAt: Date.now(),
    };
    this.records.set(executionKey, record);
    return { kind: "recorded", record };
  }

  get(executionKey: string): TurnResultRecord | undefined {
    this.prune();
    const record = this.records.get(executionKey);
    if (record) record.createdAt = Date.now();
    return record;
  }

  delete(executionKey: string): boolean {
    return this.records.delete(executionKey);
  }

  size(): number {
    this.prune();
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.ttlMs;
    for (const [key, record] of this.records) {
      if (record.createdAt < cutoff) this.records.delete(key);
    }
  }

  private evictOldest(): void {
    const oldest = [...this.records.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (oldest) this.records.delete(oldest[0]);
  }
}

function resultFingerprint(
  answer: string,
  events: readonly AdapterEvent[],
  reasoning: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ answer, events, reasoning }))
    .digest("hex");
}

export const chatGptTurnResultJournal = new TurnResultJournal();
