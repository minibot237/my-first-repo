export interface Message {
    channel: "ops" | "work";
    type: string;
    id: string;
    payload: unknown;
}
export declare function makeHeartbeat(): Message;
export declare function makeStatus(status: string): Message;
export declare function makeNudge(action?: string): Message;
export declare function makeNudgeAck(requestId: string): Message;
export declare function makeHello(): Message;
export declare function makeHelloAck(requestId: string): Message;
export declare function makeWebFetch(url: string): Message;
export declare function makeWebFetchResponse(requestId: string, body: string): Message;
export declare function encode(msg: Message): Buffer;
/**
 * Accumulates data and yields complete messages.
 * Feed chunks from the socket into this; it handles partial reads.
 */
export declare class MessageReader {
    private buf;
    push(chunk: Buffer): Message[];
}
