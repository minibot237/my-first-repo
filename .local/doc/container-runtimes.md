# Minibot Container Runtimes

This document covers the container subsystem of the minibot long-running agent platform. Two container runtimes are implemented behind a shared abstraction, allowing the supervisor to manage containerized agents identically regardless of the underlying technology.

---

## Overview

The minibot agent runs inside a Linux container with **no network access**. All communication with the host supervisor happens over a unix socket using a length-prefixed JSON protocol. The container cannot reach the internet, cannot talk to other containers, and cannot interact with the container runtime itself.

```
┌────────────────────────────────────┐
│  macOS host                        │
│                                    │
│  supervisor (Node.js)              │
│    │                               │
│    │ unix socket                   │
│    │                               │
│  ┌─┴────────────────────────────┐  │
│  │  Linux container             │  │
│  │  agent (Node.js)             │  │
│  │  - no network                │  │
│  │  - no runtime access         │  │
│  │  - single socket to host     │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
```

---

## Runtime Abstraction

Both runtimes implement the `ContainerRuntime` interface defined in `src/host/runtime/types.ts`:

```typescript
interface ContainerRuntime {
  name: string;
  buildImage(tag: string, contextDir: string): Promise<void>;
  start(imageTag: string, opts?: StartOpts): Promise<ContainerHandle>;
}

interface ContainerHandle {
  id: string;
  stop(): Promise<void>;
}

interface StartOpts {
  publishSocket?: { hostPath: string; containerPath: string };
  env?: Record<string, string>;
  rm?: boolean;
  args?: string[];
}
```

The supervisor selects a runtime via the `RUNTIME` environment variable (`apple-containers` or `docker`) and interacts only with this interface. All CLI-specific details are encapsulated within each runtime implementation.

---

## Apple Containers Runtime

**File:** `src/host/runtime/apple-containers.ts`
**CLI:** `container` (installed via `brew install container`)
**Requires:** macOS 26+, Rosetta 2 (for the buildkit builder)

### How it works

Apple Containers runs each container in a lightweight Linux VM using Apple's Virtualization.framework. Each VM is isolated at the hypervisor level.

### IPC mechanism: `--publish-socket`

The `container` CLI provides `--publish-socket host_path:container_path`, which creates a vsock-backed bridge between a unix socket on the host and a unix socket inside the container VM.

The direction matters: the runtime creates the host-side socket file when the container starts. The **agent inside the container listens** on the socket, and the **supervisor on the host connects** to it.

### `buildImage(tag, contextDir)`

Shells out to:
```
container build -t <tag> <contextDir>
```

The builder runs in a separate VM and uses buildkit internally. Rosetta 2 is required on the host because the buildkit image has x86 components.

### `start(imageTag, opts)`

Shells out to:
```
container run --detach [--rm] \
  [--publish-socket host_path:container_path] \
  [-e KEY=VALUE ...] \
  <imageTag>
```

Returns a `ContainerHandle` with the container UUID. The `stop()` method calls `container stop <id>`.

### Connection flow

```
1. supervisor calls runtime.start() → container VM boots
2. agent inside container calls net.createServer().listen(socketPath)
3. --publish-socket bridges the container socket to the host filesystem
4. supervisor polls for the host socket file to appear (waitForSocket)
5. supervisor calls net.createConnection(hostSocketPath)
6. agent accepts, sends "hello" message
7. supervisor responds with "hello_ack"
8. handshake complete, socket closes
9. supervisor calls handle.stop() → container VM stops
```

The supervisor retries the connection (up to 20 attempts, 500ms apart) because the socket file may appear on the host before the agent has called `listen()` inside the VM.

### Containers have no network by default

Apple Containers VMs are networkless unless explicitly attached to a network with `--network`. We don't pass `--network`, so the container has no network interface — the only way out is the published socket.

---

## Docker Runtime

**File:** `src/host/runtime/docker.ts`
**CLI:** `docker`
**Requires:** Docker Engine or Docker Desktop

### How it works

Docker containers run as isolated Linux processes (via containerd) sharing the host kernel — or on macOS, inside Docker Desktop's Linux VM.

### IPC mechanism: bind-mounted unix socket

Docker uses `-v host_path:container_path` to bind-mount a unix socket from the host filesystem into the container. The supervisor creates the socket before starting the container.

The direction is opposite to Apple Containers: the **supervisor on the host listens** on the socket, and the **agent inside the container connects** to it.

### `buildImage(tag, contextDir)`

Shells out to:
```
docker build -t <tag> <contextDir>
```

Uses the standard Docker build pipeline (BuildKit by default in modern Docker).

### `start(imageTag, opts)`

