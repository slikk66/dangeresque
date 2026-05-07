import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  DEFAULT_VERIFY_MODES,
  type VerifyConfig,
  type VerifyCommand,
  type VerifyFailurePolicy,
} from "./verify.js";

export const CONFIG_DIR = ".dangeresque";
export const RUNS_DIR = "runs";
export const PID_FILE = ".dangeresque.pid";
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export const POINTER_ANCHOR = "<!-- DANGERESQUE-START -->";
export const POINTER_END_ANCHOR = "<!-- DANGERESQUE-END -->";
export const POINTER_BLOCK = `<!-- DANGERESQUE-START -->
**\`dangeresque\` is installed in this repo.** Use it to orchestrate issue-driven work — managing AI workers, isolated git worktrees, and gated merges — instead of raw \`git worktree\`, \`kill <pid>\`, or \`cd <worktree>\` commands.

- **Workflow primer:** read \`.dangeresque/DANGERESQUE.md\` or run \`dangeresque brief\`.
- **Command surface:** run \`dangeresque --help\` (auto-generated, never stale).
- **AFK worker constraints:** \`.dangeresque/AFK_WORKER_RULES.md\` (mode table, scope rules, status language).
<!-- DANGERESQUE-END -->
`;

const POINTER_BLOCK_RE =
  /<!-- DANGERESQUE-START -->[\s\S]*?<!-- DANGERESQUE-END -->/;

/**
 * Files dangeresque is allowed to install/maintain the pointer in, scoped to
 * the active engine. claude reads CLAUDE.md (project root and/or .claude/);
 * codex reads AGENTS.md. We never touch the other engine's file — it may be
 * authored independently and is not ours to manage.
 */
export function agentMdCandidates(
  projectRoot: string,
  engine: Engine,
): string[] {
  if (engine === "codex") {
    return [join(projectRoot, "AGENTS.md")];
  }
  return [
    join(projectRoot, "CLAUDE.md"),
    join(projectRoot, ".claude", "CLAUDE.md"),
  ];
}

export function agentMdHasPointer(
  projectRoot: string,
  engine: Engine,
): {
  found: boolean;
  matchedPath: string | null;
  checkedPaths: string[];
} {
  const checkedPaths = agentMdCandidates(projectRoot, engine);
  for (const p of checkedPaths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf-8");
    if (content.includes(POINTER_ANCHOR)) {
      return { found: true, matchedPath: p, checkedPaths };
    }
  }
  return { found: false, matchedPath: null, checkedPaths };
}

/**
 * Ensure the dangeresque pointer block is present in `content`.
 * - If anchored block exists, regex-replace it with the current canonical
 *   POINTER_BLOCK (refreshes drifted text).
 * - Otherwise prepend POINTER_BLOCK to the top.
 * Returns the new content plus the action taken.
 */
export function ensurePointer(content: string): {
  content: string;
  action: "replaced" | "prepended" | "noop";
} {
  const replacement = POINTER_BLOCK.replace(/\n$/, "");
  if (POINTER_BLOCK_RE.test(content)) {
    const next = content.replace(POINTER_BLOCK_RE, replacement);
    return { content: next, action: next === content ? "noop" : "replaced" };
  }
  return { content: POINTER_BLOCK + "\n" + content, action: "prepended" };
}

export type Engine = "claude" | "codex";

