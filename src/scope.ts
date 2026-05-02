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

export interface ScopeReport {
  in_scope: string[];
  extended: Array<{
    path: string;
    rationale: string;
    category: "extension" | "opportunistic";
  }>;
  outside: string[];
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

export function parseScopeDeclaration(markdown: string): ScopeDeclarationEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ScopeDeclarationEntry[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/^##\s+Scope Declaration\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    const m = line.match(DECLARATION_LINE_REGEX);
    if (!m) continue;
    const cat = m[2];
    if (
      cat !== "declared" &&
      cat !== "extension" &&
      cat !== "opportunistic" &&
      cat !== "incidental"
    ) {
      continue;
    }
    entries.push({
      path: m[1].trim(),
      rationale: m[3].trim(),
      category: cat,
    });
  }

  return entries;
}

export interface ClassifyOptions {
  changedFiles: string[];
  block: ScopeBlock;
  declaration: ScopeDeclarationEntry[];
}

export function classifyChanges(opts: ClassifyOptions): ScopeReport {
  const declMap = new Map<string, ScopeDeclarationEntry>();
  for (const d of opts.declaration) declMap.set(d.path, d);

  const report: ScopeReport = { in_scope: [], extended: [], outside: [] };

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

    const decl = declMap.get(file);
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
