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
import { getBaseLines, getCurrentLines } from './git';

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
}

const panels = new Map<string, vscode.WebviewPanel>();
let onSessionsChanged: (() => void) | undefined;

export function setSessionsChangedListener(cb: () => void): void {
  onSessionsChanged = cb;
}

function repoRootOf(sessionDir: string): string {
  return path.resolve(sessionDir, '..', '..', '..');
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
  for (const p of manifest.files) {
    const base = (await getBaseLines(repoRoot, manifest.baseRef, p)) ?? [];
    const current = getCurrentLines(repoRoot, p);
    const s = statsOf(computeBlocks(base, current, context));
    added += s.added;
    removed += s.removed;
  }
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

export async function openReviewPanel(
  sessionDir: string,
  manifest: Manifest,
  filePath: string
): Promise<void> {
  const key = sessionDir + '::' + filePath;
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  const repoRoot = repoRootOf(sessionDir);
  const baseLines = (await getBaseLines(repoRoot, manifest.baseRef, filePath)) ?? [];
  const currentLines = getCurrentLines(repoRoot, filePath);
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
    blocks: computeBlocks(baseLines, currentLines, context),
    author,
    hybridThreshold: threshold,
    layoutMode: layoutMode(),
    fileStats: statsOf(computeBlocks(baseLines, currentLines, context)),
    sessionStats: { added: 0, removed: 0 },
    fileCounts: sessionFileCounts(sessionDir),
    sessionOpen: sessionHasOpen(sessionDir),
  };
  // Session totals are async (they git-show every file); fill them in before
  // the first send so the webview never shows a stale zero total.
  void sessionStats(repoRoot, manifest, context).then((s) => {
    data.sessionStats = s;
  });

  const panel = vscode.window.createWebviewPanel(
    'afterMathReview',
    `Review: ${path.basename(filePath)}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panels.set(key, panel);
  let disposed = false;
  panel.onDidDispose(() => {
    disposed = true;
    panels.delete(key);
  });
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
  const send = () => {
    if (disposed) return;
    data.file = load();
    data.layoutMode = layoutMode();
    data.fileCounts = sessionFileCounts(sessionDir);
    data.sessionOpen = sessionHasOpen(sessionDir);
    // Keep the session totals fresh without blocking the send: refresh in the
    // background and re-send once the git show round-trips are done.
    void sessionStats(repoRoot, manifest, context).then((s) => {
      if (disposed) return;
      const changed = s.added !== data.sessionStats.added || s.removed !== data.sessionStats.removed;
      data.sessionStats = s;
      if (changed) void panel.webview.postMessage({ type: 'data', data });
    });
    void panel.webview.postMessage({ type: 'data', data });
  };
  send();

  panel.webview.onDidReceiveMessage(async (msg: {
    type: string;
    line?: number;
    side?: 'left' | 'right';
    text?: string;
    id?: string;
    ready?: boolean;
    accept?: boolean;
    comments?: ReviewComment[];
    commit?: CommitOptions;
    mode?: string;
  }) => {
    if (msg.type === 'ready') {
      send();
      return;
    }
    try {
      // Authoritative per-file read (the webview's copy may be stale).
      const fr = load();
      const now = new Date().toISOString();
      let notify = false;
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
        case 'resolveComment': {
          // Resolve exactly ONE comment (by id), never the whole file.
          const c = fr.comments.find((x) => x.id === msg.id);
          if (c) {
            c.resolved = true;
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
          break;
        }
        case 'acceptFile': {
          // Per-file: toggle accepted. Accepting does NOT release the agent —
          // it keeps waiting until the review is committed or a file is
          // revised. Un-accepting sends the file back to needs review.
          fr.status = msg.accept === false ? 'needs_review' : 'accepted';
          fr.updatedAt = now;
          writeFileReview(sessionDir, fr);
          notify = true;
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
          // Session-level: every file is accepted — but only when the whole
          // session has no open feedback (authoritative disk read). The
          // human's commit options are recorded in the manifest for the agent.
          const session = readSession(sessionDir);
          if (!session) break;
          if (sessionHasOpenFeedback(session)) {
            void panel.webview.postMessage({ type: 'prBlocked', reason: 'open-feedback' });
            return;
          }
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
            send();
          }
          return;
        }
        default:
          return;
      }
      if (notify) {
        send();
        onSessionsChanged?.();
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

  #toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  #toolbar .fname { font-weight: 600; margin-right: 4px; }
  #statusChip { padding: 1px 8px; border-radius: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  .chip-needs_review { background: #8a6d1a66; color: #e0b341; }
  .chip-in_review { background: #2a5a8a66; color: #6cb6ff; }
  .chip-accepted { background: #2a7a2a66; color: #6fce6f; }
  .chip-rejected { background: #8a2a2a66; color: #ff8080; }
  button { font-family: inherit; font-size: 12px; color: var(--fg); background: var(--vscode-button-secondaryBackground, #3a3a3a); border: 1px solid var(--border); border-radius: 3px; padding: 2px 8px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
  button.active { outline: 1px solid var(--fg); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.acceptbtn { color: var(--add-fg); }
  button.revise { color: var(--del-fg); }
  button.pr { color: var(--add-fg); }
  button.readybtn { color: #6cb6ff; }
  button.readybtn.on { background: #2a5a8a66; color: #6cb6ff; outline: 1px solid #6cb6ff; }
  .stats { font-size: 11px; white-space: nowrap; }
  .stats .add { color: var(--add-fg); font-weight: 600; }
  .stats .del { color: var(--del-fg); font-weight: 600; }
  .stats.muted { opacity: 0.85; }
  button.gear { font-size: 14px; padding: 0 7px; line-height: 18px; }
  button.gear.on { outline: 1px solid var(--fg); }
  /* Settings menu: fixed so it stays visible while the diff is scrolled. */
  .settingsmenu { position: fixed; top: 44px; right: 8px; width: 280px; z-index: 60; background: var(--bg); border: 1px solid var(--border); border-left: 3px solid #6cb6ff; border-radius: 3px; padding: 8px 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
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
     content edge and must never be clipped by the scroll container. */
  #content { flex: 1; overflow: auto; padding: 2px 2px 14px; position: relative; }

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
     it is one square border around the whole contiguous change section. */
  .row code, .cell code { flex: 1; height: var(--lh); overflow: hidden; text-overflow: ellipsis; }
  .chg { border: 1px solid var(--linec); }
  .chg.adds { --linec: var(--add-line); }
  .chg.dels { --linec: var(--del-line); }
  .chg.adds code { background: var(--add-bg); }
  .chg.dels code { background: var(--del-bg); }
  .chg.adds .marker { color: var(--add-fg); }
  .chg.dels .marker { color: var(--del-fg); }
  .row.ctx { color: var(--ctx-fg); }

  .addc { display: none; width: 16px; height: 16px; line-height: 14px; padding: 0; margin-right: 2px; font-size: 11px; border-radius: 3px; }
  .row:hover .addc, .cell:hover .addc { display: inline-block; }

  .badge { min-width: 16px; height: 15px; padding: 0 4px; font-size: 10px; border-radius: 8px; background: #b48a2a; color: #1e1e1e; font-weight: 700; display: inline-block; text-align: center; }
  .badge.resolved { background: #4a6a4a; color: #cfe8cf; }

  .hunk-side { display: flex; gap: 6px; }
  .hunk-side .col { flex: 1; min-width: 0; }
  .cell.ph { background: rgba(128,128,128,0.08); }

  /* Inline confirm/note dialog: fixed so it is always visible, contents
     right-aligned. */
  .dialogbar { position: fixed; top: 44px; right: 8px; left: auto; width: 440px; max-width: calc(100% - 16px); z-index: 50; background: var(--bg); border: 1px solid var(--border); border-left: 3px solid #6cb6ff; border-radius: 3px; padding: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); text-align: right; }
  .dialogbar h4 { margin: 0 0 8px 0; font-size: 12px; color: var(--fg); text-align: right; line-height: 1.5; }
  .dialogbar .actions { display: flex; gap: 6px; justify-content: flex-end; }
  .dialogbar .opt { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12.5px; }
  .dialogbar .opt.indent { margin-left: 22px; }
  .dialogbar .opt.disabled { opacity: 0.45; }
  .dialogbar input[type="radio"], .dialogbar input[type="checkbox"] { accent-color: #6cb6ff; margin: 0; }
  .dialogbar .branchrow { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12.5px; }
  .dialogbar .branchrow input[type="text"] { flex: 1; background: var(--vscode-input-background, #2a2a2a); color: var(--fg); border: 1px solid var(--border); font-family: inherit; font-size: 12.5px; padding: 3px 5px; }

  .editor { border: 1px solid var(--border); border-left: 3px solid #6cb6ff; margin: 4px 8px; padding: 8px; border-radius: 3px; }
  .editor h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #6cb6ff; }
  .editor .item { margin: 6px 0; padding: 6px; background: rgba(108,182,255,0.08); border-radius: 3px; font-size: 12.5px; }
  .editor .item.resolved { background: rgba(108,182,255,0.04); opacity: 0.75; }
  .editor .meta { color: #888; font-size: 11px; margin-top: 3px; }
  .editor .itemactions { display: flex; gap: 6px; margin-top: 6px; }
  .editor textarea { width: 100%; min-height: 44px; margin-top: 6px; background: var(--vscode-input-background, #2a2a2a); color: var(--fg); border: 1px solid var(--border); font-family: inherit; font-size: 12.5px; padding: 5px; resize: vertical; }
  .editor .actions { display: flex; gap: 6px; margin-top: 6px; }

  #discussion { border-top: 1px solid var(--border); padding: 8px 10px; max-height: 40%; overflow: auto; }
  #discussion h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #888; }
  #discussion .ditem { margin: 5px 0; font-size: 12.5px; }
  #discussion .dmeta { color: #888; font-size: 11px; }
  #discussion textarea { width: 100%; min-height: 34px; margin-top: 6px; background: var(--vscode-input-background, #2a2a2a); color: var(--fg); border: 1px solid var(--border); font-family: inherit; font-size: 12.5px; padding: 5px; resize: vertical; }
</style>
</head>
<body>
  <div id="toolbar">
    <span class="fname" id="fname"></span>
    <button id="btnAccept" class="acceptbtn" title="Accept THIS file. The agent is NOT released — it keeps waiting until the whole review is committed (or you revise a file).">Accept</button>
    <button id="btnReady" class="readybtn" title="Release THIS file to the agent: it will start working on this file's open comments right away, without waiting for the rest of the review. Click again to take it back.">Revise</button>
    <span id="fileStats" class="stats" title="Added and removed lines in THIS file"></span>
    <span id="sessionStats" class="stats muted" title="Added and removed lines across the whole review"></span>
    <span id="fileCounts" class="stats muted" title="Files accepted / total files in this review"></span>
    <span id="statusChip"></span>
    <span class="spacer"></span>
    <span class="sessiongroup">
      <button id="btnRevise" class="revise" title="Release every file in this review that has open comments or discussion. The agent will start working on all of them at once and wait for your review of the result.">Revise all</button>
      <button id="btnPR" class="pr" title="Mark the whole review accepted. The agent will then commit the changes — to a local branch or as a pull request, your choice in the dialog. Only available when every comment is resolved.">Commit changes</button>
    </span>
    <button id="btnSettings" class="gear" title="Review settings">⚙</button>
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
  <div id="content"></div>
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
    div.innerHTML = '<span class="gutter">' + gutter + '</span><span class="marker">' + marker + '</span><code>' + esc(text) + '</code>';
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
    div.innerHTML = '<span class="gutter">' + gutter + '</span><span class="marker">' + (isAdd ? '+' : '-') + '</span><code>' + esc(l.text) + '</code>';
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

  // The "Commit changes" dialog: choose local commit or pull request, an
  // optional new branch, and (PR only) whether to squash into one commit.
  function commitDialog() {
    closeDialog();
    const bar = document.createElement('div');
    bar.className = 'dialogbar';
    bar.innerHTML = '<h4>Commit the changes? Every file in this review is accepted and the agent commits them the way you choose below.</h4>';
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
    go.textContent = 'Commit';
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
      const mode = bar.querySelector('input[name="commitMode"]:checked').value;
      const branch = branchInput.value.trim();
      const squash = mode === 'pr' && squashInput.checked;
      closeDialog();
      post({ type: 'commitChanges', commit: { mode: mode, branch: branch, squash: squash } });
    };
    cancel.onclick = closeDialog;
  }

  // Builds (fresh) the comment box for one line. Each open line gets its own
  // box; boxes never share state.
  function buildEditorBox(line) {
    const ed = document.createElement('div');
    ed.className = 'editor';
    ed.setAttribute('data-editorline', line);
    const title = document.createElement('h4');
    title.textContent = 'Comments — line ' + line;
    ed.appendChild(title);
    data.file.comments
      .filter((c) => c.line === line)
      .forEach((c) => {
        const item = document.createElement('div');
        item.className = 'item' + (c.resolved ? ' resolved' : '');
        let html = esc(c.text) + '<div class="meta">' + esc(c.author) + ' · ' + new Date(c.createdAt).toLocaleString() + (c.resolved ? ' · resolved' : '') + '</div>';
        if (c.resolved) {
          // Resolved: no action buttons, just a pencil to reopen/edit.
          html += '<div class="itemactions"><button class="editc" data-id="' + c.id + '" title="Edit this comment (reopens it)">&#9998;</button></div>';
        } else {
          html += '<div class="itemactions">' +
            '<button class="editc" data-id="' + c.id + '" title="Edit this comment">&#9998;</button>' +
            '<button data-act="resolve" data-id="' + c.id + '" title="Mark this one comment as resolved">Mark resolved</button>' +
            '</div>';
        }
        item.innerHTML = html;
        ed.appendChild(item);
      });
    const ta = document.createElement('textarea');
    ta.placeholder = 'Add a comment…';
    ed.appendChild(ta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const submit = document.createElement('button');
    submit.textContent = 'Comment';
    submit.title = 'Add your comment to this line';
    submit.onclick = () => {
      const text = ta.value.trim();
      if (!text) return;
      post({ type: 'addComment', line: line, side: 'right', text: text });
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Close';
    cancel.title = 'Collapse the comment box for this line (other lines stay as they are)';
    cancel.onclick = () => {
      commentBoxes.set(line, false);
      render();
    };
    actions.appendChild(submit);
    actions.appendChild(cancel);
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
    // Lines that no longer have any comment don't keep a box.
    commentBoxes.forEach((_, line) => {
      if (!byLine.has(line)) commentBoxes.delete(line);
    });
    byLine.forEach((comments, line) => {
      const row = document.querySelector('[data-newline="' + line + '"]');
      if (!row) return;
      const gutter = row.querySelector('.gutter');
      const open = comments.filter((c) => !c.resolved).length;
      const badge = document.createElement('span');
      badge.className = 'badge' + (open === 0 ? ' resolved' : '');
      badge.textContent = String(comments.length);
      badge.title = comments.map((c) => (c.resolved ? '[resolved] ' : '') + c.text).join('\\n');
      const isOpen = commentBoxes.get(line) === true;
      badge.onclick = (e) => { e.stopPropagation(); setLineOpen(line, !isOpen); };
      gutter.appendChild(badge);
      if (isOpen) {
        row.insertAdjacentElement('afterend', buildEditorBox(line));
      }
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
    list.innerHTML = '';
    data.file.discussion.forEach((d) => {
      const div = document.createElement('div');
      div.className = 'ditem';
      let html = esc(d.text) + ' <span class="dmeta">— ' + esc(d.author) + ' · ' + new Date(d.createdAt).toLocaleString() + (d.answered ? ' · answered' : '') + '</span>';
      if (!d.answered) {
        html += ' <button data-dact="answer" data-id="' + d.id + '" title="Mark this discussion entry as answered">✓</button>';
      }
      div.innerHTML = html;
      list.appendChild(div);
    });
  }

  function statsSpan(s) {
    return '<span class="add">+' + s.added + '</span> <span class="del">-' + s.removed + '</span>';
  }

  function render() {
    if (!data) return;
    document.getElementById('fname').textContent = data.fileName;
    document.getElementById('fileStats').innerHTML = statsSpan(data.fileStats);
    document.getElementById('sessionStats').innerHTML =
      '(' + statsSpan(data.sessionStats) + ')';
    document.getElementById('fileCounts').innerHTML =
      data.fileCounts
        ? '<span class="add">' + data.fileCounts.accepted + '</span>/' + data.fileCounts.total + ' files'
        : '';
    // Keep the settings select in sync with the (global) layout preference.
    document.querySelectorAll('#settingsMenu [data-mode]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    const chip = document.getElementById('statusChip');
    chip.textContent = data.file.status.replace('_', ' ');
    chip.className = 'chip-' + data.file.status;
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
    // Session-level button: "Commit changes" targets the WHOLE session —
    // it is only clickable when NO file in this session (not just this
    // file) has open feedback. The host re-checks before acting.
    const prBtn = document.getElementById('btnPR');
    const sessionOpen = data.sessionOpen !== false;
    prBtn.disabled = sessionOpen;
    prBtn.title = sessionOpen
      ? 'Resolve all comments and discussion in every file of this review first.'
      : 'Mark the whole review accepted — the agent will then commit the changes, to a local branch or as a pull request (your choice in the dialog).';
    const content = document.getElementById('content');
    content.innerHTML = '';
    const ctxRow = (l) => rowLine('ctx', l.no, l.text, '', true);
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
        }
      }
    });
    attachBadges();
    renderDiscussion();
  }

  document.getElementById('content').addEventListener('click', (e) => {
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
    const res = el.closest('[data-act="resolve"]');
    if (res) {
      // Resolve exactly the one comment this button belongs to.
      post({ type: 'resolveComment', id: res.getAttribute('data-id') });
      return;
    }
    const ans = el.closest('[data-dact="answer"]');
    if (ans) {
      post({ type: 'answerDiscussion', id: ans.getAttribute('data-id') });
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
    post({ type: 'addDiscussion', text: text });
  };
  document.getElementById('dInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('dPost').click();
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'data') {
      // fileCounts is session-wide: keep it fresh from every data message.
      if (data && msg.data.fileCounts) data.fileCounts = msg.data.fileCounts;
      data = msg.data;
      // The layout is a global preference: adopt the host's authoritative
      // value (covers other panels and the initial load).
      if (msg.data.layoutMode && msg.data.layoutMode !== mode) mode = msg.data.layoutMode;
      reanchorStaleComments();
      render();
    }
    if (msg.type === 'readyBlocked') {
      note(msg.reason === 'no-feedback' ? 'Add a comment or a discussion entry to this file first — Revise releases your feedback to the agent, so there is nothing to release yet.' : 'This file cannot be released to the agent right now.');
    }
    if (msg.type === 'prBlocked') {
      note('Some file in this review still has an unresolved comment or unanswered discussion. Resolve everything, then commit the changes.');
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
