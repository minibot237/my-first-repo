/** A running container handle. */
export interface ContainerHandle {
  id: string;
  stop(): Promise<void>;
}

/** Abstraction over container runtimes (Apple Containers, Docker, etc). */
export interface ContainerRuntime {
  name: string;
  /** Build the container image from a Dockerfile context directory. */
  buildImage(tag: string, contextDir: string): Promise<void>;
  /** Start a container and return a handle. */
  start(imageTag: string, opts?: StartOpts): Promise<ContainerHandle>;
}

export interface StartOpts {
  /** Socket mapping: host path <-> container path. */
  publishSocket?: { hostPath: string; containerPath: string };
  /** Environment variables to set inside the container. */
  env?: Record<string, string>;
  /** Remove container after it stops. */
  rm?: boolean;
  /** Extra args passed to the runtime CLI. */
  args?: string[];
}
