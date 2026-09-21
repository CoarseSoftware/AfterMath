import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileReview, Session, fileHasAgentChanges, hasOpenFeedback, hasRevisedFeedback, isReleasable, isSessionFinalized, listSessions, writeFileReview } from '@aftermath/protocol';
import { notifyPanels, openReviewPanel, setSessionsChangedListener } from './reviewPanel';

const SCAN_INTERVAL_MS = 10_000;

class SessionItem extends vscode.TreeItem {
  constructor(public readonly session: Session) {
    super('', vscode.TreeItemCollapsibleState.Expanded);
    const total = session.files.length;
    const accepted = session.files.filter((f) => f.status === 'accepted').length;
    const open = session.files.filter(hasOpenFeedback).length;
    const released = session.files.filter(isReleasable).length;
    this.label = `${session.manifest.session}  ·  ${accepted}/${total} accepted`;
    this.description =
      `round ${session.manifest.submission}` +
      (open ? ` · ${open} need(s) revision` : '') +
      (released ? ` · ${released} released` : '');
    this.tooltip = session.manifest.summary;
    this.iconPath = new vscode.ThemeIcon(sessionIcon(session));
    this.contextValue = 'session';
  }
}

class FileItem extends vscode.TreeItem {
  constructor(public readonly session: Session, public readonly fr: FileReview) {
    // Show only the file name — the folder chain is already the tree path,
    // so the full path here would push the row far to the right.
    const fileName = fr.path.split('/').pop() ?? fr.path;
    const changed = fileHasAgentChanges(fr);
    const openComments = fr.comments.filter((c) => !c.resolved).length;
    const openDiscussion = fr.discussion.filter((d) => !d.answered).length;
    const revised = hasRevisedFeedback(fr);

    // Single-row tree item: file name (label) + a status "pill" and any detail
    // in the description. This API's TreeItem label has no markdown/multi-line
    // support, so everything lives on one line and long names simply truncate.
    const detailParts: string[] = [];
    if (changed) detailParts.push('AI updated this file');
    if (fr.ready) detailParts.push('released');
    if (hasOpenFeedback(fr) && detailParts.length === 0) detailParts.push('open feedback');
    if (openComments > 0) detailParts.push(`${openComments} open comment${openComments === 1 ? '' : 's'}`);
    if (openDiscussion > 0) detailParts.push(`${openDiscussion} unanswered`);

    // The colored ThemeIcon (sparkle/rocket/check/…) carries the state; the
    // label stays plain so the row reads as:  [icon] name  status  details.
    super(fileName, vscode.TreeItemCollapsibleState.None);
    // Plain-text description keeps a tooltip / accessibility fallback.
    this.description = [statusPill(fr.status), ...detailParts].join('  ');

    this.tooltip =
      fr.path +
      '\n' +
      fr.status +
      (changed ? ' — AI updated this file' : '') +
      (openComments ? ` — ${openComments} open comment(s)` : '') +
      (openDiscussion ? ` — ${openDiscussion} open discussion` : '') +
      (this.fr.ready ? ' — released to the agent (waiting on the AI)' : '');
    // deleted / added / edit — drives the red "-", yellow "+" or pencil icon.
    const kind = fileChangeKind(fr, repoRootOf(session.dir), session.manifest.baseRef);
    this.iconPath = new vscode.ThemeIcon(
      fileIcon(fr, openComments, openDiscussion, fr.ready === true, changed, revised, session.manifest.agent, kind),
      new vscode.ThemeColor(fileIconColor(fr.status, fr.ready === true, changed, revised, kind))
    );
    this.contextValue = 'file';
    // Clicking a row opens its review panel (the command runs on selection;
    // the description row is the only one the selection handler itself acts
    // on). Right-click offers the status commands (see package.json menus).
    this.command = {
      command: 'afterMath.openFileReview',
      title: 'Open Review',
      arguments: [session.dir, session.manifest.session, fr.path],
    };
  }
}

