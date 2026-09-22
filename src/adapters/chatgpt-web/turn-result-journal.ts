import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
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

export interface TurnResultJournalOptions {
  /** Optional private snapshot. Omit for isolated tests and in-memory use. */
  statePath?: string;
  /** Test seam for deterministic storage failures. */
  writeSnapshot?: (path: string, data: string) => void;
}

export class TurnResultJournalPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Turn result journal persistence failed", { cause });
    this.name = "TurnResultJournalPersistenceError";
  }
}

interface StoredTurnResultRecord {
  executionKey: string;
  answer: string;
  events: AdapterEvent[];
  createdAt: number;
}

/**
 * A bounded journal for terminal Responses results, optionally persisted as a private snapshot.
 *
 * The journal is deliberately independent from browser sessions. A browser epoch can be
 * released while its final answer remains replayable under the exact native execution key.
 */
export class TurnResultJournal {
  private records = new Map<string, TurnResultRecord>();
  private statePath: string | undefined;
  private writeSnapshot: (path: string, data: string) => void;

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
    options: TurnResultJournalOptions = {},
  ) {
    this.statePath = options.statePath;
    this.writeSnapshot = options.writeSnapshot ?? ((path, data) => atomicWriteFile(path, data));
    this.load();
  }

  configure(statePath: string | undefined, options: TurnResultJournalOptions = {}): void {
    const writeSnapshot = options.writeSnapshot ?? ((path: string, data: string) => atomicWriteFile(path, data));
    if (this.statePath === statePath) {
      this.writeSnapshot = writeSnapshot;
      return;
    }
    const previousPath = this.statePath;
    const previousRecords = this.records;
    const previousWriteSnapshot = this.writeSnapshot;
    this.statePath = statePath;
    this.writeSnapshot = writeSnapshot;
    this.records = new Map();
    try {
      if (statePath) this.load();
    } catch (error) {
      this.statePath = previousPath;
      this.records = previousRecords;
      this.writeSnapshot = previousWriteSnapshot;
      throw error;
    }
  }

  record(
    executionKey: string,
    answer: string,
    events: readonly AdapterEvent[] = [],
    reasoning: readonly string[] = [],
  ): TurnResultRecordOutcome {
    if (!executionKey.trim()) throw new Error("Turn result execution key is required");
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer) throw new Error("Turn result answer is required");
    const fingerprint = resultFingerprint(normalizedAnswer, visibleEvents(events));
    const records = new Map(this.records);
    pruneRecords(records, this.ttlMs);
    const existing = records.get(executionKey);
    if (existing) {
      const refreshed = { ...existing, createdAt: Date.now() };
      records.set(executionKey, refreshed);
      this.commit(records);
      return existing.fingerprint === fingerprint ? { kind: "duplicate", record: refreshed } : { kind: "conflict", existing };
    }
    if (records.size >= this.maxEntries) evictOldest(records);
    const record: TurnResultRecord = {
      executionKey,
      answer: normalizedAnswer,
      events: structuredClone(events),
      reasoning: [...reasoning],
      fingerprint,
      createdAt: Date.now(),
    };
    records.set(executionKey, record);
    this.commit(records);
    return { kind: "recorded", record };
  }

  get(executionKey: string): TurnResultRecord | undefined {
    this.prune();
    const record = this.records.get(executionKey);
    if (record) record.createdAt = Date.now();
    return record;
  }

  delete(executionKey: string): boolean {
    if (!this.records.has(executionKey)) return false;
    const records = new Map(this.records);
    records.delete(executionKey);
    this.commit(records);
    return true;
  }

  size(): number {
    this.prune();
    return this.records.size;
  }

  clear(): void {
    this.commit(new Map());
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch {
      throw new Error("Turn result journal snapshot is invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Turn result journal snapshot is invalid");
    }
    const snapshot = parsed as { version?: unknown; records?: unknown };
    if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) {
      throw new Error("Turn result journal snapshot is invalid");
    }
    if (snapshot.records.length > this.maxEntries) {
      throw new Error("Turn result journal snapshot is invalid");
    }
    const records = new Map<string, TurnResultRecord>();
    for (const value of snapshot.records) {
      const record = parseStoredRecord(value);
      if (records.has(record.executionKey)) throw new Error("Turn result journal snapshot is invalid");
      records.set(record.executionKey, record);
    }
    pruneRecords(records, this.ttlMs);
    this.records = records;
  }

  private commit(records: Map<string, TurnResultRecord>): void {
    if (this.statePath) {
      const snapshot = JSON.stringify({
        version: 1,
        records: [...records.values()].map(storedRecord),
      });
      try {
        this.writeSnapshot(this.statePath, snapshot);
      } catch (error) {
        throw new TurnResultJournalPersistenceError(error);
      }
    }
    this.records = records;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.ttlMs;
    for (const [key, record] of this.records) {
      if (record.createdAt < cutoff) this.records.delete(key);
    }
  }
}

