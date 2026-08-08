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

export interface PhaseConfig {
  engine: Engine;
  model: string;
  effort: string;
}

export type ModelEffortConfig = Omit<PhaseConfig, "engine">;
export type EngineDefaults = Record<Engine, ModelEffortConfig>;

export type ReviewPhaseConfig = Partial<PhaseConfig>;

export interface RunPlan {
  worker: PhaseConfig;
  review: PhaseConfig;
}

export interface RunPlanOverrides {
  worker?: Partial<PhaseConfig>;
  review?: Partial<PhaseConfig>;
}

/** Convert absolute path to claude project hash (e.g. /Users/foo/.bar → -Users-foo--bar) */
export function projectHash(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export interface DangeresqueConfig {
  /** Standing model/effort pins used when a phase selects or switches engine. */
  engineDefaults: EngineDefaults;
  /** Worker execution profile. */
  worker: PhaseConfig;
  /** Review execution profile. Omitted fields inherit the resolved worker. */
  review?: ReviewPhaseConfig;
  /** Permission mode (engine-specific) */
  permissionMode: string;
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
  /** Pre-review verification commands (compile/test/lint) run in the worktree. */
  verify?: VerifyConfig;
  /** Scope subsystem config (allow-list policy + opportunistic-fix budget). */
  scope?: ScopeConfig;
  /** Pre-worker enforcement gate. Absent block = gate off; opt-in via config. */
  dispatchGate?: DispatchGateConfig;
  /** Pre-merge enforcement gate. Absent block = gate off; opt-in via config. */
  mergeGate?: MergeGateConfig;
}

/**
 * Pre-worker enforcement gate. Runs before `runWorker` for configured modes;
 * blocking failure refuses the dispatch with exit 2. Independent of any
 * model/reviewer output — this is the physical enforcement point.
 */
export interface DispatchGateConfig {
  /** Master switch. Default false (opt-in). */
  enabled: boolean;
  /** Modes that trigger the gate. Default: all supported modes. */
  modes: string[];
  /** Built-in: IMPLEMENT refuses if no prior INVESTIGATE artifact exists. `--force` bypasses. */
  requireInvestigateBeforeImplement: boolean;
  /**
   * Regex naming the issue comment that carries the spec being dispatched — a
   * downstream project convention (e.g. `^##\\s*\\[ACTIVE`), which is why
   * dangeresque takes it as config rather than knowing any comment format.
   *
   * When set, `requireInvestigateBeforeImplement` stops asking "does ANY
   * INVESTIGATE artifact exist" and asks "did one run AFTER the current work
   * order was written". Without it a decade-old INVESTIGATE about an unrelated
   * subject satisfies the gate forever (issue #106).
   *
   * Absent, or matching no comment, leaves the existence-only check in place.
   * Compiled with the `m` flag at load time; an uncompilable pattern throws.
   */
  workOrderPattern?: string;
  /**
   * Project-configured shell commands run in projectRoot with
   * DANGERESQUE_ISSUE/MODE env vars. DANGERESQUE_WORKTREE and
   * DANGERESQUE_ARTIFACT are absent — neither exists yet at dispatch.
   */
  commands: VerifyCommand[];
}

/**
 * Pre-merge enforcement gate. Runs before the `git merge` in `mergeWorktree`
 * for configured modes; blocking failure refuses the merge with exit 2.
 */
export interface MergeGateConfig {
  /** Master switch. Default false (opt-in). */
  enabled: boolean;
  /** Merged-worktree modes that trigger the gate. Default: code-changing modes only. */
  modes: string[];
  /** Built-in: require the latest artifact matching the merged branch's own mode M (as resolved by extractMode) to show review.skipped=false + reviewer_verdict="accept". `--force` bypasses (not currently exposed for merge). */
  requireAcceptedImplement: boolean;
  /**
   * Project-configured shell commands run in projectRoot with
   * DANGERESQUE_ISSUE/MODE/MERGE=1 plus DANGERESQUE_WORKTREE (the merge
   * candidate's checkout) and DANGERESQUE_ARTIFACT / _ARTIFACT_JSON (the run
   * report being merged, and its eval JSON).
   */
  commands: VerifyCommand[];
}

export const DEFAULT_DISPATCH_GATE_MODES = [
  "INVESTIGATE",
  "IMPLEMENT",
  "REFACTOR",
  "TEST",
  "VERIFY",
];

// Duplicates CODE_CHANGING_MODES in src/artifact.ts and src/runner.ts (drift-
// tolerance rationale: each consumer can drift independently if future modes
// change semantics). A shared export would couple three unrelated call sites.
export const DEFAULT_MERGE_GATE_MODES = ["IMPLEMENT", "REFACTOR", "TEST"];

// Modes that produce no code changes, so no review pass is ever dispatched.
// Shared by the run pipeline and the review-rescue path, which must refuse a
// rescue for a mode whose review was skipped by design rather than killed.
export const SKIP_REVIEW_MODES = new Set(["INVESTIGATE", "VERIFY"]);

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
  engineDefaults: {
    claude: {
      model: "claude-opus-4-7",
      effort: "max",
    },
    codex: {
      model: "gpt-5.5",
      effort: "xhigh",
    },
  },
  worker: {
    engine: "claude",
    model: "claude-opus-4-7",
    effort: "max",
  },
  permissionMode: "acceptEdits",
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
  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must contain a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  const legacyKeys = [
    "engine",
    "model",
    "effort",
    "reviewModel",
    "reviewEffort",
    "codexModel",
    "codexEffort",
    "codexReviewModel",
    "codexReviewEffort",
  ].filter((key) => key in raw);
  if (legacyKeys.length > 0) {
    throw new Error(
      `Legacy flat engine config is not supported: ${legacyKeys.join(", ")}. ` +
        `Move engine/model/effort under "worker" and "review".`,
    );
  }
  const engineDefaults = normalizeEngineDefaults(raw.engineDefaults);
  const worker = normalizeWorkerPhase(raw.worker, engineDefaults);
  const review = normalizeReviewPhase(raw.review);
  const merged: DangeresqueConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    engineDefaults,
    worker,
    ...(review === undefined ? {} : { review }),
  } as DangeresqueConfig;
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
  merged.dispatchGate = normalizeDispatchGateConfig(raw.dispatchGate);
  merged.mergeGate = normalizeMergeGateConfig(raw.mergeGate);
  return merged;
}

