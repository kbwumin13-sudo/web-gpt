import { beforeEach, expect, test } from "bun:test";
import {
  chatGptContextLog,
  chatGptContextTelemetrySnapshot,
  recordChatGptContextOmitted,
  recordChatGptContextRetrieval,
  resetChatGptContextTelemetry,
} from "../src/adapters/chatgpt-web/context-telemetry";

beforeEach(() => {
  resetChatGptContextTelemetry();
});

test("a turn handed an incomplete packet that never read the rest is counted", () => {
  // This is the case that produced a wrong answer with the bridge holding the right one: the model
  // answered from the packet alone, and nothing here could tell that apart from a turn that had
  // everything it needed.
  recordChatGptContextOmitted("trace_1", 170);
  chatGptContextLog("trace_1");
  expect(chatGptContextTelemetrySnapshot()).toMatchObject({
    omitted_turns: 1,
    omitted_records: 170,
    retrieved_turns: 0,
    omitted_without_retrieval: 1,
  });
});

test("a turn that read some of what it was not sent is counted once, not once per call", () => {
  recordChatGptContextOmitted("trace_1", 170);
  recordChatGptContextRetrieval("trace_1", "search");
  recordChatGptContextRetrieval("trace_1", "search");
  recordChatGptContextRetrieval("trace_1", "read");
  chatGptContextLog("trace_1");
  expect(chatGptContextTelemetrySnapshot()).toMatchObject({
    omitted_turns: 1,
    retrieved_turns: 1,
    searches: 2,
    reads: 1,
    omitted_without_retrieval: 0,
  });
});

test("a complete packet is not counted as a bet that was never collected", () => {
  // Zero Risk and retained resumes send what they send; there is nothing left for retrieval, so
  // not retrieving is not a signal.
  recordChatGptContextOmitted("trace_1", 0);
  recordChatGptContextRetrieval("trace_1", "search");
  expect(chatGptContextTelemetrySnapshot()).toMatchObject({
    omitted_turns: 0,
    retrieved_turns: 0,
    searches: 1,
    omitted_without_retrieval: 0,
  });
});

test("each turn reports its own trade once", () => {
  recordChatGptContextOmitted("trace_1", 12);
  recordChatGptContextRetrieval("trace_1", "read");
  expect(chatGptContextLog("trace_1")).toBe("[chatgpt-web] context trace=trace_1 omittedRecords=12 retrieved=true");
  // Consumed: a turn is reported once, so a retry cannot report the same trade twice.
  expect(chatGptContextLog("trace_1")).toBeUndefined();
  expect(chatGptContextLog("never_seen")).toBeUndefined();
});

test("turns that never conclude do not accumulate without bound, and are not counted", () => {
  for (let index = 0; index < 400; index += 1) recordChatGptContextOmitted(`trace_${index}`, 1);
  // Nothing is counted until a turn answers, so turns still open — or gone — contribute nothing.
  expect(chatGptContextTelemetrySnapshot()).toMatchObject({ omitted_turns: 0, omitted_records: 0 });
  expect(chatGptContextLog("trace_0")).toBeUndefined();
  expect(chatGptContextLog("trace_399")).toBe("[chatgpt-web] context trace=trace_399 omittedRecords=1 retrieved=false");
  expect(chatGptContextTelemetrySnapshot()).toMatchObject({ omitted_turns: 1, omitted_records: 1 });
});

test("a turn refused before the model replied is not counted as one that trusted its packet", () => {
  // Two upstream capacity refusals were the first turns this shipped with, and counting at build
  // time reported them as two turns that answered without reading what they were not sent.
  recordChatGptContextOmitted("trace_failed", 55);
  expect(chatGptContextTelemetrySnapshot()).toMatchObject({
    omitted_turns: 0,
    omitted_without_retrieval: 0,
  });
});
