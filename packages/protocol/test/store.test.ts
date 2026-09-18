import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyCommit,
  ensureGitignore,
  findSessionDirs,
  listSessions,
  readSession,
  reviewFileName,
  sessionDir,
  writeJsonAtomic,
  writeManifest,
  writeFileReview,
  FileReview,
} from '../src';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'));
}

function sampleReview(p: string): FileReview {
  return {
    path: p,
    status: 'needs_review',
    comments: [],
    discussion: [],
    updatedAt: new Date().toISOString(),
  };
}

test('reviewFileName is stable and unique per path', () => {
  assert.equal(reviewFileName('src/a.ts'), reviewFileName('src/a.ts'));
  assert.notEqual(reviewFileName('src/a.ts'), reviewFileName('src/b.ts'));
  assert.match(reviewFileName('src/a.ts'), /^[0-9a-f]{12}\.json$/);
});

test('manifest and file reviews round-trip', () => {
  const repo = tmpRepo();
  const dir = sessionDir(repo, 's1');
  writeManifest(dir, {
    session: 's1',
    baseRef: 'abc123',
    summary: 'Did a thing.',
    submittedAt: '2026-01-01T00:00:00.000Z',
    submission: 1,
    files: ['src/a.ts'],
    agent: 'claude-code',
  });
  writeFileReview(dir, sampleReview('src/a.ts'));

  const s = readSession(dir);
  assert.ok(s);
  assert.equal(s.manifest.session, 's1');
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0].path, 'src/a.ts');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('findSessionDirs finds nested sessions and skips node_modules', () => {
  const root = tmpRepo();
  const repo = path.join(root, 'repo1');
  const dir = sessionDir(repo, 's1');
  writeManifest(dir, {
    session: 's1',
    baseRef: 'x',
    summary: 's',
    submittedAt: '2026-01-01T00:00:00.000Z',
    submission: 1,
    files: [],
    agent: 'a',
  });
  // a session inside node_modules must NOT be found
  const nm = path.join(root, 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  writeJsonAtomic(path.join(nm, 'manifest.json'), { session: 'nm' });

  assert.deepEqual(findSessionDirs(root), [dir]);
  const sessions = listSessions([root]);
  assert.equal(sessions.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('applyCommit accepts all files and records commit options in the manifest', () => {
  const repo = tmpRepo();
  const dir = sessionDir(repo, 's2');
  writeManifest(dir, {
    session: 's2',
    baseRef: 'abc123',
    summary: 'Did things.',
    submittedAt: '2026-01-01T00:00:00.000Z',
    submission: 1,
    files: ['src/a.ts', 'src/b.ts'],
    agent: 'claude-code',
  });
  const frA = sampleReview('src/a.ts');
  frA.status = 'rejected';
  frA.ready = true;
  const frB = sampleReview('src/b.ts');
  frB.ready = true;
  writeFileReview(dir, frA);
  writeFileReview(dir, frB);

  const session = readSession(dir);
  assert.ok(session);
  const n = applyCommit(dir, session, { mode: 'pr', branch: 'feature/x', squash: true }, '2026-01-02T00:00:00.000Z');
  assert.equal(n, 2);

  const after = readSession(dir);
  assert.ok(after);
  assert.ok(after.files.every((f) => f.status === 'accepted' && f.ready === false));
  assert.deepEqual(after.manifest.commit, { mode: 'pr', branch: 'feature/x', squash: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('ensureGitignore adds entry once', () => {
  const repo = tmpRepo();
  ensureGitignore(repo);
  let gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.match(gi, /\.aftermath\//);
  ensureGitignore(repo); // idempotent
  gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.equal(gi.split('\n').filter((l) => l.trim() === '.aftermath/').length, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});
