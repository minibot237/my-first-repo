import net from "node:net";
import {
  encode, makeHello, makeHeartbeat, makeNudgeAck, makeWebFetch,
  MessageReader, type Message,
} from "../shared/protocol.js";

const SOCKET_PATH = process.env["SOCKET_PATH"] || "/tmp/minibot.sock";
const MODE = process.env["AGENT_MODE"] || "listen";

function log(msg: string, data?: unknown) {
  const entry = { ts: new Date().toISOString(), component: "agent", msg, ...(data !== undefined ? { data } : {}) };
  console.log(JSON.stringify(entry));
}

function handleSocket(sock: net.Socket, cleanup?: () => void) {
  // Send hello on work channel
  const hello = makeHello();
  log("sending hello", { id: hello.id });
  sock.write(encode(hello));

  // Start heartbeat on ops channel
  const heartbeatInterval = setInterval(() => {
    const hb = makeHeartbeat();
    sock.write(encode(hb));
  }, 3000);

  const reader = new MessageReader();

  sock.on("data", (chunk) => {
    const messages = reader.push(chunk);
    for (const msg of messages) {
      log("received", { channel: msg.channel, type: msg.type, id: msg.id });
      handleMessage(sock, msg);
    }
  });

  function handleMessage(s: net.Socket, msg: Message) {
    switch (msg.type) {
      case "hello_ack":
        log("handshake complete");
        break;

      case "nudge":
        // Ack the nudge on ops channel
        s.write(encode(makeNudgeAck(msg.id)));
        log("nudged — sending contrived web_fetch");
        // Fire a fake work request
        const req = makeWebFetch("https://example.com/data.json");
        s.write(encode(req));
        break;

      case "web_fetch_response":
        log("got web_fetch response", { bytes: (msg.payload as { bytes?: number })?.bytes });
        break;

      default:
        log("unhandled message", { type: msg.type });
    }
  }

  sock.on("error", (err) => {
    clearInterval(heartbeatInterval);
    log("socket error", { error: err.message });
  });

  sock.on("close", () => {
    clearInterval(heartbeatInterval);
    log("disconnected");
    cleanup?.();
  });
}

if (MODE === "connect") {
  log("connecting to supervisor", { path: SOCKET_PATH });
  const sock = net.createConnection(SOCKET_PATH, () => {
    log("connected to supervisor");
    handleSocket(sock);
  });
  sock.on("error", (err) => {
    log("connection error", { error: (err as NodeJS.ErrnoException).message });
    process.exit(1);
  });
} else {
  const server = net.createServer((sock) => {
    log("supervisor connected");
    handleSocket(sock, () => server.close());
  });
  server.listen(SOCKET_PATH, () => {
    log("agent listening", { path: SOCKET_PATH });
  });
}
