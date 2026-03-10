import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerRuntime, ContainerHandle, StartOpts } from "./types.js";
import { log as _log } from "../log.js";

const exec = promisify(execFile);

function log(msg: string, data?: unknown) {
  _log("apple-containers", msg, data);
}

export class AppleContainersRuntime implements ContainerRuntime {
  name = "apple-containers";

  async buildImage(tag: string, contextDir: string): Promise<void> {
    log("building image", { tag, contextDir });
    const { stdout, stderr } = await exec("container", ["build", "-t", tag, contextDir]);
    if (stdout) log("build stdout", { output: stdout });
    if (stderr) log("build output", { output: stderr });
    log("image built", { tag });
  }

  async start(imageTag: string, opts?: StartOpts): Promise<ContainerHandle> {
    const args = ["run", "--detach"];

    if (opts?.rm) args.push("--rm");

    if (opts?.publishSocket) {
      args.push("--publish-socket", `${opts.publishSocket.hostPath}:${opts.publishSocket.containerPath}`);
    }

    if (opts?.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    if (opts?.args) args.push(...opts.args);

    args.push(imageTag);

    log("starting container", { imageTag, args });
    const { stdout } = await exec("container", args);
    const id = stdout.trim();
    log("container started", { id });

    return {
      id,
      stop: async () => {
        log("stopping container", { id });
        await exec("container", ["stop", id]);
        log("container stopped", { id });
      },
    };
  }
}
