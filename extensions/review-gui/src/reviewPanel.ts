import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Block,
  CommitOptions,
  FileReview,
  Manifest,
  ReviewComment,
  applyCommit,
  applyRequestRevision,
  computeBlocks,
  hasOpenFeedback,
  readSession,
  readFileReview,
  sessionHasOpenFeedback,
  writeFileReview,
} from '@aftermath/protocol';
import * as fs from 'fs';
import { getBaseLines, getCurrentLines } from './git';
import { isSupported, lookup } from './languages';

export type LayoutMode = 'unified' | 'side' | 'hybrid';

export interface ReviewData {
  fileName: string;
  sessionDir: string;
  file: FileReview;
  blocks: Block[];
  author: string;
  hybridThreshold: number;
  /** Global layout preference (shared by every review panel). */
  layoutMode: LayoutMode;
  /** Added/removed line counts for THIS file. */
  fileStats: { added: number; removed: number };
  /** Added/removed line counts across ALL files in the session. */
  sessionStats: { added: number; removed: number };
  /** Files accepted so far / total files in the session. */
  fileCounts: { accepted: number; total: number };
  /** Does THIS session (any file) still have open feedback? */
  sessionOpen: boolean;
  /** The code reviewer (AI agent) that submitted this session — used to tag
   *  discussion entries with a "Reviewer" / "You" indicator. */
  sessionAgent: string;
}

const panels = new Map<string, vscode.WebviewPanel>();
/** Reverse of {@link panels}: panel -> its sessionDir::filePath key (needed
 *  when a reused tab is handed over to a different file). */
const panelKeys = new Map<vscode.WebviewPanel, string>();
function tabKeyOf(panel: vscode.WebviewPanel): string {
  return panelKeys.get(panel) ?? '';
}
/** Live generation (send/watchers) of a panel — disposed on handover to a
 *  new file and on close. */
const generations = new Map<vscode.WebviewPanel, { dispose: () => void }>();
/**
 * The un-posted discussion draft per panel (mirrored from the webview on
 * every change). The extension API cannot cancel a webview panel's dispose,
 * so on tab close the host uses this to warn the user and offer to restore
 * the text (see the onDidDispose guard in openReviewPanel).
 */
const panelDrafts = new Map<vscode.WebviewPanel, string>();
/** One-shot draft restore: panel -> text placed into the discussion box when
 *  the webview's script announces readiness (a fresh panel's script may not
 *  be live when the restore is requested). */
const pendingRestores = new Map<vscode.WebviewPanel, string>();
let onSessionsChanged: (() => void) | undefined;

/**
 * The ONE reused review tab. Clicking a file in the left panel swaps this
 * tab's file instead of opening a new editor tab; holding shift (flagged via
 * the `afterMath.flagShift` keybinding) opens a fresh tab instead.
 */
let reviewTabPanel: vscode.WebviewPanel | undefined;

/**
 * One-shot round-trip into a webview: post `msg`, resolve with the `value`
 * of the next `{ type: 'reply', id }` message (undefined if the panel goes
 * away first or nothing comes back within `timeoutMs`).
 */
function askWebview<T = unknown>(
  panel: vscode.WebviewPanel,
  msg: Record<string, unknown>,
  timeoutMs = 300
): Promise<T | undefined> {
  const id = 'q' + Math.random().toString(36).slice(2);
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let sub: vscode.Disposable | undefined;
    const finish = (v: T | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (sub) sub.dispose();
      resolve(v);
    };
    timer = setTimeout(() => finish(undefined), timeoutMs);
    sub = panel.webview.onDidReceiveMessage((m: { type?: string; id?: string; value?: T }) => {
      if (m && m.type === 'reply' && m.id === id) finish(m.value);
    });
    void panel.webview.postMessage({ ...msg, id });
  });
}

export function setSessionsChangedListener(cb: () => void): void {
  onSessionsChanged = cb;
}

/** Push a quick status update (status pill / accept button / file counts /
 *  ready state — NO diff recompute, NO session-wide git stats) into every
 *  open review panel of the given session. Used right after a status change
 *  so the UI flips instantly instead of waiting for the full data round-trip
 *  (git base read + LCS diff + per-file git stats). The counts are read
 *  straight from the session's JSON files (no git). */
export function notifyPanels(sessionDir: string): void {
  const counts = sessionFileCounts(sessionDir);
  const sessionOpen = sessionHasOpen(sessionDir);
  const prefix = sessionDir + '::';
  for (const [key, panel] of [...panels]) {
    if (!key.startsWith(prefix)) continue;
    void panel.webview.postMessage({
      type: 'quick',
      file: undefined,
      fileCounts: counts,
      sessionOpen,
    });
  }
}

function repoRootOf(sessionDir: string): string {
  return path.resolve(sessionDir, '..', '..', '..');
}

// ---------------------------------------------------------------------------
// Speed: cache the git base content (git show baseRef:<file>) per
// (repoRoot, baseRef, filePath). The base commit NEVER changes — the diff
// re-reads it on every data send AND every file-watcher refresh, which meant
// a `git show` subprocess (up to 64 MB buffer) on the critical path of every
// open/switch/refresh. One subprocess per file per extension session.
// ---------------------------------------------------------------------------
const baseCache = new Map<string, Promise<string[] | null>>();
function cachedBaseLines(repoRoot: string, baseRef: string, filePath: string): Promise<string[] | null> {
  const key = repoRoot + '\0' + baseRef + '\0' + filePath;
  let p = baseCache.get(key);
  if (!p) {
    p = getBaseLines(repoRoot, baseRef, filePath);
    baseCache.set(key, p);
  }
  return p;
}

function statsOf(blocks: Block[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const b of blocks) {
    if (b.kind === 'hunk') {
      added += b.newLines.length;
      removed += b.oldLines.length;
    }
  }
  return { added, removed };
}

/** Added/removed line counts across every file in the session. */
async function sessionStats(
  repoRoot: string,
  manifest: Manifest,
  context: number
): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;
  // The base content is CACHED per (repoRoot, baseRef, file) — the base
  // commit never changes, so a full session re-stat is a set of plain file
  // reads + LCS, with git show only the FIRST time a file is seen.
  await Promise.all(
    manifest.files.map(async (p) => {
      const base = (await cachedBaseLines(repoRoot, manifest.baseRef, p)) ?? [];
      const current = getCurrentLines(repoRoot, p);
      const s = statsOf(computeBlocks(base, current, context));
      added += s.added;
      removed += s.removed;
    })
  );
  return { added, removed };
}

/** Does this session (any file) still have open feedback? */
function sessionHasOpen(sessionDir: string): boolean {
  const session = readSession(sessionDir);
  return session ? sessionHasOpenFeedback(session) : true;
}

/** Files accepted so far vs the total in the session (per-file statuses). */
function sessionFileCounts(sessionDir: string): { accepted: number; total: number } {
  const session = readSession(sessionDir);
  if (!session) return { accepted: 0, total: 0 };
  return {
    accepted: session.files.filter((f) => f.status === 'accepted').length,
    total: session.files.length,
  };
}

function genId(prefix: string, existing: { id: string }[]): string {
  let id = '';
  do {
    id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } while (existing.some((e) => e.id === id));
  return id;
}

/**
 * Open the review for `filePath`.
 *
 * Tab policy: a plain click REUSES the single review tab (swapping its file,
 * or just re-revealing it if it already shows this file). `openInNewTab`
 * (shift-click) always opens a fresh tab. Before a different file takes over
 * the reused tab, an un-posted discussion in it is guarded — the user is
 * asked to discard it or cancel (see askWebview / 'hasUnposted').
 */
