export {
  loadConfig,
  validateSetup,
  resolveProjectRoot,
  type DangeresqueConfig,
  type ValidationResult,
  CONFIG_DIR,
  TASK_FILE,
} from "./config.js";

export {
  runWorker,
  runReview,
  fetchIssue,
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
  type WorktreeInfo,
} from "./worktree.js";

export { initProject } from "./init.js";

export { stageComment } from "./stage.js";

export {
  ArtifactBuilder,
  writeArtifact,
  commitArtifactJson,
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
