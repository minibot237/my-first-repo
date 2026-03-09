import { randomUUID } from "node:crypto";

// --- Core message type ---

export interface Message {
  channel: "ops" | "work";
  type: string;
  id: string;
  payload: unknown;
}

// --- Message constructors ---

// Ops channel
export function makeHeartbeat(): Message {
  return { channel: "ops", type: "heartbeat", id: randomUUID(), payload: { uptime: process.uptime() } };
}

export function makeStatus(status: string): Message {
  return { channel: "ops", type: "status", id: randomUUID(), payload: { status } };
}

export function makeNudge(action: string = "check"): Message {
  return { channel: "ops", type: "nudge", id: randomUUID(), payload: { action } };
}

export function makeNudgeAck(requestId: string): Message {
  return { channel: "ops", type: "nudge_ack", id: requestId, payload: { accepted: true } };
}

// Work channel
export function makeHello(): Message {
  return { channel: "work", type: "hello", id: randomUUID(), payload: { name: "minibot", version: "0.0.1" } };
}

export function makeHelloAck(requestId: string): Message {
  return { channel: "work", type: "hello_ack", id: requestId, payload: { supervisor: "stub", accepted: true } };
}

export function makeWebFetch(url: string): Message {
  return { channel: "work", type: "web_fetch", id: randomUUID(), payload: { url } };
}

export function makeWebFetchResponse(requestId: string, body: string): Message {
  return { channel: "work", type: "web_fetch_response", id: requestId, payload: { body, bytes: body.length } };
}

// --- Length-prefixed encoding ---
// 4-byte big-endian length prefix, then UTF-8 JSON.

export function encode(msg: Message): Buffer {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, "utf-8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Accumulates data and yields complete messages.
 * Feed chunks from the socket into this; it handles partial reads.
 */
export class MessageReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Message[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages: Message[] = [];

    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;

      const json = this.buf.subarray(4, 4 + len).toString("utf-8");
      this.buf = this.buf.subarray(4 + len);
      messages.push(JSON.parse(json) as Message);
    }

    return messages;
  }
}