/** Convert absolute path to claude project hash (e.g. /Users/foo/.bar → -Users-foo--bar) */
export function projectHash(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export interface DangeresqueConfig {
  /** Execution engine (default: claude) */
  engine: Engine;
  /** Model to use */
  model: string;
  /** Permission mode (engine-specific) */
  permissionMode: string;
  /** Effort level (engine-specific) */
  effort: string;
  /** Run headless (default: true). Set false for interactive mode where supported. */
  headless: boolean;
  /** Allowed tools patterns */
  allowedTools: string[];
  /** Disallowed tools patterns */
  disallowedTools: string[];
  /** Worker prompt file path (relative to config dir) */
  workerPrompt: string;
  /** Review prompt file path (relative to config dir) */
  reviewPrompt: string;
  /** Enable macOS notifications via hooks (default: true) */
  notifications: boolean;
  /** Model for review pass (falls back to `model` when unset) */
  reviewModel?: string;
  /** Effort level for review pass (falls back to `effort` when unset) */
  reviewEffort?: string;
  /** Model when engine is codex (falls back to `model` when unset) */
  codexModel?: string;
  /** Review-pass model when engine is codex (falls back to `codexModel`, then `reviewModel`, then `model`) */
  codexReviewModel?: string;
  /** Pre-review verification commands (compile/test/lint) run in the worktree. */
  verify?: VerifyConfig;
  /** Scope subsystem config (allow-list policy + opportunistic-fix budget). */
  scope?: ScopeConfig;
}

export interface ScopeOpportunisticConfig {
  enabled: boolean;
  maxFiles: number;
  maxLines: number;
  denyGlobs: string[];
}

export interface ScopeConfig {
  opportunistic: ScopeOpportunisticConfig;
}

const DEFAULT_CONFIG: DangeresqueConfig = {
  engine: "claude",
  model: "claude-opus-4-7",
  permissionMode: "acceptEdits",
  effort: "max",
  headless: true,
  // MCP allow rules must name the server (mcp__<server> or mcp__<server>__*);
  // bare `mcp__*` is not honored by claude-code. Run `dangeresque allow mcp`
  // to add per-server entries — see docs/PERMISSIONS.md.
  allowedTools: [
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "Bash(git status *)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(git branch *)",
    "Bash(ls *)",
    "Bash(cat *)",
    "Bash(head *)",
    "Bash(tail *)",
    "Bash(grep *)",
    "Bash(echo *)",
    "Bash(find *)",
    "Bash(wc *)",
  ],
  disallowedTools: [
    "Bash(git push *)",
    "Bash(git reset --hard *)",
    "Bash(rm -rf *)",
    "Bash(git branch -D *)",
  ],
  workerPrompt: "worker-prompt.md",
  reviewPrompt: "review-prompt.md",
  notifications: true,
};

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  enabled: true,
  modes: [...DEFAULT_VERIFY_MODES],
  commands: [],
};

export const DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG: ScopeOpportunisticConfig = {
  enabled: true,
  maxFiles: 1,
  maxLines: 20,
  denyGlobs: [
    "infra/**",
    ".github/**",
    "**/*.lock",
    "**/migrations/**",
    "**/.env*",
    "**/secrets/**",
  ],
};

export function loadConfig(projectRoot: string): DangeresqueConfig {
  const configPath = join(projectRoot, CONFIG_DIR, "config.json");
  if (!existsSync(configPath)) {
    return {
      ...DEFAULT_CONFIG,
      verify: { ...DEFAULT_VERIFY_CONFIG },
      scope: defaultScopeConfig(),
    };
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const merged: DangeresqueConfig = { ...DEFAULT_CONFIG, ...raw };
  // Tool lists extend defaults rather than replace them: the user's config.json
  // is purely additions. Empty/missing user array leaves defaults untouched.
  merged.allowedTools = mergeStringList(
    DEFAULT_CONFIG.allowedTools,
    raw.allowedTools,
  );
  merged.disallowedTools = mergeStringList(
    DEFAULT_CONFIG.disallowedTools,
    raw.disallowedTools,
  );
  merged.verify = normalizeVerifyConfig(raw.verify);
  merged.scope = normalizeScopeConfig(raw.scope);
  return merged;
}

function defaultScopeConfig(): ScopeConfig {
  return {
    opportunistic: {
      ...DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG,
      denyGlobs: [...DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG.denyGlobs],
    },
  };
}

function normalizeScopeConfig(raw: unknown): ScopeConfig {
  if (!raw || typeof raw !== "object") return defaultScopeConfig();
  const obj = raw as Record<string, unknown>;
  return {
    opportunistic: normalizeScopeOpportunisticConfig(obj.opportunistic),
  };
}

export function normalizeScopeOpportunisticConfig(
  raw: unknown,
): ScopeOpportunisticConfig {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG,
      denyGlobs: [...DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG.denyGlobs],
    };
  }
  const obj = raw as Record<string, unknown>;
  const enabled =
    typeof obj.enabled === "boolean"
      ? obj.enabled
      : DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG.enabled;
  const maxFiles =
    typeof obj.maxFiles === "number" && obj.maxFiles >= 0
      ? Math.floor(obj.maxFiles)
      : DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG.maxFiles;
  const maxLines =
    typeof obj.maxLines === "number" && obj.maxLines >= 0
      ? Math.floor(obj.maxLines)
      : DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG.maxLines;
  // Empty array overrides defaults to "no project-level deny" — distinct from
  // missing/malformed which falls back. Drops malformed entries silently.
  const denyGlobs = Array.isArray(obj.denyGlobs)
    ? obj.denyGlobs.filter((g): g is string => typeof g === "string")
    : [...DEFAULT_SCOPE_OPPORTUNISTIC_CONFIG.denyGlobs];
  return { enabled, maxFiles, maxLines, denyGlobs };
}