export function resolveRunPlan(
  config: DangeresqueConfig,
  overrides: RunPlanOverrides = {},
): RunPlan {
  const worker = resolvePhaseOverride(
    "worker",
    config.worker,
    overrides.worker,
    config.engineDefaults,
  );

  const configuredReviewEngine = config.review?.engine ?? config.worker.engine;
  const reviewEngine =
    overrides.review?.engine ?? config.review?.engine ?? worker.engine;
  const reviewBase =
    reviewEngine === worker.engine
      ? worker
      : { engine: reviewEngine, ...config.engineDefaults[reviewEngine] };
  const configuredReview =
    config.review && reviewEngine === configuredReviewEngine
      ? { ...reviewBase, ...config.review, engine: reviewEngine }
      : reviewBase;
  const review: PhaseConfig = {
    engine: reviewEngine,
    model: overrides.review?.model ?? configuredReview.model,
    effort: overrides.review?.effort ?? configuredReview.effort,
  };
  assertResolvedPhase("review", review);
  return { worker, review };
}

function resolvePhaseOverride(
  name: "worker" | "review",
  configured: PhaseConfig,
  override: Partial<PhaseConfig> | undefined,
  engineDefaults: EngineDefaults,
): PhaseConfig {
  const engine = override?.engine ?? configured.engine;
  const base =
    engine === configured.engine
      ? configured
      : { engine, ...engineDefaults[engine] };
  const phase: PhaseConfig = {
    engine,
    model: override?.model ?? base.model,
    effort: override?.effort ?? base.effort,
  };
  assertResolvedPhase(name, phase);
  return phase;
}

