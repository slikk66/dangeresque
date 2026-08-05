import { matchesGlob as nativeMatchesGlob } from "node:path";

export interface ScopeBlock {
  allow: string[];
  deny: string[];
  diagnostics: string[];
}

export type ScopeCategory =
  | "declared"
  | "extension"
  | "opportunistic"
  | "incidental";

export interface ScopeDeclarationEntry {
  path: string;
  rationale: string;
  category: ScopeCategory;
}

/**
 * What we know about the worker's `## Scope Declaration` section.
 *
 * The three live states separate a worker-behaviour problem from a dangeresque
 * problem — the conflation that made issue #90's own premise wrong (it read 232
 * files as "no declaration" when the real number was 8; the rest were sections
 * we failed to parse).
 *
 * - `parsed`     — heading found, at least one row extracted.
 * - `unreadable` — heading found, zero rows extracted. OUR parser's problem.
 * - `missing`    — no `## Scope Declaration` heading at all. The worker's problem.
 * - `unknown`    — reserved for artifacts migrated up from schema v7, which
 *                  predate this field. Never written by a live run: the
 *                  migration can prove `parsed` from recorded rows but cannot
 *                  reconstruct the other two, and guessing `missing` would
 *                  re-create the exact conflation above.
 */
export type DeclarationStatus = "parsed" | "unreadable" | "missing" | "unknown";

export interface ScopeReport {
  in_scope: string[];
  extended: Array<{
    path: string;
    rationale: string;
    category: "extension" | "opportunistic";
  }>;
  outside: string[];
  declaration_status: DeclarationStatus;
  /** Ambiguous declaration resolutions. Omitted when empty (the normal case). */
  diagnostics?: string[];
}

// Wraps node:path.matchesGlob so a future swap (vendored minimatch subset)
// is one file, not codebase-wide. matchesGlob is unflagged in Node 22+.
export function matchesGlob(path: string, pattern: string): boolean {
  return nativeMatchesGlob(path, pattern);
}

const FENCE_REGEX = /```dangeresque-scope\r?\n([\s\S]*?)\r?\n```/g;

export function parseScopeBlocks(text: string): ScopeBlock {
  const allow: string[] = [];
  const deny: string[] = [];
  const diagnostics: string[] = [];

  let blockIndex = 0;
  let m: RegExpExecArray | null;
  FENCE_REGEX.lastIndex = 0;
  while ((m = FENCE_REGEX.exec(text)) !== null) {
    blockIndex += 1;
    parseSingleBlock(m[1], blockIndex, allow, deny, diagnostics);
  }

  // Deny wins on conflict: any path appearing in both lists is dropped from allow.
  const denySet = new Set(deny);
  const dedupedAllow = uniq(allow.filter((p) => !denySet.has(p)));
  const dedupedDeny = uniq(deny);

  return { allow: dedupedAllow, deny: dedupedDeny, diagnostics };
}

