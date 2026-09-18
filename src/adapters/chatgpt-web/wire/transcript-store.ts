import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatGptWireObservation } from "./turn-observation";
import type { ChatGptWireStream } from "./wire-collector";

/**
 * On-disk recording of observed conversation streams.
 *
 * A raw transcript is the fixture that turns a live failure into an offline regression test — the
 * capability this project has never had, and the reason a fixed bug could come back. It is also a
 * verbatim copy of a conversation, so it is written only when explicitly enabled, into an
 * owner-only directory, and pruned. Counting how well the stream was understood needs no content
 * and is therefore always on; keeping the content itself is a deliberate act.
 */

/** Set to `1` to retain raw transcripts. Off by default because a transcript is conversation content. */
export const WIRE_TRANSCRIPT_ENV = "CODEX_CHATGPT_WEB_WIRE_TRANSCRIPTS";

const MAX_RETAINED_TRANSCRIPTS = 20;
const TRACE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function wireTranscriptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WIRE_TRANSCRIPT_ENV] === "1";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // An existing directory keeps its mode through mkdir, so it is tightened explicitly.
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

/** Oldest first, so a long-lived daemon retains a bounded window rather than every turn it ever ran. */
function prune(root: string, keep: number): void {
  let entries: { name: string; modifiedAt: number }[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => ({ name: entry.name, modifiedAt: statSync(join(root, entry.name)).mtimeMs }))
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
  } catch {
    return;
  }
  for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
    rmSync(join(root, entry.name), { force: true });
  }
}

export interface WireTranscript {
  traceId: string;
  recordedAt: string;
  stream: {
    url: string;
    method: string;
    /** Replay has to divide the recorded bytes the same way they were divided live. */
    framing: "sse" | "message";
    status?: number;
    startedAt: number;
    endedAt?: number;
    truncated: boolean;
    observedLength: number;
    error?: string;
  };
  observation: ChatGptWireObservation;
  /**
   * What the DOM concluded for the same turn.
   *
   * Without it a disagreement is only a pair of lengths, and the two explanations for "the wire read
   * more" — the wire counting text that is not the answer, or the DOM losing part of one — cannot be
   * told apart. Both have been observed, so the texts have to be side by side to decide.
   */
  dom?: { answer: string; failed: boolean };
  /** The bytes as received, which is what a replay consumes. */
  raw: string;
}

export function buildWireTranscript(
  traceId: string,
  stream: ChatGptWireStream,
  observation: ChatGptWireObservation,
  now = new Date(),
  dom?: { answer: string; failed: boolean },
): WireTranscript {
  return {
    traceId,
    recordedAt: now.toISOString(),
    stream: {
      url: stream.url,
      method: stream.method,
      framing: stream.framing,
      ...(stream.status === undefined ? {} : { status: stream.status }),
      startedAt: stream.startedAt,
      ...(stream.endedAt === undefined ? {} : { endedAt: stream.endedAt }),
      truncated: stream.truncated,
      observedLength: stream.observedLength,
      ...(stream.error === undefined ? {} : { error: stream.error }),
    },
    observation,
    ...(dom === undefined ? {} : { dom }),
    raw: stream.raw,
  };
}

/**
 * Write a transcript, returning its path. Recording is diagnostic: a filesystem failure is reported
 * to the caller and never raised into a turn.
 */
export function writeWireTranscript(root: string, transcript: WireTranscript): string | undefined {
  if (!TRACE_PATTERN.test(transcript.traceId)) return undefined;
  try {
    privateDirectory(root);
    // Leaves room for the file about to be written, so the directory holds at most the limit.
    prune(root, MAX_RETAINED_TRANSCRIPTS - 1);
    const path = join(root, `${transcript.recordedAt.replaceAll(":", "-")}-${transcript.traceId}.json`);
    writeFileSync(path, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}
