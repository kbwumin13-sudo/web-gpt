import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "./environment";

/** Rotate retained Web caches when this private Runtime prompt contract changes. */
export const CHATGPT_RUNTIME_CONTRACT_VERSION = 1;

export interface ChatGptTaskScope {
  threadId: string;
  namespace: string;
  workspaceFingerprint: string;
}

export interface ChatGptSessionBinding {
  task: ChatGptTaskScope;
  modelId: string;
  reasoning: string | undefined;
  compactionEpoch: string;
  webConversationId?: string;
  browserGeneration: number;
}

export function chatGptSessionBinding(
  task: ChatGptTaskScope,
  modelId: string,
  reasoning: string | undefined,
  compactionEpoch: string,
): ChatGptSessionBinding {
  return { task, modelId, reasoning, compactionEpoch, browserGeneration: 0 };
}

/** Only a trusted turn environment contributes to the Web conversation's workspace identity. */
export function chatGptTaskScope(
  threadId: string,
  namespace: string,
  environment: ChatGptTurnEnvironment,
): ChatGptTaskScope {
  if (!threadId.trim() || !namespace.trim() || !isAbsolute(environment.cwd)) {
    throw new Error("ChatGPT task scope requires a native thread, namespace and trusted absolute cwd");
  }
  const paths = (values: readonly string[]) => values.map(value => resolve(value)).sort();
  const workspaceFingerprint = createHash("sha256").update(JSON.stringify({
    cwd: resolve(environment.cwd),
    roots: paths(environment.roots),
    writableRoots: paths(environment.writableRoots),
    sandboxPolicy: environment.sandboxPolicy,
  })).digest("hex");
  return { threadId, namespace, workspaceFingerprint };
}