function normalizeVerifyConfig(raw: unknown): VerifyConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_VERIFY_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  const enabled =
    typeof obj.enabled === "boolean"
      ? obj.enabled
      : DEFAULT_VERIFY_CONFIG.enabled;
  const modes =
    Array.isArray(obj.modes) && obj.modes.every((m) => typeof m === "string")
      ? (obj.modes as string[]).map((m) => m.toUpperCase())
      : [...DEFAULT_VERIFY_CONFIG.modes];
  const commandsRaw = Array.isArray(obj.commands) ? obj.commands : [];
  const commands: VerifyCommand[] = [];
  for (const c of commandsRaw) {
    if (!c || typeof c !== "object") continue;
    const cObj = c as Record<string, unknown>;
    if (typeof cObj.name !== "string" || typeof cObj.cmd !== "string") continue;
    const policy: VerifyFailurePolicy =
      cObj.on_failure === "warn" ? "warn" : "block";
    const timeout =
      typeof cObj.timeout_ms === "number" && cObj.timeout_ms > 0
        ? cObj.timeout_ms
        : DEFAULT_VERIFY_TIMEOUT_MS;
    commands.push({
      name: cObj.name,
      cmd: cObj.cmd,
      on_failure: policy,
      timeout_ms: timeout,
    });
  }
  return { enabled, modes, commands };
}

function mergeStringList(defaults: string[], userValue: unknown): string[] {
  if (!Array.isArray(userValue) || userValue.length === 0) {
    return [...defaults];
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const v of [...defaults, ...userValue]) {
    if (typeof v !== "string" || seen.has(v)) continue;
    seen.add(v);
    merged.push(v);
  }
  return merged;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSetup(projectRoot: string): ValidationResult {
  const errors: string[] = [];
  const configDir = join(projectRoot, CONFIG_DIR);

  if (!existsSync(configDir)) {
    errors.push(`Missing ${CONFIG_DIR}/ directory`);
    return { valid: false, errors };
  }

  const config = loadConfig(projectRoot);

  if (!["claude", "codex"].includes(config.engine)) {
    errors.push(
      `Invalid engine '${config.engine}' (expected 'claude' or 'codex')`,
    );
  }

  const workerPromptPath = join(configDir, config.workerPrompt);
  if (!existsSync(workerPromptPath)) {
    errors.push(`Missing worker prompt: ${workerPromptPath}`);
  }

  const reviewPromptPath = join(configDir, config.reviewPrompt);
  if (!existsSync(reviewPromptPath)) {
    errors.push(`Missing review prompt: ${reviewPromptPath}`);
  }

  return { valid: errors.length === 0, errors };
}

export function validateEngineRuntime(
  engine: Engine,
  projectRoot: string,
  opts: {
    homedirFn?: () => string;
    probeMissing?: (engine: Engine) => boolean;
  } = {},
): ValidationResult {
  const errors: string[] = [];
  const homedirFn = opts.homedirFn ?? homedir;
  const probeMissing = opts.probeMissing ?? defaultProbeMissing;

  if (probeMissing(engine)) {
    errors.push(
      `Engine '${engine}' not found on PATH.\n` +
        `    Install it and re-run, or switch engine in .dangeresque/config.json.`,
    );
    return { valid: false, errors };
  }

  if (engine === "codex") {
    const authPath = join(homedirFn(), ".codex", "auth.json");
    if (!existsSync(authPath)) {
      errors.push(
        `Engine 'codex' is on PATH but not authenticated.\n` +
          `    Run: codex login\n` +
          `    Then retry.`,
      );
    }
  }
  // Claude stores creds in macOS Keychain on darwin and ~/.claude/.credentials.json on Linux;
  // no reliable cross-platform file signal, so rely on post-spawn failure for auth issues.

  const pointer = agentMdHasPointer(projectRoot, engine);
  if (!pointer.found) {
    const labels = pointer.checkedPaths.map((p) => relative(projectRoot, p));
    const list = formatList(labels);
    errors.push(
      `dangeresque pointer missing from ${list}.\n` +
        `    Run 'dangeresque init' to install one, or add this block at the top of your agent rules file:\n\n` +
        POINTER_BLOCK,
    );
  }

  return { valid: errors.length === 0, errors };
}

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function defaultProbeMissing(engine: Engine): boolean {
  const probe = spawnSync(engine, ["--version"], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  return Boolean(
    probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

export function resolveProjectRoot(): string {
  return resolve(process.cwd());
}
