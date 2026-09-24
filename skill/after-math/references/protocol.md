# After Math Review Protocol — reference

## Folder layout

```
<project>/.aftermath/reviews/<sessionId>/
  manifest.json
  README.md           # the review's description page (markdown); GUI opens it as a tab
  <sha1-12>.json      # one per changed file
```

- `.aftermath/` must be in the project's `.gitignore`. Keep the folder on disk after cleanup; only delete your session folder.
- Multiple agents may work the same branch concurrently, each with their own `<sessionId>`. Never read-modify-write another session's files.
- `<sessionId>`: short unique id (e.g. `a1b2c3d`). Reuse the same id across submit → fix → re-submit rounds for the same review.

## manifest.json

```json
{
  "session": "a1b2c3d",
  "baseRef": "9f86d08",
  "summary": "Added retry logic to the payment client and covered it with unit tests.\nBumped the SDK dependency to 2.4.1.",
  "submittedAt": "2026-09-16T12:00:00.000Z",
  "submission": 1,
  "files": ["src/payment/client.ts", "src/payment/client.test.ts"],
  "agent": "claude-code",
  "commit": { "mode": "pr", "branch": "feature/payment-retry", "squash": true }
}
```

- `baseRef` — commit the changes are diffed against (HEAD at session start). The review GUI computes diffs as `git diff <baseRef> -- <file>`; changes are **uncommitted** until the review is fully accepted.
- `summary` — the review's **description**. Shown in the After Math left panel under the session name (small text, truncated) and opens as a markdown tab on click (the tab shows the session folder's `README.md`, which the agent writes alongside `summary`; the GUI regenerates it from the manifest if missing). **Keep it as brief as possible** (one tight sentence). Markdown supported.
- `submission` — round counter. Start at 1; increment by 1 on every re-submission after fixes.
- `files` — repo-relative paths, forward slashes, matching the `path` field of the per-file JSONs.
- `commit` — **human-only**, written by the GUI when "Commit changes" is confirmed (the moment every file becomes `accepted`):
  - `mode` — `local` (commit to a local branch and stop) or `pr` (commit and open a pull request).
  - `branch` — optional; name of a branch to commit to (created if missing), e.g. when the dev was working on `main`. Absent = commit on the current branch.
  - `squash` — optional, PR mode only; the PR is a single squashed commit (checked by default in the GUI).

## Per-file review: `<sha1(path)>.json`

File name = first 12 hex chars of SHA-1 of the exact repo-relative path string (same string as in `manifest.files`), plus `.json`.

```json
{
  "path": "src/payment/client.ts",
  "status": "needs_review",
  "comments": [
    {
      "id": "c1",
      "line": 42,
      "side": "right",
      "text": "This timeout should come from config, not a literal.",
      "author": "jacob",
      "createdAt": "2026-09-16T12:30:00.000Z",
      "resolved": false,
      "reply": "Moved it to `config.timeoutMs` and removed the literal.",
      "replyAt": "2026-09-16T12:40:00.000Z",
      "revised": true
    }
  ],
  "discussion": [
    {
      "id": "d1",
      "text": "Why exponential backoff instead of fixed delay?",
      "author": "jacob",
      "createdAt": "2026-09-16T12:31:00.000Z",
      "answered": true,
      "reply": "Fixed delay can hammer a recovering endpoint; exponential backs off on repeated failures. Happy to switch if you prefer.",
      "replyAt": "2026-09-16T12:40:00.000Z"
    }
  ],
  "agentTouched": true,
  "updatedAt": "2026-09-16T12:31:00.000Z"
}
```

### Fields

- `status` — `needs_review` | `in_review` | `accepted` | `rejected`.
  - Agent writes `needs_review` (submit / re-submit) and never `accepted`/`rejected`/`in_review` (human-only).
  - `accepted` is set per file by the human's **Accept** button (the "Commit changes" dialog also accepts every file). Accepting does **not** release a file to the agent — the agent only works on files that are **releasable** (`ready: true` + open feedback). Never touch an `accepted`, not-ready file; it is done until the human acts again.
- `comments[].line` — 1-based line number **in the current (new) version** of the file.
- `comments[].side` — `right` (current side) or `left` (a removed line; `line` then refers to the adjacent current-side line).
- `comments[].resolved` — **human-only**. The agent NEVER sets it (it only writes `reply`/`replyAt`/`revised` on the comments it addresses and leaves `resolved` exactly as it is). The human's "Mark Resolved" button (comment box footer) flips `resolved` on **every** comment of the line's chain at once (clicking it again re-opens the whole chain). The flag is the human's open/closed state for that line.
- `comments[].revised` / `discussion[].revised` — **agent-written** boolean, `true` when the agent made a **code change** in response to that item (as opposed to only replying to push back or ask for clarification). The GUI shows revised items with a blue "Revised" pill in the code view, and files with revised feedback get a distinct "revised" icon in the left panel. Set it alongside `reply` on every item the agent acted on; never on items it only replied to.
- `comments[].reply` / `comments[].replyAt` — **agent-written** brief reply (1–3 sentences on what it changed) and its timestamp, set when the agent addresses the comment. Absent until then.
- `discussion[].reply` / `discussion[].replyAt` — **agent-written** brief reply (1–3 sentences) to the discussion entry and its timestamp. Set alongside flipping `answered: true` for a question/change-request the agent answers; set (leaving `answered: false`) when the agent pushes back or needs clarification instead of changing code. Absent until then.
- `ready` — **human-only** release gate, default false. When the human marks a file "Revise this file" in the GUI (or sets `ready: true`), the agent's waiter wakes for that file even though the rest of the session is still under review. A file is releasable only when it has **open feedback and is `ready`** — its `status` is not part of the gate. The agent clears `ready` when it re-submits the fixed file.
- `agentTouched` — **agent-written** boolean. The agent sets it `true` on every file it (re-)submits after working on it, so the GUI can flag in the left panel that the AI changed that file since the human last looked (colored file name + a "changed by the agent" icon). The human's **Accept** clears it (the GUI writes it back to `false`). The agent only ever sets it to `true`; it never sets it `false`.
- `comments[].updatedAt` — optional; set when the human edits a comment's text in the GUI.
- `discussion[]` — free-thread Q&A / change requests. `answered` flips to `true` when the other side replies (agent may mark its own answers' counterpart answered; the human clicks ✓ on the entry in the GUI's discussion box, which then shows a green "✓ answered" pill).
- `id`s — agent-generated unique strings (e.g. `c1`, `c2`, `d1`...); keep them stable; never reuse.

