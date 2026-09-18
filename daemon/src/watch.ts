import { Session, isSessionFinalized, listSessions } from '@aftermath/protocol';
import { DaemonConfig, SessionState, loadConfig, loadState, saveState } from './config';
import { notify } from './notify';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Notification-only watcher. The fix/fix-resubmit/finalize loop runs inside the
 * agent's own session (the skill's waiter script blocks there); the daemon's
 * only job is to alert the human about new review work and its completion.
 */
function tick(cfg: DaemonConfig, state: Record<string, SessionState>): boolean {
  const sessions = listSessions(cfg.projectRoots);
  let changed = false;

  for (const s of sessions) {
    const key = s.dir;
    const st: SessionState = state[key] ?? { submission: 0, announcedFinalized: false };

    // New session or re-submission: notify the human to review.
    if (s.manifest.submission > st.submission) {
      const isNew = st.submission === 0;
      if (cfg.toast) {
        void notify(
          isNew ? 'After Math: code review ready' : `After Math: review re-submitted (round ${s.manifest.submission})`,
          `${s.manifest.summary} (${s.manifest.files.length} file(s))`,
          cfg.sound
        );
      }
      st.submission = s.manifest.submission;
      st.announcedFinalized = false;
      changed = true;
    }

    // Full acceptance: the agent finalizes in its own session; let the human know.
    if (isSessionFinalized(s) && !st.announcedFinalized) {
      if (cfg.toast) {
        void notify('After Math: review accepted', `The agent will commit and open a PR for: ${s.manifest.summary}`, cfg.sound);
      }
      st.announcedFinalized = true;
      changed = true;
    }

    state[key] = st;
  }

  // Drop state for sessions whose folders were cleaned up.
  const existing = new Set(sessions.map((s) => s.dir));
  for (const k of Object.keys(state)) {
    if (!existing.has(k)) delete state[k];
  }

  return changed;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const state = loadState();
  console.log('[after-math] daemon starting (notifications only)');
  console.log(`[after-math] watching: ${cfg.projectRoots.join(', ')}`);
  console.log(`[after-math] poll interval: ${cfg.pollIntervalMs}ms`);
  for (;;) {
    try {
      if (tick(cfg, state)) saveState(state);
    } catch (err) {
      console.error('[after-math] tick error:', err);
    }
    await sleep(cfg.pollIntervalMs);
  }
}

void main();
