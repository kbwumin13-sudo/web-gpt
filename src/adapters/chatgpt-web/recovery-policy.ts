import { ChatGptWebAdapterError } from "./adapter-error";

const TRANSIENT_RESPONSE_ERROR_CODES = new Set([
  "upstream_server_error",
  "chatgpt_submitted_turn_failed",
]);

const TRANSIENT_RESPONSE_ERROR_TEXT = /stopped responding|response DOM|final answer|observation/i;
const TURN_OWNERSHIP_ERROR_TEXT = /(?:retired|could not observe).*Codex Native turn|turn binding/i;

/** Errors that may be emitted just before a native compaction handoff crosses the MCP boundary. */
export function isChatGptCompactionHandoffRaceCandidate(error: unknown): boolean {
  if (error instanceof ChatGptWebAdapterError) {
    return TRANSIENT_RESPONSE_ERROR_CODES.has(error.code);
  }
  return error instanceof Error && TRANSIENT_RESPONSE_ERROR_TEXT.test(error.message);
}

/** Errors for which a keyed Launcher tab can safely remain available for a retained retry. */
export function isChatGptRetainedTurnRetryCandidate(error: unknown): boolean {
  return isChatGptCompactionHandoffRaceCandidate(error)
    || (error instanceof Error && /observation/i.test(error.message));
}

/** Errors caused by Codex Native ownership ending; replaying the Web turn cannot repair these. */
export function isChatGptTurnOwnershipFailure(error: unknown): boolean {
  return error instanceof Error && TURN_OWNERSHIP_ERROR_TEXT.test(error.message);
}