/** Plain-text status label for a file row (the colored ThemeIcon carries the
 *  color; no emoji dots between the name and the status). */
function statusPill(status: FileReview['status']): string {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'in_review':
      return 'in review';
    default:
      return 'needs review';
  }
}

/**
 * The session's description, shown under the session name and above the
 * files. Rendered as small, height-limited text; clicking it opens the full
 * (markdown) description in its own tab.
 */
class DescriptionItem extends vscode.TreeItem {
  constructor(public readonly session: Session) {
    super('', vscode.TreeItemCollapsibleState.None);
    const s = session.manifest.summary;
    const oneLine = s.replace(/\s+/g, ' ').trim();
    const shown = oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine;
    this.label = shown;
    this.description = '';
    this.tooltip = 'Show the full review description (markdown)';
    this.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'));
    this.contextValue = 'description';
  }
}

/**
 * The description shown in a tab, as a REAL file (`.aftermath/reviews/<id>/README.md`)
 * — untitled in-memory documents prompt to save when closed, a file on disk
 * does not. Written on demand from the manifest when missing (agents also
 * write it at submit time; a stale one is refreshed if it differs).
 */
async function showDescriptionMarkdown(session: Session): Promise<void> {
  const m = session.manifest;
  const content = [
    `# Review ${m.session}`,
    '',
    `**Round:** ${m.submission}`,
    '',
    m.summary,
    '',
    `**Files (${m.files.length}):**`,
    ...m.files.map((f) => `- ${f}`),
    '',
  ].join('\n');
  const readmePath = path.join(session.dir, 'README.md');
  const uri = vscode.Uri.file(readmePath);
  try {
    const existing = await vscode.workspace.fs.readFile(uri);
    if (Buffer.from(existing).toString('utf8') !== content) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

/** A folder node in the per-session file tree (built from the file paths). */
class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    /** Remaining path segments below this folder. */
    public readonly segments: string[],
    /** Session file paths that live under this folder. */
    public readonly filePaths: string[],
    /** Names of this folder's sub-folders (direct children). */
    subFolderNames: string[],
    /** The row's own display name (the collapsed folder name, e.g. "UseCases/Menu"). */
    public readonly displayName: string
  ) {
    // Like the git changes view: a chain of single sub-folders is AGGREGATED
    // onto one row instead of one row per folder — the common prefix stops
    // being a wall of one-name rows, and only the first point of divergence
    // (two sub-folders, or a folder next to files) expands. The label is ONLY
    // this row's own name (which may be a short collapsed chain like
    // "UseCases/Menu"), not the whole path from the root — the parent rows
    // already show that, and repeating it pushes the row far to the right.
    // (The raw parameter, not this.displayName: parameter properties are
    // assigned only AFTER super() returns.)
    super(displayName, vscode.TreeItemCollapsibleState.Expanded);
    const inline = subFolderNames.slice(0, 2);
    // Show how many files in this folder are accepted (right-click the row to
    // accept / un-accept all of them).
    let accepted = 0;
    for (const p of filePaths) {
      const fr = session.files.find((x) => x.path === p);
      if (fr && fr.status === 'accepted') accepted += 1;
    }
    const parts: string[] = [
      `${accepted}/${filePaths.length} accepted`,
    ];
    if (inline.length === 1) parts.push(inline[0]);
    else if (inline.length === 2) parts.push(`${inline[0]}, ${inline[1]}`);
    this.description = parts.join(' · ');
    this.tooltip =
      segments.join('/') +
      `\n${accepted} of ${filePaths.length} file(s) accepted` +
      (subFolderNames.length > 0 ? `\n${subFolderNames.join(', ')}` : '');
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'folder';
    // Clicking a folder row opens the first file in it (the tree view's
    // selection handler is what triggers the command).
    if (filePaths.length > 0) {
      this.command = {
        command: 'afterMath.openFileReview',
        title: 'Open Review',
        arguments: [session.dir, session.manifest.session, filePaths[0]],
      };
    }
  }
}