function pruneRecords(records: Map<string, TurnResultRecord>, ttlMs: number, now = Date.now()): void {
  const cutoff = now - ttlMs;
  for (const [key, record] of records) {
    if (record.createdAt < cutoff) records.delete(key);
  }
}

function evictOldest(records: Map<string, TurnResultRecord>): void {
  const oldest = [...records.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
  if (oldest) records.delete(oldest[0]);
}

function visibleEvents(events: readonly AdapterEvent[]): AdapterEvent[] {
  return events.flatMap(event => event.type === "text_delta"
    ? [{ type: "text_delta" as const, text: event.text, ...(event.phase ? { phase: event.phase } : {}) }]
    : []);
}

function storedRecord(record: TurnResultRecord): StoredTurnResultRecord {
  return {
    executionKey: record.executionKey,
    answer: record.answer,
    events: visibleEvents(record.events),
    createdAt: record.createdAt,
  };
}

function parseStoredRecord(value: unknown): TurnResultRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Turn result journal snapshot is invalid");
  const record = value as Partial<StoredTurnResultRecord>;
  const createdAt = record.createdAt;
  if (typeof record.executionKey !== "string" || !record.executionKey.trim()
    || typeof record.answer !== "string" || !record.answer.trim()
    || !Array.isArray(record.events) || typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    throw new Error("Turn result journal snapshot is invalid");
  }
  const events = record.events.flatMap(event => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Turn result journal snapshot is invalid");
    const text = event as { type?: unknown; text?: unknown; phase?: unknown };
    if (text.type !== "text_delta" || typeof text.text !== "string") throw new Error("Turn result journal snapshot is invalid");
    if (text.phase !== undefined && typeof text.phase !== "string") throw new Error("Turn result journal snapshot is invalid");
    return [{ type: "text_delta" as const, text: text.text, ...(typeof text.phase === "string"
      ? { phase: text.phase as Extract<AdapterEvent, { type: "text_delta" }>["phase"] } : {}) }];
  });
  const answer = record.answer.trim();
  return {
    executionKey: record.executionKey,
    answer,
    events,
    reasoning: [],
    fingerprint: resultFingerprint(answer, events),
    createdAt,
  };
}

function resultFingerprint(
  answer: string,
  events: readonly AdapterEvent[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ answer, events }))
    .digest("hex");
}

export const CHATGPT_TURN_RESULT_JOURNAL_TTL_MS = 7 * 24 * 60 * 60_000;
export const CHATGPT_TURN_RESULT_JOURNAL_MAX_ENTRIES = 256;

/** Production replay is bounded to 256 published results retained for seven days; it is not ACK storage. */
export const chatGptTurnResultJournal = new TurnResultJournal(
  CHATGPT_TURN_RESULT_JOURNAL_TTL_MS,
  CHATGPT_TURN_RESULT_JOURNAL_MAX_ENTRIES,
);

export function configureChatGptTurnResultJournal(
  statePath: string | undefined,
  options?: TurnResultJournalOptions,
): void {
  chatGptTurnResultJournal.configure(statePath, options);
}
