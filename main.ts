// mend: one patch tool for every AI edit format.
//
// mend applies an edit that an AI model wrote to a tree of text files. The
// edit arrives in one of four formats — a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool
// calls as JSON — and mend reads all four to the specification in SPEC.md:
// it finds the lines an edit names even when their whitespace or indentation
// drifted, and it changes every file or none.
//
// Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with
// the working directory as the root of the tree. Node 22 and its standard
// library alone; nothing is installed before it runs.
//
// When MAKEFUN_ENV_URL is set, this file hands a trial over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the patch cannot be used at all. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Trailing spaces and tabs removed. */
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
/** Leading and trailing spaces and tabs removed. */
const trimST = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
/** The leading spaces and tabs of a line. */
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

/** Split a file's text at its own line break (CRLF when its first line feed follows a carriage return, LF otherwise). */
function parseFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

/** Write a file's lines back with its own break, and a final one exactly when it ended with one. A file of no lines is written empty. */
function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** One line of an edit's old or new side: a context line, a removed line, or an added line. */
interface EditLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line (unified diffs only). */
  noNL: boolean;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndST(s);
  return trimST(s);
}

/**
 * Positions where O occurs in lines at one tier, at or after `from`; with
 * eofOnly, only occurrences that end at the file's last line. Occurrences may
 * overlap.
 */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const want = o.map((s) => normLine(s, tier));
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, and its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(lines, o, tier, from, eofOnly);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * The lines N writes when it replaces O at position `pos`: a context line is
 * written as the file's own matched line, never the patch's. At tier 2 every
 * other line is re-indented: the leading spaces and tabs of O's first line
 * are replaced by those of the file's first matched line, where the line
 * starts with them.
 */