function normalizeEngineDefaults(raw: unknown): EngineDefaults {
  if (raw === undefined) {
    return {
      claude: { ...DEFAULT_CONFIG.engineDefaults.claude },
      codex: { ...DEFAULT_CONFIG.engineDefaults.codex },
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("engineDefaults must be an object");
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "claude" && key !== "codex") {
      throw new Error(
        `engineDefaults has unknown engine '${key}' — allowed: claude, codex`,
      );
    }
  }
  const result: EngineDefaults = {
    claude: { ...DEFAULT_CONFIG.engineDefaults.claude },
    codex: { ...DEFAULT_CONFIG.engineDefaults.codex },
  };
  for (const engine of ["claude", "codex"] as const) {
    const value = input[engine];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`engineDefaults.${engine} must be an object`);
    }
    const profile = value as Record<string, unknown>;
    for (const key of Object.keys(profile)) {
      if (key !== "model" && key !== "effort") {
        throw new Error(
          `engineDefaults.${engine} has unknown field '${key}' — allowed: model, effort`,
        );
      }
    }
    for (const key of ["model", "effort"] as const) {
      if (typeof profile[key] !== "string" || profile[key].trim() === "") {
        throw new Error(
          `engineDefaults.${engine}.${key} must be a non-empty string`,
        );
      }
    }
    result[engine] = profile as unknown as ModelEffortConfig;
  }
  return result;
}

function normalizeWorkerPhase(
  raw: unknown,
  engineDefaults: EngineDefaults,
): PhaseConfig {
  if (raw === undefined) return { ...DEFAULT_CONFIG.worker };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("worker must be an object");
  }
  assertPhaseKeys("worker", raw as Record<string, unknown>);
  const input = raw as Partial<PhaseConfig>;
  const engine = input.engine ?? DEFAULT_CONFIG.worker.engine;
  if (engine !== "claude" && engine !== "codex") {
    throw new Error(`Invalid worker.engine '${engine}' (expected 'claude' or 'codex')`);
  }
  const worker = {
    engine,
    ...engineDefaults[engine],
    ...input,
  };
  assertResolvedPhase("worker", worker);
  return worker;
}

function normalizeReviewPhase(raw: unknown): ReviewPhaseConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("review must be an object");
  }
  const review = raw as Record<string, unknown>;
  assertPhaseKeys("review", review);
  for (const key of ["engine", "model", "effort"] as const) {
    if (review[key] !== undefined && typeof review[key] !== "string") {
      throw new Error(`review.${key} must be a non-empty string`);
    }
    if (typeof review[key] === "string" && review[key].trim() === "") {
      throw new Error(`review.${key} must be a non-empty string`);
    }
  }
  if (review.engine !== undefined && review.engine !== "claude" && review.engine !== "codex") {
    throw new Error(`Invalid review.engine '${review.engine}' (expected 'claude' or 'codex')`);
  }
  return review as ReviewPhaseConfig;
}

function assertPhaseKeys(name: "worker" | "review", phase: Record<string, unknown>): void {
  for (const key of Object.keys(phase)) {
    if (key !== "engine" && key !== "model" && key !== "effort") {
      throw new Error(`${name} has unknown field '${key}' — allowed: engine, model, effort`);
    }
  }
}

