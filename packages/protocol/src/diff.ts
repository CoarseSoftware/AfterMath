/**
 * Line diff engine (dependency-free). Produces blocks covering the entire new
 * file: context blocks (unchanged runs) and hunks (changes), with up to
 * `context` unchanged lines padded around each hunk.
 */

/** A line reference. `no` is a 1-based line number, or null for a placeholder. */
export interface LineRef {
  no: number | null;
  text: string;
}

export type Block =
  | { kind: 'context'; lines: LineRef[] }
  | {
      kind: 'hunk';
      oldLines: LineRef[];
      newLines: LineRef[];
      /** Up to `context` unchanged lines immediately before the hunk (new-side numbering). */
      contextBefore: LineRef[];
      /** Up to `context` unchanged lines immediately after the hunk. */
      contextAfter: LineRef[];
    };

interface Op {
  kind: 'same' | 'del' | 'add';
  lines: LineRef[];
}

const DP_LIMIT = 1_000_000; // max n*m cells for the full LCS DP path

function numbered(lines: string[], start: number): LineRef[] {
  return lines.map((text, i) => ({ no: start + i, text }));
}

function mergeOps(ops: Op[]): Op[] {
  const merged: Op[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.kind === op.kind) last.lines.push(...op.lines);
    else merged.push(op);
  }
  return merged;
}

/**
 * LCS line diff. Standard DP: L[i][j] = length of the longest common
 * subsequence of base[i..] and current[j..]. Backtracking emits one
 * same/del/add op per step; adjacent same-kind ops are merged.
 *
 * Backtrack preference: match > delete > insert. This keeps a changed line
 * as a del/add pair (so it renders as one modify hunk) and puts deletions
 * before insertions in ambiguous cases.
 */
function lcsDiff(base: string[], current: string[]): Op[] {
  const n = base.length;
  const m = current.length;
  if (n === 0) return m === 0 ? [] : [{ kind: 'add', lines: numbered(current, 1) }];
  if (m === 0) return [{ kind: 'del', lines: numbered(base, 1) }];

  // L has (n+1) rows of (m+1) uint32 cells; L[(n+1)(m+1)-1] = L[0][0].
  const w = m + 1;
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const nextRow = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      if (base[i] === current[j]) {
        L[row + j] = L[nextRow + j + 1] + 1;
      } else {
        L[row + j] = Math.max(L[row + j + 1], L[nextRow + j]);
      }
    }
  }

  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === current[j]) {
      out.push({ kind: 'same', lines: [{ no: j + 1, text: base[i] }] });
      i++;
      j++;
    } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) {
      out.push({ kind: 'del', lines: [{ no: i + 1, text: base[i] }] });
      i++;
    } else {
      out.push({ kind: 'add', lines: [{ no: j + 1, text: current[j] }] });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', lines: [{ no: i + 1, text: base[i] }] });
    i++;
  }
  while (j < m) {
    out.push({ kind: 'add', lines: [{ no: j + 1, text: current[j] }] });
    j++;
  }
  return mergeOps(out);
}

/**
 * Fallback for very large files (n*m above DP_LIMIT): anchor on the first
 * common line, recurse on the gaps. O(n*m) time worst case, O(1) extra
 * memory — fine for the rare giant-file case.
 */
function fallbackDiff(base: string[], current: string[]): Op[] {
  const out: Op[] = [];
  const rec = (a: string[], b: string[], aStart: number, bStart: number): void => {
    let ai = -1;
    let bi = -1;
    outer: for (let x = 0; x < a.length; x++) {
      for (let y = 0; y < b.length; y++) {
        if (a[x] === b[y]) {
          ai = x;
          bi = y;
          break outer;
        }
      }
    }
    if (ai === -1) {
      if (a.length) out.push({ kind: 'del', lines: numbered(a, aStart) });
      if (b.length) out.push({ kind: 'add', lines: numbered(b, bStart) });
      return;
    }
    rec(a.slice(0, ai), b.slice(0, bi), aStart, bStart);
    out.push({ kind: 'same', lines: [{ no: bStart + bi, text: a[ai] }] });
    rec(a.slice(ai + 1), b.slice(bi + 1), aStart + ai + 1, bStart + bi + 1);
  };
  rec(base, current, 1, 1);
  return mergeOps(out);
}

function diffOps(base: string[], current: string[]): Op[] {
  if (base.length * current.length <= DP_LIMIT) return lcsDiff(base, current);
  return fallbackDiff(base, current);
}

/**
 * Compute diff blocks for two line arrays. Hunks are padded with up to
 * `context` unchanged lines on each side; the block list always reassembles
 * to the full current file (context lines + hunk newLines).
 */
export function computeBlocks(base: string[], current: string[], context = 3): Block[] {
  const ops = diffOps(base, current);

  const blocks: Block[] = [];
  let pendingContext: LineRef[] = [];
  const flushContext = (): void => {
    if (pendingContext.length > 0) {
      blocks.push({ kind: 'context', lines: pendingContext });
      pendingContext = [];
    }
  };

  const sameOp = (i: number): LineRef[] | null =>
    ops[i]?.kind === 'same' ? ops[i].lines : null;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === 'same') {
      pendingContext.push(...op.lines);
      continue;
    }
    // Change op: pair a del with the following add into one modify hunk.
    let oldLines: LineRef[] = [];
    let newLines: LineRef[] = [];
    if (op.kind === 'del') {
      oldLines = op.lines;
      if (ops[i + 1]?.kind === 'add') {
        newLines = ops[i + 1].lines;
        i++;
      }
    } else {
      newLines = op.lines;
    }

    // Trailing padding: the first `context` lines of the following context run.
    const after = (sameOp(i + 1) ?? []).slice(0, context);
    if (after.length > 0 && ops[i + 1]?.kind === 'same') {
      (ops[i + 1] as { lines: LineRef[] }).lines = (ops[i + 1] as { lines: LineRef[] }).lines.slice(
        after.length
      );
    }

    // Leading padding: the last `context` lines of the preceding context run
    // belong to this hunk; the rest stays a plain context block.
    const lead = Math.min(context, pendingContext.length);
    const pad = pendingContext.slice(pendingContext.length - lead);
    const before = pendingContext.slice(0, pendingContext.length - lead);
    pendingContext = [];
    if (before.length > 0) blocks.push({ kind: 'context', lines: before });
    blocks.push({ kind: 'hunk', oldLines, newLines, contextBefore: pad, contextAfter: after });
  }
  flushContext();
  return blocks;
}

/**
 * Number of previous-side lines visible without scrolling in a side-by-side
 * hunk, per the After Math scroll rules:
 * - The current side always renders fully and never scrolls.
 * - If previous > 10 and previous > current: show max(current, 10) lines, scroll the rest.
 * - If current <= 10: scroll threshold is 10 lines.
 * - If current > 10 and previous > current: show up to current's length, scroll beyond.
 */
export function visibleLeftLines(oldCount: number, newCount: number): number {
  return Math.min(oldCount, Math.max(newCount, 10));
}

/**
 * Hybrid view threshold: hunks with fewer than `threshold` total changed lines
 * render stacked (inline); anything greater renders side by side.
 */
export function hunkRenderMode(
  oldCount: number,
  newCount: number,
  threshold = 5
): 'stacked' | 'side' {
  return oldCount + newCount < threshold ? 'stacked' : 'side';
}

/** Split text into lines without a trailing empty line from a final newline. */
export function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
