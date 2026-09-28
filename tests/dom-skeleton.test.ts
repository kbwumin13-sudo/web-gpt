import { afterEach, expect, test } from "bun:test";
import { chatGptDomSkeleton, sanitizeChatGptDomSkeleton } from "../src/adapters/chatgpt-web/dom-skeleton";

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

function skeletonOf(html: string, maxChildren = 12) {
  scope.document = createDocument(html);
  return chatGptDomSkeleton({ maxLines: 3_000, maxChildren });
}

test("the page skeleton keeps structure and drops every piece of rendered text", () => {
  const history = Array.from({ length: 20 }, (_, index) => (
    `<a href="/c/private-conversation-${index}" title="private title ${index}"><div>private history ${index}</div></a>`
  )).join("");
  const skeleton = skeletonOf(
    `<nav aria-label="private navigation">${history}</nav>`
    + '<main id="main"><div data-chatgpt-search-unit-key="u1:user" data-chatgpt-search-message-ids="msg-1 msg-2">'
    + '<div class="whitespace-pre-wrap [--private:1px] group/turn">private user prompt</div></div>'
    + '<section data-testid="conversation-turn-2" data-turn="assistant" data-note="private words here">'
    + '<button aria-label="private tool label" type="button">private step</button>'
    + '<div data-markdown-text-style="assistant-message"><p>private answer <span data-math-source="x^2">x</span></p></div>'
    + "<script>private script</script></section></main>",
  );
  const encoded = JSON.stringify(skeleton);
  expect(encoded).not.toContain("private");
  expect(encoded).not.toContain("x^2");

  const lines = skeleton.lines.map(line => line.trim());
  expect(lines).toContain("main @id=main");
  expect(lines).toContain("div @data-chatgpt-search-unit-key=u1:user @data-chatgpt-search-message-ids=msg-1,msg-2");
  // Utility classes with arbitrary values are dropped; ordinary tokens stay. Own text is a length.
  expect(lines).toContain("div .whitespace-pre-wrap t=19");
  // A spaced value outside an identifier list can be prose, so only its name survives.
  expect(lines).toContain("section @data-testid=conversation-turn-2 @data-turn=assistant @data-note");
  expect(lines).toContain("button @aria-label @type=button t=12");
  // The answer root is summarized as one unit instead of being walked.
  expect(lines).toContain("div @data-markdown-text-style=assistant-message n=1 d=2 t=16");
  expect(lines.some(line => line.startsWith("script"))).toBeFalse();
  // Twenty history rows keep their first four and last eight around one elision marker.
  expect(lines.filter(line => line.startsWith("a @href @title"))).toHaveLength(12);
  expect(lines).toContain("~8");
});

test("the page skeleton stops at its line budget and says so", () => {
  const rows = Array.from({ length: 40 }, () => "<div><span></span></div>").join("");
  scope.document = createDocument(`<main>${rows}</main>`);
  const skeleton = chatGptDomSkeleton({ maxLines: 10, maxChildren: 100 });
  expect(skeleton.lines).toHaveLength(10);
  expect(skeleton.truncated).toBeTrue();
});

test("persisted skeletons keep only lines that match the structural grammar", () => {
  const sanitized = sanitizeChatGptDomSkeleton({
    elements: 3,
    truncated: false,
    lines: [
      "body",
      "  div @data-turn=assistant .flex t=12",
      "    ~4",
      "  div @data-chatgpt-search-message-ids=msg-1,msg-2",
      "  div private words in a line",
      // Only identifier lists may carry several values.
      "  p @data-note=private,words",
      42,
    ],
  });
  expect(sanitized).toEqual({
    elements: 3,
    truncated: false,
    lines: [
      "body",
      "  div @data-turn=assistant .flex t=12",
      "    ~4",
      "  div @data-chatgpt-search-message-ids=msg-1,msg-2",
    ],
    rejectedLines: 3,
  });
  expect(sanitizeChatGptDomSkeleton("not a skeleton")).toBeUndefined();
});
