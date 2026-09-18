import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { toLines } from '@aftermath/protocol';

/**
 * Read the previous-side content of a file: `git show <baseRef>:<path>`.
 * Returns null when the file did not exist at baseRef (i.e. it is new).
 */
export function getBaseLines(
  repoRoot: string,
  baseRef: string,
  filePath: string
): Promise<string[] | null> {
  const gitPath = filePath.split(path.sep).join('/');
  return new Promise((resolve) => {
    execFile(
      'git',
      ['show', `${baseRef}:${gitPath}`],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // 128 = git usage/rev error -> file not present at baseRef (new file)
          resolve(null);
          return;
        }
        resolve(toLines(stdout));
      }
    );
  });
}

/** Read the current-side content from the working tree. Returns [] when deleted. */
export function getCurrentLines(repoRoot: string, filePath: string): string[] {
  try {
    return toLines(fs.readFileSync(path.join(repoRoot, filePath), 'utf8'));
  } catch {
    return [];
  }
}
