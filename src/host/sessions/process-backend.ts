import { unstable_v2_createSession, type SDKSession, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../log.js";

export interface ProcessBackendConfig {
  kind: "process";
  model: string;
}

export class ClaudeSession {
  private session: SDKSession;
  private closed = false;

  constructor(config: ProcessBackendConfig) {
    const env = { ...process.env };
    delete env["CLAUDECODE"];

    log("coder", "creating SDK session", { model: config.model });

    this.session = unstable_v2_createSession({
      model: config.model,
      env,
      permissionMode: "bypassPermissions",
    });

    log("coder", "SDK session created");
  }

  async *send(content: string, signal?: AbortSignal): AsyncGenerator<string> {
    if (this.closed) throw new Error("Session is closed");

    log("coder", "sending message", { length: content.length });
    await this.session.send(content);
    log("coder", "send resolved, starting stream");

    const onAbort = () => this.session.close();
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      let msgCount = 0;
      for await (const msg of this.session.stream()) {
        msgCount++;
        if (msgCount <= 5) {
          log("coder", "stream msg", { type: msg.type, n: msgCount });
        }
        // Full assistant message — extract text content blocks
        if (msg.type === "assistant") {
          const aMsg = msg as any;
          if (aMsg.message?.content) {
            for (const block of aMsg.message.content) {
              if (block.type === "text" && block.text) {
                yield block.text;
              }
            }
          }
        }
        // Partial streaming deltas
        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (
            event?.type === "content_block_delta" &&
            event?.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            yield event.delta.text;
          }
        }
      }
      log("coder", "stream ended", { totalMessages: msgCount });
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.session.close();
    }
  }
}
