import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CLAUDE_PROJECTS_DIR, projectHash } from "./config.js";
import type { PidInfo } from "./worktree.js";

const useColor = !process.env.NO_COLOR;
const c = {
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  magenta: (s: string) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

function truncate(s: string, max = 200): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "..." : oneLine;
}

export function resolveSessionPath(
  pidInfo: PidInfo,
  phase: "worker" | "review",
  worktreePath?: string,
): string | null {
  const trackedLogPath =
    phase === "review" ? pidInfo.reviewLogPath : pidInfo.workerLogPath;
  if (trackedLogPath && existsSync(trackedLogPath)) return trackedLogPath;

  const sessionId =
    phase === "review" ? pidInfo.reviewSessionId : pidInfo.workerSessionId;
  if (!sessionId) return null;

  if (pidInfo.projectHash) {
    const p = join(
      CLAUDE_PROJECTS_DIR,
      pidInfo.projectHash,
      `${sessionId}.jsonl`,
    );
    if (existsSync(p)) return p;
  }
  if (worktreePath) {
    const p = join(
      CLAUDE_PROJECTS_DIR,
      projectHash(worktreePath),
      `${sessionId}.jsonl`,
    );
    if (existsSync(p)) return p;
  }
  return null;
}

function formatClaudeLine(data: any): string | null {
  const type = data.type;

  if (
    [
      "permission-mode",
      "file-history-snapshot",
      "attachment",
      "queue-operation",
    ].includes(type)
  ) {
    return null;
  }

  if (type === "assistant" && data.message?.content) {
    const lines: string[] = [];
    for (const block of data.message.content) {
      if (block.type === "text" && block.text) {
        lines.push(`${c.cyan("[assistant]")} ${truncate(block.text)}`);
      } else if (block.type === "tool_use") {
        const name = block.name ?? "unknown";
        let summary = "";
        if (block.input) {
          if (block.input.command) summary = block.input.command;
          else if (block.input.file_path) summary = block.input.file_path;
          else if (block.input.pattern) summary = block.input.pattern;
          else if (block.input.prompt)
            summary = truncate(block.input.prompt, 80);
          else if (block.input.description) summary = block.input.description;
        }
        lines.push(
          `${c.yellow("[tool]")} ${c.bold(name)}${summary ? " " + c.dim(summary) : ""}`,
        );
      }
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  if (type === "user" && data.message?.content) {
    const content = data.message.content;
    if (Array.isArray(content)) {
      const results: string[] = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const isError = block.is_error;
          const output =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "").slice(0, 120);
          if (isError) {
            results.push(`${c.red("[error]")} ${truncate(output, 150)}`);
          } else {
            results.push(
              `${c.green("[result]")} ${c.dim(truncate(output, 150))}`,
            );
          }
        }
      }
      return results.length > 0 ? results.join("\n") : null;
    }
    if (typeof content === "string") {
      return `${c.magenta("[prompt]")} ${truncate(content)}`;
    }
  }

  if (type === "result") {
    const cost = data.cost_usd ? `$${data.cost_usd.toFixed(4)}` : "";
    const dur = data.duration_ms
      ? `${(data.duration_ms / 1000).toFixed(1)}s`
      : "";
    const sub = data.subtype ?? "done";
    return `${c.bold("[session end]")} ${sub}${cost ? " " + cost : ""}${dur ? " " + dur : ""}`;
  }

  return null;
}

function formatCodexLine(data: any): string | null {
  const event = data.type ?? data.event ?? "event";

  if (event.includes("plan") && (data.step || data.content)) {
    return `${c.magenta("[plan]")} ${truncate(String(data.step ?? data.content), 180)}`;
  }
  if (
    event.includes("tool") ||
    event.includes("exec") ||
    event.includes("command")
  ) {
    const detail =
      data.command ?? data.name ?? data.output ?? data.content ?? "";
    return `${c.yellow("[tool]")} ${c.bold(event)} ${c.dim(truncate(String(detail), 180))}`;
  }
  if (data.error) {
    return `${c.red("[error]")} ${truncate(String(data.error), 180)}`;
  }

  const msg = data.msg ?? data.output ?? data.content ?? data.text;
  if (msg) {
    return `${c.cyan(`[${event}]`)} ${truncate(String(msg), 180)}`;
  }

  return `${c.dim("[event]")} ${truncate(JSON.stringify(data), 180)}`;
}

export function formatLine(line: string): string | null {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }

  const maybeClaude = formatClaudeLine(data);
  if (maybeClaude) return maybeClaude;

  if (data.type || data.event || data.msg || data.output || data.error) {
    return formatCodexLine(data);
  }

  return null;
}

export interface TailOptions {
  sessionPath: string;
  follow: boolean;
  raw: boolean;
  pid?: number;
}

export async function tailLog(opts: TailOptions): Promise<void> {
  const { sessionPath, follow, raw, pid } = opts;

  if (!existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
  }

  await printFile(sessionPath, raw);

  if (!follow) return;

  let offset = statSync(sessionPath).size;

  const watcher = watch(sessionPath, () => {
    const newSize = statSync(sessionPath).size;
    if (newSize <= offset) return;

    const stream = createReadStream(sessionPath, {
      start: offset,
      encoding: "utf-8",
    });
    let buffer = "";
    stream.on("data", (chunk: string) => {
      buffer += chunk;
    });
    stream.on("end", () => {
      offset = newSize;
      const lines = buffer.split("\n").filter(Boolean);
      for (const line of lines) {
        if (raw) {
          console.log(line);
        } else {
          const formatted = formatLine(line);
          if (formatted) console.log(formatted);
        }
      }
    });
  });

  if (pid) {
    const pollInterval = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(pollInterval);
        watcher.close();
        console.log(c.dim("\n--- session ended ---"));
      }
    }, 3000);
  }

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
  await new Promise<void>((resolve) => {
    watcher.on("close", resolve);
  });
}

async function printFile(path: string, raw: boolean): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf-8" }),
    });
    rl.on("line", (line) => {
      if (raw) {
        console.log(line);
      } else {
        const formatted = formatLine(line);
        if (formatted) console.log(formatted);
      }
    });
    rl.on("close", resolve);
  });
}
