import * as path from 'path';
import * as vscode from 'vscode';
import { FileReview, Session, hasOpenFeedback, isReleasable, isSessionFinalized, listSessions } from '@aftermath/protocol';
import { openReviewPanel, setSessionsChangedListener } from './reviewPanel';

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
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.description =
      fr.status.replace('_', ' ') +
      (this.fr.ready ? ' · released' : hasOpenFeedback(this.fr) ? ' · open feedback' : '');
    const openComments = fr.comments.filter((c) => !c.resolved).length;
    const openDiscussion = fr.discussion.filter((d) => !d.answered).length;
    this.tooltip =
      fr.path +
      '\n' +
      fr.status +
      (openComments ? ` — ${openComments} open comment(s)` : '') +
      (openDiscussion ? ` — ${openDiscussion} open discussion` : '') +
      (this.fr.ready ? ' — released to the agent (waiting on the AI)' : '');
    this.iconPath = new vscode.ThemeIcon(
      fileIcon(fr.status, openComments + openDiscussion > 0, fr.ready === true),
      new vscode.ThemeColor(fileIconColor(fr.status, fr.ready === true))
    );
    this.contextValue = 'file';
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
    public readonly filePaths: string[]
  ) {
    // Label = this folder's OWN name (the last segment), not the top-level
    // one — every row shows a different name down the chain.
    super(segments[segments.length - 1], vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${filePaths.length} file${filePaths.length === 1 ? '' : 's'}`;
    this.tooltip = segments.join('/');
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'folder';
  }
}

/**
 * Children of a folder level: group the file paths by their next segment.
 * Folders come first (alphabetical), then root-level files.
 */
function childrenFor(session: Session, segments: string[], filePaths: string[]): vscode.TreeItem[] {
  const folders = new Map<string, { segs: string[]; files: string[] }>();
  const loose: string[] = [];
  for (const p of filePaths) {
    const parts = p.split('/');
    const rest = parts.slice(segments.length);
    if (rest.length === 1) {
      // Only the file name is left: this is a file at this level.
      loose.push(p);
    } else {
      // rest[0] is a sub-folder. `segs` is the folder's full path from the
      // session root (no file name), so the next level starts inside it.
      const name = rest[0];
      if (!folders.has(name)) folders.set(name, { segs: segments.concat([name]), files: [] });
      folders.get(name)!.files.push(p);
    }
  }
  const out: vscode.TreeItem[] = [];
  [...folders.keys()].sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const f = folders.get(name)!;
    out.push(new FolderItem(session, f.segs, f.files));
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

function fileIcon(status: FileReview['status'], hasOpen: boolean, ready: boolean): string {
  if (ready) return 'robot';
  if (status === 'accepted') return 'check';
  if (hasOpen && status === 'rejected') return 'sync';
  if (hasOpen) return 'comment';
  return 'edit';
}

/** Icon color: green check when accepted, blue robot when released to the
 *  agent, a stand-out yellow pencil while awaiting review. */
function fileIconColor(status: FileReview['status'], ready: boolean): string {
  if (status === 'accepted') return 'charts.green';
  if (ready) return 'charts.blue';
  return 'charts.yellow';
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
    if (item instanceof DescriptionItem) {
      await showDescriptionMarkdown(item.session);
      return;
    }
    if (item instanceof FileItem) {
      await openReviewPanel(item.session.dir, item.session.manifest, item.fr.path);
    }
  }
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

  context.subscriptions.push(
    vscode.commands.registerCommand('afterMath.refresh', () => void scan(true)),
    vscode.commands.registerCommand('afterMath.openSession', () => {
      if (provider.sessions.length === 0) {
        void vscode.window.showInformationMessage('After Math: no review sessions found.');
        return;
      }
      const s = provider.sessions[0];
      if (s.files[0]) void openReviewPanel(s.dir, s.manifest, s.files[0].path);
    })
  );
  view.onDidChangeSelection((e) => void provider.handleItemClick(e.selection[0]));

  void scan(true);
  const timer = setInterval(() => void scan(true), SCAN_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  /* nothing to clean up */
}