export async function openReviewPanel(
  sessionDir: string,
  manifest: Manifest,
  filePath: string,
  openInNewTab = false
): Promise<void> {
  const key = sessionDir + '::' + filePath;
  const existing = panels.get(key);
  if (existing) {
    // This file's panel is already open (e.g. from an earlier shift-click):
    // bring it forward.
    existing.reveal();
    if (!openInNewTab) reviewTabPanel = existing;
    return;
  }

  // Plain click: reuse the single review tab instead of stacking editor tabs.
  const tab = reviewTabPanel;
  if (tab && !openInNewTab) {
    if (tab.title === `Review: ${path.basename(filePath)}` && tab.viewColumn === vscode.ViewColumn.One) {
      // The reused tab already shows this file (tracked or not) — just reveal.
      tab.reveal();
      return;
    }
    // A different file is about to take over the tab: protect an un-posted
    // discussion (typed into the box but not sent to the session). The
    // webview answers directly; the host-side draft mirror is the fallback
    // when the round-trip can't complete (e.g. the tab is hidden).
    const live = await askWebview<boolean>(tab, { type: 'hasUnposted' }, 1000);
    const unposted = live === true || panelDrafts.has(tab);
    if (unposted) {
      const D = vscode.window.showErrorMessage;
      const action = await D(
        'You have an uncommitted discussion. Opening a new file will discard those changes. If you wanted to open in a new tab, hold shift while clicking.',
        { modal: true },
        'Discard discussion',
        'Cancel'
      );
      if (action !== 'Discard discussion') {
        // Cancel: keep the current file and jump to the un-posted discussion.
        tab.reveal(vscode.ViewColumn.One, true);
        void askWebview(tab, { type: 'gotoUnposted' });
        return;
      }
      void askWebview(tab, { type: 'clearUnposted' });
    }
    // The tab now shows another file: hand it over to this one. The webview
    // document is replaced (fresh script state) and createPanelContent wires
    // up the new file's data, watchers and message handler.
    const oldKey = tabKeyOf(tab);
    // The user is looking at a DIFFERENT file now: stamp this file as
    // reviewed (left-panel "discussion added" icon for the human feedback
    // left in it). The host does the write DIRECTLY — no webview round-trip:
    // the tab's document is replaced a moment later, which would race the
    // reply. (The webview's 'viewClosed' reply handler exists so a future
    // richer handshake can piggyback on this same signal.)
    if (oldKey && oldKey !== key) {
      const oldSessionDir = oldKey.slice(0, oldKey.indexOf('::'));
      const oldFile = oldKey.slice(oldKey.indexOf('::') + 2);
      void (async () => {
        try {
          const fr = readFileReview(oldSessionDir, oldFile);
          if (!fr) return;
          const nowIso = new Date().toISOString();
          fr.reviewedAt = nowIso;
          fr.updatedAt = nowIso;
          writeFileReview(oldSessionDir, fr);
          onSessionsChanged?.();
        } catch {
          /* best-effort — the icon just stays off */
        }
      })();
    }
    tab.title = `Review: ${path.basename(filePath)}`;
    if (oldKey) panels.delete(oldKey);
    panels.set(key, tab);
    panelKeys.set(tab, key);
    reviewTabPanel = tab;
    // The user clicked this file: make sure the tab is front and center.
    tab.reveal(vscode.ViewColumn.One, false);
    // The old file's draft is gone (discarded or never was) — never let it
    // resurface in the close guard for the NEW file.
    panelDrafts.delete(tab);
    void createPanelContent(tab, sessionDir, manifest, filePath);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'afterMathReview',
    `Review: ${path.basename(filePath)}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panels.set(key, panel);
  panelKeys.set(panel, key);
  if (!openInNewTab) reviewTabPanel = panel;
  panel.onDidDispose(() => {
    panels.delete(key);
    panelKeys.delete(panel);
    generations.get(panel)?.dispose();
    generations.delete(panel);
    const draft = panelDrafts.get(panel);
    panelDrafts.delete(panel);
    if (reviewTabPanel === panel) reviewTabPanel = undefined;
    // "I have looked at this file": stamp the file's review record so the
    // left panel can show the "discussion added" icon once HUMAN feedback
    // (created after the last submission) exists. The agent's own feedback
    // (initial review comments / its replies) predates this stamp, so it
    // never counts as "the human added a discussion".
    void (async () => {
      try {
        const session = readSession(sessionDir);
        const fr = session?.files.find((x) => x.path === filePath);
        if (!session || !fr) return;
        fr.reviewedAt = new Date().toISOString();
        fr.updatedAt = fr.reviewedAt;
        writeFileReview(session.dir, fr);
        onSessionsChanged?.();
      } catch {
        /* best-effort — the icon just stays off */
      }
    })();
    if (draft) {
      void (async () => {
        const action = await vscode.window.showErrorMessage(
          'The review tab was closed with an uncommitted discussion. Those changes were not posted to the session.',
          { modal: true },
          'Restore discussion',
          'OK'
        );
        if (action !== 'Restore discussion') return;
        const session = readSession(sessionDir);
        if (!session) return;
        await openReviewPanel(sessionDir, session.manifest, filePath, true);
        const p = panels.get(sessionDir + '::' + filePath);
        if (!p) return;
        // Delivered once the webview's script is live (see the 'ready'
        // handler in createPanelContent).
        pendingRestores.set(p, draft);
      })();
    }
  });
  void createPanelContent(panel, sessionDir, manifest, filePath);
}

/**
 * Wire up a (fresh or reused) review webview for one file: diff loading,
 * initial send, file watchers and the message handler. Called for every new
 * panel AND again when the reused tab is handed over to another file — the
 * webview's document (and thus its script state: comment boxes, scroll
 * position, un-posted text) is reset by the new HTML, so re-running this is
 * exactly a fresh load.
 */
async function createPanelContent(
  panel: vscode.WebviewPanel,
  sessionDir: string,
  manifest: Manifest,
  filePath: string
): Promise<void> {
  const key = sessionDir + '::' + filePath;
  const repoRoot = repoRootOf(sessionDir);
  const context = vscode.workspace
    .getConfiguration('afterMath')
    .get<number>('diffContext', 3);
  const threshold = vscode.workspace
    .getConfiguration('afterMath')
    .get<number>('hybridThreshold', 5);
  const author = os.userInfo().username;
  const layoutMode = (): LayoutMode => {
    const v = vscode.workspace
      .getConfiguration('afterMath')
      .get<string>('layoutMode', 'unified');
    return v === 'side' || v === 'hybrid' ? v : 'unified';
  };

  const load = (): FileReview =>
    readFileReview(sessionDir, filePath) ?? {
      path: filePath,
      status: 'needs_review',
      comments: [],
      discussion: [],
      updatedAt: new Date().toISOString(),
    };

  const data: ReviewData = {
    fileName: filePath,
    sessionDir,
    file: load(),
    blocks: [],
    author,
    hybridThreshold: threshold,
    layoutMode: layoutMode(),
    fileStats: { added: 0, removed: 0 },
    sessionStats: { added: 0, removed: 0 },
    fileCounts: sessionFileCounts(sessionDir),
    sessionOpen: sessionHasOpen(sessionDir),
    sessionAgent: manifest.agent ?? '',
  };
  // The diff (blocks + file stats) is recomputed on demand: it changes every
  // time the agent edits the file, so it must be re-derived, not cached.
  // The BASE side is cached (git show baseRef never changes); only the
  // working-tree read + LCS run per refresh.
  const refreshDiff = async (): Promise<void> => {
    const base = (await cachedBaseLines(repoRoot, manifest.baseRef, filePath)) ?? [];
    const cur = getCurrentLines(repoRoot, filePath);
    const blocks = computeBlocks(base, cur, context);
    data.blocks = blocks;
    data.fileStats = statsOf(blocks);
  };
  // The diff needs (first time) a git subprocess round-trip + an LCS pass —
  // don't hold the panel open on it: the webview is created FIRST (with a
  // loading state) and the data arrives a moment later. Session totals run
  // in the background the same way — and ONLY when the session changed
  // (manifest mtime), never on every keystroke of a file watcher.
  void refreshDiff().catch(() => {
    /* git hiccup — the next send will retry */
  });
  const manifestPath = path.join(sessionDir, 'manifest.json');
  let manifestMtime = 0;
  const sessionChanged = (): boolean => {
    let m = 0;
    try {
      m = fs.statSync(manifestPath).mtimeMs;
    } catch {
      m = -1;
    }
    const changed = m !== manifestMtime;
    manifestMtime = m;
    return changed;
  };
  // Per-generation guard: the reused tab may be handed over (or closed)
  // again while this load is still running — then this generation's sends
  // and watchers must go quiet. Any PREVIOUS generation on this panel is
  // cut off now, so its stale watchers can't fire on the new content.
  generations.get(panel)?.dispose();
  let disposed = false;
  let pendingSend: NodeJS.Timeout | undefined;
  let watchers: vscode.FileSystemWatcher[] = [];
  let genSub: vscode.Disposable | undefined;
  let msgSub: vscode.Disposable | undefined;
  const disposeGeneration = (): void => {
    disposed = true;
    if (pendingSend) clearTimeout(pendingSend);
    for (const w of watchers) void w.dispose();
    if (genSub) genSub.dispose();
    if (msgSub) msgSub.dispose();
  };
  generations.set(panel, { dispose: disposeGeneration });
  genSub = panel.onDidDispose(disposeGeneration);
  // Kick off the (cached) session totals in the background — only when the
  // session actually changed (manifest mtime); see sessionChanged().
  if (sessionChanged()) {
    void (async () => {
      const s = await sessionStats(repoRoot, manifest, context);
      if (disposed) return;
      data.sessionStats = s;
    })().catch(() => {
      /* git hiccup — the next send will retry */
    });
  }
  const html = buildHtml();
  // The webview script is embedded in a template literal, so tsc never checks
  // it and TypeScript-isms (e.g. `x as T`) would silently kill the panel.
  // Parse it now so any syntax error is loud instead of invisible.
  const scriptSrc = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(scriptSrc);
  panel.webview.html = html;

  // The webview's script may not be executing yet when we first post; it
  // announces readiness and we (re)send the data at that point.
  const send = async (): Promise<void> => {
    if (disposed) return;
    data.file = load();
    data.layoutMode = layoutMode();
    data.fileCounts = sessionFileCounts(sessionDir);
    data.sessionOpen = sessionHasOpen(sessionDir);
    // Re-derive the diff so the view tracks the file on disk (the agent may
    // have edited it since the last send).
    try {
      await refreshDiff();
    } catch {
      /* git hiccup — keep the previously computed blocks */
    }
    if (disposed) return;
    // Keep the session totals fresh without blocking the send — but only
    // re-stat when the SESSION actually changed (manifest mtime moved): a
    // full session stat is a file read + LCS per file, and running it on
    // every watcher tick of ONE file's working-tree change is what made
    // opening/switching files feel slow.
    if (sessionChanged()) {
      void sessionStats(repoRoot, manifest, context).then((s) => {
        if (disposed) return;
        const changed = s.added !== data.sessionStats.added || s.removed !== data.sessionStats.removed;
        data.sessionStats = s;
        if (changed) void panel.webview.postMessage({ type: 'data', data });
      });
    }
    void panel.webview.postMessage({ type: 'data', data });
  };

  // Quick status push for THIS panel: flip the status UI in the webview
  // WITHOUT recomputing the diff or the session-wide git stats — that full
  // data round-trip is what made the Accept button feel slow. The host's
  // acceptFile/setReady handlers call this, and notifyPanels() covers the
  // other panels of the session (e.g. right-click status changes from the
  // left panel, or another file's accept flipping the shared counters).
  const sendQuick = (): void => {
    if (disposed) return;
    data.file = load();
    data.fileCounts = sessionFileCounts(sessionDir);
    data.sessionOpen = sessionHasOpen(sessionDir);
    void panel.webview.postMessage({
      type: 'quick',
      file: data.file,
      fileCounts: data.fileCounts,
      sessionOpen: data.sessionOpen,
    });
  };

  // Live updates: the agent edits the reviewed source file and re-writes the
  // review JSONs on disk (fixes, replies, re-submissions). Watching only the
  // ONE file under review (not the whole session folder — a session-wide
  // ** glob fired for EVERY file in the session, re-running the full send —
  // git base read + LCS diff + per-file session stats — on unrelated
  // activity and made switching files feel slow) keeps the panel fresh
  // without that cost. Debounced — the agent often rewrites files back to
  // back. Cross-file session updates (another file's JSON, a re-submission)
  // still arrive via the left panel's session watcher (tree + quick status
  // push through notifyPanels) and the periodic scan.
  const fileAbs = path.join(repoRoot, filePath);
  watchers = [vscode.workspace.createFileSystemWatcher(fileAbs)];
  const fileMtime = (): number => {
    try {
      return fs.statSync(fileAbs).mtimeMs;
    } catch {
      return -1;
    }
  };
  let lastMtime = fileMtime();
  const onDiskChange = (): void => {
    if (disposed) return;
    // Skip the notification if the file on disk is actually unchanged
    // (watchers can fire for metadata-only events).
    const m = fileMtime();
    if (m === lastMtime) return;
    lastMtime = m;
    if (pendingSend) clearTimeout(pendingSend);
    pendingSend = setTimeout(() => {
      pendingSend = undefined;
      void send();
      onSessionsChanged?.();
    }, 300);
  };
  for (const w of watchers) {
    w.onDidCreate(onDiskChange);
    w.onDidChange(onDiskChange);
    w.onDidDelete(onDiskChange);
  }
  void send();

  msgSub = panel.webview.onDidReceiveMessage(async (msg: {
    type: string;
    line?: number;
    col?: number;
    character?: number;
    file?: string;
    side?: 'left' | 'right';
    action?: 'openFile' | 'goDef';
    text?: string;
    id?: string;
    ready?: boolean;
    accept?: boolean;
    comments?: ReviewComment[];
    commit?: CommitOptions;
    mode?: string;
  }) => {
    // A 'reply' is the answer to an askWebview() round-trip (host-initiated)
    // — not a user action.
    if (msg.type === 'reply') return;
    if (msg.type === 'codeHover') {
      // Type info under the mouse (like the SCM diff's editor): run the
      // language service for THIS file and send the answer back to the
      // webview. Only TS/JS files produce a result.
      if (msg.line === undefined) return;
      if (isSupported(filePath)) {
        const result = await lookup(repoRoot, filePath, msg.line, msg.col ?? 0);
        if (!disposed) {
          void panel.webview.postMessage({ type: 'hoverResult', line: msg.line, result });
        }
      }
      return;
    }
    if (msg.type === 'codeContext') {
      // Right-click a code line. Two actions (webview menu):
      //  - openFile: open THIS file (the one under review) in a new editor tab.
      //  - goDef: resolve the definition under the cursor and open THAT
      //    file in a new tab, selecting the definition line.
      if (msg.line === undefined) return;
      const open = (rel: string, target?: { file: string; line: number; character: number }): void => {
        void (async () => {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(repoRoot, rel)));
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            if (target) {
              const sel = new vscode.Selection(
                Math.max(0, target.line - 1),
                Math.max(0, target.character - 1),
                Math.max(0, target.line - 1),
                Math.max(0, target.character - 1)
              );
              editor.selection = sel;
              editor.revealRange(sel, vscode.TextEditorRevealType.InCenter);
            }
          } catch {
            /* definition target gone (deleted file) — nothing to open */
          }
        })();
      };
      if (msg.action === 'goDef') {
        // Only TS/JS files can carry a definition; anything else (or a
        // position with no symbol) has nowhere to jump to.
        if (!isSupported(filePath)) return;
        const result = await lookup(repoRoot, filePath, msg.line, msg.col ?? 0);
        if (result?.definition) open(result.definition.file, result.definition);
        return;
      }
      open(filePath); // action 'openFile' (and the legacy default)
      return;
    }
    if (msg.type === 'ready') {
      // The script is live: deliver a one-shot draft restore (tab-close
      // recovery) before the first data send.
      const restore = pendingRestores.get(panel);
      if (restore) {
        pendingRestores.delete(panel);
        void panel.webview.postMessage({ type: 'restoreDraft', text: restore });
      }
      void send();
      return;
    }
    if (msg.type === 'viewClosed') {
      // The user is about to look at a DIFFERENT file (the reused tab is
      // being handed over). Stamp this file as reviewed so the left panel
      // can show the "discussion added" icon for the human feedback left in
      // it — same effect as closing the tab, but at the moment of the
      // view change.
      try {
        const fr = load();
        const nowIso = new Date().toISOString();
        fr.reviewedAt = nowIso;
        fr.updatedAt = nowIso;
        writeFileReview(sessionDir, fr);
        onSessionsChanged?.();
      } catch {
        /* best-effort — the icon just stays off */
      }
      return;
    }
    if (msg.type === 'draft') {
      // The un-posted discussion draft, mirrored to the host for the
      // tab-close guard — not a session mutation.
      if (typeof msg.text === 'string' && msg.text.trim() !== '') panelDrafts.set(panel, msg.text);
      else panelDrafts.delete(panel);
      return;
    }
    try {
      // Authoritative per-file read (the webview's copy may be stale).
      const fr = load();
      const now = new Date().toISOString();
      let notify = false;
      // Status-only changes (accept/ready) skip the full send: the status UI
      // flips instantly via sendQuick(), and the file watcher already
      // schedules the full (diff + stats) refresh a beat later.
      let quick = false;
      switch (msg.type) {
        case 'addComment': {
          const c: ReviewComment = {
            id: genId('c', fr.comments),
            line: msg.line ?? 1,
            side: msg.side === 'left' ? 'left' : 'right',
            text: msg.text ?? '',
            author,
            createdAt: now,
            resolved: false,
          };
          fr.comments.push(c);
          fr.updatedAt = now;
          writeFileReview(sessionDir, fr);
          notify = true;
          break;
        }
        case 'editComment': {
          const c = fr.comments.find((x) => x.id === msg.id);
          if (c && typeof msg.text === 'string' && msg.text.trim() !== '') {
            c.text = msg.text.trim();
            c.updatedAt = now;
            fr.updatedAt = now;
            writeFileReview(sessionDir, fr);
            notify = true;
          }
          break;
        }
        case 'reanchorComments': {
          // The webview re-anchored comments whose line numbers went stale
          // (file grew/shrank between rounds). Persist the corrected lines.
          fr.comments = msg.comments ?? fr.comments;
          fr.updatedAt = now;
          writeFileReview(sessionDir, fr);
          notify = true;
          break;
        }
        case 'resolveComments': {
          // Resolve the WHOLE comment chain on this line (every comment
          // anchored to it) — resolution is per chain, never per comment.
          const any = fr.comments.some((c) => c.line === msg.line);
          if (any) {
            fr.comments.forEach((c) => {
              if (c.line === msg.line) c.resolved = true;
            });
            fr.updatedAt = now;
            writeFileReview(sessionDir, fr);
            notify = true;
          }
          break;
        }
        case 'reopenComments': {
          // Re-open the chain: flip every comment on this line back to open
          // (the "✓ Resolved" footer button toggles it off).
          const any = fr.comments.some((c) => c.line === msg.line && c.resolved);
          if (any) {
            fr.comments.forEach((c) => {
              if (c.line === msg.line) c.resolved = false;
            });
            fr.updatedAt = now;
            writeFileReview(sessionDir, fr);
            notify = true;
          }
          break;
        }
        case 'addDiscussion': {
          fr.discussion.push({
            id: genId('d', fr.discussion),
            text: msg.text ?? '',
            author,
            createdAt: now,
            answered: false,
          });
          fr.updatedAt = now;
          writeFileReview(sessionDir, fr);
          notify = true;
          break;
        }
        case 'answerDiscussion': {
          const d = fr.discussion.find((x) => x.id === msg.id);
          if (d) {
            d.answered = true;
            fr.updatedAt = now;
            writeFileReview(sessionDir, fr);
            notify = true;
            quick = true;
          }
          break;
        }
        case 'unanswerDiscussion': {
          // Re-open an answered entry (the green "✓ answered" pill) so the
          // human can add to it or change their mind.
          const d = fr.discussion.find((x) => x.id === msg.id);
          if (d && d.answered) {
            d.answered = false;
            fr.updatedAt = now;
            writeFileReview(sessionDir, fr);
            notify = true;
            quick = true;
          }
          break;
        }
        case 'setReady': {
          // Per-file "Ready to work". Releasing requires open feedback on
          // this file (authoritative disk read).
          if (msg.ready === true) {
            if (!hasOpenFeedback(fr)) {
              void panel.webview.postMessage({ type: 'readyBlocked', reason: 'no-feedback' });
              return;
            }
            fr.ready = true;
          } else {
            fr.ready = false;
          }
          fr.updatedAt = now;
          writeFileReview(sessionDir, fr);
          notify = true;
          quick = true;
          break;
        }
        case 'acceptFile': {
          // Per-file: toggle accepted. Accepting does NOT release the agent —
          // it keeps waiting until the review is committed or a file is
          // revised. Un-accepting sends the file back to needs review.
          const accept = msg.accept !== false;
          fr.status = accept ? 'accepted' : 'needs_review';
          // Accepting acknowledges the agent's changes — clear the "changed by
          // the agent" flag so the left panel stops highlighting it.
          if (accept) fr.agentTouched = false;
          fr.updatedAt = now;
          writeFileReview(sessionDir, fr);
          notify = true;
          quick = true;
          break;
        }
        case 'requestRevision': {
          // Session-level: release every file that has open feedback.
          const session = readSession(sessionDir);
          if (!session) break;
          const released = applyRequestRevision(sessionDir, session, now);
          void panel.webview.postMessage({ type: 'sessionUpdated', released });
          notify = true;
          break;
        }
        case 'commitChanges': {
          // Session-level: "Commit changes" is available AT ANY TIME. The
          // webview shows "n of m files accepted" in the dialog and asks
          // before committing; committing accepts every remaining file (the
          // human explicitly chose "commit all"). The human's commit options
          // are recorded in the manifest for the agent.
          const session = readSession(sessionDir);
          if (!session) break;
          const commit: CommitOptions = {
            mode: msg.commit?.mode === 'pr' ? 'pr' : 'local',
            ...(typeof msg.commit?.branch === 'string' && msg.commit.branch.trim() !== ''
              ? { branch: msg.commit.branch.trim() }
              : {}),
            ...(msg.commit?.mode === 'pr' ? { squash: msg.commit.squash !== false } : {}),
          };
          applyCommit(sessionDir, session, commit, now);
          void panel.webview.postMessage({ type: 'sessionUpdated', commit });
          notify = true;
          break;
        }
        case 'setLayoutMode': {
          // Global preference: stored in workspace settings so every review
          // panel (and the next one) uses the same layout.
          if (msg.mode === 'unified' || msg.mode === 'side' || msg.mode === 'hybrid') {
            await vscode.workspace
              .getConfiguration('afterMath')
              .update('layoutMode', msg.mode, vscode.ConfigurationTarget.Workspace);
            await send();
          }
          return;
        }
        default:
          return;
      }
      if (notify) {
        onSessionsChanged?.();
        if (quick) {
          // Status UI flips now (this panel + every other panel of the
          // session); the full data send rides on the file-watcher refresh.
          sendQuick();
          notifyPanels(sessionDir);
        } else {
          await send();
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`After Math: ${String(err)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Webview HTML (self-contained; no external assets)
// ---------------------------------------------------------------------------

function buildHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --lh: 19px;
    --fg: var(--vscode-editor-foreground, #ccc);
    --bg: var(--vscode-editor-background, #1e1e1e);
    --add-bg: rgba(64, 150, 64, 0.22);
    --del-bg: rgba(190, 60, 60, 0.22);
    --add-fg: #6fce6f;
    --del-fg: #ff8080;
    --add-line: #3fb950;
    --del-line: #f85149;
    --ctx-fg: var(--vscode-editor-foreground, #ccc);
    --border: var(--vscode-panel-border, #444);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); }

  /* Two-row header: row 1 = file name + status pill, row 2 = the action
     buttons. Kept on separate rows so a long file name can never push the
     buttons off the line. */
  #toolbar { display: flex; flex-direction: column; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  #toolbar .trow { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  #toolbar .fname { font-weight: 600; margin-right: 4px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #toolbar .trow-head #statusChip { flex: 0 0 auto; }
  #statusChip { padding: 1px 8px; border-radius: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; flex: 0 0 auto; }
  .aichip { padding: 1px 8px; border-radius: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; flex: 0 0 auto; background: #4a3a7a66; color: #c3a6ff; }
  .chip-needs_review { background: #8a6d1a66; color: #e0b341; }
  .chip-in_review { background: #2a5a8a66; color: #6cb6ff; }
  .chip-accepted { background: #2a7a2a66; color: #6fce6f; }
  .chip-rejected { background: #8a2a2a66; color: #ff8080; }
  button { font-family: inherit; font-size: 12px; color: var(--fg); background: var(--vscode-button-secondaryBackground, #3a3a3a); border: 1px solid var(--border); border-radius: 3px; padding: 2px 8px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
  button.active { outline: 1px solid var(--fg); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.acceptbtn { color: var(--add-fg); }
  /* "Revise all" matches the per-file Revise button (blue), not the red of a
     plain "revise" action — it is the same release action, applied to all. */
  button.revise { color: #6cb6ff; }
  button.pr { color: var(--add-fg); }
  button.readybtn { color: #6cb6ff; }
  button.readybtn.on { background: #2a5a8a66; color: #6cb6ff; outline: 1px solid #6cb6ff; }
  .stats { font-size: 11px; white-space: nowrap; }
  .stats .add { color: var(--add-fg); font-weight: 600; }
  .stats .del { color: var(--del-fg); font-weight: 600; }
  .stats.muted { opacity: 0.85; }
  button.gear { font-size: 14px; padding: 0 7px; line-height: 18px; }
  button.gear.on { outline: 1px solid var(--fg); }
  /* Previous/next change-group navigation (left of Accept). */
  button.navbtn { font-size: 12px; padding: 0 8px; line-height: 18px; }
  /* Settings menu: fixed so it stays visible while the diff is scrolled. */
  .settingsmenu { position: fixed; top: 74px; right: 8px; width: 280px; z-index: 60; background: var(--bg); border: 1px solid var(--border); border-left: 3px solid #6cb6ff; border-radius: 3px; padding: 8px 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
  .settingsmenu .settingsmenu-header { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #888; margin-bottom: 6px; }
  .settingsmenu .settings-sub { border: 1px solid var(--border); border-radius: 3px; padding: 6px; }
  .settingsmenu .settings-sublabel { display: block; font-size: 11px; color: var(--fg); margin-bottom: 4px; }
  .settingsmenu .settings-select { display: flex; flex-direction: column; gap: 2px; }
  .settingsmenu .opt { text-align: left; background: transparent; border: none; padding: 3px 6px; border-radius: 3px; }
  .settingsmenu .opt:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
  .settingsmenu .opt.active { background: #2a5a8a66; }
  .settingsmenu .opt.active::before { content: '✓  '; color: var(--add-fg); }
  .spacer { flex: 1; }
  .sessiongroup { display: flex; align-items: center; gap: 6px; border-left: 1px solid var(--border); padding-left: 10px; }

  /* 2px of padding on every side: the changed-line borders sit right at the
     content edge and must never be clipped by the scroll container. overflow
     auto gives BOTH scrollbars: vertical for long files and horizontal when a
     code line is wider than the view (the rows stretch to the longest line —
     see .row code — so the bar appears on the WHOLE page, not per row). */
  #content { flex: 1; overflow: auto; padding: 2px 2px 14px; position: relative; }
  /* --page-w is set by the script after every render to the width of the
     WIDEST row anywhere in the file (see syncPageWidth). Percentages on a
     scroll container's children resolve against the VISIBLE width, not the
     scrollable one, so a fixed px minimum is the only way for a block to
     stretch out to the longest line. */
  /* Side-by-side hunks opt out of the page-wide horizontal scroll: sticky to
     the LEFT (and right) edge of #content, so no matter how far the page is
     scrolled horizontally the block stays in place, exactly as wide as the
     view (current behavior). The two columns then scroll their code
     independently — see .hunk-side .col. */
  .hunk-side { position: sticky; left: 0; right: 0; }

  /* min-height (not just height): with empty content the flex children have
     zero height, so a plain height declaration collapses the row — every row,
     blank ones included, must keep the full line height. */
  /* Blank rows: the code span has no text, so the row's height must come
     from the line box itself. Give EVERY inline participant (row, gutter,
     marker, code) the same explicit line-height — then even a row whose only
     content is the line number is exactly one line tall, same as rows with
     text. min-height is the belt, line-height the suspenders. */
  .row, .cell, .row .gutter, .cell .gutter, .row .marker, .cell .marker, .row code, .cell code { line-height: var(--lh); }
  .row, .cell { display: flex; align-items: center; min-height: var(--lh); font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; white-space: pre; }
  .row .gutter, .cell .gutter { width: 52px; min-width: 52px; text-align: right; padding-right: 6px; color: var(--vscode-editorLineHighlight, #666); user-select: none; display: flex; justify-content: flex-end; align-items: center; gap: 3px; }
  .row .marker, .cell .marker { width: 12px; min-width: 12px; text-align: center; user-select: none; }
  /* The text area is a full-height box: a fixed height makes an EMPTY code
     span exactly one line tall (an empty inline span has no line box of its
     own, so line-height alone left it ~2 px). The border is NOT per row —
     it is one square border around the whole contiguous change section.
     NOTE: no overflow:hidden here — that would disable the flex item's
     automatic minimum size and the span would shrink to zero, ellipsizing
     long lines instead of letting the row stretch. Rows stretch to the
     longest line, so #content's overflow:auto produces the whole-page
     horizontal scroll bar (and each side-by-side .col its own). */
  .row code, .cell code { flex: 1 0 auto; min-width: 0; height: var(--lh); }
  /* Every row spans the FULL width of the code (the widest line anywhere in
     the file, --page-w — see syncPageWidth) so the line-number gutter and
     the code area line up with every other row. */
  .row { min-width: var(--page-w, 100%); }
  .chg { border: 1px solid var(--linec); }
  /* Unified/hybrid change blocks span the FULL width of the code, not just
     the view: the page scrolls horizontally as a whole, so the border and
     the green/red line background must reach the end of the LONGEST line
     anywhere in the file — not only of the widest line inside this block.
     min-width: var(--page-w) stretches the block out to that width (set by
     syncPageWidth after every render), so scrolling the horizontal bar
     never leaves the block behind while other lines run past its border.
     (A plain block box stays at the visible width and long lines run past
     the border; fit-content only sized the box to THIS block's widest row,
     which is what let code overlap it once the page scrolled.) Scoping to
     :not(.col) leaves the side-by-side columns alone (flex items with their
     own per-column horizontal scroll — side by side stays as it is). */
  #content .chg:not(.col) { min-width: var(--page-w, 100%); }
  .chg.adds { --linec: var(--add-line); }
  .chg.dels { --linec: var(--del-line); }
  .chg.adds code { background: var(--add-bg); }
  .chg.dels code { background: var(--del-bg); }
  .chg.adds .marker { color: var(--add-fg); }
  .chg.dels .marker { color: var(--del-fg); }
  .row.ctx { color: var(--ctx-fg); }

  /* Syntax coloring: the host sends the editor's own TextMate tokens for
     the file (the same grammar engine the editor uses) and the webview maps
     the scope chain onto a few broad classes — the default dark theme's
     family of colors. A file with no grammar, or a reply that never
     arrives, just renders plain text (no visual difference from before). */
  code .tk-cmt { color: #6a9955; }
  code .tk-str { color: #ce9178; }
  code .tk-kw  { color: #c586c0; }
  code .tk-const { color: #569cd6; }
  code .tk-prop { color: #9cdcfe; }
  code .tk-type { color: #4ec9b0; }
  code .tk-fn  { color: #dcdcaa; }
  code .tk-num { color: #b5cea8; }

  .addc { display: none; width: 16px; height: 16px; line-height: 14px; padding: 0; margin-right: 2px; font-size: 11px; border-radius: 3px; }
  .row:hover .addc, .cell:hover .addc { display: inline-block; }

  .badge { min-width: 16px; height: 15px; padding: 0 4px; font-size: 10px; border-radius: 8px; background: #b48a2a; color: #1e1e1e; font-weight: 700; display: inline-block; text-align: center; }
  .badge.resolved { background: #4a6a4a; color: #cfe8cf; }

  /* Hover type tooltip (SCM-diff style): follows the mouse over a code line,
     shows the symbol's signature + its declaration. Absolutely positioned
     inside #content (position: relative) so it scrolls with the code and
     never covers the toolbar. pointer-events: none — it must not steal the
     mouse or the hover would flicker. */
  .codetip { position: absolute; z-index: 70; max-width: 640px; background: var(--vscode-editorWidget-background, #252526); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); padding: 4px 8px; font-size: 12px; pointer-events: none; }
  .codetip .ct-kind { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: nowrap; }
  .codetip .ct-text { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; color: #999; white-space: pre-wrap; word-break: break-word; margin-top: 3px; max-height: 120px; overflow: hidden; }

  /* Right-click context menu on a code line: VS Code-style floating menu
     (fixed = stays put even though #content scrolls). */
  .codectx { position: fixed; z-index: 80; min-width: 190px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526)); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); padding: 4px 0; font-size: 13px; }
  .codectx .ctx-item { padding: 4px 16px; cursor: pointer; white-space: nowrap; }
  .codectx .ctx-item:hover { background: var(--vscode-menu-selectionBackground, #04395e); }

  .hunk-side { display: flex; gap: 6px; }
  /* Each column is an INDEPENDENT scroll box: it keeps exactly half the view
     width (never pushed by the page-level horizontal scroll — .hunk-side is
     pinned with position: sticky) and scrolls its OWN code horizontally when
     a line is longer than the column. overflow-y is HIDDEN, not auto: a
     column's height always fits its rows exactly, so with overflow:auto
     the moment a horizontal bar appears (it eats ~15px of the box's height)
     the content no longer fits VERTICALLY and a phantom vertical bar shows
     up next to it. The one legit vertical case — a long removals side
     capped by a max-height in renderSide — sets overflow-y: auto inline. */
  .hunk-side .col { flex: 1; min-width: 0; max-width: 50%; overflow-x: auto; overflow-y: hidden; }
  .cell.ph { background: rgba(128,128,128,0.08); }

  /* Inline confirm/note dialog: fixed so it is always visible, contents
     right-aligned. */
  .dialogbar { position: fixed; top: 74px; right: 8px; left: auto; width: 440px; max-width: calc(100% - 16px); z-index: 50; background: var(--bg); border: 1px solid var(--border); border-left: 3px solid #6cb6ff; border-radius: 3px; padding: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); text-align: right; }
  .dialogbar h4 { margin: 0 0 8px 0; font-size: 12px; color: var(--fg); text-align: right; line-height: 1.5; }
  .dialogbar .actions { display: flex; gap: 6px; justify-content: flex-end; }
  .dialogbar .opt { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12.5px; }
  .dialogbar .opt.indent { margin-left: 22px; }
  .dialogbar .opt.disabled { opacity: 0.45; }
  .dialogbar input[type="radio"], .dialogbar input[type="checkbox"] { accent-color: #6cb6ff; margin: 0; }
  .dialogbar .branchrow { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12.5px; }
  .dialogbar .branchrow input[type="text"] { flex: 1; background: var(--vscode-input-background, #2a2a2a); color: var(--fg); border: 1px solid var(--border); font-family: inherit; font-size: 12.5px; padding: 3px 5px; }

  .editor { border: 1px solid var(--border); border-left: 3px solid #6cb6ff; margin: 4px 8px; padding: 8px; border-radius: 3px; }
  /* Header row: the line title on the left, the minimize icon pinned to the
     TOP RIGHT of the box (it collapses just this line's box). */
  .editor .edhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .editor .edhead h4 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #6cb6ff; }
  button.minbtn { font-size: 12px; padding: 0 7px; line-height: 16px; }
  .editor .item { margin: 6px 0; padding: 6px; background: rgba(108,182,255,0.08); border-radius: 3px; font-size: 12.5px; }
  .editor .item.resolved { background: rgba(108,182,255,0.04); opacity: 0.75; }
  .editor .meta { color: #888; font-size: 11px; margin-top: 3px; }
  /* The per-comment action row (pencil to edit / reopen) sits at the BOTTOM
     of the whole comment block, right-aligned. Resolving is NOT per comment —
     the whole chain is resolved by the box footer button. */
  .editor .itemactions { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; }
  .editor textarea { width: 100%; min-height: 44px; margin-top: 6px; background: var(--vscode-input-background, #2a2a2a); color: var(--fg); border: 1px solid var(--border); font-family: inherit; font-size: 12.5px; padding: 5px; resize: vertical; }
  /* Box footer: "Mark Resolved" (resolves the WHOLE comment chain on this
     line) pinned BOTTOM LEFT, "Submit Comment" pinned BOTTOM RIGHT. */
  .editor .actions { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-top: 6px; }
  .editor .actions .left, .editor .actions .right { display: flex; gap: 6px; }
  button.resolvebtn { color: var(--add-fg); }
  button.resolvebtn.on { background: rgba(111,206,111,0.15); outline: 1px solid var(--add-fg); }

  /* The agent's brief reply, shown under the comment / discussion it answers. */
  .reply { margin-top: 6px; padding: 5px 7px; background: rgba(127,106,180,0.12); border-left: 2px solid #8b6fd0; border-radius: 2px; font-size: 12.5px; color: var(--fg); }
  .reply .replylabel { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: #b79bf0; margin-right: 5px; }
  .reply .replyat { color: #888; font-size: 11px; margin-left: 4px; }

  /* "Revised" pill: the agent changed the code in response to this comment
     / discussion entry. Sits inline next to the text. */
  .pill-revised { display: inline-block; vertical-align: 1px; margin-left: 6px; padding: 0 7px; border-radius: 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; background: #2a5a8a66; color: #6cb6ff; }

  #discussion { border-top: 1px solid var(--border); padding: 8px 10px; max-height: 40%; overflow: auto; }
  #discussion h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #888; }
  /* Each entry is a column: text on top, the answer/resolve action pinned to
     the BOTTOM RIGHT of the whole entry (it works for that whole discussion,
     not just the first line of text). */
  #discussion .ditem { display: flex; flex-direction: column; align-items: flex-start; margin: 6px 0; padding: 6px 0; font-size: 12.5px; border-top: 1px solid var(--border); }
  #discussion .ditem:first-child { border-top: none; padding-top: 2px; }
  #discussion .ditem.answered { opacity: 0.7; }
  /* pre-wrap: posted text keeps its ENTER (carriage return) line breaks —
     esc() puts them into the HTML as real \n, which a normal div would
     collapse into one line. pre-wrap renders them as line breaks (and
     still wraps long lines). */
  #discussion .dbody { width: 100%; min-width: 0; white-space: pre-wrap; word-wrap: break-word; }
  #discussion .dfoot { display: flex; justify-content: flex-end; align-items: center; gap: 6px; margin-top: 4px; width: 100%; }
  #discussion .dmeta { color: #888; font-size: 11px; }
  #discussion .answerbtn { color: var(--add-fg); font-weight: 700; padding: 0 6px; }
  #discussion .answerpill { color: var(--add-fg); background: rgba(111,206,111,0.15); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 1px 7px; border-radius: 8px; }
  #discussion .answerpill:hover { background: rgba(111,206,111,0.3); }
  #discussion textarea { width: 100%; min-height: 34px; margin-top: 6px; background: var(--vscode-input-background, #2a2a2a); color: var(--fg); border: 1px solid var(--border); font-family: inherit; font-size: 12.5px; padding: 5px; resize: vertical; }

  /* Who spoke: a pill in front of each discussion entry — purple (robot +
     the agent's name) for the AI agent, blue for you. */
  .who { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 1px 7px; border-radius: 8px; margin-right: 6px; vertical-align: 1px; white-space: nowrap; }
  .who.agent { background: #4a3a7a66; color: #c3a6ff; }
  .who.agent .robot { flex: 0 0 auto; }
  .who.human { background: #2a5a8a66; color: #6cb6ff; }

  /* Shown until the first data message arrives (the diff needs a git
     round-trip, so the panel opens first and fills in a moment later). */
  #loading { padding: 24px 12px; color: #888; font-size: 12.5px; }

  /* "n of m files accepted" line in the commit dialog: red-ish when some
     files are still un-accepted, green-ish when everything is accepted. */
  .commitnote { font-size: 12px; margin: 6px 0; }
  .commitnote.warn { color: var(--del-fg); }
  .commitnote.ok { color: var(--add-fg); }
</style>
</head>
<body>
  <div id="toolbar">
    <div class="trow trow-head">
      <span class="fname" id="fname"></span>
      <span id="aiChip" class="aichip" hidden title="AI updated this file — the agent revised the code in response to your feedback.">✦ AI updated</span>
      <span id="statusChip"></span>
    </div>
    <div class="trow trow-actions">
      <button id="btnPrevChange" class="navbtn" title="Jump to the previous group of changes" disabled>↑</button>
      <button id="btnNextChange" class="navbtn" title="Jump to the next group of changes" disabled>↓</button>
      <button id="btnAccept" class="acceptbtn" title="Accept THIS file. The agent is NOT released — it keeps waiting until the whole review is committed (or you revise a file).">Accept</button>
      <button id="btnReady" class="readybtn" title="Release THIS file to the agent: it will start working on this file's open comments right away, without waiting for the rest of the review. Click again to take it back.">Revise</button>
      <span id="fileStats" class="stats" title="Added and removed lines in THIS file"></span>
      <span id="sessionStats" class="stats muted" title="Added and removed lines across the whole review"></span>
      <span id="fileCounts" class="stats muted" title="Files accepted / total files in this review"></span>
      <span class="spacer"></span>
      <span class="sessiongroup">
        <button id="btnRevise" class="revise" title="Release every file in this review that has open comments or discussion. The agent will start working on all of them at once and wait for your review of the result.">Revise all</button>
        <button id="btnPR" class="pr" title="Let the agent commit the changes — to a local branch or as a pull request, your choice in the dialog. Available at any time; files you have not accepted yet are accepted too, after you confirm.">Commit changes</button>
      </span>
      <button id="btnSettings" class="gear" title="Review settings">⚙</button>
    </div>
  </div>
  <div id="settingsMenu" class="settingsmenu" hidden>
    <div class="settingsmenu-header">Settings</div>
    <div class="settings-sub" id="layoutSub">
      <span class="settings-sublabel" title="How changes are laid out. Applies to every review.">Layout</span>
      <div class="settings-select">
        <button data-mode="unified" class="opt" title="One column: changes marked inline in the full file">Unified</button>
        <button data-mode="side" class="opt" title="Two columns: additions (left) and removals (right), per change block">Side-by-side</button>
        <button data-mode="hybrid" class="opt" title="Small changes inline, larger changes side-by-side">Hybrid</button>
      </div>
    </div>
  </div>
  <div id="content"><div id="loading">Loading review…</div></div>
  <div id="discussion">
    <h4>Discussion</h4>
    <div id="dList"></div>
    <textarea id="dInput" placeholder="Ask a question or request a change…"></textarea>
    <div class="actions" style="display:flex;gap:6px;margin-top:5px;">
      <button id="dPost" title="Post to this file's discussion (Ctrl+Enter)">Post</button>
    </div>
  </div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const LH = 21; // --lh (19 px) + the 2 px changed-line border; used for scroll math
  let data = null;
  // Language of the file on display (derived from its extension when the
  // data arrives). '' = unknown language, plain text.
  let lang = '';
  // True while a block comment (/* … */) is open across lines; each file's
  // first rendered line resets it (line 1 can never be inside a block).
  let blockOpen = false;
  // Highlight cache: fileName -> (line text -> html). Re-renders while the
  // user is reading (posting a comment, accepting, …) must not re-run the
  // tokenizer over every visible line — only new file content does.
  const tokCache = new Map();

  // --- lightweight syntax highlighting -------------------------------------
  // Runs entirely in the webview (the extension API has no tokenization
  // endpoint) — a small set of per-language regexes colors comments,
  // strings, numbers, keywords and identifiers. It is deliberately simple:
  // each line is scanned left to right and the FIRST matching pattern wins,
  // which keeps strings from swallowing the code after them. Unknown
  // languages (or a line nothing matches) render exactly as before.
  const LANGS = {
    ts: {
      line: /\\/\\/.*$/,
      blocks: [/\\/\\*(?!\\*\\/)/, /\\*\\//],
      str: /'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?|\\x60(?:\\\\.|[^\\x60\\\\])*\\x60?/,
      num: /\\b0[xXbBoO][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b/,
      kw: /\\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|let|namespace|new|null|of|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\\b/,
      fn: /\\b[A-Za-z_$][\\w$]*(?=\\s*\\()/,
      type: /\\b[A-Z][A-Za-z0-9_$]*\\b/,
    },
    py: {
      line: /#.*$/,
      blocks: [],
      str: /'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?/,
      num: /\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?j?\\b/,
      kw: /\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|False|try|while|with|yield|self|cls)\\b/,
      fn: /\\b[A-Za-z_][\\w]*(?=\\s*\\()/,
      type: /\\b[A-Z][A-Za-z0-9_]*\\b/,
    },
    json: {
      line: [],
      blocks: [],
      str: /"(?:\\\\.|[^"\\\\\\n])*"?/,
      num: /-?\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b/,
      kw: /\\b(?:true|false|null)\\b/,
      prop: /"(?:\\\\.|[^"\\\\\\n])*"?(?=\\s*:)/,
      fn: [],
      type: [],
    },
    md: {
      line: [],
      blocks: [],
      str: /\\x60[^\\x60]*\\x60?/,
      num: [],
      kw: /^#{1,6}\\s.*$|^\\s*[-*+]\\s.*$|^\\s*\\d+\\.\\s.*$|^\\s*>\\s.*$/,
      prop: [],
      fn: /\\[[^\\]]*\\]\\([^)]*\\)/,
      type: [],
    },
    css: {
      line: [],
      blocks: [/\\/\\*/, /\\*\\//],
      str: /'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?/,
      num: /#[0-9a-fA-F]{3,8}\\b|-?\\b\\d[\\.]*(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?\\b/,
      kw: /\\b[a-z-]+(?=\\s*:)/,
      prop: /\\b(?:at-\\w+|media|import|charset|supports)\\b/,
      fn: [],
      type: /\\.[-\\w]+|@[-\\w]+/,
    },
    java: {
      line: /\\/\\/.*$/,
      blocks: [/\\/\\*/, /\\*\\//],
      str: /'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?/,
      num: /\\b0[xXbBoO][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?[fFdDlL]?\\b/,
      kw: /\\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|do|double|else|enum|extends|false|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|null|package|private|protected|public|record|return|sealed|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|true|try|var|void|volatile|while|yield)\\b/,
      fn: /\\b[a-z_$][\\w$]*(?=\\s*\\()/,
      type: /\\b[A-Z][A-Za-z0-9_$]*\\b/,
    },
    go: {
      line: /\\/\\/.*$/,
      blocks: [/\\/\\*/, /\\*\\//],
      str: /'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?|\\x60[^\\x60]*\\x60?/,
      num: /\\b0[xXbBoO][\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b/,
      kw: /\\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|iota|nil|true|false)\\b/,
      fn: /\\b[a-z_][\\w]*(?=\\s*\\()/,
      type: /\\b[A-Z][A-Za-z0-9_]*\\b/,
    },
    sh: {
      line: /#.*$/,
      blocks: [],
      str: /'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?/,
      num: /\\b\\d+\\b/,
      kw: /\\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|time|coproc)\\b/,
      prop: /^\\s*(?:export|local|readonly|set|unset|alias|source|\\.|return|exit|break|continue)\\b/,
      fn: /\\b[a-zA-Z_][\\w-]*(?=\\s*\\()/,
      type: [],
    },
  };
  const ALIASES = {
    'tsx': 'ts', 'mts': 'ts', 'cts': 'ts', 'jsx': 'ts', 'js': 'ts', 'mjs': 'ts', 'cjs': 'ts',
    'tsv': 'json', 'csv': 'json', 'yaml': 'py', 'yml': 'py',
    'c': 'java', 'h': 'java', 'cpp': 'java', 'cc': 'java', 'cxx': 'java', 'hpp': 'java',
    'cs': 'java', 'rs': 'java', 'swift': 'java', 'kt': 'java', 'kts': 'java', 'scala': 'java',
    'lua': 'py', 'pl': 'py', 'r': 'py',
  };
  function langOf(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    if (!m) return '';
    const e = m[1].toLowerCase();
    return LANGS[e] ? e : ALIASES[e] || '';
  }
  // One line of code as HTML: colored when the language is known, escaped
  // plain text otherwise. Cached per (file, line text).
  function codeHtml(text) {
    if (!lang || !text) return esc(text);
    let byText = tokCache.get(data.fileName);
    if (!byText) {
      byText = new Map();
      tokCache.set(data.fileName, byText);
      if (tokCache.size > 8) {
        const first = tokCache.keys().next().value;
        tokCache.delete(first); // oldest file drops out (Map insertion order)
      }
    }
    let html = byText.get(text);
    if (html !== undefined) return html;
    const L = LANGS[lang];
    const blockRe = L.blocks ? L.blocks[1] : null; // block-comment CLOSER
    // (re-read every iteration: closing a block flips it off mid-line)
    let inBlock = blockOpen && !!blockRe;
    const PATS = [
      // The line-comment pattern is deliberately NOT anchored: // and #
      // comments most often trail code on the same line.
      [L.line, 'tk-cmt', false],
      [L.blocks && L.blocks[0], 'tk-cmt', false],
      // prop is tried before str: for JSON the prop pattern carries a (?=:)
      // lookahead so it only claims key strings; value strings still fall
      // through to str below.
      [L.prop, lang === 'json' ? 'tk-prop' : 'tk-fn', false],
      [L.str, 'tk-str', false],
      [L.kw, 'tk-kw', false],
      [L.num, 'tk-num', false],
      [L.type, 'tk-type', false],
      [L.fn, 'tk-fn', false],
    ];
    html = '';
    let i = 0;
    const put = (c, s) => {
      if (!s) return;
      html += (c ? '<span class="' + c + '">' : '') + esc(s) + (c ? '</span>' : '');
    };
    while (i < text.length) {
      let m = null;
      if (inBlock) {
        blockRe.lastIndex = i;
        m = blockRe.exec(text);
        if (m) {
          put('tk-cmt', text.slice(i, m.index + m[0].length));
          i = m.index + m[0].length;
          blockOpen = false;
          inBlock = false;
          continue;
        }
        put('tk-cmt', text.slice(i));
        break;
      }
      const rest = text.slice(i);
      // Patterns in priority order (ties at the same index go to the
      // EARLIER pattern: a line comment beats a string, a string beats a
      // keyword, …). First match in the rest of the line wins.
      let best = null; // { idx, cls, re }
      for (const p of PATS) {
        const re = p[0];
        // Empty-array slots (a language with no such pattern) are skipped.
        if (!re || typeof re.exec !== 'function') continue;
        re.lastIndex = 0;
        const mm = re.exec(rest);
        if (!mm) continue;
        if (p[2] && mm.index !== 0) continue; // anchored: only at line start
        if (!best || mm.index < best.idx) {
          best = { idx: mm.index, cls: p[1], re: re };
          if (mm.index === 0) break; // nothing can beat index 0
        }
      }
      if (!best) {
        put(null, text.slice(i));
        break;
      }
      if (best.idx > 0) {
        put(null, text.slice(i, i + best.idx));
        i += best.idx;
      }
      best.re.lastIndex = 0;
      const mm = best.re.exec(text.slice(i));
      const matched = mm ? mm[0] : '';
      put(best.cls, matched);
      i += matched.length;
      if (best.cls === 'tk-cmt' && L.blocks && L.blocks[0] && best.re === L.blocks[0]) blockOpen = true;
      if (matched.length === 0) i++; // safety: never spin
    }
    byText.set(text, html);
    return html;
  }
  // Layout is a GLOBAL preference (host setting afterMath.layoutMode); the
  // webview mirrors it in the mode variable for instant UI feedback and the
  // host echoes the authoritative value back in the next data message.
  let mode = 'unified';
  // Per-line comment box state: line -> open/closed. null = not yet touched:
  // the first render opens every line that has a comment (open by default).
  // Each line remembers its own state across re-renders — opening one line
  // never closes another.
  let commentBoxes = null;
  let editingId = null;
  // Change-group navigation: one anchor per contiguous change group (its
  // first bordered .chg block), in document order. currentChange indexes it.
  let changeAnchors = [];
  let currentChange = -1;
  // The panel auto-scrolls to the first change exactly once on load.
  let scrolledToFirstChange = false;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function post(msg) { vscode.postMessage(msg); }

  function rowLine(cls, no, text, marker, commentable) {
    const div = document.createElement('div');
    div.className = 'row ' + cls;
    if (no != null) div.setAttribute('data-newline', no);
    let gutter = '<span class="ln">' + (no != null ? no : '') + '</span>';
    if (commentable && no != null) {
      gutter += '<button class="addc" data-line="' + no + '" title="Add a comment on this line">+</button>';
    }
    div.innerHTML = '<span class="gutter">' + gutter + '</span><span class="marker">' + marker + '</span><code>' + codeHtml(text) + '</code>';
    return div;
  }

  function sideCell(l, kind) {
    const div = document.createElement('div');
    if (!l) {
      div.className = 'cell ph';
      div.innerHTML = '<span class="gutter"><span class="ln"></span></span><span class="marker"></span><code></code>';
      return div;
    }
    const isAdd = kind === 'add';
    // 'add' renders the CURRENT line (commentable); 'del' the previous one.
    div.className = 'cell ' + (isAdd ? 'add' : 'del');
    if (isAdd && l.no != null) div.setAttribute('data-newline', l.no);
    let gutter = '<span class="ln">' + (l.no != null ? l.no : '') + '</span>';
    if (isAdd) gutter += '<button class="addc" data-line="' + l.no + '" title="Add a comment on this line">+</button>';
    div.innerHTML = '<span class="gutter">' + gutter + '</span><span class="marker">' + (isAdd ? '+' : '-') + '</span><code>' + codeHtml(l.text) + '</code>';
    return div;
  }

  function renderSide(h) {
    const wrap = document.createElement('div');
    wrap.className = 'hunk-side';
    // Additions (current) on the LEFT, removals (previous) on the RIGHT.
    // Each column is ONE bordered change block (green / red).
    const left = document.createElement('div');
    left.className = 'col left' + (h.newLines.length > 0 ? ' chg adds' : '');
    const right = document.createElement('div');
    right.className = 'col right' + (h.oldLines.length > 0 ? ' chg dels' : '');
    const n = Math.max(h.oldLines.length, h.newLines.length);
    for (let i = 0; i < n; i++) {
      left.appendChild(sideCell(h.newLines[i], 'add'));
      right.appendChild(sideCell(h.oldLines[i], 'del'));
    }
    // Scroll rules: the additions (current) side never scrolls; the removals
    // side scrolls above max(additions, 10) lines when it is longer.
    const visible = Math.min(h.oldLines.length, Math.max(h.newLines.length, 10));
    if (h.oldLines.length > visible) {
      right.style.maxHeight = (visible * LH) + 'px';
      right.style.overflowY = 'auto';
    }
    wrap.appendChild(left);
    wrap.appendChild(right);
    return wrap;
  }

  // Only side-by-side goes through renderHunk; unified and hybrid render
  // their hunks inline in render(). Changed lines are bordered in all views.
  function renderHunk(h) {
    return renderSide(h);
  }

  function closeDialog() {
    const old = document.querySelector('.dialogbar');
    if (old) old.remove();
  }

  // Native confirm()/alert() are unreliable in VS Code webviews (they can
  // return false without showing a dialog), so confirmations happen in a
  // fixed, right-aligned inline dialog that stays visible while scrolled.
  function dialog(question, onAction, actionLabel) {
    closeDialog();
    const bar = document.createElement('div');
    bar.className = 'dialogbar';
    bar.innerHTML = '<h4>' + esc(question) + '</h4>';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const go = document.createElement('button');
    go.textContent = actionLabel || 'Confirm';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    actions.appendChild(go);
    actions.appendChild(cancel);
    bar.appendChild(actions);
    document.body.appendChild(bar);
    go.onclick = () => { closeDialog(); onAction(); };
    cancel.onclick = closeDialog;
  }

  function note(text, okLabel) {
    closeDialog();
    const bar = document.createElement('div');
    bar.className = 'dialogbar';
    bar.innerHTML = '<h4>' + esc(text) + '</h4>';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const ok = document.createElement('button');
    ok.textContent = okLabel || 'OK';
    actions.appendChild(ok);
    bar.appendChild(actions);
    document.body.appendChild(bar);
    ok.onclick = closeDialog;
  }

  // The "Commit changes" dialog: always available. Shows how many files are
  // accepted ("n of m"); when not all are, it warns that the remaining ones
  // will be accepted too and asks for confirmation. Then: local commit or
  // pull request, an optional new branch, and (PR only) whether to squash.
  function commitDialog() {
    closeDialog();
    const bar = document.createElement('div');
    bar.className = 'dialogbar';
    const counts = data.fileCounts || { accepted: 0, total: 0 };
    const allAccepted = counts.accepted >= counts.total;
    const h4 = document.createElement('h4');
    h4.textContent = allAccepted
      ? 'Commit the changes? Every file in this review is accepted and the agent commits them the way you choose below.'
      : 'Commit the changes? Only ' + counts.accepted + ' of ' + counts.total + ' files are accepted — committing accepts the remaining ' + (counts.total - counts.accepted) + ' file(s) as well and the agent commits everything.';
    bar.appendChild(h4);
    const note = document.createElement('div');
    note.className = 'commitnote ' + (allAccepted ? 'ok' : 'warn');
    note.textContent = allAccepted
      ? counts.accepted + ' / ' + counts.total + ' files accepted'
      : counts.accepted + ' / ' + counts.total + ' files accepted — ' + (counts.total - counts.accepted) + ' will be accepted now';
    bar.appendChild(note);
    const optLocal = document.createElement('div');
    optLocal.className = 'opt';
    optLocal.innerHTML = '<label><input type="radio" name="commitMode" value="local" checked title="Commit to a local branch and stop there"> Commit to local branch</label>';
    const optPr = document.createElement('div');
    optPr.className = 'opt';
    optPr.innerHTML = '<label><input type="radio" name="commitMode" value="pr" title="Commit and open a pull request"> Create pull request</label>';
    const branchRow = document.createElement('div');
    branchRow.className = 'branchrow';
    branchRow.innerHTML = '<input type="text" placeholder="New branch name (optional) — commits there instead of the current branch">';
    const squashRow = document.createElement('div');
    squashRow.className = 'opt indent disabled';
    squashRow.innerHTML = '<label><input type="checkbox" checked disabled title="Squash the session into a single commit for the pull request"> Squash commit (single commit for the pull request)</label>';
    bar.appendChild(optLocal);
    bar.appendChild(optPr);
    bar.appendChild(branchRow);
    bar.appendChild(squashRow);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const go = document.createElement('button');
    go.textContent = allAccepted ? 'Commit' : 'Accept all & commit';
    go.title = 'Accept every file and let the agent commit the changes';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    actions.appendChild(go);
    actions.appendChild(cancel);
    bar.appendChild(actions);
    document.body.appendChild(bar);
    const branchInput = branchRow.querySelector('input');
    const squashInput = squashRow.querySelector('input');
    const radios = bar.querySelectorAll('input[name="commitMode"]');
    radios.forEach((r) => {
      r.onchange = () => {
        const pr = bar.querySelector('input[name="commitMode"]:checked').value === 'pr';
        squashInput.disabled = !pr;
        squashRow.classList.toggle('disabled', !pr);
      };
    });
    go.onclick = () => {
      const commitMode = bar.querySelector('input[name="commitMode"]:checked').value;
      const branch = branchInput.value.trim();
      const squash = commitMode === 'pr' && squashInput.checked;
      closeDialog();
      post({ type: 'commitChanges', commit: { mode: commitMode, branch: branch, squash: squash } });
    };
    cancel.onclick = closeDialog;
  }

  // Builds (fresh) the comment box for one line. Each open line gets its own
  // box; boxes never share state.
  function buildEditorBox(line) {
    const ed = document.createElement('div');
    ed.className = 'editor';
    ed.setAttribute('data-editorline', line);
    // Header row: title left, minimize icon TOP RIGHT (collapses just this
    // line's box; other lines keep their state).
    const head = document.createElement('div');
    head.className = 'edhead';
    const title = document.createElement('h4');
    title.textContent = 'Comments — line ' + line;
    const minBtn = document.createElement('button');
    minBtn.className = 'minbtn';
    minBtn.textContent = '▾'; // ▾
    minBtn.title = 'Minimize the comment box for this line (the badge stays on the line to reopen it)';
    minBtn.onclick = () => {
      commentBoxes.set(line, false);
      render();
    };
    head.appendChild(title);
    head.appendChild(minBtn);
    ed.appendChild(head);
    data.file.comments
      .filter((c) => c.line === line)
      .forEach((c) => {
        const item = document.createElement('div');
        item.className = 'item' + (c.resolved ? ' resolved' : '');
        const revisedPill = c.revised === true
          ? '<span class="pill-revised" title="The agent revised the code in response to this comment">Revised</span>'
          : '';
        let html = esc(c.text) + revisedPill + '<div class="meta">' + esc(c.author) + ' · ' + new Date(c.createdAt).toLocaleString() + (c.resolved ? ' · resolved' : '') + (c.revised === true ? ' · revised by agent' : '') + '</div>';
        if (c.reply) {
          // The agent's brief reply (1–3 sentences on what it changed).
          html += '<div class="reply"><span class="replylabel">Agent</span> ' + esc(c.reply) +
            (c.replyAt ? ' <span class="replyat">' + new Date(c.replyAt).toLocaleString() + '</span>' : '') + '</div>';
        }
        // Per comment there is only the pencil (edit; reopen when resolved).
        // Resolving is a CHAIN action — the box footer resolves every
        // comment on this line at once.
        html += '<div class="itemactions"><button class="editc" data-id="' + c.id + '" title="' + (c.resolved ? 'Edit this comment (reopens it)' : 'Edit this comment') + '">&#9998;</button></div>';
        item.innerHTML = html;
        ed.appendChild(item);
      });
    const ta = document.createElement('textarea');
    ta.placeholder = 'Add a comment…';
    ed.appendChild(ta);
    // Footer: "Mark Resolved" BOTTOM LEFT (resolves the WHOLE comment chain —
    // every comment on this line — not one comment), "Submit Comment"
    // BOTTOM RIGHT.
    const actions = document.createElement('div');
    actions.className = 'actions';
    const allResolved = data.file.comments.filter((c) => c.line === line).every((c) => c.resolved);
    const resolve = document.createElement('button');
    resolve.className = 'resolvebtn' + (allResolved ? ' on' : '');
    resolve.textContent = allResolved ? '✓ Resolved' : 'Mark Resolved';
    resolve.title = allResolved
      ? 'This comment chain is resolved — click to open it again'
      : 'Mark this whole comment chain (every comment on this line) as resolved';
    resolve.onclick = () => {
      if (allResolved) {
        // Re-open the chain: flip every comment on this line back to open.
        post({ type: 'reopenComments', line: line });
      } else {
        post({ type: 'resolveComments', line: line });
      }
    };
    const submit = document.createElement('button');
    submit.textContent = 'Submit Comment';
    submit.title = 'Add your comment to this line';
    submit.onclick = () => {
      const text = ta.value.trim();
      if (!text) return;
      post({ type: 'addComment', line: line, side: 'right', text: text });
    };
    const left = document.createElement('div');
    left.className = 'left';
    left.appendChild(resolve);
    const right = document.createElement('div');
    right.className = 'right';
    right.appendChild(submit);
    actions.appendChild(left);
    actions.appendChild(right);
    ed.appendChild(actions);
    return ed;
  }

  // Remembered per-line toggle: badge / + clicks flip just that line.
  function setLineOpen(line, open) {
    if (!commentBoxes) {
      commentBoxes = new Map();
      data.file.comments.forEach((c) => commentBoxes.set(c.line, true));
    }
    commentBoxes.set(line, open);
    render();
  }

  // Replaces the item text with an editable textarea for the given comment id.
  function startEdit(itemEl, c) {
    editingId = c.id;
    itemEl.innerHTML = '<div class="meta">' + esc(c.author) + ' · editing</div>';
    const ta = document.createElement('textarea');
    ta.value = c.text;
    itemEl.appendChild(ta);
    const acts = document.createElement('div');
    acts.className = 'itemactions';
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.title = 'Save the edited comment';
    save.onclick = () => {
      const text = ta.value.trim();
      if (!text) return;
      post({ type: 'editComment', id: c.id, text: text });
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.title = 'Discard the edit';
    cancel.onclick = () => render();
    acts.appendChild(save);
    acts.appendChild(cancel);
    itemEl.appendChild(acts);
    ta.focus();
  }

  function attachBadges() {
    document.querySelectorAll('.badge').forEach((b) => b.remove());
    const byLine = new Map();
    data.file.comments.forEach((c) => {
      if (!byLine.has(c.line)) byLine.set(c.line, []);
      byLine.get(c.line).push(c);
    });
    // First render: every line that has a comment opens by default. After
    // that each line keeps the state the user last set it to.
    if (!commentBoxes) {
      commentBoxes = new Map();
      byLine.forEach((_, line) => commentBoxes.set(line, true));
    }
    // Lines that no longer have any comment don't keep a box — unless the
    // user explicitly opened one (via the + button) so they can add a first
    // comment. The box disappears once it is closed or the line goes away.
    commentBoxes.forEach((open, line) => {
      if (!byLine.has(line) && open !== true) commentBoxes.delete(line);
    });
    // Every line whose box is open gets the box — including lines with no
    // comment yet (that is exactly what the + button is for).
    const openLines = new Set();
    commentBoxes.forEach((open, line) => { if (open === true) openLines.add(line); });
    openLines.forEach((line) => {
      const comments = byLine.get(line) ?? [];
      const row = document.querySelector('[data-newline="' + line + '"]');
      if (!row) { commentBoxes.delete(line); return; }
      const gutter = row.querySelector('.gutter');
      if (comments.length > 0 && gutter) {
        const open = comments.filter((c) => !c.resolved).length;
        const badge = document.createElement('span');
        badge.className = 'badge' + (open === 0 ? ' resolved' : '');
        badge.textContent = String(comments.length);
        badge.title = comments.map((c) => (c.resolved ? '[resolved] ' : '') + c.text).join('\\n');
        const isOpen = commentBoxes.get(line) === true;
        badge.onclick = (e) => { e.stopPropagation(); setLineOpen(line, !isOpen); };
        gutter.appendChild(badge);
      }
      row.insertAdjacentElement('afterend', buildEditorBox(line));
    });
  }

  // Comments can carry a stale line number (added in an earlier round when
  // the file was longer/shorter). Re-anchor each one to the nearest line
  // that still exists so its pill lands on a real line.
  function reanchorStaleComments() {
    let maxLine = 0;
    const consider = (l) => { if (l.no != null && l.no > maxLine) maxLine = l.no; };
    data.blocks.forEach((b) => {
      if (b.kind === 'context') {
        b.lines.forEach(consider);
      } else {
        b.newLines.forEach(consider);
        b.contextAfter.forEach(consider);
      }
    });
    if (maxLine === 0) return;
    let changed = false;
    data.file.comments.forEach((c) => {
      if (c.line > maxLine) {
        c.line = maxLine;
        changed = true;
      }
    });
    if (changed) post({ type: 'reanchorComments', comments: data.file.comments });
  }

  function renderDiscussion() {
    const list = document.getElementById('dList');
    const box = document.getElementById('discussion');
    // Re-renders (post, answer, quick status) must not yank the discussion
    // box back to the top while the user is reading it.
    const prevScroll = box ? box.scrollTop : 0;
    list.innerHTML = '';
    data.file.discussion.forEach((d) => {
      const div = document.createElement('div');
      div.className = 'ditem' + (d.answered ? ' answered' : '');
      const revisedPill = d.revised === true
        ? '<span class="pill-revised" title="The agent revised the code in response to this entry">Revised</span>'
        : '';
      // Who wrote this entry: the AI agent (robot + its name) or you.
      const who = isAgentAuthor(d.author)
        ? '<span class="who agent" title="Written by the AI agent">' + robotIcon() + '<span class="who-name">' + esc(agentDisplayName()) + '</span></span>'
        : '<span class="who human" title="Written by you">You</span>';
      // Body: who + text (newlines preserved) + revised pill + meta + reply.
      const body = document.createElement('div');
      body.className = 'dbody';
      body.innerHTML = who + esc(d.text) + revisedPill +
        '<div class="dmeta">— ' + esc(d.author) + ' · ' + new Date(d.createdAt).toLocaleString() + (d.answered ? ' · answered' : '') + (d.revised === true ? ' · revised by agent' : '') + '</div>';
      if (d.reply) {
        // The agent's brief reply to this entry.
        const reply = document.createElement('div');
        reply.className = 'reply';
        reply.innerHTML = '<span class="replylabel">Agent</span> ' + esc(d.reply) +
          (d.replyAt ? ' <span class="replyat">' + new Date(d.replyAt).toLocaleString() + '</span>' : '');
        body.appendChild(reply);
      }
      div.appendChild(body);
      // Footer: the answer/resolve action pinned to the BOTTOM RIGHT of the
      // whole entry (it applies to that whole discussion entry).
      const foot = document.createElement('div');
      foot.className = 'dfoot';
      if (d.answered) {
        // Visible "answered" indicator (green pill); clicking it re-opens
        // the entry (back to unanswered).
        foot.innerHTML = '<button class="answerpill" data-dact="unanswer" data-id="' + d.id + '" title="Answered — click to open this entry again">✓ answered</button>';
      } else {
        foot.innerHTML = '<button data-dact="answer" data-id="' + d.id + '" class="answerbtn" title="Mark this discussion entry as answered">✓</button>';
      }
      div.appendChild(foot);
      list.appendChild(div);
    });
    if (box) box.scrollTop = prevScroll;
  }

  // Is this author the session's code reviewer (the AI agent)? Compared
  // case-insensitively on the account part ("claude@devbox" matches "claude").
  function isAgentAuthor(author) {
    const agent = (data.sessionAgent || '').trim().toLowerCase();
    const a = String(author || '').trim().toLowerCase();
    if (!agent || !a) return false;
    if (a === agent) return true;
    return a.split('@')[0] === agent.split('@')[0];
  }

  // The agent's display name for the pill: the manifest's agent value with
  // any "@host" suffix dropped (falls back to "Agent" when the manifest has
  // no agent name).
  function agentDisplayName() {
    const raw = (data.sessionAgent || '').trim().split('@')[0];
    return raw || 'Agent';
  }

  // Small inline robot (the webview is self-contained — no codicon font).
  function robotIcon() {
    return '<svg class="robot" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
      '<rect x="2.5" y="4.5" width="11" height="9" rx="1.6" fill="currentColor"/>' +
      '<rect x="4.4" y="6.9" width="2.4" height="2.4" rx="0.7" fill="#1e1e1e"/>' +
      '<rect x="9.2" y="6.9" width="2.4" height="2.4" rx="0.7" fill="#1e1e1e"/>' +
      '<rect x="5.4" y="10.6" width="5.2" height="1.1" rx="0.55" fill="#1e1e1e"/>' +
      '<path d="M8 2.6v1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/>' +
      '<circle cx="8" cy="2.1" r="1.15" fill="currentColor"/>' +
      '</svg>';
  }

  function statsSpan(s) {
    return '<span class="add">+' + s.added + '</span> <span class="del">-' + s.removed + '</span>';
  }

  // Size --page-w on #content to the widest row anywhere in the rendered
  // diff (a row's scrollWidth = gutter + marker + its full, untruncated
  // pre-formatted line). Change blocks and rows take this as their
  // min-width, so the bordered change box fills the ENTIRE width of the
  // code: when the horizontal scrollbar is scrolled, the box stays as wide
  // as the longest line instead of being left behind by the code. A couple
  // of passes — stretching the rows to the new width can only ever make
  // them measure the same width back (scrollWidth >= content), so this
  // converges immediately.
  function syncPageWidth() {
    const content = document.getElementById('content');
    if (!content) return;
    let w = 0;
    for (let pass = 0; pass < 3; pass++) {
      let widest = 0;
      content.querySelectorAll('.row').forEach((r) => {
        if (r.scrollWidth > widest) widest = r.scrollWidth;
      });
      if (widest <= w) break;
      w = widest;
      content.style.setProperty('--page-w', w + 'px');
    }
    if (w === 0) content.style.removeProperty('--page-w');
  }

  // The status UI only (status pill, accept/revise buttons, file counters,
  // AI-updated chip) — factored out of render() so the host's quick status
  // push can flip it WITHOUT re-rendering the diff.
  function applyStatusUi() {
    document.getElementById('fileCounts').innerHTML =
      data.fileCounts
        ? '<span class="add">' + data.fileCounts.accepted + '</span>/' + data.fileCounts.total + ' files'
        : '';
    const chip = document.getElementById('statusChip');
    chip.textContent = data.file.status.replace('_', ' ');
    chip.className = 'chip-' + data.file.status;
    // "AI updated this file": only after a revision round — the agent changed
    // the code in response to feedback (revised: true on the comment or
    // discussion entry, alongside its reply). Never on the initial review,
    // where the file keeps its pencil / + / - icon.
    const revisedFeedback =
      data.file.comments.some((c) => c.revised === true) ||
      data.file.discussion.some((d) => d.revised === true);
    document.getElementById('aiChip').hidden =
      !(revisedFeedback && data.file.status !== 'accepted');
    const readyBtn = document.getElementById('btnReady');
    const on = data.file.ready === true;
    readyBtn.classList.toggle('on', on);
    readyBtn.textContent = on ? '✓ Revise' : 'Revise';
    // Accept: toggle this file's accepted status (does not release the agent).
    const acceptBtn = document.getElementById('btnAccept');
    const isAccepted = data.file.status === 'accepted';
    acceptBtn.textContent = isAccepted ? '✓ Accept' : 'Accept';
    acceptBtn.title = isAccepted
      ? 'This file is accepted. Click to un-accept it (back to needs review).'
      : 'Accept THIS file. The agent keeps waiting until the whole review is committed (or you revise a file).';
    // Session-level button: "Commit changes" is ALWAYS clickable — the
    // dialog shows "n of m files accepted" and asks before committing
    // everything. The host accepts any remaining files on confirm.
    const prBtn = document.getElementById('btnPR');
    prBtn.disabled = false;
    prBtn.title = 'Let the agent commit the changes — to a local branch or as a pull request (your choice in the dialog). Files you have not accepted yet are accepted too, after you confirm.';
  }

  // Jump the diff view to change group i (smooth). The anchor's TOP is
  // aligned with the top of #content, so the whole group is visible from its
  // first line — including groups whose border is a few context lines below
  // the hunk element's top.
  function jumpToChange(i) {
    const content = document.getElementById('content');
    const el = changeAnchors[i];
    if (!el) return;
    currentChange = i;
    content.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
    updateChangeButtons();
  }

  // Derive which change group is CURRENT from where the view actually is —
  // buttons AND manual scrolling both move the view, so the buttons must
  // follow the scroll position (otherwise they wrap/gray out out of sync
  // with the view). current = the last group whose top is at or above the
  // viewport top + a small epsilon (the group the user is reading now).
  function syncChangeFromScroll() {
    const content = document.getElementById('content');
    const top = content.scrollTop;
    let cur = -1;
    for (let i = 0; i < changeAnchors.length; i++) {
      if (changeAnchors[i].offsetTop <= top + 8) cur = i;
    }
    currentChange = cur;
    updateChangeButtons();
  }

  function updateChangeButtons() {
    const prev = document.getElementById('btnPrevChange');
    const next = document.getElementById('btnNextChange');
    // No wrap-around: at the last group "next" is disabled (staying put), at
    // the first group "prev" is disabled. Before the first group (top of
    // page, no group visible yet) only "next" is enabled.
    prev.disabled = currentChange <= 0;
    next.disabled = currentChange < 0 || currentChange >= changeAnchors.length - 1;
  }

  // Scroll listener: keep the buttons in sync with MANUAL scrolling (rAF-
  // throttled so a fast fling costs one pass per frame).
  let scrollRaf = 0;
  document.getElementById('content').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      syncChangeFromScroll();
    });
  });

  // Previous / next group of changes (the two buttons left of Accept).
  // Clamped, never wrapping: hitting ↓ at the bottom stays put (button
  // grayed out), hitting ↑ at the top stays put.
  document.getElementById('btnPrevChange').onclick = () => {
    if (currentChange < 0) { currentChange = 0; updateChangeButtons(); return; }
    jumpToChange(Math.max(0, currentChange - 1));
  };
  document.getElementById('btnNextChange').onclick = () => {
    if (currentChange < 0) { jumpToChange(0); return; }
    if (currentChange >= changeAnchors.length - 1) return; // already at the bottom
    jumpToChange(currentChange + 1);
  };

  // --- code hover type info + right-click context menu ---------------------
  // The webview is plain HTML (no editor), so type info comes from the host's
  // TypeScript language service: hovering a code line round-trips
  // {line, column} and the answer renders as an SCM-diff-style tooltip.
  let hoverTimer = 0;
  let hoverToken = 0;
  let hoverState = null; // { line, col, x, y, row } — the line under the mouse
  let hoverTipEl = null;
  let ctxMenuEl = null;
  let measureSpan = null; // hidden span used to measure the monospace char width

  function charWidth() {
    if (!measureSpan) {
      measureSpan = document.createElement('span');
      measureSpan.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--vscode-editor-font-family, monospace);font-size:12.5px;';
      measureSpan.textContent = '00000000000000000000000000000000';
      document.body.appendChild(measureSpan);
    }
    const w = measureSpan.getBoundingClientRect().width / measureSpan.textContent.length;
    return w > 0 ? w : 7.6;
  }
  /** 0-based column under the mouse, from the code span's own geometry. */
  function colAt(codeEl, clientX) {
    const r = codeEl.getBoundingClientRect();
    if (clientX <= r.left) return 0;
    return Math.min(5000, Math.max(0, Math.floor((clientX - r.left) / charWidth())));
  }

  function closeHoverTip() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    hoverToken++; // invalidate any in-flight answer
    hoverState = null;
    if (hoverTipEl) { hoverTipEl.remove(); hoverTipEl = null; }
  }

  function placeHoverTip() {
    if (!hoverTipEl || !hoverState) return;
    const content = document.getElementById('content');
    const cr = content.getBoundingClientRect();
    // Absolute inside #content: page coords minus the content box, plus the
    // current scroll (the tip must stick to the CODE, not the viewport).
    let left = hoverState.x - cr.left + content.scrollLeft + 14;
    let top = hoverState.y - cr.top + content.scrollTop + 16;
    const tw = hoverTipEl.offsetWidth;
    const th = hoverTipEl.offsetHeight;
    // Flip up / left when the tip would run past the visible box.
    if (left + tw > content.clientWidth - 6) left = hoverState.x - cr.left + content.scrollLeft - tw - 14;
    if (top + th > content.clientHeight - 6) top = Math.max(4, hoverState.y - cr.top + content.scrollTop - th - 12);
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    hoverTipEl.style.left = left + 'px';
    hoverTipEl.style.top = top + 'px';
  }

  function onCodeMouseMove(e) {
    const code = e.target.closest ? e.target.closest('code') : null;
    // '.row' (unified/hybrid) or '.cell' (side-by-side); only the current
    // (add) side carries data-newline, so deleted lines stay inert.
    const row = code ? (code.closest('.row') || code.closest('.cell')) : null;
    const line = row ? row.getAttribute('data-newline') : null;
    if (!code || !row || line === null || !data || !isSupportedFile(data.fileName)) {
      closeHoverTip();
      return;
    }
    const col = colAt(code, e.clientX);
    hoverState = { line: parseInt(line, 10), col: col, x: e.clientX, y: e.clientY, row: row };
    if (hoverTipEl) placeHoverTip(); // stick to the mouse while already shown
    if (hoverTimer) clearTimeout(hoverTimer);
    const token = ++hoverToken;
    const lineNo = hoverState.line;
    const colNo = hoverState.col;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (token !== hoverToken || !hoverState || hoverState.line !== lineNo || hoverState.col !== colNo) return;
      post({ type: 'codeHover', line: lineNo, col: colNo });
    }, 350);
  }

  function isSupportedFile(name) {
    const e = (name || '').split('.').pop().toLowerCase();
    return ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'].includes(e);
  }

  // Delegated on document.body: comment boxes and the gutter are inside
  // #content too, and the menu must close when the mouse leaves the code.
  document.body.addEventListener('mousemove', (e) => {
    const t = e.target;
    const overCode = t instanceof Element && t.closest && t.closest('#content code');
    if (overCode) onCodeMouseMove(e);
    else if (hoverTipEl || hoverTimer) closeHoverTip();
  });
  document.getElementById('content').addEventListener('scroll', closeHoverTip);

  function closeCtxMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  document.body.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const code = t instanceof Element && t.closest ? t.closest('#content code') : null;
    // '.row' (unified/hybrid) or '.cell' (side-by-side) — both carry
    // data-newline on the current (add) side.
    const row = code ? (code.closest('.row') || code.closest('.cell')) : null;
    const lineAttr = row ? row.getAttribute('data-newline') : null;
    if (!code || !row || lineAttr === null) { closeCtxMenu(); return; }
    e.preventDefault();
    closeHoverTip();
    closeCtxMenu();
    const lineNo = parseInt(lineAttr, 10);
    const colNo = colAt(code, e.clientX);
    const menu = document.createElement('div');
    menu.className = 'codectx';
    const mkItem = (text, title, action) => {
      const item = document.createElement('div');
      item.className = 'ctx-item';
      item.textContent = text;
      item.title = title;
      item.onclick = () => {
        closeCtxMenu();
        post({ type: 'codeContext', line: lineNo, col: colNo, action: action });
      };
      menu.appendChild(item);
    };
    mkItem('Go to Definition', 'Open the file containing the definition of this symbol in a new tab', 'goDef');
    mkItem('Open File in New Tab', 'Open this file (the one under review) in a new editor tab', 'openFile');
    document.body.appendChild(menu);
    // Keep the menu inside the viewport.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let mx = e.clientX;
    let my = e.clientY;
    if (mx + mw > window.innerWidth - 4) mx = Math.max(4, window.innerWidth - mw - 4);
    if (my + mh > window.innerHeight - 4) my = Math.max(4, window.innerHeight - mh - 4);
    menu.style.left = mx + 'px';
    menu.style.top = my + 'px';
    ctxMenuEl = menu;
    // Dismiss on any click / escape / scroll that is not the menu itself.
    const dismiss = (ev) => {
      if (ctxMenuEl && !ctxMenuEl.contains(ev.target)) closeCtxMenu();
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') closeCtxMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', dismiss, true);
      document.addEventListener('scroll', dismiss, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });

  function render() {
    closeHoverTip(); // the tip lives inside #content, which render() replaces
    if (!data) return;
    // (Re)derive the file's language and reset the block-comment state —
    // the first line rendered can never be inside a /* … */ started earlier.
    lang = langOf(data.fileName);
    blockOpen = false;
    const loading = document.getElementById('loading');
    if (loading) loading.remove();
    document.getElementById('fname').textContent = data.fileName;
    document.getElementById('fileStats').innerHTML = statsSpan(data.fileStats);
    document.getElementById('sessionStats').innerHTML =
      '(' + statsSpan(data.sessionStats) + ')';
    // Keep the settings select in sync with the (global) layout preference.
    document.querySelectorAll('#settingsMenu [data-mode]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    applyStatusUi();
    const content = document.getElementById('content');
    // Remember where the user is (re-renders must not yank the view back to
    // the top or to the first change — data messages arrive on every
    // comment/accept/status change while they are reading).
    const prevScroll = scrolledToFirstChange ? content.scrollTop : 0;
    content.innerHTML = '';
    const ctxRow = (l) => rowLine('ctx', l.no, l.text, '', true);
    const hunkEls = []; // rendered element for each change group, in order
    data.blocks.forEach((b) => {
      if (b.kind === 'context') {
        const wrap = document.createElement('div');
        wrap.className = 'ctx-block';
        b.lines.forEach((l) => wrap.appendChild(ctxRow(l)));
        content.appendChild(wrap);
      } else {
        // Every view: the contiguous change block carries ONE green/red
        // border + line backgrounds; nothing else is bordered.
        const twoSided = b.oldLines.length > 0 && b.newLines.length > 0;
        const sideBySide = mode === 'side' ||
          (mode === 'hybrid' && twoSided && b.oldLines.length + b.newLines.length >= data.hybridThreshold);
        if (sideBySide) {
          content.appendChild(renderHunk(b));
          hunkEls.push(content.lastChild);
        } else {
          const wrap = document.createElement('div');
          // The whole contiguous change (removed lines followed by added
          // lines) is ONE bordered block: red around the removals run, green
          // around the additions run. A single changed line gets a border
          // around that one line (same rule, one-row group).
          if (b.contextBefore.length > 0) {
            const cb = document.createElement('div');
            b.contextBefore.forEach((l) => cb.appendChild(ctxRow(l)));
            wrap.appendChild(cb);
          }
          if (b.oldLines.length > 0) {
            const dg = document.createElement('div');
            dg.className = 'chg dels';
            b.oldLines.forEach((l) => dg.appendChild(rowLine('del', l.no, l.text, '-', false)));
            wrap.appendChild(dg);
          }
          if (b.newLines.length > 0) {
            const ag = document.createElement('div');
            ag.className = 'chg adds';
            b.newLines.forEach((l) => ag.appendChild(rowLine('add', l.no, l.text, '+', true)));
            wrap.appendChild(ag);
          }
          b.contextAfter.forEach((l) => wrap.appendChild(ctxRow(l)));
          content.appendChild(wrap);
          hunkEls.push(wrap);
        }
      }
    });
    attachBadges();
    renderDiscussion();
    // Stretch change blocks + rows to the widest line of the WHOLE file so
    // the horizontal scroll never separates the change box from the code.
    syncPageWidth();
    // Change-group navigation: anchor each rendered change group at its first
    // bordered block (in side-by-side the first .chg is the additions column;
    // in unified it is the red removals run or the single line's border).
    changeAnchors = hunkEls.map((el) => {
      const chg = el.querySelector('.chg');
      return chg || el;
    });
    // First load only: scroll straight to the first group of changes.
    if (!scrolledToFirstChange && changeAnchors.length > 0) {
      scrolledToFirstChange = true;
      currentChange = 0;
      jumpToChange(0);
    } else {
      // Subsequent renders: restore the reading position (the re-render may
      // have grown/shrunk the content above the viewport).
      content.scrollTop = prevScroll;
      syncChangeFromScroll();
    }
  }

  // Delegated from document.body (NOT just #content): the "answer" button
  // lives in the #discussion box, which is a sibling of #content — listening
  // on #content alone made the ✓ button a dead click.
  document.body.addEventListener('click', (e) => {
    const t = e.target;
    const el = t instanceof Element ? t : null;
    if (!el) return;
    const addc = el.closest('.addc');
    if (addc) {
      const line = parseInt(addc.getAttribute('data-line'), 10);
      // Opening one line's box never closes another line's.
      if (commentBoxes && commentBoxes.get(line) === true) return;
      setLineOpen(line, true);
      return;
    }
    const ed = el.closest('.editc');
    if (ed) {
      const id = ed.getAttribute('data-id');
      const c = data.file.comments.find((x) => x.id === id);
      const itemEl = el.closest('.item');
      if (c && itemEl) startEdit(itemEl, c);
      return;
    }
    const ans = el.closest('[data-dact="answer"]');
    if (ans) {
      post({ type: 'answerDiscussion', id: ans.getAttribute('data-id') });
      return;
    }
    const unans = el.closest('[data-dact="unanswer"]');
    if (unans) {
      post({ type: 'unanswerDiscussion', id: unans.getAttribute('data-id') });
      return;
    }
  });

  // Settings menu (gear): toggles the panel; picking a layout applies it
  // globally (host setting) — every review panel follows the same layout.
  const settingsMenu = document.getElementById('settingsMenu');
  const gearBtn = document.getElementById('btnSettings');
  gearBtn.onclick = (e) => {
    e.stopPropagation();
    const willShow = settingsMenu.hidden;
    settingsMenu.hidden = !willShow;
    gearBtn.classList.toggle('on', willShow);
  };
  document.querySelectorAll('#settingsMenu [data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.getAttribute('data-mode');
      post({ type: 'setLayoutMode', mode: mode });
      render();
    };
  });
  document.addEventListener('click', (e) => {
    if (settingsMenu.hidden) return;
    if (settingsMenu.contains(e.target) || gearBtn.contains(e.target)) return;
    settingsMenu.hidden = true;
    gearBtn.classList.remove('on');
  });

  // Per-file: accept / un-accept this file (no agent release).
  document.getElementById('btnAccept').onclick = () => {
    post({ type: 'acceptFile', accept: data.file.status !== 'accepted' });
  };

  // Per-file: release this file (needs open feedback on THIS file).
  document.getElementById('btnReady').onclick = () => {
    const turningOn = data.file.ready !== true;
    if (turningOn) {
      dialog('Release this file to the agent now? It will start working on the open comments right away — even if the rest of the review is not finished.', () => {
        post({ type: 'setReady', ready: true });
      }, 'Yes, release it');
    } else {
      post({ type: 'setReady', ready: false });
    }
  };

  // Session-level: release every file that has open feedback.
  document.getElementById('btnRevise').onclick = () => {
    dialog('Release every file in this review that has open comments or discussion? The agent works on all of them at once and waits for your review of the result.', () => {
      post({ type: 'requestRevision' });
    }, 'Yes, wait for agent');
  };

  // Session-level: accept everything, then commit (local or PR). The host
  // verifies no open feedback anywhere in the session.
  document.getElementById('btnPR').onclick = commitDialog;

  document.getElementById('dPost').onclick = () => {
    const ta = document.getElementById('dInput');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    post({ type: 'draft', text: '' }); // draft is no longer un-posted
    post({ type: 'addDiscussion', text: text });
  };
  // Mirror the un-posted discussion draft to the host on every change — the
  // tab-close guard (the host cannot cancel a webview panel's dispose).
  const dInputBox = document.getElementById('dInput');
  dInputBox.addEventListener('input', () => {
    post({ type: 'draft', text: dInputBox.value });
  });
  document.getElementById('dInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('dPost').click();
  });

  // Briefly outlines the discussion box so a "Cancel" lands the user right on
  // their un-posted text.
  function flashDiscussion() {
    const box = document.getElementById('discussion');
    box.style.outline = '2px solid #6cb6ff';
    box.style.outlineOffset = '-2px';
    setTimeout(() => {
      box.style.outline = '';
      box.style.outlineOffset = '';
    }, 1200);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    // Host round-trips (askWebview): the host asks about / acts on the
    // un-posted discussion before taking this tab over or closing it.
    if (msg.type === 'hasUnposted') {
      vscode.postMessage({ type: 'reply', id: msg.id, value: document.getElementById('dInput').value.trim().length > 0 });
      return;
    }
    if (msg.type === 'viewClosed') {
      // The host is about to swap this tab to a DIFFERENT file (the user
      // picked another file in the left panel). Acknowledge — the host does
      // the reviewed-stamp write itself.
      vscode.postMessage({ type: 'reply', id: msg.id, value: true });
      return;
    }
    if (msg.type === 'gotoUnposted') {
      const dInput = document.getElementById('dInput');
      document.getElementById('discussion').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      dInput.focus();
      flashDiscussion();
      return;
    }
    if (msg.type === 'clearUnposted') {
      const ta = document.getElementById('dInput');
      ta.value = '';
      post({ type: 'draft', text: '' });
      return;
    }
    if (msg.type === 'restoreDraft') {
      // The host restored an un-posted draft after its tab was closed.
      const ta = document.getElementById('dInput');
      ta.value = String(msg.text ?? '');
      post({ type: 'draft', text: ta.value });
      document.getElementById('discussion').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      ta.focus();
      flashDiscussion();
      return;
    }
    if (msg.type === 'data') {
      // fileCounts is session-wide: keep it fresh from every data message.
      if (data && msg.data.fileCounts) data.fileCounts = msg.data.fileCounts;
      const prevFile = data ? data.fileName : null;
      data = msg.data;
      // The layout is a global preference: adopt the host's authoritative
      // value (covers other panels and the initial load).
      if (msg.data.layoutMode && msg.data.layoutMode !== mode) mode = msg.data.layoutMode;
      // The tab was handed to a DIFFERENT file: drop the old file's
      // highlight cache so its lines can't leak into the new file's view.
      if (prevFile && prevFile !== data.fileName) tokCache.delete(prevFile);
      reanchorStaleComments();
      render();
    }
    if (msg.type === 'quick') {
      // Fast status push from the host (accept/ready/answer/resolve or a
      // right-click status): flip the status UI + discussion NOW — no diff
      // recompute, no re-render of the code. The full data message follows
      // shortly via the file watcher.
      if (!data) return;
      if (msg.file) {
        data.file = msg.file;
        renderDiscussion();
      }
      if (msg.fileCounts) data.fileCounts = msg.fileCounts;
      if (typeof msg.sessionOpen === 'boolean') data.sessionOpen = msg.sessionOpen;
      applyStatusUi();
    }
    if (msg.type === 'hoverResult') {
      // Answer to a codeHover round-trip. If the mouse has moved ONTO ANOTHER
      // LINE while the (first, slow) lookup ran, the answer is for a line
      // the user already left — a small drift (a few lines) is fine, the
      // symbol is almost always the same; a big jump is discarded.
      if (!hoverState) {
        closeHoverTip();
        return;
      }
      if (Math.abs(msg.line - hoverState.line) > 3) {
        closeHoverTip();
        return;
      }
      if (!msg.result || !msg.result.hover) {
        closeHoverTip();
        return;
      }
      if (!hoverTipEl) {
        hoverTipEl = document.createElement('div');
        hoverTipEl.className = 'codetip';
        const content = document.getElementById('content');
        if (content) content.appendChild(hoverTipEl);
      }
      const h = msg.result.hover;
      const callHint = h.callable ? ' <span style="color:#888">()  (call)</span>' : '';
      hoverTipEl.innerHTML =
        '<div class="ct-kind">' + esc(h.kind) + callHint + '</div>' +
        (h.text && h.text !== h.kind ? '<div class="ct-text">' + esc(h.text) + '</div>' : '');
      placeHoverTip();
      return;
    }
    if (msg.type === 'readyBlocked') {
      note(msg.reason === 'no-feedback' ? 'Add a comment or a discussion entry to this file first — Revise releases your feedback to the agent, so there is nothing to release yet.' : 'This file cannot be released to the agent right now.');
    }
    if (msg.type === 'sessionUpdated') {
      if (msg.commit && msg.commit.mode === 'pr') {
        note('Review accepted. The agent will commit ' + (msg.commit.branch ? 'on branch ' + msg.commit.branch + ' ' : '') + (msg.commit.squash ? 'a squashed commit and ' : '') + 'open a pull request.', 'OK');
      } else if (msg.commit) {
        note('Review accepted. The agent will commit the changes ' + (msg.commit.branch ? 'on new branch ' + msg.commit.branch + '.' : 'to the current branch.'), 'OK');
      } else {
        note('Review updated — the agent has been notified.', 'OK');
      }
    }
  });

  // Tell the extension host the script is live so it can (re)send the data.
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
