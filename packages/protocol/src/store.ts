import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CommitOptions, FileReview, Manifest, Session, hasOpenFeedback } from './types';

const AFTERMATH_DIR = '.aftermath';
const REVIEWS_DIR = 'reviews';

/** Absolute path of the session folder for a project repo. */
export function sessionDir(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, AFTERMATH_DIR, REVIEWS_DIR, sessionId);
}

/** File name for a changed file's review JSON: <sha1(path)>.json */
export function reviewFileName(filePath: string): string {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12) + '.json';
}

export function reviewFilePath(session: string, filePath: string): string {
  return path.join(session, reviewFileName(filePath));
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readManifest(session: string): Manifest | null {
  return readJson<Manifest>(path.join(session, 'manifest.json'));
}

export function writeManifest(session: string, manifest: Manifest): void {
  writeJsonAtomic(path.join(session, 'manifest.json'), manifest);
}

export function readFileReview(session: string, filePath: string): FileReview | null {
  return readJson<FileReview>(reviewFilePath(session, filePath));
}

export function writeFileReview(session: string, fr: FileReview): void {
  writeJsonAtomic(reviewFilePath(session, fr.path), fr);
}

/**
 * Session-level "Request revision": mark every file that has open feedback
 * (unresolved comments or unanswered discussion) `rejected` and release it
 * (`ready: true`) so the agent's waiter wakes for all of them. Files without
 * open feedback are untouched. Returns the number of files released.
 */
export function applyRequestRevision(
  sessionDir: string,
  session: Session,
  updatedAt: string
): number {
  let released = 0;
  for (const fr of session.files) {
    if (!hasOpenFeedback(fr)) continue;
    fr.status = 'rejected';
    fr.ready = true;
    fr.updatedAt = updatedAt;
    writeFileReview(sessionDir, fr);
    released += 1;
  }
  return released;
}

/**
 * Session-level "Commit changes": mark every file in the session `accepted`
 * (clearing any stale `ready`) and record the human's commit options (local
 * commit vs pull request, optional new branch, squash) in the manifest so
 * the agent knows how to finalize. Returns the number of files accepted.
 */
export function applyCommit(
  sessionDir: string,
  session: Session,
  commit: CommitOptions,
  updatedAt: string
): number {
  let accepted = 0;
  for (const fr of session.files) {
    fr.status = 'accepted';
    fr.ready = false;
    // The agent's changes are now accepted — drop the "changed by agent" flag.
    fr.agentTouched = false;
    fr.updatedAt = updatedAt;
    writeFileReview(sessionDir, fr);
    accepted += 1;
  }
  session.manifest.commit = commit;
  writeManifest(sessionDir, session.manifest);
  return accepted;
}

/**
 * Find session directories under a root by shallowly scanning for
 * `.aftermath/reviews/<session>/manifest.json` (up to `maxDepth` directories
 * deep). Hidden directories and node_modules are skipped.
 */
export function findSessionDirs(root: string, maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const reviews = path.join(dir, AFTERMATH_DIR, REVIEWS_DIR);
    if (fs.existsSync(reviews)) {
      for (const e of safeReaddir(reviews)) {
        const s = path.join(reviews, e.name);
        if (e.isDirectory() && fs.existsSync(path.join(s, 'manifest.json'))) {
          out.push(s);
        }
      }
    }
    if (depth < maxDepth) {
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Read a full session (manifest + per-file reviews). Returns null if unreadable. */
export function readSession(sessionDirPath: string): Session | null {
  const manifest = readManifest(sessionDirPath);
  if (!manifest) return null;
  const files: FileReview[] = [];
  for (const p of manifest.files) {
    const fr = readFileReview(sessionDirPath, p);
    if (fr) files.push(fr);
  }
  return { dir: sessionDirPath, manifest, files };
}

/** List sessions under the given roots (de-duplicated, sorted by submittedAt desc). */
export function listSessions(roots: string[], maxDepth = 2): Session[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const root of roots) {
    for (const d of findSessionDirs(root, maxDepth)) {
      // Windows paths: compare case-insensitively and drop any trailing
      // separator, or the same session found via an overlapping root
      // (e.g. a watched C:\...\repos and an open workspace C:\...\repos\X)
      // appears twice.
      const key = path.resolve(d).replace(/[\\/]+$/, '').toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        dirs.push(d);
      }
    }
  }
  const sessions: Session[] = [];
  for (const d of dirs) {
    const s = readSession(d);
    if (s) sessions.push(s);
  }
  sessions.sort((a, b) => b.manifest.submittedAt.localeCompare(a.manifest.submittedAt));
  return sessions;
}

/**
 * Ensure `.aftermath/` is gitignored in the given repo. If the repo has no
 * .gitignore yet, creates one. Never edits other lines.
 */
export function ensureGitignore(repoRoot: string): void {
  const gi = path.join(repoRoot, '.gitignore');
  const entry = '.aftermath/';
  let content = '';
  try {
    content = fs.readFileSync(gi, 'utf8');
  } catch {
    /* no .gitignore yet */
  }
  const lines = content.split(/\r?\n/);
  if (lines.some((l) => l.trim() === entry || l.trim() === '.aftermath')) return;
  const next = (content.endsWith('\n') || content === '' ? content : content + '\n') + entry + '\n';
  fs.writeFileSync(gi, next, 'utf8');
}
