export {
  loadConfig,
  validateSetup,
  resolveProjectRoot,
  normalizeDispatchGateConfig,
  normalizeMergeGateConfig,
  type DangeresqueConfig,
  type DispatchGateConfig,
  type MergeGateConfig,
  type ValidationResult,
  CONFIG_DIR,
  DEFAULT_DISPATCH_GATE_MODES,
  DEFAULT_MERGE_GATE_MODES,
} from "./config.js";

export {
  applyDispatchGate,
  applyMergeGate,
  type GateResult,
  type ApplyDispatchGateOptions,
  type ApplyMergeGateOptions,
} from "./gates.js";

export {
  runWorker,
  runReview,
  fetchIssue,
  loadIssueFixture,
  postRunComment,
  type RunOptions,
  type RunResult,
  type IssueData,
} from "./runner.js";

export {
  listWorktrees,
  mergeWorktree,
  discardWorktree,
  getWorktreeResults,
  formatRunHeader,
  type WorktreeInfo,
  type WorktreeOpResult,
  type WorktreePhase,
} from "./worktree.js";

export { initProject } from "./init.js";

export { BRIEF_MARKDOWN, printBrief } from "./brief.js";

export { stageComment } from "./stage.js";

export {
  ArtifactBuilder,
  writeArtifact,
  jsonPathForArchive,
  parseVerdictFromMarkdown,
  parseGitRemoteSlug,
  ARTIFACT_SCHEMA_VERSION,
  type RunArtifact,
  type ResultClassification,
  type ReviewerVerdict,
  type FailureCategory,
  type LifecycleEvent,
  type PhaseTiming,
  type ReviewPhase,
} from "./artifact.js";

export {
  gatherArtifacts,
  computeStats,
  formatStats,
  type GatherOptions,
  type GatherResult,
  type StatsSummary,
  type FormatExtras,
} from "./stats.js";

export {
  runVerification,
  shouldRunVerify,
  appendVerifySummaryLine,
  appendVerifyBodySection,
  buildVerifySummaryLine,
  buildVerifyBodySection,
  type VerifyConfig,
  type VerifyCommand,
  type VerifyFailurePolicy,
  type VerificationResult,
  type VerificationOutcome,
  type RunVerificationOptions,
} from "./verify.js";