function parseSingleBlock(
  body: string,
  blockIndex: number,
  allow: string[],
  deny: string[],
  diagnostics: string[],
): void {
  const lines = body.split(/\r?\n/);
  let currentKey: "allow" | "deny" | null = null;
  let lineNum = 0;

  for (const rawLine of lines) {
    lineNum += 1;
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const keyMatch = trimmed.match(/^(allow|deny)\s*:\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1] as "allow" | "deny";
      continue;
    }

    const itemMatch = rawLine.match(/^\s*-\s+(.+?)\s*$/);
    if (itemMatch) {
      if (!currentKey) {
        diagnostics.push(
          `[scope-block ${blockIndex} line ${lineNum}] list item before allow:/deny: key`,
        );
        continue;
      }
      const value = stripQuotes(itemMatch[1]);
      if (value === "") {
        diagnostics.push(
          `[scope-block ${blockIndex} line ${lineNum}] empty list item`,
        );
        continue;
      }
      if (currentKey === "allow") allow.push(value);
      else deny.push(value);
      continue;
    }

    diagnostics.push(
      `[scope-block ${blockIndex} line ${lineNum}] unrecognized line: ${trimmed}`,
    );
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function uniq(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

const DECLARATION_LINE_REGEX =
  /^[-*]\s+`([^`]+)`\s*\(([a-z]+)\)\s*[—\-:]\s*(.+)$/;

// Markdown table form: `| path | category | rationale |`. Backticks around
// path optional. Header (`| Path | Category | Rationale |`) and separator
// (`|---|---|---|`) rows are rejected by the `[a-z]+` category capture and
// the downstream whitelist check, so no explicit row-skip needed.
const TABLE_LINE_REGEX =
  /^\s*\|\s*`?([^`|]+?)`?\s*\|\s*([a-z]+)\s*\|\s*(.+?)\s*\|\s*$/;

// Tolerant fallbacks, tried only after the two canonical forms above fail.
// Every shape below was taken from a real run artifact; see issue #90.

// `**New files (declared):**` / `**Deleted (extension — beyond the list):**`
// sets a carry-forward category for the bare bullets that follow (bc#744).
const GROUP_HEADING_REGEX =
  /^\s*\*\*.*?\(([a-z]+)\b[^)]*\)\s*:?\s*\*\*\s*:?\s*$/i;

// Table row whose cells carry markdown decoration the strict form rejects,
// e.g. `| \`tools/gate-lib.ts\` | \`declared\` | … |` (bc#703).
const LOOSE_TABLE_REGEX = /^\s*\|([^|]+)\|([^|]+)\|(.+?)\|\s*$/;

const LOOSE_BULLET_REGEX = /^[-*]\s+(.+)$/;

// A category annotation is a parenthetical that OPENS with a bare lowercase
// word terminated by `,` or `)` — `(declared)`, `(declared, new file)`. Prose
// parentheticals such as `(18 files — DocKit demo art)` or `(locale-loading
// helpers, zero callers)` do not match, so they fall through to the heading.
const CATEGORY_ANNOTATION_REGEX = /\(([a-z]+)\s*[,)]/;

const BACKTICK_SPAN_REGEX = /`([^`]+)`/g;

// Correction to round 1 (issue #90): the path cell must LEAD with a backticked
// span. Prose bullets ("Also confirmed `src/zzz.ts` behaviour: unchanged")
// lead with words and are rejected; real declarations lead with the path.
// Measured against all 677 bubble-craps artifacts: rejects 0 legitimate cells.
const PATH_CELL_LEAD_REGEX = /^\s*`[^`]+`/;

const CATEGORIES: ReadonlySet<string> = new Set([
  "declared",
  "extension",
  "opportunistic",
  "incidental",
]);

function asCategory(raw: string): ScopeCategory | null {
  const v = raw.trim().toLowerCase();
  return CATEGORIES.has(v) ? (v as ScopeCategory) : null;
}

// Strips PAIRED markdown wrappers from a table cell. Only backticks and bold
// are stripped — `*` and `_` are legitimate glob characters, so `**/*.ts` and
// `test/unit/**` survive untouched. A backtick pair with interior backticks
// (`` `a.ts`, `b.ts` ``) is left alone rather than mangled into a junk path.
function stripDecoration(cell: string): string {
  let s = cell.trim();
  for (;;) {
    if (
      s.length >= 2 &&
      s.startsWith("`") &&
      s.endsWith("`") &&
      s.indexOf("`", 1) === s.length - 1
    ) {
      s = s.slice(1, -1).trim();
      continue;
    }
    if (s.length >= 4 && s.startsWith("**") && s.endsWith("**")) {
      s = s.slice(2, -2).trim();
      continue;
    }
    break;
  }
  return s;
}

// Splits a bullet body at the first rationale separator that is not inside a
// backticked span, so `- \`src/styles/a.css\`, \`b.css\` — one palette` keeps
// both paths in the path cell and the prose out of it.
function splitBulletBody(body: string): { pathCell: string; rationale: string } {
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const isSeparator =
      ch === "—" ||
      ch === "–" ||
      ch === ":" ||
      (ch === "-" && body[i - 1] === " " && body[i + 1] === " ");
    if (isSeparator) {
      return { pathCell: body.slice(0, i), rationale: body.slice(i + 1).trim() };
    }
  }
  return { pathCell: body, rationale: "" };
}

function parseLooseBullet(
  body: string,
  groupCategory: ScopeCategory | null,
): ScopeDeclarationEntry[] {
  const { pathCell, rationale } = splitBulletBody(body);
  if (!PATH_CELL_LEAD_REGEX.test(pathCell)) return [];

  const annotation = pathCell.match(CATEGORY_ANNOTATION_REGEX);
  // An explicit-but-invalid category is a rejection, not an invitation to fall
  // back on the group heading.
  const category = annotation ? asCategory(annotation[1]) : groupCategory;
  if (!category) return [];

  BACKTICK_SPAN_REGEX.lastIndex = 0;
  const paths = [...pathCell.matchAll(BACKTICK_SPAN_REGEX)]
    .map((m) => m[1].trim())
    .filter((p) => p !== "");
  return paths.map((path) => ({ path, rationale, category }));
}

export interface ScopeDeclarationParse {
  status: DeclarationStatus;
  entries: ScopeDeclarationEntry[];
}

