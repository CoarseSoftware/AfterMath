import * as fs from 'fs';
import * as path from 'path';

export interface DaemonConfig {
  /** Directories scanned (shallow) for .aftermath/reviews sessions. */
  projectRoots: string[];
  pollIntervalMs: number;
  toast: boolean;
  sound: boolean;
}

const DEFAULTS: DaemonConfig = {
  projectRoots: [],
  pollIntervalMs: 5000,
  toast: true,
  sound: true,
};

/** Load daemon config: $AFTER_MATH_CONFIG or <repo>/daemon/config.json, over defaults. */
export function loadConfig(): DaemonConfig {
  const file =
    process.env.AFTER_MATH_CONFIG ?? path.join(__dirname, '..', 'config.json');
  let user: Partial<DaemonConfig> = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaemonConfig>;
  } catch {
    /* use defaults */
  }
  const cfg: DaemonConfig = { ...DEFAULTS, ...user };
  if (cfg.projectRoots.length === 0) {
    cfg.projectRoots = [path.join(process.env.USERPROFILE ?? '', 'source', 'repos')];
  }
  return cfg;
}

/** Load persisted daemon state (last-seen session info). */
export function loadState(): Record<string, SessionState> {
  const file = process.env.AFTER_MATH_STATE ?? path.join(__dirname, '..', '.state.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SessionState>;
  } catch {
    return {};
  }
}

export function saveState(state: Record<string, SessionState>): void {
  const file = process.env.AFTER_MATH_STATE ?? path.join(__dirname, '..', '.state.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Last-seen info per session directory (notification dedup only). */
export interface SessionState {
  /** Last submission round we notified about. */
  submission: number;
  /** True once the "review accepted" notification was sent. */
  announcedFinalized: boolean;
}
