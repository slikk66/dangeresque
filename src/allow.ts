import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface AllowResult {
  added: string[];
  skipped: string[];
  configPath: string;
  totalAllowedTools: number;
  configCreated: boolean;
}

interface ConfigFile {
  raw: string;
  parsed: Record<string, unknown>;
  exists: boolean;
}

function readOrInitConfig(configPath: string): ConfigFile {
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Config at ${configPath} is not a JSON object`);
    }
    return { raw, parsed, exists: true };
  }
  return { raw: "", parsed: {}, exists: false };
}

function detectIndent(raw: string): number {
  const m = raw.match(/\n([ \t]+)"/);
  if (!m) return 2;
  const ws = m[1];
  if (ws.includes("\t")) return 2;
  return ws.length;
}

function writeConfig(
  configPath: string,
  parsed: Record<string, unknown>,
  original: ConfigFile,
): void {
  const indent = original.exists ? detectIndent(original.raw) : 2;
  const trailingNewline = original.exists ? original.raw.endsWith("\n") : true;
  mkdirSync(dirname(configPath), { recursive: true });
  let serialized = JSON.stringify(parsed, null, indent);
  if (trailingNewline) serialized += "\n";
  writeFileSync(configPath, serialized);
}

function applyAdditions(
  projectRoot: string,
  patternsToAdd: string[],
  dryRun: boolean,
): AllowResult {
  const configPath = join(projectRoot, CONFIG_DIR, "config.json");
  const original = readOrInitConfig(configPath);
  const existingTools = Array.isArray((original.parsed as { allowedTools?: unknown }).allowedTools)
    ? [...((original.parsed as { allowedTools: unknown[] }).allowedTools as string[])]
    : [];

  const seen = new Set(existingTools);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const pattern of patternsToAdd) {
    if (seen.has(pattern)) {
      skipped.push(pattern);
    } else {
      existingTools.push(pattern);
      seen.add(pattern);
      added.push(pattern);
    }
  }

  let configCreated = false;
  if (!dryRun && added.length > 0) {
    const next = { ...original.parsed, allowedTools: existingTools };
    writeConfig(configPath, next, original);
    configCreated = !original.exists;
  }

  return {
    added,
    skipped,
    configPath,
    totalAllowedTools: existingTools.length,
    configCreated,
  };
}

/**
 * Run `claude mcp list` and return server names.
 * Tries `--json` first; falls back to parsing the human-readable output.
 * Throws if the claude CLI is missing or exits with a non-zero status.
 */
export function discoverMcpServers(): string[] {
  let output: string;
  try {
    output = execSync("claude mcp list --json", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    try {
      output = execSync("claude mcp list", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to run 'claude mcp list'. Is the claude CLI installed and on PATH?\n` +
          `Underlying error: ${detail}`,
      );
    }
  }
  return parseMcpListOutput(output);
}

/**
 * Parse `claude mcp list` output into server names.
 * Accepts either JSON (array of strings, array of {name}, object map, or
 * {servers: [...]}) or one-server-per-line text.
 * Exported for unit testing.
 */
export function parseMcpListOutput(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  try {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) {
      return data
        .map((entry) => extractServerName(entry))
        .filter((s): s is string => typeof s === "string" && s.length > 0);
    }
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.servers)) {
        return obj.servers
          .map((entry) => extractServerName(entry))
          .filter((s): s is string => typeof s === "string" && s.length > 0);
      }
      return Object.keys(obj).filter((k) => k && !k.startsWith("_"));
    }
  } catch {
    // not JSON — fall through to text parsing
  }

  const servers: string[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^no\s+mcp\s+servers/i.test(line)) return [];
    if (/^checking\b/i.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.\-]+)/);
    if (m && m[1]) servers.push(m[1]);
  }
  return servers;
}

function extractServerName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

export interface AllowMcpOptions {
  /** Specific server name. When omitted, discover via `claude mcp list`. */
  server?: string;
  dryRun?: boolean;
}

export function allowMcp(projectRoot: string, options: AllowMcpOptions): AllowResult {
  let patterns: string[];
  if (options.server) {
    patterns = [`mcp__${options.server}`];
  } else {
    const servers = discoverMcpServers();
    if (servers.length === 0) {
      return {
        added: [],
        skipped: [],
        configPath: join(projectRoot, CONFIG_DIR, "config.json"),
        totalAllowedTools: 0,
        configCreated: false,
      };
    }
    patterns = servers.map((s) => `mcp__${s}`);
  }
  return applyAdditions(projectRoot, patterns, !!options.dryRun);
}

export interface AllowBashOptions {
  /** Pattern body inside Bash(...). Caller passes literally e.g. "npm install *". */
  pattern: string;
  dryRun?: boolean;
}

export function allowBash(projectRoot: string, options: AllowBashOptions): AllowResult {
  const inner = options.pattern.trim();
  if (!inner) {
    throw new Error("bash pattern cannot be empty");
  }
  return applyAdditions(projectRoot, [`Bash(${inner})`], !!options.dryRun);
}
