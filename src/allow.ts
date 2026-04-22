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

export const MCP_JSON_FILENAME = ".mcp.json";

/**
 * Read server names (internal ids) from the project-scoped .mcp.json.
 * Top-level `mcpServers` keys are the exact ids used in `mcp__<id>__<tool>`.
 * Throws if the file is absent — caller surfaces a hint pointing at the explicit form.
 */
export function readMcpJsonServers(projectRoot: string): string[] {
  const path = join(projectRoot, MCP_JSON_FILENAME);
  if (!existsSync(path)) {
    throw new Error(
      `${MCP_JSON_FILENAME} not found in ${projectRoot}. ` +
        `To grant a user-scope or plugin-scope server, pass its id explicitly: ` +
        `dangeresque allow mcp <server>`,
    );
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${path}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  return Object.keys(servers as Record<string, unknown>);
}

export interface AllowMcpOptions {
  /** Specific server id. When omitted, read from project-scoped .mcp.json. */
  server?: string;
  dryRun?: boolean;
}

export function allowMcp(projectRoot: string, options: AllowMcpOptions): AllowResult {
  let patterns: string[];
  if (options.server) {
    patterns = [`mcp__${options.server}`];
  } else {
    const servers = readMcpJsonServers(projectRoot);
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
