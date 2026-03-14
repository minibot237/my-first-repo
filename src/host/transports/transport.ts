/**
 * Transport interface — shuttles text between external services and minibot.
 * Transports know nothing about sessions, trust, or actions.
 */
export interface Transport {
  /** Transport name (e.g. "telegram", "imessage") */
  readonly name: string;

  /** Begin listening for messages */
  start(): Promise<void>;

  /** Stop listening, clean up */
  stop(): void;

  /** Called by the transport when a message arrives */
  onMessage: (userId: string, text: string) => void;

  /** Send a message to a user */
  send(userId: string, text: string): Promise<void>;
}
