import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerRuntime, ContainerHandle, StartOpts } from "./types.js";
import { log as _log } from "../log.js";

const exec = promisify(execFile);

function log(msg: string, data?: unknown) {
  _log("docker", msg, data);
}

export class DockerRuntime implements ContainerRuntime {
  name = "docker";

  async buildImage(tag: string, contextDir: string): Promise<void> {
    log("building image", { tag, contextDir });
    const { stdout, stderr } = await exec("docker", ["build", "-t", tag, contextDir]);
    if (stdout) log("build stdout", { output: stdout });
    if (stderr) log("build output", { output: stderr });
    log("image built", { tag });
  }

  async start(imageTag: string, opts?: StartOpts): Promise<ContainerHandle> {
    const args = ["run", "--detach"];

    // No network access — IPC only
    args.push("--network", "none");

    if (opts?.rm) args.push("--rm");

    // Bind-mount the host socket into the container (NOT the Docker socket)
    if (opts?.publishSocket) {
      args.push("-v", `${opts.publishSocket.hostPath}:${opts.publishSocket.containerPath}`);
    }

    if (opts?.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    if (opts?.args) args.push(...opts.args);

    args.push(imageTag);

    log("starting container", { imageTag, args });
    const { stdout } = await exec("docker", args);
    const id = stdout.trim();
    log("container started", { id: id.slice(0, 12) });

    return {
      id,
      stop: async () => {
        log("stopping container", { id: id.slice(0, 12) });
        await exec("docker", ["stop", id]);
        log("container stopped", { id: id.slice(0, 12) });
      },
    };
  }
}