/**
 * Full read of a run artifact's `## Scope Declaration` section: the rows plus
 * whether the section was there at all. `parseScopeDeclaration` is the rows-only
 * view of the same single parse.
 */
export function parseScopeDeclarationSection(
  markdown: string,
): ScopeDeclarationParse {
  const lines = markdown.split(/\r?\n/);
  const entries: ScopeDeclarationEntry[] = [];
  let inSection = false;
  let sectionSeen = false;
  let groupCategory: ScopeCategory | null = null;

  for (const line of lines) {
    if (/^##\s+Scope Declaration\s*$/.test(line)) {
      inSection = true;
      sectionSeen = true;
      groupCategory = null;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      inSection = false;
      groupCategory = null;
      continue;
    }
    if (!inSection) continue;

    const heading = line.match(GROUP_HEADING_REGEX);
    if (heading) {
      groupCategory = asCategory(heading[1]);
      continue;
    }

    const strict =
      line.match(DECLARATION_LINE_REGEX) ?? line.match(TABLE_LINE_REGEX);
    if (strict) {
      const cat = asCategory(strict[2]);
      if (cat) {
        entries.push({
          path: strict[1].trim(),
          rationale: strict[3].trim(),
          category: cat,
        });
        continue;
      }
      // Category failed the whitelist — fall through to the tolerant forms,
      // which may read the same line differently (a backticked category cell
      // looks like a whitelist miss to the strict table regex).
    }

    const table = line.match(LOOSE_TABLE_REGEX);
    if (table) {
      const cat = asCategory(stripDecoration(table[2]));
      if (!cat) continue;
      const path = stripDecoration(table[1]);
      if (path !== "") {
        entries.push({
          path,
          rationale: stripDecoration(table[3]),
          category: cat,
        });
      }
      continue;
    }

    const bullet = line.match(LOOSE_BULLET_REGEX);
    if (bullet) entries.push(...parseLooseBullet(bullet[1], groupCategory));
  }

  const status: DeclarationStatus = !sectionSeen
    ? "missing"
    : entries.length > 0
      ? "parsed"
      : "unreadable";

  return { status, entries };
}

export function parseScopeDeclaration(markdown: string): ScopeDeclarationEntry[] {
  return parseScopeDeclarationSection(markdown).entries;
}

// ---------------------------------------------------------------------------
// Declaration matcher (issue #90)
//
// `git diff --name-only` emits repo-root-relative paths; workers write paths
// relative to the sub-project they were working in, and abbreviate long ones.
// An exact string compare therefore missed 55% of the files it flagged. Three
// layers, in order:
//
//   A. normalize   — strip leading `./` and `/` from both sides.
//   B. prefix set  — a row may cross a directory boundary only through a
//                    prefix that a DIFFERENT row in the same declaration
//                    attested by segment-anchored tail match. A prefix SET, not
//                    one prefix: a worker can legitimately span two sub-projects
//                    in one run. This is deliberately stricter than free-form
//                    suffix matching — a lone row `index.ts` cannot absorb
//                    `deep/nested/index.ts` on its own say-so.
//   C. ellipsis    — `.../a/b.ts` and `docs/adr/0055-...md` both occur. Split
//                    on `...`, require the surviving fragments in order,
//                    anchored at whichever end the row did not elide.
//
// Ties resolve toward `in_scope` and record a diagnostic; measured at 0/3804
// forward and 1/3269 reverse collisions across the corpus, so no tie-break
// machinery. Lives beside `matchesGlob` so a future swap stays one file.
// ---------------------------------------------------------------------------

export interface DeclarationResolver {
  resolve(file: string): ScopeDeclarationEntry | undefined;
  readonly diagnostics: string[];
}

function normalizePath(p: string): string {
  let s = p.trim();
  while (s.startsWith("./") || s.startsWith("/")) {
    s = s.startsWith("./") ? s.slice(2) : s.slice(1);
  }
  return s;
}

function matchesEllipsis(target: string, row: string): boolean {
  const parts = row.split("...");
  const fragments = parts.filter((p) => p !== "");
  if (fragments.length === 0) return false;
  const headAnchored = parts[0] !== "";
  const tailAnchored = parts[parts.length - 1] !== "";

  let cursor = 0;
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    const isLast = i === fragments.length - 1;
    // The tail fragment must END the path, not merely occur after the cursor —
    // a leftmost scan would reject `a...b` against `a/b/xb`.
    const at =
      isLast && tailAnchored
        ? target.length - fragment.length
        : target.indexOf(fragment, cursor);
    if (at < cursor) return false;
    if (isLast && tailAnchored && !target.endsWith(fragment)) return false;
    if (i === 0 && headAnchored && at !== 0) return false;
    cursor = at + fragment.length;
  }
  return true;
}

