import { ChatGptBrowserWorker, closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET, planHierarchicalCompaction } from "../src/adapters/chatgpt-web/hierarchical-compaction";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateTokens } from "../src/lib/token-estimate";
import { COMPACT_PROMPT } from "../src/responses/compaction";
import { loadConfig } from "../src/config";
import type { CodexMessage, CodexParsedRequest } from "../src/types";

const config = loadConfig();
const profileFlag = process.argv.indexOf("--profile");
const profilePath = profileFlag >= 0 ? process.argv[profileFlag + 1] : undefined;
if (process.argv.includes("--execute") && (!profilePath || profilePath.startsWith("--"))) {
  throw new Error("Real browser execution requires --profile <dedicated managed Chrome profile path>");
}
const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
const marker = "AZURE-731";
const meaningful = process.argv.includes("--meaningful");
const history: CodexMessage[] = Array.from({ length: 60 }, (_item, index) => ({
  role: "user",
  content: meaningful
    ? `Record ${index + 1}: ${(`Step ${index + 1} verified /tmp/check-${index + 1}.txt; decision keep result ${index + 1}. `).repeat(75)}${index === 59 ? ` Final required identifier: ${marker}.` : ""}`
    : `record ${index + 1} ${index === 59 ? `FINAL_FACT ${marker} ` : ""}${"word ".repeat(1_180)}`,
  timestamp: index + 1,
}));
const source: CodexParsedRequest = {
  modelId: "gpt-5.6-sol",
  stream: false,
  context: { systemPrompt: ["You are Codex."], messages: [...history, { role: "user", content: COMPACT_PROMPT, timestamp: 9000 }] },
  options: { reasoning: "high" },
  _compactionRequest: true,
};
const plan = planHierarchicalCompaction(source, capabilities);
if (!plan || plan.leaves.length < 2 || plan.droppedMessages !== 0) {
  throw new Error(`Expected a lossless multi-leaf plan, got leaves=${plan?.leaves.length ?? 0} dropped=${plan?.droppedMessages ?? -1}`);
}
const compiled = plan.leaves.map(leaf => compileChatGptWebPrompt(
  leaf.request, capabilities, undefined,
  { compactionPromptJsonByteBudget: CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET },
));
const metrics = compiled.map((part, index) => ({
  leaf: index + 1,
  messageCount: plan.leaves[index]!.messageCount,
  chars: part.text.length,
  estimatedTokens: estimateTokens(part.text, source.modelId),
  hasMarker: part.text.includes(marker),
}));
process.stdout.write(`HIERARCHICAL_PLAN ${JSON.stringify({ leaves: plan.leaves.length, droppedMessages: plan.droppedMessages, elidedRecords: plan.elidedRecords, metrics })}\n`);
if (!process.argv.includes("--execute")) process.exit(0);

const worker = ChatGptBrowserWorker.forProvider({
  adapter: "chatgpt-web",
  baseUrl: "https://chatgpt.com",
  chatgptWeb: {
    appName: config.appName,
    browserHost: "managed-chrome",
    managedProfilePath: profilePath,
    chromeExecutablePath: config.chromeExecutablePath,
    headed: true,
    browserDiagnosticsPath: "output/web-recovery-hierarchical-browser-diagnostics",
  },
});
const run = async (request: CodexParsedRequest, traceId: string): Promise<string> => {
  const prompt = compileChatGptWebPrompt(
    request, capabilities, undefined,
    { compactionPromptJsonByteBudget: CHATGPT_COMPACTION_LEAF_JSON_BYTE_BUDGET },
  );
  const response = await worker.run({
    traceId, modelId: request.modelId, reasoning: request.options.reasoning,
    capabilities, compaction: true,
    prepare: async () => ({ ...prompt, release() {} }),
    onTextDelta() {},
  });
  if (!response.trim()) throw new Error(`Empty real ChatGPT summary from ${traceId}`);
  return response;
};
try {
  if (process.argv.includes("--last-leaf-only")) {
    const last = plan.leaves.at(-1)!;
    const summary = await run(last.request, "hierarchy_live_last_leaf_only");
    process.stdout.write(`LAST_LEAF_RESULT ${JSON.stringify({ chars: summary.length, hasMarker: summary.includes(marker), text: summary.slice(0, 2_000) })}\n`);
    if (!summary.includes(marker)) throw new Error("Last segment omitted the synthetic final fact");
  } else if (process.argv.includes("--merge-only")) {
    const merged = await run(plan.merge([
      "Segment 1 records ordinary repetitive text.",
      "Segment 2 records ordinary repetitive text.",
      `Segment 3 contains FINAL_FACT ${marker}. Preserve the literal final fact.`,
    ]), "hierarchy_live_merge_only");
    process.stdout.write(`MERGE_ONLY_RESULT ${JSON.stringify({ chars: merged.length, hasMarker: merged.includes(marker), text: merged.slice(0, 2_000) })}\n`);
    if (!merged.includes(marker)) throw new Error("Merge omitted the synthetic final fact");
  } else {
    const summaries: string[] = [];
    for (const leaf of plan.leaves) {
      const summary = await run(leaf.request, `hierarchy_live_segment${leaf.index}`);
      summaries.push(summary);
      process.stdout.write(`HIERARCHICAL_SEGMENT_OK ${leaf.index}/${plan.leaves.length} chars=${summary.length} hasFinalFact=${summary.includes(marker)}\n`);
      await Bun.sleep(5_000);
    }
    const merged = await run(plan.merge(summaries), "hierarchy_live_merge");
    if (!merged.includes(marker)) throw new Error(`Merged summary lost the final fact (chars=${merged.length})`);
    process.stdout.write(`HIERARCHICAL_LIVE_OK leaves=${plan.leaves.length} mergeChars=${merged.length} finalFactRetained=true\n`);
  }
} finally {
  await closeChatGptBrowserWorkers();
}