function buildReplacement(o: EditLine[], n: EditLine[], fileLines: string[], pos: number, tier: number): string[] {
  const ctxO: number[] = [];
  o.forEach((it, idx) => {
    if (it.kind === 'ctx') ctxO.push(idx);
  });
  const p = o.length > 0 ? leadST(o[0]!.text) : '';
  const f = pos < fileLines.length ? leadST(fileLines[pos]!) : '';
  let ci = 0;
  return n.map((it) => {
    if (it.kind === 'ctx') {
      const oi = ctxO[ci]!;
      ci += 1;
      return fileLines[pos + oi]!;
    }
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return it.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as old/new pairs, for the R lines. */
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  noteMove(old: string, nw: string): void {
    this.moves.push({ old, nw });
  }
}

type Edit = (tree: Tree) => void;

/**
 * Apply a section's hunks, in order, each to the result of the ones before
 * it. A hunk whose old lines are not empty takes the occurrence nearest to
 * its old line number (adjusted for the length change of the hunks before
 * it); an empty one inserts after that many lines. When the matched lines
 * run to the end of the file, the result ends with a line break unless a `\`
 * line follows the hunk's last context or `+` line; otherwise the file's
 * final break stays as it was.
 */
function applyHunks(doc: FileDoc, hunks: Array<{ a: number; items: EditLine[] }>, strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  let final = doc.final;
  let d = 0;
  for (const hunk of hunks) {
    const oItems = hunk.items.filter((it) => it.kind !== 'new');
    const nItems = hunk.items.filter((it) => it.kind !== 'old');
    const o = oItems.map((it) => it.text);
    let lastNoNL = false;
    for (let k = hunk.items.length - 1; k >= 0; k -= 1) {
      const it = hunk.items[k]!;
      if (it.kind !== 'old') {
        lastNoNL = it.noNL;
        break;
      }
    }
    if (o.length === 0) {
      const pos = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const atEnd = pos === lines.length;
      const added = nItems.map((it) => it.text);
      lines.splice(pos, 0, ...added);
      if (atEnd) final = !lastNoNL;
      d += added.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const replacement = buildReplacement(oItems, nItems, lines, best, found.tier);
    const runsToEnd = best + o.length === lines.length;
    lines.splice(best, o.length, ...replacement);
    if (runsToEnd) final = !lastNoNL;
    d += replacement.length - o.length;
  }
  return { br: doc.br, lines, final };
}

/** Detect the patch's format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UniHunk {
  a: number;
  items: EditLine[];
}

interface UniSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters, up to the first tab, with surrounding spaces removed. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/**
 * A hunk header line. The spec's form is `@@ -A[,B] +C[,D] @@`, optionally
 * followed by text, so the match is on that prefix alone: whatever follows
 * the closing `@@` is the hunk's trailing text, whether or not a space
 * separates it.
 */
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk header line, or a parse error at its line. Only its old start line is used. */
function parseHunkHeader(line: string, lineNo: number): number {
  const m = HUNK_HEAD.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

/**
 * A hunk's body: the lines after its header that start with ` `, `-`, `+` or
 * `\`, or are empty (an empty line is a context line whose text is empty).
 * The body ends at the first other line, at a `diff --git ` line, at a `--- `
 * line followed by a `+++ ` line, or at the end of the patch; empty lines at
 * the end of a body are not part of it. A `\` line marks the body line
 * before it.
 */
function parseHunkBody(lines: string[], start: number): { items: EditLine[]; next: number } {
  const raw: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l === '' || l[0] === ' ' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      i += 1;
      continue;
    }
    if (l[0] === '-') {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      raw.push(l);
      i += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const items: EditLine[] = [];
  for (const l of raw) {
    if (l === '') items.push({ kind: 'ctx', text: '', noNL: false });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), noNL: false });
    else if (l[0] === '-') items.push({ kind: 'old', text: l.slice(1), noNL: false });
    else if (l[0] === '+') items.push({ kind: 'new', text: l.slice(1), noNL: false });
    else if (items.length > 0) items[items.length - 1]!.noNL = true;
  }
  return { items, next: i };
}

/** Read a unified diff as its sections' edits. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'none' | 'header' | 'after' = 'none';
  const startSection = (gitOld?: string, gitNew?: string): void => {
    cur = {
      gitOld,
      gitNew,
      dashOld: undefined,
      dashNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(cur);
    state = 'header';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null) {
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]!);
      } else {
        startSection();
        cur!.dashOld = dashPath(line);
        cur!.dashNew = dashPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.dashNew = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i + 1);
        const body = parseHunkBody(lines, i + 1);
        cur.hunks.push({ a, items: body.items });
        state = 'after';
        i = body.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (state === 'none' || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line, i + 1);
      const body = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a, items: body.items });
      state = 'after';
      i = body.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified section as one edit: a creation, a deletion, a move, or a change. */
function unifiedEdit(s: UniSection, strict: boolean): Edit {
  const oldRaw = s.dashOld !== undefined ? s.dashOld : s.renameOld !== undefined ? s.renameOld : s.gitOld;
  const newRaw = s.dashNew !== undefined ? s.dashNew : s.renameNew !== undefined ? s.renameNew : s.gitNew;
  const oldPath = oldRaw === undefined ? null : oldRaw;
  const newPath = newRaw === undefined ? null : newRaw;
  if (oldPath === null || s.newFile) {
    // A creation: the new path does not exist; the file is the `+` lines of all its hunks.
    // A created file ends with a line break unless a `\` line follows its last `+` line.
    return (tree) => {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const added: string[] = [];
      let lastNoNL = false;
      let anyNew = false;
      for (const hunk of s.hunks) {
        for (const it of hunk.items) {
          if (it.kind === 'new') {
            added.push(it.text);
            lastNoNL = it.noNL;
            anyNew = true;
          }
        }
      }
      tree.now.set(newPath, !anyNew ? '' : `${added.join('\n')}${lastNoNL ? '' : '\n'}`);
    };
  }
  if (newPath === null || s.deletedFile) {
    // A deletion: the old path exists; it is deleted, and its hunks are not read.
    return (tree) => {
      if (oldPath === null) throw new Fail('missing', '/dev/null');
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    // A move: the old path exists, the new path does not; the hunks apply to the old file's lines.
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(parseFile(cur), s.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, renderFile(out));
      tree.noteMove(oldPath, newPath);
    };
  }
  // Otherwise a change of the one path, which exists.
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    const out = applyHunks(parseFile(cur), s.hunks, strict, oldPath);
    tree.now.set(oldPath, renderFile(out));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

/** Read SEARCH/REPLACE blocks as edits, in the patch's order. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as one edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // Empty old lines create the file with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseFile(cur);
    const found = findTier(doc.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const oItems: EditLine[] = oldLines.map((text) => ({ kind: 'old' as const, text, noNL: false }));
    const nItems: EditLine[] = newLines.map((text) => ({ kind: 'new' as const, text, noNL: false }));
    const replacement = buildReplacement(oItems, nItems, doc.lines, pos, found.tier);
    const out = [...doc.lines];
    out.splice(pos, oldLines.length, ...replacement);
    tree.now.set(path, renderFile({ br: doc.br, lines: out, final: doc.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  body: Array<{ text: string; no: number }>;
}

interface V4aChunk {
  anchor: string | null;
  items: EditLine[];
  eof: boolean;
}

/** Read a V4A patch as its sections' edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const body: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, no: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section (before the next section or *** End Patch) are not part of it.
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    sections.push({ kind, path, headerLine: i + 1, body });
    i = j;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') edits.push(v4aAddEdit(s));
    else if (s.kind === 'delete') edits.push(v4aDeleteEdit(s));
    else edits.push(v4aUpdateEdit(s, strict));
  }
  return edits;
}

/** An Add File section: the file is the section's lines, ended by a line break. */
function v4aAddEdit(s: V4aSection): Edit {
  const added: string[] = [];
  for (const b of s.body) {
    if (b.text === '') added.push('');
    else if (b.text[0] === '+') added.push(b.text.slice(1));
    else throw new Exit2(`error: parse ${b.no}`);
  }
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
    tree.now.set(s.path, added.length === 0 ? '' : `${added.join('\n')}\n`);
  };
}

/** A Delete File section has no lines. */
function v4aDeleteEdit(s: V4aSection): Edit {
  if (s.body.length > 0) throw new Exit2(`error: parse ${s.body[0]!.no}`);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (tree.get(s.path) === null) throw new Fail('missing', s.path);
    tree.now.set(s.path, null);
  };
}