## Workflow state machine

```
agent submits ──> needs_review (per file)
agent blocks  ──> waiter script (background task) polls the session dir
human reviews ──> adds line comments / discussion (per file)
  per-file release  ──> "Revise this file" (ready: true on that file)
  session release   ──> "Revise all": every file WITH open feedback
                        is set rejected + ready: true
open feedback + ready ──> waiter exits EVENT=fix
  (payload = releasable files only; unready files keep waiting)
agent fixes ──> needs_review again, ready cleared, submission+1, each
                addressed comment gets a brief `reply` (items with a code
                change also get `revised: true`); `resolved` is NOT touched
                (human-only), `agentTouched: true`
agent blocks  ──> new waiter (repeat until accepted)
"Commit changes" ──> available at ANY time; the dialog shows
                     "n of m files accepted" and, when not all are accepted,
                     asks for confirmation. Confirms → sets every file
                     accepted (including un-accepted ones) AND records commit
                     options (local commit or PR, optional branch, squash) in
                     the manifest — this confirmation is what ends the session
all accepted WITHOUT commit ──> NOT done: the human is still deciding
                     (may revise or un-accept); the waiter keeps blocking
manifest has commit ──> waiter exits EVENT=done
agent finalizes ──> follows manifest.commit: branch/commit, optionally
                    push + gh pr create, delete session folder
```

Every action is scoped to ONE session: the per-file buttons (Accept, Revise, comments) act on that session's file, and "Revise all" / "Commit changes" act only on the session the review panel belongs to — never on other sessions' folders or waiters.

### GUI buttons

- **Accept** (per file, green, toggle) — marks just that file `accepted` without releasing the agent; clicking again un-accepts it (back to `needs_review`). Accepted files are final until the human acts again; leave them alone (a re-submission of another file must not touch them).
- **Revise** (per file) — releases that one file to the agent now. Requires the file to have open feedback (unresolved comments or unanswered discussion). Toggleable; turning it off takes the file back.
- **Revise all** (session) — releases **every** file of THIS session that has open feedback at once (sets each `rejected` + `ready: true`). Files without open feedback are untouched. Other review sessions are never affected.
- **Commit changes** (session) — marks every file of THIS session `accepted` (including files the human had not accepted yet — the dialog shows "n of m files accepted" and asks for confirmation when some are missing) and records the commit options in the manifest; that confirmation ends the session (the agent's waiter wakes with `EVENT=done`). A fully accepted session without this confirmation is still waiting. Available at any time. The dialog offers: **Commit to local branch** or **Create pull request** (radio), an optional **new branch name** (used for either), and a **Squash commit** checkbox (indented under the PR option, enabled only for PRs, checked by default) that makes the PR a single commit.
- **Set status** (left panel, right-click a file) — sets that file's status to needs review / in review / accepted / rejected. **Accept all / Un-accept all** (right-click a folder) does the same for every file under the folder.
- **Line comment box** (per file, anchored under a code line) — the comment chain for that line (every comment whose `line` matches). A minimize icon (▾) at the TOP RIGHT collapses the box; the gutter badge on the line reopens it. Each comment shows a pencil (edits it; reopens it when resolved). Footer: **Mark Resolved** at the BOTTOM LEFT resolves the WHOLE chain — it sets `resolved: true` on every comment on that line at once (never per comment); once the chain is fully resolved the button turns into a green "✓ Resolved" and clicking it re-opens the chain (`resolved: false` on all of them). **Submit Comment** at the BOTTOM RIGHT adds a new comment to the line.
- **Discussion box** (per file, bottom of the code view) — free-thread Q&A / change requests with the agent. Each entry is separated by a line and tagged with a pill: a purple **robot + the agent's name** for the agent's entries, a blue **You** for the human's. The ✓ button at the end of an entry marks it `answered: true` (the entry then shows a green "✓ answered" pill, dimmed; clicking the pill re-opens it). The agent's `reply` renders as a purple reply block under the entry.
- **File icons** (left panel, when a file has no open feedback) — red **`-`** = the change deletes the file, yellow **`+`** = the change adds a new file (needs review), yellow **pencil** = the file was edited. With open feedback the icon is a chat bubble: **blue** when the open feedback came from the agent (the session's reviewer), yellow when it came from the human.

## Git rules

- **No commits until the review is fully accepted.** The working tree holds the changes throughout.
- On finalize, commit exactly the paths in `manifest.json` (nothing else may have changed since — if `git status` shows unexpected changes, commit only the listed paths and mention the rest in the PR body).
- Use `git add -A -- <paths...>` so new and deleted files are included.
- PR: `gh pr create --title "<first line of summary>" --body "<summary>"`.

## Writing files

- Write JSON with 2-space indentation and a trailing newline.
- Write atomically where practical (write to a temp file, then rename) so the GUI/daemon never read a half-written file.
- All timestamps: ISO 8601 UTC.
