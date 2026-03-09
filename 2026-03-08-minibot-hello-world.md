# Minibot Hello World

**Goal:** Get a container running on the Mac Mini, talking to a host-side supervisor stub over a socket. One container, one channel, one message round-trip. Then do it again with Docker.

**Language:** TypeScript (Node.js), both sides.

**Not in scope:** Full suppy architecture, model routing, permissions engine, content safety pipeline, multiple VM types. All of that comes later. This is "make two processes talk through a wall."

---

## What We're Building

```
┌─────────────────────────────────┐
│  Mac Mini (macOS 26.2 host)     │
│                                 │
│  ┌───────────────────────────┐  │
│  │  supervisor-stub (Node)   │  │
│  │  - listens on vsock/unix  │  │
│  │  - accepts connections    │  │
│  │  - receives messages      │  │
│  │  - sends responses        │  │
│  │  - logs everything        │  │
│  └─────────┬─────────────────┘  │
│            │ vsock (Apple)      │
│            │ unix sock (Docker) │
│  ┌─────────┴─────────────────┐  │
│  │  Linux container          │  │
│  │  - agent-stub (Node)      │  │
│  │  - connects to host       │  │
│  │  - sends hello message    │  │
│  │  - waits for response     │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## Architecture Decisions (Locked In)

These come from the v2 architecture doc but apply even at this scale:

1. **No network in containers by default.** Communication is IPC only.
2. **Host is the authority.** The container initiates, the host decides.
3. **Runtime-agnostic from day one.** The supervisor code doesn't import Apple frameworks or Docker libraries. It talks to an abstraction that shells out to the right CLI.
4. **Same language both sides.** TypeScript on the host, TypeScript in the container.
5. **Length-prefixed JSON messages.** Simple, parseable, extensible.

## Project Structure

```
minibot/
  src/
    host/
      supervisor.ts        # main entry — starts listening, accepts connections
      runtime/
        types.ts           # ContainerRuntime + ChannelProvider interfaces
        apple-containers.ts  # shells out to `container` CLI
        docker.ts          # shells out to `docker` CLI (step 2)
    container/
      agent.ts             # runs inside the container — connects to host, sends messages
    shared/
      protocol.ts          # message types, length-prefix encode/decode
  container-image/
    Dockerfile             # minimal Linux image with Node.js + agent.ts
  package.json
  tsconfig.json
```

## Message Protocol

Length-prefixed JSON over the socket. Every message:

```typescript
interface Message {
  type: string        // message type identifier
  id: string          // request ID for correlation
  payload: unknown    // type-specific data
}
```

Encoding: 4-byte big-endian length prefix, then UTF-8 JSON.

For step 1, two message types:

```typescript
// Container -> Host
{ type: "hello", id: "uuid", payload: { name: "minibot", version: "0.0.1" } }

// Host -> Container
{ type: "hello_ack", id: "same-uuid", payload: { supervisor: "stub", accepted: true } }
```

## Step 1: Apple Containers + vsock

### Prerequisites
- macOS 26.2 on the Mac Mini
- `container` CLI available (ships with macOS 26)
- Node.js installed on the host
- A minimal Linux container image with Node.js

### How Apple Containers vsock Works
- Each container VM gets a vsock device automatically
- Host and container communicate via context ID (CID) + port number
- Inside the container (Linux): use `socket.AF_VSOCK` — Node.js doesn't have native AF_VSOCK support, so we'll need a small native addon or use a unix socket bridged from vsock
- On the host: the `container` CLI may expose vsock port forwarding, or we use the Virtualization.framework vsock API via a thin helper

### vsock + Node.js Reality Check

Node.js doesn't have built-in `AF_VSOCK` support. Options:

1. **Use `socat` as a bridge** inside the container — vsock on one end, unix socket on the other. Agent.ts talks to the unix socket. Simplest, no native code.
2. **Write a tiny C addon** for Node.js that wraps AF_VSOCK. Small, but adds a compile step.
3. **Use Python or C for the in-container socket layer** and pipe JSON to a Node.js process. Ugly.
4. **Check if the `container` CLI supports port forwarding** from vsock to a unix socket or TCP port on the host. If so, both sides just use regular sockets.

**Recommendation:** Start by investigating what `container` CLI provides for vsock. If it does port forwarding (like Docker does with TCP ports), we might not need AF_VSOCK in Node at all — the runtime abstraction handles the translation and both sides just see a normal socket.

If not, `socat` bridge is the pragmatic first step. Zero native code, works today.

### Tasks

- [ ] Investigate `container` CLI vsock capabilities (`container --help`, man pages, WWDC sessions)
- [ ] Create a minimal Linux container image with Node.js
- [ ] Write `shared/protocol.ts` — length-prefix encode/decode, message types
- [ ] Write `container/agent.ts` — connect to host, send hello, wait for ack
- [ ] Write `host/supervisor.ts` — listen, accept, read hello, send ack, log
- [ ] Write `runtime/apple-containers.ts` — create/start/stop container via CLI
- [ ] Wire it up: supervisor creates container, container boots, agent connects, hello round-trip completes
- [ ] Celebrate

## Step 2: Docker

Once step 1 works with Apple Containers:

- [ ] Install Docker on the Mac Mini
- [ ] Write `runtime/docker.ts` — same interface, shells out to `docker` CLI
- [ ] Build the same container image as a Docker image
- [ ] IPC via unix socket (bind-mounted into the container)
- [ ] Same supervisor, same agent, same protocol — just different runtime + channel
- [ ] Verify the hello round-trip works identically

## Step 3: Make It Useful

Once both runtimes work:

- [ ] Add a second message type — something real (task submission? status check?)
- [ ] Add basic message validation on the supervisor side
- [ ] Add logging (structured JSON to stdout, nothing fancy)
- [ ] Start thinking about what the "RunVM" agent actually needs to do first

---

## What This Proves

When step 1 and 2 are done, we have:

- A container that boots and talks to the host without network access
- A host supervisor that controls container lifecycle and mediates communication
- A runtime abstraction that works with both Apple Containers and Docker
- A message protocol that's extensible
- The foundation for everything in the v2 architecture doc

Everything else — model routing, permissions, content safety, multiple VM types — layers on top of this working foundation.

---

## Reference

- [suppy-vm-architecture-v2.md](../docs/REFERENCE/thoughts/suppy-vm-architecture-v2.md) — full target architecture
- [suppy-architecture-thoughts.md](../docs/REFERENCE/thoughts/suppy-architecture-thoughts.md) — design philosophy and threat model
- Apple Containers docs / WWDC 2025 sessions on Virtualization.framework
- `container` CLI man page (on the Mini)
