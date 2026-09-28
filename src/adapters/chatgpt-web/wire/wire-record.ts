/**
 * One observation of ChatGPT's backend traffic, in the order it happened.
 *
 * This is the whole contract between whatever watches the network and the host-side assembly in
 * `wire-collector.ts`. Keeping it this small is what lets a recorded transcript replay through the
 * same code a live turn runs.
 */
export type ChatGptWireRecord =
  | { kind: "request"; id: string; method: string; url: string; at: number }
  | { kind: "response"; id: string; status: number; at: number }
  | { kind: "chunk"; id: string; text: string; at: number }
  | { kind: "end"; id: string; at: number }
  | { kind: "error"; id: string; message: string; at: number };

/**
 * Method recorded for a WebSocket. A `fetch` response is event-stream framed; socket messages are
 * already one payload each and must not be run through event-stream framing.
 */
export const WEBSOCKET_METHOD = "WS";