/** Direct sub-folder names of a level (paths whose next segment is a folder). */
function subFolderNames(segments: string[], filePaths: string[]): string[] {
  const names = new Set<string>();
  for (const p of filePaths) {
    const rest = p.split('/').slice(segments.length);
    if (rest.length > 1) names.add(rest[0]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Collapse a chain of single sub-folders into one name, like the git changes
 * view: if `seg` is the ONLY sub-folder at its level and there are no files
 * beside it, the chain keeps going (a/b/c with nothing else anywhere becomes
 * one "a/b/c" row instead of three one-name rows). The chain stops at the
 * first level that has a second sub-folder or a file — that is where the
 * tree fans out again. `filePaths` may be the WHOLE session; it is narrowed
 * to the files actually under each level before counting (siblings outside
 * this branch must not stop the chain).
 */
function collapseChain(segments: string[], name: string, filePaths: string[]): string {
  let cur = name;
  for (;;) {
    const segs = segments.concat(cur.split('/'));
    const under = filePaths.filter((p) => p.split('/').slice(0, segs.length).join('/') === segs.join('/'));
    if (under.some((p) => p.split('/').slice(segs.length).length === 1)) break;
    const subs = subFolderNames(segs, under);
    if (subs.length !== 1) break;
    cur += '/' + subs[0];
  }
  return cur;
}

/**
 * Children of a folder level: group the file paths by their next segment,
 * collapsing single-folder chains into one row first. Folders come first
 * (alphabetical), then root-level files.
 */
function childrenFor(session: Session, segments: string[], filePaths: string[]): vscode.TreeItem[] {
  const folders = new Map<string, string[]>(); // collapsed folder name -> file paths
  const loose: string[] = [];
  for (const p of filePaths) {
    const rest = p.split('/').slice(segments.length);
    if (rest.length === 1) {
      // Only the file name is left: this is a file at this level.
      loose.push(p);
      continue;
    }
    // rest[0] is a sub-folder (the collapsed name may cover several).
    // `segs` is the folder's full path from the session root (no file
    // name), so the next level starts inside it.
    const name = collapseChain(segments, rest[0], filePaths);
    if (!folders.has(name)) folders.set(name, []);
    folders.get(name)!.push(p);
  }
  const out: vscode.TreeItem[] = [];
  [...folders.keys()].sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const files = folders.get(name)!;
    const segs = segments.concat(name.split('/'));
    out.push(new FolderItem(session, segs, files, subFolderNames(segs, files), name));
  });
  loose.sort((a, b) => a.localeCompare(b)).forEach((p) => {
    out.push(new FileItem(session, session.files.find((x) => x.path === p)!));
  });
  return out;
}

function sessionIcon(s: Session): string {
  if (isSessionFinalized(s)) return 'check-all';
  if (s.files.some(isReleasable)) return 'sync';
  if (s.files.some(hasOpenFeedback)) return 'comment';
  return 'comment-discussion';
}

/**
 * The file's kind of change vs the base commit:
 * - `deleted` — the file exists at the base ref but is gone from the working
 *   tree (the GUI renders it with a red "-");
 * - `added` — the file did not exist at the base ref (yellow "+", needs review);
 * - `edit` — both sides exist (yellow pencil).
 */
type FileChangeKind = 'deleted' | 'added' | 'edit';

function fileChangeKind(fr: FileReview, repoRoot: string, baseRef: string): FileChangeKind {
  const repoPath = path.join(repoRoot, fr.path);
  const current = fs.existsSync(repoPath);
  if (!current) return 'deleted';
  let base: string | null = null;
  try {
    base = execFileSync('git', ['show', `${baseRef}:${fr.path}`], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
  } catch {
    base = null; // exit != 0 (or git missing) => file not present at baseRef
  }
  if (base === null || base === '') return 'added';
  return 'edit';
}

function fileIcon(
  fr: FileReview,
  openComments: number,
  openDiscussion: number,
  ready: boolean,
  changed: boolean,
  revised: boolean,
  agentName: string,
  kind: FileChangeKind
): string {
  if (fr.status === 'accepted') return 'check';
  if (changed) {
    // The agent changed this file since you last looked: a rocket when it has
    // actually revised feedback for you, a sparkle otherwise.
    return revised ? 'rocket' : 'sparkle';
  }
  if (ready) return 'robot';
  if (openComments + openDiscussion > 0) {
    // Open feedback: a CHAT icon so it stands out — and when it came from the
    // CODE REVIEWER (the session's agent) it gets the same blue as the
    // "Revise" buttons so review comments are unmistakable at a glance.
    const fromReviewer = fr.discussion
      .filter((d) => !d.answered)
      .some((d) => reviewerAuthor(d.author, agentName)) ||
      fr.comments
        .filter((c) => !c.resolved)
        .some((c) => reviewerAuthor(c.author, agentName));
    return fromReviewer ? 'comment-discussion' : 'comment';
  }
  // No open feedback: the kind of change the file carries. Deleted files get
  // a red "-", added files a yellow "+", edits keep the yellow pencil.
  if (kind === 'deleted') return 'dash';
  if (kind === 'added') return 'add';
  if (fr.status === 'rejected') return 'sync';
  return 'edit';
}

/** Is this discussion/comment author the session's code reviewer (the AI
 *  agent that submitted the review)? Compared case-insensitively on the
 *  account part (a "claude@devbox" style author matches "claude"). */
function reviewerAuthor(author: string, agentName: string): boolean {
  if (!agentName) return false;
  const a = author.trim().toLowerCase();
  const r = agentName.trim().toLowerCase();
  if (a === r) return true;
  const aLocal = a.split('@')[0];
  const rLocal = r.split('@')[0];
  return aLocal.length > 0 && aLocal === rLocal;
}

/** Icon color: green check when accepted, blue rocket when the agent revised
 *  your feedback, purple sparkle when the agent changed the file, blue robot
 *  when released to the agent, a stand-out blue chat icon for reviewer
 *  comments, a red "-" for deleted files, and stand-out yellow ("+" for new
 *  files, pencil for edits) while awaiting review. */
function fileIconColor(
  status: FileReview['status'],
  ready: boolean,
  changed: boolean,
  revised: boolean,
  kind: FileChangeKind
): string {
  if (status === 'accepted') return 'charts.green';
  if (changed && revised) return 'charts.blue';
  if (changed) return 'charts.purple';
  if (ready) return 'charts.blue';
  if (kind === 'deleted') return 'charts.red';
  return 'charts.yellow';
}

/** The repo root for a session dir (<root>/.aftermath/reviews/<id>). */
function repoRootOf(sessionDir: string): string {
  return path.resolve(sessionDir, '..', '..', '..');
}

class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  sessions: Session[] = [];

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (!item) return this.sessions.map((s) => new SessionItem(s));
    if (item instanceof SessionItem) {
      // Description first, then the files as a folder hierarchy (expanded by
      // default).
      return [
        new DescriptionItem(item.session),
        ...childrenFor(item.session, [], item.session.files.map((fr) => fr.path)),
      ];
    }
    if (item instanceof FolderItem) {
      return childrenFor(item.session, item.segments, item.filePaths);
    }
    return [];
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  async handleItemClick(item: vscode.TreeItem | undefined): Promise<void> {
    // File/folder rows carry their own command (open the review panel); the
    // selection handler only deals with the description row.
    if (item instanceof DescriptionItem) {
      await showDescriptionMarkdown(item.session);
    }
  }

  /** Right-click: set ONE file's status. The status is written straight to
   *  disk (no git work), then the panel (if open) and the tree refresh. */
  setFileStatus(item: vscode.TreeItem | undefined, status: FileReview['status']): void {
    if (!(item instanceof FileItem)) return;
    const { session, fr } = item;
    fr.status = status;
    // Accepting acknowledges the agent's changes (same as the Accept button).
    if (status === 'accepted') fr.agentTouched = false;
    fr.updatedAt = new Date().toISOString();
    try {
      writeFileReview(session.dir, fr);
    } catch (err) {
      void vscode.window.showErrorMessage(`After Math: ${String(err)}`);
      return;
    }
    // Instant UI feedback: the tree row re-renders (via the refresh
    // listener) and any open panel for this session flips its status pill /
    // accept button / file counts without a git diff round-trip.
    notifyPanels(session.dir);
    notifyTreeAndPanels?.();
  }

  /** Right-click: set EVERY file under a folder to a status (accept all /
   *  un-accept all). Each file is written to disk, then one refresh. */
  setFolderStatus(item: vscode.TreeItem | undefined, status: FileReview['status']): void {
    if (!(item instanceof FolderItem)) return;
    const { session, filePaths } = item;
    const now = new Date().toISOString();
    for (const p of filePaths) {
      const fr = session.files.find((x) => x.path === p);
      if (!fr) continue;
      fr.status = status;
      if (status === 'accepted') fr.agentTouched = false;
      fr.updatedAt = now;
      try {
        writeFileReview(session.dir, fr);
      } catch (err) {
        void vscode.window.showErrorMessage(`After Math: ${String(err)}`);
        return;
      }
    }
    notifyPanels(session.dir);
    notifyTreeAndPanels?.();
  }
}

let notifyTreeAndPanels: (() => void) | undefined;
export function setTreeRefreshListener(cb: () => void): void {
  notifyTreeAndPanels = cb;
}

function watchedRoots(): string[] {
  const cfg = vscode.workspace.getConfiguration('afterMath').get<string[]>('watchedPaths') ?? [];
  const roots = [...cfg];
  for (const ws of vscode.workspace.workspaceFolders ?? []) {
    if (!roots.includes(ws.uri.fsPath)) roots.push(ws.uri.fsPath);
  }
  return roots;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SessionsProvider();
  const view: vscode.TreeView<vscode.TreeItem> = vscode.window.createTreeView<vscode.TreeItem>(
    'afterMath.sessions',
    {
      treeDataProvider: provider,
      showCollapseAll: true,
    }
  );
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'afterMath.refresh';
  context.subscriptions.push(
    view,
    statusItem,
    provider,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('afterMath.watchedPaths')) void scan(true);
    }),
    view.onDidExpandElement((e) => {
      if (e.element instanceof SessionItem) void scan(false);
    })
  );

  setSessionsChangedListener(() => void scan(false));

  // Right-click status changes write straight to disk (no git work): refresh
  // the tree in place. Open panels were already updated by notifyPanels
  // (quick message — no diff recompute, no full re-scan).
  setTreeRefreshListener(() => {
    provider.refresh();
  });

  const seen = new Map<string, number>(); // session dir -> last seen submission

  // Attention without a toast: the pending count badge pulses (the view
  // description blinks next to it) for a few seconds when a new review
  // appears or one is re-submitted.
  let flashTimer: NodeJS.Timeout | undefined;
  function flashBadge(value: number): void {
    if (flashTimer) clearInterval(flashTimer);
    let on = true;
    flashTimer = setInterval(() => {
      on = !on;
      view.description = on ? `After Math — ${value} pending` : undefined;
    }, 400);
    setTimeout(() => {
      clearInterval(flashTimer);
      flashTimer = undefined;
      view.description = undefined;
    }, 3200);
  }

  async function scan(notifyNew: boolean): Promise<void> {
    let sessions: Session[] = [];
    try {
      sessions = listSessions(watchedRoots());
    } catch (err) {
      console.error('[after-math] scan failed:', err);
      return;
    }
    provider.sessions = sessions;
    provider.refresh();

    if (notifyNew) {
      let flashValue = 0;
      for (const s of sessions) {
        const prev = seen.get(s.dir);
        if (prev === undefined) {
          seen.set(s.dir, s.manifest.submission);
          flashValue++;
        } else if (s.manifest.submission > prev) {
          seen.set(s.dir, s.manifest.submission);
          flashValue++;
        }
      }
      if (flashValue > 0) flashBadge(flashValue);
    }
    const existing = new Set(sessions.map((s) => s.dir));
    for (const k of [...seen.keys()]) {
      if (!existing.has(k)) seen.delete(k);
    }

    const pending = sessions.filter((s) => !isSessionFinalized(s)).length;
    if (pending > 0) {
      statusItem.text = `$(comment-discussion) After Math: ${pending} pending`;
      statusItem.tooltip = 'Open review sessions';
      view.badge = { value: pending, tooltip: `${pending} pending review(s)` };
    } else {
      statusItem.text = '$(check-all) After Math: up to date';
      statusItem.tooltip = 'No pending reviews';
      view.badge = undefined;
    }
    statusItem.show();
  }

  const openFileReview = (sessionDir: string, _sessionId: string, filePath: string): void => {
    const s = provider.sessions.find((x) => x.dir === sessionDir);
    if (s) void openReviewPanel(s.dir, s.manifest, filePath);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('afterMath.refresh', () => void scan(true)),
    vscode.commands.registerCommand('afterMath.openSession', () => {
      if (provider.sessions.length === 0) {
        void vscode.window.showInformationMessage('After Math: no review sessions found.');
        return;
      }
      const s = provider.sessions[0];
      if (s.files[0]) void openReviewPanel(s.dir, s.manifest, s.files[0].path);
    }),
    // Row click (the tree items carry this command): open the review panel.
    vscode.commands.registerCommand('afterMath.openFileReview', (sessionDir: string, sessionId: string, filePath: string) => {
      openFileReview(sessionDir, sessionId, filePath);
    }),
    // Right-click a file row: set its status.
    vscode.commands.registerCommand('afterMath.file.setStatus', (item: vscode.TreeItem, status: string) => {
      if (status === 'needs_review' || status === 'in_review' || status === 'accepted' || status === 'rejected') {
        provider.setFileStatus(item, status);
      }
    }),
    // Right-click a folder row: accept all / un-accept all files in it.
    vscode.commands.registerCommand('afterMath.folder.setStatus', (item: vscode.TreeItem, status: string) => {
      if (status === 'accepted' || status === 'needs_review') {
        provider.setFolderStatus(item, status);
      }
    })
  );
  view.onDidChangeSelection((e) => void provider.handleItemClick(e.selection[0]));

  // Live updates for the left panel: the agent re-writes the session's JSON
  // files on disk (re-submissions, replies, "revised" flags). Watch every
  // watched root for `.aftermath/reviews/**` and re-scan (debounced) so the
  // tree — not just the open review panel — refreshes without a reload. The
  // 10 s timer above stays as a safety net for anything the watcher misses.
  let scanDebounce: NodeJS.Timeout | undefined;
  const scheduleScan = (): void => {
    if (scanDebounce) clearTimeout(scanDebounce);
    scanDebounce = setTimeout(() => {
      scanDebounce = undefined;
      void scan(false);
    }, 400);
  };
  // Glob separators are always forward slashes, even on Windows — a
  // path.join pattern would emit backslashes that never match.
  for (const root of watchedRoots()) {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '.aftermath/reviews/**')
    );
    w.onDidCreate(scheduleScan);
    w.onDidChange(scheduleScan);
    w.onDidDelete(scheduleScan);
    context.subscriptions.push(w);
  }
  context.subscriptions.push({
    dispose: () => {
      if (scanDebounce) clearTimeout(scanDebounce);
    },
  });

  void scan(true);
  const timer = setInterval(() => void scan(true), SCAN_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  /* nothing to clean up */
}