export function buildDeclarationResolver(
  changedFiles: string[],
  declaration: ScopeDeclarationEntry[],
): DeclarationResolver {
  const rows = declaration.map((d) => normalizePath(d.path));
  const files = changedFiles.map((f) => normalizePath(f));

  // Layer B, step 1: which rows attest which repo-root prefix. Ellipsis rows
  // cannot attest — their elided head makes the implied prefix unknowable.
  const attested = new Map<string, Set<number>>();
  for (const file of files) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === "" || row.includes("...")) continue;
      if (file === row || !file.endsWith("/" + row)) continue;
      const prefix = file.slice(0, file.length - row.length);
      let owners = attested.get(prefix);
      if (!owners) {
        owners = new Set();
        attested.set(prefix, owners);
      }
      owners.add(i);
    }
  }

  // Layer B, step 2: the prefixes each row may use. `""` is always available
  // (exact match); anything else must have been attested by another row.
  const rowPrefixes = rows.map((_, i) => {
    const usable = [""];
    for (const [prefix, owners] of attested) {
      if (owners.size > 1 || !owners.has(i)) usable.push(prefix);
    }
    return usable;
  });

  const rowMatches = (file: string, index: number): boolean => {
    const row = rows[index];
    if (row === "") return false;
    if (row === file) return true;
    if (row.includes("...")) {
      return rowPrefixes[index].some(
        (prefix) =>
          file.startsWith(prefix) &&
          matchesEllipsis(file.slice(prefix.length), row),
      );
    }
    return rowPrefixes[index].some((prefix) => prefix + row === file);
  };

  const resolved = new Map<string, ScopeDeclarationEntry>();
  const claimedBy = new Map<number, string[]>();
  const diagnostics: string[] = [];

  for (let fi = 0; fi < files.length; fi++) {
    const hits: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rowMatches(files[fi], i)) hits.push(i);
    }
    if (hits.length === 0) continue;
    if (hits.length > 1) {
      diagnostics.push(
        `[declaration] ${changedFiles[fi]} matched ${hits.length} declaration rows ` +
          `(${hits.map((i) => declaration[i].path).join(", ")}); resolved to the first`,
      );
    }
    resolved.set(files[fi], declaration[hits[0]]);
    claimedBy.set(hits[0], [...(claimedBy.get(hits[0]) ?? []), changedFiles[fi]]);
  }

  for (const [index, claimed] of claimedBy) {
    if (claimed.length > 1) {
      diagnostics.push(
        `[declaration] row \`${declaration[index].path}\` absorbed ${claimed.length} ` +
          `changed files (${claimed.join(", ")})`,
      );
    }
  }

  return {
    diagnostics,
    resolve: (file: string) => resolved.get(normalizePath(file)),
  };
}

export interface ClassifyOptions {
  changedFiles: string[];
  block: ScopeBlock;
  declaration: ScopeDeclarationEntry[];
  /**
   * Whether the worker's declaration section was present/readable. Callers that
   * only hold the parsed rows may omit it; the report then reads `parsed` when
   * rows exist and `missing` when they do not. `parseScopeDeclarationSection`
   * supplies the real answer.
   */
  declarationStatus?: DeclarationStatus;
}

export function classifyChanges(opts: ClassifyOptions): ScopeReport {
  const resolver = buildDeclarationResolver(opts.changedFiles, opts.declaration);

  const report: ScopeReport = {
    in_scope: [],
    extended: [],
    outside: [],
    declaration_status:
      opts.declarationStatus ??
      (opts.declaration.length > 0 ? "parsed" : "missing"),
    ...(resolver.diagnostics.length > 0
      ? { diagnostics: resolver.diagnostics }
      : {}),
  };

  for (const file of opts.changedFiles) {
    const denied = opts.block.deny.some((g) => matchesGlob(file, g));
    if (denied) {
      report.outside.push(file);
      continue;
    }

    const allowed = opts.block.allow.some((g) => matchesGlob(file, g));
    if (allowed) {
      report.in_scope.push(file);
      continue;
    }

    const decl = resolver.resolve(file);
    if (decl) {
      if (decl.category === "extension" || decl.category === "opportunistic") {
        report.extended.push({
          path: file,
          rationale: decl.rationale,
          category: decl.category,
        });
        continue;
      }
      if (decl.category === "declared" || decl.category === "incidental") {
        report.in_scope.push(file);
        continue;
      }
    }

    report.outside.push(file);
  }

  return report;
}
