import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  Block,
  computeBlocks,
  hunkRenderMode,
  toLines,
  visibleLeftLines,
} from '../src/diff';

/** Reassemble the new file from blocks: context + hunk padding/newLines. */
function newFileFrom(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'context') out.push(...b.lines.map((l) => l.text));
    else
      out.push(
        ...b.contextBefore.map((l) => l.text),
        ...b.newLines.map((l) => l.text),
        ...b.contextAfter.map((l) => l.text)
      );
  }
  return out;
}

function reassembleOld(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'context') out.push(...b.lines.map((l) => l.text));
    else
      out.push(
        ...b.contextBefore.map((l) => l.text),
        ...b.oldLines.map((l) => l.text),
        ...b.contextAfter.map((l) => l.text)
      );
  }
  return out;
}

test('identical files produce a single context block', () => {
  const a = ['x', 'y', 'z'];
  const blocks = computeBlocks(a, a);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'context');
  assert.deepEqual(newFileFrom(blocks), a);
});

test('new file is one add hunk', () => {
  const blocks = computeBlocks([], ['a', 'b']);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'hunk');
  const h = blocks[0] as Extract<Block, { kind: 'hunk' }>;
  assert.deepEqual(h.oldLines, []);
  assert.deepEqual(h.newLines.map((l) => l.no), [1, 2]);
});

test('deleted file is one del hunk', () => {
  const blocks = computeBlocks(['a', 'b'], []);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'hunk');
  const h = blocks[0] as Extract<Block, { kind: 'hunk' }>;
  assert.deepEqual(h.newLines, []);
  assert.equal(h.oldLines.length, 2);
});

test('modify pairs a del and add into one hunk with context', () => {
  const base = ['1', '2', '3', '4', '5'];
  const current = ['1', '2X', '3', '4', '5'];
  const blocks = computeBlocks(base, current, 3);
  // the whole file fits in one hunk block with before/after padding
  assert.equal(blocks.length, 1);
  const h = blocks[0] as Extract<Block, { kind: 'hunk' }>;
  assert.deepEqual(h.contextBefore.map((l) => l.text), ['1']);
  assert.deepEqual(h.oldLines.map((l) => l.text), ['2']);
  assert.deepEqual(h.newLines.map((l) => l.text), ['2X']);
  assert.deepEqual(h.newLines[0].no, 2);
  assert.deepEqual(h.oldLines[0].no, 2);
  assert.deepEqual(h.contextAfter.map((l) => l.text), ['3', '4', '5']);
  assert.deepEqual(newFileFrom(blocks), current);
  assert.deepEqual(reassembleOld(blocks), base);
});

test('new file line numbers are continuous across blocks', () => {
  const base = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const current = base.map((l, i) => (i === 9 ? 'CHANGED' : l));
  const blocks = computeBlocks(base, current, 3);
  const nos: number[] = [];
  for (const b of blocks) {
    if (b.kind === 'context') nos.push(...b.lines.map((l) => l.no as number));
    else
      nos.push(
        ...b.contextBefore.map((l) => l.no as number),
        ...b.newLines.map((l) => l.no as number),
        ...b.contextAfter.map((l) => l.no as number)
      );
  }
  assert.deepEqual(nos, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('distant changes produce separate hunks capped at context lines', () => {
  const base = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
  const current = base.slice();
  current[4] = 'A';
  current[30] = 'B';
  const blocks = computeBlocks(base, current, 3);
  const hunks = blocks.filter((b) => b.kind === 'hunk');
  assert.equal(hunks.length, 2);
  // hunk padding is capped at `context` on each side
  for (const b of hunks as Extract<Block, { kind: 'hunk' }>[]) {
    assert.ok(b.contextBefore.length <= 3);
    assert.ok(b.contextAfter.length <= 3);
  }
  assert.deepEqual(newFileFrom(blocks), current);
  assert.deepEqual(reassembleOld(blocks), base);
});

test('visibleLeftLines implements the scroll rules', () => {
  // previous > 10 and previous > current -> max(current, 10)
  assert.equal(visibleLeftLines(25, 3), 10);
  assert.equal(visibleLeftLines(25, 15), 15);
  // current <= 10 -> threshold 10
  assert.equal(visibleLeftLines(15, 8), 10);
  assert.equal(visibleLeftLines(10, 8), 10); // nothing to scroll
  // previous <= current -> no scroll
  assert.equal(visibleLeftLines(4, 9), 4);
  assert.equal(visibleLeftLines(12, 12), 12);
});

test('hunkRenderMode hybrid threshold', () => {
  assert.equal(hunkRenderMode(1, 1), 'stacked'); // 2 < 5
  assert.equal(hunkRenderMode(2, 2), 'stacked'); // 4 < 5
  assert.equal(hunkRenderMode(3, 2), 'side'); // 5
  assert.equal(hunkRenderMode(1, 5), 'side'); // 6 > 5
});

test('toLines handles CRLF, CR and trailing newline', () => {
  assert.deepEqual(toLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(toLines('a\rb'), ['a', 'b']);
  assert.deepEqual(toLines(''), []);
});
