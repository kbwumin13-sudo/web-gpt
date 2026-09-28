import { afterEach, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { chatGptAgentCommentaryProbe, type ChatGptAgentCommentaryProbe } from "../src/adapters/chatgpt-web/agent-commentary";
import { CHATGPT_AGENT_COMMENTARY_SETTLE_GRACE_MS, ChatGptAgentCommentaryRelay } from "../src/adapters/chatgpt-web/browser-worker";

// domino ships without module typings; it is already present as a turndown dependency and is the
// only DOM implementation available to this suite.
const { createDocument } = require("@mixmark-io/domino") as {
  createDocument: (html: string) => Document;
};

const scope = globalThis as typeof globalThis & { document?: Document };
const originalDocument = scope.document;
afterEach(() => {
  scope.document = originalDocument;
});

// The shape of ChatGPT's thread as captured by the structure-only skeleton on 2026-09-29; the
// text is synthetic. A finished turn keeps its marker and answer unit; the live turn has its work
// block (commentary, a tool row with a tertiary label, a root still streaming) and then its answer.
const finishedTurn = '<div data-turn-key="fallback-turn-0"><div data-content-search-turn-key="fallback-turn-0">'
  + '<div><span hidden data-chatgpt-agent-turn-start></span>'
  + '<div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="m0 m0">'
  + '<div data-markdown-text-style="assistant-message"><p>OLD ANSWER</p></div></div></div></div></div>';
const toolRow = '<div><span><span><div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">'
  + "<p>TOOL LABEL</p></div></span></span></div>";
const liveTurn = (answer: boolean, lastCalledTool = false) => '<div data-turn-key="fallback-turn-1"><div data-content-search-turn-key="fallback-turn-1">'
  + '<div data-markdown-text-style="assistant-message"><p>BEFORE MARKER</p></div>'
  + '<div><span hidden data-chatgpt-agent-turn-start></span><div><button aria-expanded="true"></button>'
  + '<div><div>'
  + '<div data-markdown-text-style="assistant-message" data-markdown-text-tone="primary"><p>First <code>step</code>.</p></div>'
  + toolRow
  + '<div data-markdown-text-style="assistant-message" data-markdown-text-tone="primary"><p>Second step.</p>'
  + '<div data-markdown-text-style="assistant-message">nested</div></div>'
  // ChatGPT leaves the streaming mark on the newest root until another message starts.
  + '<div data-markdown-animated data-markdown-text-style="assistant-message" data-markdown-text-tone="primary"><p>Stream</p></div>'
  + (lastCalledTool ? toolRow : "")
  + "</div></div></div></div>"
  + (answer
    ? '<div><div data-chatgpt-search-unit-key="fallback-turn-1:1:assistant" data-chatgpt-search-message-ids="m1 m1">'
      + '<div data-markdown-text-style="assistant-message"><p>ANSWER</p></div></div></div>'
    : "")
  + "</div></div>";

function probe(html: string, baselineTurnKeys: string[], fromBlock = 0): ChatGptAgentCommentaryProbe {
  scope.document = createDocument(`<main>${html}</main>`);
  return chatGptAgentCommentaryProbe({ baselineTurnKeys, fromBlock });
}

test("the agent probe reads only the new turn's commentary, never its answer or tool labels", () => {
  for (const [answer, lastCalledTool] of [[false, false], [false, true], [true, false]] as const) {
    const observed = probe(finishedTurn + liveTurn(answer, lastCalledTool), ["fallback-turn-0"]);
    expect(observed.turnKeys).toEqual(["fallback-turn-0", "fallback-turn-1"]);
    expect(observed.blocks.map(block => ({ text: block.html.replace(/<[^>]+>/g, ""), complete: block.complete }))).toEqual([
      { text: "First step.", complete: true },
      // A nested root is part of its outer root, not a second block.
      { text: "Second step.nested", complete: true },
      // The marked root is finished once a tool row or the answer follows it.
      { text: "Stream", complete: answer || lastCalledTool },
    ]);
  }
});

test("the agent probe sends back only the roots not yet relayed", () => {
  const observed = probe(finishedTurn + liveTurn(true), ["fallback-turn-0"], 2);
  expect(observed.blocks.map(block => block.html.replace(/<[^>]+>/g, ""))).toEqual(["Stream"]);
  expect(probe(finishedTurn + liveTurn(true), ["fallback-turn-0"], 5).blocks).toEqual([]);
});

test("the agent probe relays nothing it cannot attribute to this submission", () => {
  // Before the prompt is sent the baseline is empty, so two agent turns are ambiguous.
  expect(probe(finishedTurn + liveTurn(false), []).blocks).toEqual([]);
  // A turn already present at submission belongs to an earlier message.
  expect(probe(finishedTurn, ["fallback-turn-0"]).blocks).toEqual([]);
  // The previous page shape has no turn keys or agent marker at all.
  const previousShape = probe('<div data-testid="conversation-turn-2" data-turn="assistant">'
    + '<div class="markdown"><p>answer</p></div></div>', []);
  expect(previousShape).toEqual({ turnKeys: [], blocks: [] });
});

type ScriptedPage = Page & { probes: string[][] };

/** Each probe takes the next state; the last one repeats. `onProbe` lets a test move its clock. */
function scriptedPage(states: Array<ChatGptAgentCommentaryProbe | Error>, onProbe?: () => void): ScriptedPage {
  const probes: string[][] = [];
  return {
    probes,
    evaluate: async (_fn: unknown, argument: { baselineTurnKeys: string[]; fromBlock: number }) => {
      probes.push(argument.baselineTurnKeys);
      onProbe?.();
      const state = states.length > 1 ? states.shift()! : states[0]!;
      if (state instanceof Error) throw state;
      // As the page does: roots the relay already emitted are not sent again.
      return { ...state, blocks: state.blocks.slice(argument.fromBlock) };
    },
  } as unknown as ScriptedPage;
}

const turnKeys = ["fallback-turn-0", "fallback-turn-1"];
const block = (html: string, complete = true) => ({ html, complete });
const empty = { turnKeys: [], blocks: [] };

test("between tool calls the relay emits each finished root once, as Markdown, after it reads stable", async () => {
  let now = 1_000;
  const emitted: string[] = [];
  const page = scriptedPage([
    { turnKeys: ["fallback-turn-0"], blocks: [] },
    { turnKeys, blocks: [block("<p>Run <code>ls</code> first.</p>"), block("<p>Str</p>", false)] },
  ]);
  const relay = await ChatGptAgentCommentaryRelay.open(page, text => emitted.push(text), { now: () => now });
  if (!relay) throw new Error("relay did not open");

  await relay.observe(page);
  expect(emitted).toEqual([]);
  // Probes are throttled between loop wakes.
  now += 100;
  await relay.observe(page);
  expect(page.probes).toHaveLength(2);
  now += 500;
  await relay.observe(page);
  expect(emitted).toEqual(["Run `ls` first."]);
  now += 500;
  await relay.observe(page);
  // The unfinished root is never emitted half-written, and the finished one is not repeated.
  expect(emitted).toEqual(["Run `ls` first."]);
  expect(page.probes.slice(1).every(keys => keys.join() === "fallback-turn-0")).toBeTrue();
});

test("a tool call relays the commentary that led to it, though ChatGPT still marks it streaming", async () => {
  // A call's row renders only after the call returns, so the newest root keeps its streaming mark
  // and nothing follows it while the call waits.
  const emitted: string[] = [];
  const page = scriptedPage([
    empty,
    { turnKeys, blocks: [block("<p>Checking.</p>", false)] },
    { turnKeys, blocks: [block("<p>Checking.</p>", false)] },
    // The second call: its commentary is still being revealed when the call arrives.
    { turnKeys, blocks: [block("<p>Checking.</p>"), block("<p>Next st</p>", false)] },
    { turnKeys, blocks: [block("<p>Checking.</p>"), block("<p>Next step.</p>", false)] },
  ]);
  const relay = await ChatGptAgentCommentaryRelay.open(page, text => emitted.push(text));
  if (!relay) throw new Error("relay did not open");

  await relay.flushBeforeTool(page);
  expect(emitted).toEqual(["Checking."]);
  await relay.flushBeforeTool(page);
  expect(emitted).toEqual(["Checking.", "Next step."]);
  // Nothing new to relay: the answer does not wait, and nothing is relayed after it starts.
  const probes = page.probes.length;
  await relay.close(page);
  expect(page.probes).toHaveLength(probes + 1);
  await relay.flushBeforeTool(page);
  await relay.observe(page);
  expect(page.probes).toHaveLength(probes + 1);
  expect(emitted).toEqual(["Checking.", "Next step."]);
});

test("a tool call waits a bounded time for its commentary to stop changing", async () => {
  let now = 1_000;
  let revealed = 0;
  const emitted: string[] = [];
  const page = {
    evaluate: async (_fn: unknown, argument: { fromBlock: number }) => {
      now += 400;
      revealed += 1;
      return revealed === 1
        ? empty
        : { turnKeys, blocks: [block(`<p>${"x".repeat(revealed)}</p>`, false)].slice(argument.fromBlock) };
    },
  } as unknown as Page;
  const relay = await ChatGptAgentCommentaryRelay.open(page, text => emitted.push(text), { now: () => now });
  if (!relay) throw new Error("relay did not open");

  const started = now;
  await relay.flushBeforeTool(page);
  expect(now - started).toBeLessThanOrEqual(CHATGPT_AGENT_COMMENTARY_SETTLE_GRACE_MS + 400);
  // At the grace the call is released with the latest reading rather than held any longer.
  expect(emitted).toEqual(["x".repeat(revealed)]);
});

test("an unreadable page means no commentary, never a failed turn", async () => {
  const emitted: string[] = [];
  expect(await ChatGptAgentCommentaryRelay.open(scriptedPage([new Error("page gone")]), text => emitted.push(text)))
    .toBeUndefined();
  expect(await ChatGptAgentCommentaryRelay.open(scriptedPage([empty]), undefined))
    .toBeUndefined();

  const page = scriptedPage([empty, new Error("evaluation failed")]);
  const relay = await ChatGptAgentCommentaryRelay.open(page, text => emitted.push(text));
  if (!relay) throw new Error("relay did not open");
  await relay.observe(page);
  await relay.flushBeforeTool(page);
  await relay.close(page);
  expect(emitted).toEqual([]);
});
