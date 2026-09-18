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
      "resolved": false
    }
  ],
  "discussion": [
    {
      "id": "d1",
      "text": "Why exponential backoff instead of fixed delay?",
      "author": "jacob",
      "createdAt": "2026-09-16T12:31:00.000Z",
      "answered": false
    }
  ],
  "updatedAt": "2026-09-16T12:31:00.000Z"
}
```

### Fields

- `status` — `needs_review` | `in_review` | `accepted` | `rejected`.
  - Agent writes `needs_review` (submit / re-submit) and never `accepted`/`rejected`/`in_review` (human-only).
  - `accepted` is set per file by the human's **Accept** button (the "Commit changes" dialog also accepts every file). Accepting does **not** release a file to the agent — the agent only works on files that are **releasable** (`ready: true` + open feedback). Never touch an `accepted`, not-ready file; it is done until the human acts again.
- `comments[].line` — 1-based line number **in the current (new) version** of the file.
- `comments[].side` — `right` (current side) or `left` (a removed line; `line` then refers to the adjacent current-side line).
- `comments[].resolved` — set `true` by the agent after addressing the comment.
- `ready` — **human-only** release gate, default false. When the human marks a file "Revise this file" in the GUI (or sets `ready: true`), the agent's waiter wakes for that file even though the rest of the session is still under review. A file is releasable only when it has **open feedback and is `ready`** — its `status` is not part of the gate. The agent clears `ready` when it re-submits the fixed file.
- `comments[].updatedAt` — optional; set when the human edits a comment's text in the GUI.
- `discussion[]` — free-thread Q&A / change requests. `answered` flips to `true` when the other side replies (agent may mark its own answers' counterpart answered; the human answers in the GUI).
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
agent fixes ──> needs_review again, ready cleared, submission+1, comments resolved
agent blocks  ──> new waiter (repeat until accepted)
"Commit changes" ──> available only when NO file has open feedback;
                     sets every file accepted AND records commit options
                     (local commit or PR, optional branch, squash) in the
                     manifest — this confirmation is what ends the session
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
- **Commit changes** (session) — marks every file of THIS session `accepted` and records the commit options in the manifest; that confirmation ends the session (the agent's waiter wakes with `EVENT=done`). A fully accepted session without this confirmation is still waiting. Offered only when this session has no open feedback. The dialog offers: **Commit to local branch** or **Create pull request** (radio), an optional **new branch name** (used for either), and a **Squash commit** checkbox (indented under the PR option, enabled only for PRs, checked by default) that makes the PR a single commit.

## Git rules

- **No commits until the review is fully accepted.** The working tree holds the changes throughout.
- On finalize, commit exactly the paths in `manifest.json` (nothing else may have changed since — if `git status` shows unexpected changes, commit only the listed paths and mention the rest in the PR body).
- Use `git add -A -- <paths...>` so new and deleted files are included.
- PR: `gh pr create --title "<first line of summary>" --body "<summary>"`.

## Writing files

- Write JSON with 2-space indentation and a trailing newline.
- Write atomically where practical (write to a temp file, then rename) so the GUI/daemon never read a half-written file.
- All timestamps: ISO 8601 UTC.
