export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

/**
 * Cloudflare kept its "verify you are human" check on screen instead of ChatGPT past the grace the
 * turn gives it.
 *
 * The browser now clears Cloudflare's managed check by itself (see `chrome-launch.ts`), so reaching
 * this means Cloudflare wants more than that: an interaction, or a pause because too many Temporary
 * Chats were opened. Deliberately NOT retryable, because every automatic retry opens another
 * Temporary Chat and makes a rate block both harder and longer.
 */
export function chatGptCloudflareChallengeError(cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "Cloudflare kept its 'verify you are human' check on screen instead of ChatGPT, so this turn "
    + "could not start. This is NOT an expired login — running `login` again will not clear it. "
    + "Either run `codex-chatgpt-web clear-challenge` and pass the check yourself in the window it "
    + "opens, or wait a few minutes before retrying.",
    {
      status: 503,
      errorType: "server_error",
      code: "cloudflare_challenge",
      retryable: false,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * Cloudflare is answering ChatGPT's own API requests with a challenge while the page still loads.
 *
 * Not retryable: each retry opens another Temporary Chat into the same challenged route. The
 * cf-mitigated header proves that Cloudflare intervened, but does not identify why. A challenged
 * proxy exit can keep failing even after the browser has been idle, so waiting is not a guaranteed
 * remedy. This API response has no checkbox; check the route before sending another turn.
 */
export function chatGptCloudflareApiChallengeError(path: string, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `Cloudflare answered this browser's ChatGPT request to ${path} with a challenge (HTTP 403), `
    + "so this turn could not run. The page may still open without a visible verification prompt. "
    + "The response does not say whether the cause is request rate, browser state, or the proxy "
    + "exit. This API response has no checkbox to pass. Do not retry right away; if it persists, "
    + "check the browser session and try a working network or proxy exit.",
    {
      status: 503,
      errorType: "server_error",
      code: "cloudflare_challenge",
      retryable: false,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
