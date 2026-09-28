export interface AppServerNotification {
  method?: string;
  params?: unknown;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

/** Codex final messages are Markdown source; escaped underscores render as ordinary underscores. */
export function visibleFinalText(text: string): string {
  return text.trim().replaceAll("\\_", "_");
}

/** Evidence belongs to exactly the thread and turn started by the installed acceptance run. */
export class InstalledTurnEvidence {
  private readonly items = new Map<string, RecordValue>();
  private completedTurn?: RecordValue;

  constructor(readonly threadId: string, readonly turnId: string) {}

  observe(notification: AppServerNotification): boolean {
    const params = record(notification.params);
    if (!params || params.threadId !== this.threadId) return false;
    if (notification.method === "item/completed") {
      if (params.turnId !== this.turnId) return false;
      const item = record(params.item);
      if (item && typeof item.id === "string") this.items.set(item.id, item);
      return false;
    }
    if (notification.method !== "turn/completed") return false;
    const turn = record(params.turn);
    if (!turn || turn.id !== this.turnId) return false;
    this.completedTurn = turn;
    return true;
  }

  outcome(): { status: string; answer: string; toolItems: RecordValue[]; turn: RecordValue } {
    const turn = this.completedTurn;
    if (!turn || typeof turn.status !== "string") throw new Error("The exact Codex turn has not completed");
    const loaded = Array.isArray(turn.items) ? turn.items.map(record).filter((item): item is RecordValue => item !== undefined) : [];
    const items = new Map<string, RecordValue>();
    for (const item of loaded) if (typeof item.id === "string") items.set(item.id, item);
    for (const [id, item] of this.items) items.set(id, item);
    const ordered = [...items.values()];
    const messages = ordered.filter(item => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim());
    // Codex tags the answer `final_answer` and progress notes `commentary`; an untagged message is
    // the answer only when nothing is tagged as one.
    const final = messages.filter(item => item.phase === "final_answer" || item.phase === "final").at(-1)
      ?? messages.filter(item => item.phase !== "commentary").at(-1);
    const toolItems = ordered.filter(item => ["commandExecution", "mcpToolCall", "functionCallOutput", "fileChange"].includes(String(item.type)));
    return { status: turn.status, answer: typeof final?.text === "string" ? final.text : "", toolItems, turn };
  }
}
