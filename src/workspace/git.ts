import { execFile } from "node:child_process";

export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  cwd?: string;
  /** GitHub installation token for this command only. Never written to disk. */
  token?: string;
  /** Host the token is valid for (default https://github.com/). */
  tokenHost?: string;
  timeoutMs?: number;
  /** Extra environment (e.g. author identity). */
  env?: Record<string, string>;
}

/**
 * Environment for git: no user/system config, no prompts, no credential helpers.
 * The token is passed through GIT_CONFIG_* variables of this one process, so it
 * never appears in argv, .git/config or the worktree.
 */
export function gitEnv(options: GitRunOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    ...options.env,
  };
  if (options.token) {
    const host = options.tokenHost ?? "https://github.com/";
    const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = `http.${host}.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
    // Never let a credential helper store or supply anything.
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 = "";
  }
  return env;
}

function redact(text: string, token?: string): string {
  let out = text.replace(
    /AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi,
    "AUTHORIZATION: basic [REDACTED]",
  );
  out = out.replace(/x-access-token:[^@\s]+@/g, "x-access-token:[REDACTED]@");
  if (token) out = out.split(token).join("[REDACTED]");
  return out;
}

export function runGit(args: string[], options: GitRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: gitEnv(options),
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          const reason = error.killed ? "timed out" : `exited with ${code ?? error.code}`;
          const cleanStderr = redact(String(stderr).trim(), options.token);
          reject(
            new GitError(
              `git ${args[0] ?? ""} ${reason}: ${cleanStderr || redact(error.message, options.token)}`,
              args,
              code,
              cleanStderr,
            ),
          );
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}
