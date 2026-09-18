import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * Turns a browser transport failure into something the reader can act on.
 *
 * A network failure used to reach Codex as the raw exception plus Playwright's call log —
 * `goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/?temporary-chat=true Call log: -
 * navigating to …`. That is accurate and fails closed, but it does not say the one thing that
 * matters: this machine cannot reach ChatGPT, and the thing to check is the network path, not the
 * bridge. Two real failures in one session were read as bridge defects because of it.
 *
 * The Chromium error code is the classification key. It is a stable, documented enumeration, unlike
 * the surrounding prose, so a code this table does not know is reported by name rather than guessed.
 */

/** Chromium reports transport failures as `net::ERR_*`; the code is the part worth matching on. */
const NETWORK_ERROR_CODE = /net::(ERR_[A-Z0-9_]+)/;
/** Playwright appends a multi-line call log that describes its own retry loop, not the failure. */
const CALL_LOG = /\s*Call log:[\s\S]*$/;

interface NetworkFailure {
  /** What the reader should check, in one sentence. */
  advice: string;
  /**
   * Whether waiting and retrying can plausibly resolve it. A dropped connection can be a blip; a
   * refused proxy or a disconnected interface does not fix itself between attempts, and retrying
   * only delays the message that would have helped.
   */
  retryable: boolean;
}

const FAILURES: Record<string, NetworkFailure> = {
  ERR_PROXY_CONNECTION_FAILED: {
    advice: "The configured proxy refused the connection. Check that it is running and reachable.",
    retryable: false,
  },
  ERR_TUNNEL_CONNECTION_FAILED: {
    advice: "The proxy accepted the request but could not open a tunnel to ChatGPT. Its upstream node is likely unavailable; try another one.",
    retryable: false,
  },
  ERR_INTERNET_DISCONNECTED: {
    advice: "This machine has no network connection.",
    retryable: false,
  },
  ERR_NAME_NOT_RESOLVED: {
    advice: "chatgpt.com did not resolve. Check DNS, or whether a proxy is meant to handle this name.",
    retryable: false,
  },
  ERR_CONNECTION_REFUSED: {
    advice: "The connection to ChatGPT was refused. Check the proxy and any local network filter.",
    retryable: false,
  },
  ERR_CONNECTION_CLOSED: {
    advice: "The connection to ChatGPT closed during the handshake, which usually means the proxy is running but its upstream node is dead. Try another node.",
    retryable: true,
  },
  ERR_CONNECTION_RESET: {
    advice: "The connection to ChatGPT was reset. A proxy node or an intermediate network is dropping the session.",
    retryable: true,
  },
  ERR_CONNECTION_ABORTED: {
    advice: "The connection to ChatGPT was aborted before it completed.",
    retryable: true,
  },
  ERR_CONNECTION_TIMED_OUT: {
    advice: "The connection to ChatGPT timed out. The network path is unusable or too slow.",
    retryable: true,
  },
  ERR_TIMED_OUT: {
    advice: "The connection to ChatGPT timed out. The network path is unusable or too slow.",
    retryable: true,
  },
  ERR_EMPTY_RESPONSE: {
    advice: "ChatGPT closed the connection without sending a response.",
    retryable: true,
  },
  ERR_SSL_PROTOCOL_ERROR: {
    advice: "The TLS handshake with ChatGPT failed. A proxy node or a TLS-intercepting filter is breaking the connection.",
    retryable: false,
  },
  ERR_CERT_AUTHORITY_INVALID: {
    advice: "ChatGPT presented a certificate from an untrusted authority, which means something is intercepting TLS.",
    retryable: false,
  },
  ERR_CERT_COMMON_NAME_INVALID: {
    advice: "ChatGPT presented a certificate for a different name, which means something is intercepting TLS.",
    retryable: false,
  },
};

/** The Chromium transport error code in a message, if it carries one. */
export function chromiumNetworkErrorCode(value: unknown): string | undefined {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : undefined;
  return message === undefined ? undefined : NETWORK_ERROR_CODE.exec(message)?.[1];
}

/**
 * Drop Playwright's call log. It describes the library's own waiting loop, which is never the
 * reason a connection failed, and it is the bulk of what reached the user.
 */
export function withoutCallLog(message: string): string {
  return message.replace(CALL_LOG, "").trim();
}

/**
 * Strip Playwright's call log from an error while leaving the error itself intact.
 *
 * The error's type and identity are load-bearing downstream — abort reasons, retry classification,
 * and the compaction handoff signal are all decided by `instanceof` — so the message is trimmed in
 * place rather than the error being replaced with a new one.
 */
export function withoutPlaywrightCallLog<T>(error: T): T {
  if (!(error instanceof Error) || !CALL_LOG.test(error.message)) return error;
  try {
    // `DOMException.message` is a prototype getter, so assignment throws; an own property shadows
    // it without replacing the error. Formatting a failure must never add one of its own, so a
    // refusal here leaves the original message rather than propagating.
    Object.defineProperty(error, "message", {
      value: withoutCallLog(error.message),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Keep the untrimmed message.
  }
  return error;
}

/**
 * Build an explicit error for a browser transport failure, or return undefined when the failure is
 * not a transport one and belongs to whichever layer already understands it.
 */
export function chatGptNetworkError(cause: unknown): ChatGptWebAdapterError | undefined {
  const code = chromiumNetworkErrorCode(cause);
  if (code === undefined) return undefined;
  const failure = FAILURES[code];
  const detail = failure?.advice
    // An unknown code is named rather than explained, so a new one is visible instead of guessed at.
    ?? "The browser could not complete the connection.";
  return new ChatGptWebAdapterError(
    `The browser could not reach ChatGPT (${code}). ${detail}`,
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_network_unreachable",
      retryable: failure?.retryable ?? true,
      cause,
    },
  );
}