Shells out to:
```
docker run --detach --network none [--rm] \
  [-v host_path:container_path] \
  [-e KEY=VALUE ...] \
  <imageTag>
```

Key flags:
- **`--network none`** — the container has no network interfaces. No internet, no inter-container communication, no DNS. IPC only.
- **`-v`** — mounts only our application socket. The Docker socket (`/var/run/docker.sock`) is never mounted, so the container cannot create, inspect, or control other containers.

Returns a `ContainerHandle` with the container ID (truncated to 12 chars in logs). The `stop()` method calls `docker stop <id>`.

### Connection flow

```
1. supervisor calls net.createServer().listen(socketPath) on the host
2. supervisor calls runtime.start() with AGENT_MODE=connect
3. Docker starts the container with the socket bind-mounted in
4. agent inside container calls net.createConnection(socketPath)
5. supervisor accepts the connection
6. agent sends "hello" message
7. supervisor responds with "hello_ack"
8. handshake complete, socket closes
9. supervisor calls handle.stop() → container stops
```

The supervisor sets a 15-second timeout waiting for the agent to connect. No retry loop is needed because the socket is already listening before the container starts.

### Security: no Docker socket access

The container receives **only** the minibot application socket via bind-mount. It has no access to:
- `/var/run/docker.sock` — cannot create, list, or manage containers
- Any host filesystem path beyond the single socket file
- Any network interface

This is a deliberate constraint from the architecture: containers must not be able to create read/write containers or interact with the runtime that hosts them.

---

## Agent Modes

The agent (`src/container/agent.ts`) runs inside the container in both runtimes. It operates in one of two modes, controlled by the `AGENT_MODE` environment variable:

| Mode | Runtime | Agent role | Supervisor role |
|------|---------|-----------|----------------|
| `listen` (default) | Apple Containers | `net.createServer().listen()` | `net.createConnection()` |
| `connect` | Docker | `net.createConnection()` | `net.createServer().listen()` |

In both modes, the agent always initiates the protocol exchange by sending `hello` first. The supervisor always responds with `hello_ack`. The message protocol is identical regardless of who binds vs connects.

---

## Message Protocol

**File:** `src/shared/protocol.ts`

All messages are length-prefixed JSON over the unix socket.

### Wire format

```
[4 bytes: big-endian uint32 length][UTF-8 JSON payload]
```

### Message structure

```typescript
interface Message {
  type: string;    // message type identifier
  id: string;      // UUID for request correlation
  payload: unknown; // type-specific data
}
```

### Current message types

**`hello`** (agent → supervisor):
```json
{ "type": "hello", "id": "<uuid>", "payload": { "name": "minibot", "version": "0.0.1" } }
```

**`hello_ack`** (supervisor → agent):
```json
{ "type": "hello_ack", "id": "<same-uuid>", "payload": { "supervisor": "stub", "accepted": true } }
```

### MessageReader

The `MessageReader` class handles TCP stream reassembly. It buffers incoming data and yields complete messages, handling partial reads and multiple messages in a single chunk.

---

## Container Image

**File:** `container-image/Dockerfile`

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY shared/ ./shared/
COPY container/ ./container/
CMD ["node", "container/agent.js"]
```

The same Dockerfile is used by both runtimes. The compiled TypeScript (`dist/shared/` and `dist/container/`) is copied into the build context before building.

Build workflow:
```
npx tsc                                    # compile TypeScript
cp -r dist/shared dist/container container-image/  # copy into build context
node dist/host/supervisor.js               # builds image + runs container
```

---

## Running

### Apple Containers

```bash
RUNTIME=apple-containers node dist/host/supervisor.js
```

Prerequisites: macOS 26+, `brew install container`, `container system start`, Rosetta 2 installed.

### Docker

```bash
RUNTIME=docker node dist/host/supervisor.js
```

Prerequisites: Docker Engine or Docker Desktop running.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIME` | `apple-containers` | Runtime to use (`apple-containers` or `docker`) |
| `SOCKET_PATH` | `./minibot.sock` | Host-side socket path |

---

## Comparison

| | Apple Containers | Docker |
|---|---|---|
| Isolation | Hardware VM (Virtualization.framework) | Process-level (namespaces/cgroups) |
| IPC | `--publish-socket` (vsock bridge) | `-v` bind-mount (unix socket) |
| Network | None by default | `--network none` |
| Socket direction | Agent listens, supervisor connects | Supervisor listens, agent connects |
| Docker socket | N/A | Never mounted |
| Build tool | `container build` (buildkit in VM) | `docker build` (BuildKit) |
| Platform | macOS 26+ only | macOS, Linux |