function assertResolvedPhase(name: "worker" | "review", phase: PhaseConfig): void {
  if (phase.engine !== "claude" && phase.engine !== "codex") {
    throw new Error(`Invalid ${name}.engine '${phase.engine}' (expected 'claude' or 'codex')`);
  }
  for (const key of ["model", "effort"] as const) {
    if (typeof phase[key] !== "string" || phase[key].trim() === "") {
      throw new Error(`${name}.${key} must be a non-empty string`);
    }
  }
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

// Diverges from normalizeDispatchGateConfig / normalizeMergeGateConfig, which
// eager-throw on any malformed entry (gates are enforcement points — a silently-
// dropped rule is a silently-lost guarantee). `verify` keeps silent-drop for
// backwards-compat with pre-#85 configs; changing it belongs in a separate
// issue that owns the impact assessment on existing operators.
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

// Allowed shape for a gate command entry. Any other key on a raw command
// object triggers a fail-closed throw at load time (matches the eager-throw
// stance for gate config: unknown key = quiet typo = silently-lost guarantee).
const GATE_COMMAND_KEYS = new Set(["name", "cmd", "on_failure", "timeout_ms"]);

/**
 * Fail-closed parser for a gate block's `commands` array. Throws on any
 * malformed entry — missing fields, wrong types, invalid enums, unknown
 * keys. Intentionally loud: a silently-dropped gate command is a silently-
 * lost enforcement guarantee (issue #85). Caller passes a stable block
 * label ("dispatchGate" or "mergeGate") for error messages.
 */
function normalizeGateCommands(raw: unknown, blockLabel: string): VerifyCommand[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${blockLabel}.commands must be an array of command objects, got ${typeof raw}`,
    );
  }
  const commands: VerifyCommand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      throw new Error(
        `${blockLabel}.commands[${i}] must be an object with {name, cmd, on_failure, timeout_ms}, got ${entry === null ? "null" : typeof entry}`,
      );
    }
    const c = entry as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name.length === 0) {
      throw new Error(
        `${blockLabel}.commands[${i}] is missing required non-empty string field 'name'`,
      );
    }
    if (typeof c.cmd !== "string" || c.cmd.length === 0) {
      throw new Error(
        `${blockLabel}.commands[${i}] (${c.name}) is missing required non-empty string field 'cmd'`,
      );
    }
    let policy: VerifyFailurePolicy = "block";
    if (c.on_failure !== undefined) {
      if (c.on_failure !== "block" && c.on_failure !== "warn") {
        throw new Error(
          `${blockLabel}.commands[${i}] (${c.name}) has invalid on_failure "${String(c.on_failure)}", expected "block" or "warn"`,
        );
      }
      policy = c.on_failure;
    }
    let timeout = DEFAULT_VERIFY_TIMEOUT_MS;
    if (c.timeout_ms !== undefined) {
      if (typeof c.timeout_ms !== "number" || !isFinite(c.timeout_ms) || c.timeout_ms <= 0) {
        throw new Error(
          `${blockLabel}.commands[${i}] (${c.name}) has invalid timeout_ms ${String(c.timeout_ms)}, expected positive finite number`,
        );
      }
      timeout = c.timeout_ms;
    }
    for (const key of Object.keys(c)) {
      if (!GATE_COMMAND_KEYS.has(key)) {
        throw new Error(
          `${blockLabel}.commands[${i}] (${c.name}) has unknown field '${key}' — allowed: ${[...GATE_COMMAND_KEYS].join(", ")}`,
        );
      }
    }
    commands.push({ name: c.name, cmd: c.cmd, on_failure: policy, timeout_ms: timeout });
  }
  return commands;
}

const DISPATCH_GATE_KEYS = new Set([
  "enabled",
  "modes",
  "requireInvestigateBeforeImplement",
  "workOrderPattern",
  "commands",
]);

const MERGE_GATE_KEYS = new Set([
  "enabled",
  "modes",
  "requireAcceptedImplement",
  "commands",
]);

/**
 * Parse the optional `dispatchGate` config block. Returns `undefined` when
 * absent (gate off, unchanged behavior). Throws on any malformed field so the
 * operator gets a loud startup failure instead of a silently-relaxed gate.
 */
export function normalizeDispatchGateConfig(raw: unknown): DispatchGateConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`dispatchGate must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!DISPATCH_GATE_KEYS.has(key)) {
      throw new Error(
        `dispatchGate has unknown field '${key}' — allowed: ${[...DISPATCH_GATE_KEYS].join(", ")}`,
      );
    }
  }

  let enabled = false;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error(`dispatchGate.enabled must be a boolean, got ${typeof obj.enabled}`);
    }
    enabled = obj.enabled;
  }

  let modes = [...DEFAULT_DISPATCH_GATE_MODES];
  if (obj.modes !== undefined) {
    if (!Array.isArray(obj.modes) || !obj.modes.every((m) => typeof m === "string")) {
      throw new Error(`dispatchGate.modes must be an array of strings`);
    }
    modes = (obj.modes as string[]).map((m) => m.toUpperCase());
  }

  let requireInvestigateBeforeImplement = true;
  if (obj.requireInvestigateBeforeImplement !== undefined) {
    if (typeof obj.requireInvestigateBeforeImplement !== "boolean") {
      throw new Error(`dispatchGate.requireInvestigateBeforeImplement must be a boolean`);
    }
    requireInvestigateBeforeImplement = obj.requireInvestigateBeforeImplement;
  }

  // Compile here purely to reject an illegal pattern at load time rather than
  // at the dispatch surface — a gate whose rule cannot be evaluated is not a
  // gate. The compiled form is thrown away; gates.ts owns the matching.
  let workOrderPattern: string | undefined;
  if (obj.workOrderPattern !== undefined) {
    if (typeof obj.workOrderPattern !== "string") {
      throw new Error(
        `dispatchGate.workOrderPattern must be a string, got ${typeof obj.workOrderPattern}`,
      );
    }
    try {
      new RegExp(obj.workOrderPattern, "m");
    } catch (err) {
      throw new Error(
        `dispatchGate.workOrderPattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    workOrderPattern = obj.workOrderPattern;
  }

  const commands = normalizeGateCommands(obj.commands, "dispatchGate");
  return {
    enabled,
    modes,
    requireInvestigateBeforeImplement,
    ...(workOrderPattern !== undefined ? { workOrderPattern } : {}),
    commands,
  };
}

/**
 * Parse the optional `mergeGate` config block. Returns `undefined` when
 * absent (gate off, unchanged behavior). Throws on any malformed field.
 */
export function normalizeMergeGateConfig(raw: unknown): MergeGateConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`mergeGate must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!MERGE_GATE_KEYS.has(key)) {
      throw new Error(
        `mergeGate has unknown field '${key}' — allowed: ${[...MERGE_GATE_KEYS].join(", ")}`,
      );
    }
  }

  let enabled = false;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error(`mergeGate.enabled must be a boolean, got ${typeof obj.enabled}`);
    }
    enabled = obj.enabled;
  }

  let modes = [...DEFAULT_MERGE_GATE_MODES];
  if (obj.modes !== undefined) {
    if (!Array.isArray(obj.modes) || !obj.modes.every((m) => typeof m === "string")) {
      throw new Error(`mergeGate.modes must be an array of strings`);
    }
    modes = (obj.modes as string[]).map((m) => m.toUpperCase());
  }

  let requireAcceptedImplement = true;
  if (obj.requireAcceptedImplement !== undefined) {
    if (typeof obj.requireAcceptedImplement !== "boolean") {
      throw new Error(`mergeGate.requireAcceptedImplement must be a boolean`);
    }
    requireAcceptedImplement = obj.requireAcceptedImplement;
  }

  const commands = normalizeGateCommands(obj.commands, "mergeGate");
  return { enabled, modes, requireAcceptedImplement, commands };
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

  let config: DangeresqueConfig;
  try {
    config = loadConfig(projectRoot);
    resolveRunPlan(config);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { valid: false, errors };
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