const isV4aBodyLine = (t: string): boolean => t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+';

/** An Update File section as one edit: its chunks apply in order, with a cursor that starts at line 0. */
function v4aUpdateEdit(s: V4aSection, strict: boolean): Edit {
  const body = s.body;
  let idx = 0;
  let moveTo: string | undefined;
  // Blank lines before the first chunk (or the Move to line) are not part of the section.
  while (idx < body.length && blank(body[idx]!.text)) idx += 1;
  if (idx < body.length && body[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = body[idx]!.text.slice(13).trim();
    idx += 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (; idx < body.length; idx += 1) {
    const { text, no } = body[idx]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      chunks.push(cur);
    } else if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
    } else if (isV4aBodyLine(text)) {
      if (cur === null) {
        if (blank(text)) continue;
        if (chunks.length === 0) {
          cur = { anchor: null, items: [], eof: false };
          chunks.push(cur);
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (text === '') cur.items.push({ kind: 'ctx', text: '', noNL: false });
      else if (text[0] === ' ') cur.items.push({ kind: 'ctx', text: text.slice(1), noNL: false });
      else if (text[0] === '-') cur.items.push({ kind: 'old', text: text.slice(1), noNL: false });
      else cur.items.push({ kind: 'new', text: text.slice(1), noNL: false });
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${s.headerLine}`);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(s.path);
    if (curText === null) throw new Fail('missing', s.path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseFile(curText);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(lines, [chunk.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.occ[0]! + 1;
      }
      const oItems = chunk.items.filter((it) => it.kind !== 'new');
      const nItems = chunk.items.filter((it) => it.kind !== 'old');
      const o = oItems.map((it) => it.text);
      if (o.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        const added = nItems.map((it) => it.text);
        lines.splice(pos, 0, ...added);
        cursor = pos + added.length;
      } else {
        const found = findTier(lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.occ[0]!;
        const replacement = buildReplacement(oItems, nItems, lines, pos, found.tier);
        lines.splice(pos, o.length, ...replacement);
        cursor = pos + replacement.length;
      }
    }
    const out = renderFile({ br: doc.br, lines, final: doc.final });
    if (moveTo !== undefined) {
      tree.now.set(s.path, null);
      tree.now.set(moveTo, out);
      tree.noteMove(s.path, moveTo);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const out = [...doc.lines];
      out.splice(line, 0, ...add);
      tree.now.set(p, renderFile({ br: doc.br, lines: out, final: doc.final }));
    };
  }
  return null;
}

/** A JSON patch: one array of edit objects, or JSON Lines with one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rows: Array<{ key: string; line: string }> = [];
  const moved = new Set<string>();
  for (const mv of tree.moves) {
    // A move prints R old -> new, sorted by new, instead of its D and A lines — but only when the old path
    // existed before the patch and does not after it, and the new path did not exist before it and does after it.
    if (tree.original(mv.old) !== null && tree.original(mv.nw) === null && tree.get(mv.old) === null && tree.get(mv.nw) !== null) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      moved.add(mv.old);
      moved.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
