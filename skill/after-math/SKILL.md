---
name: after-math
description: Submit finished coding work for human review via After Math (Coarse Software)'s local review pipeline. Use at the end of a coding session: it writes the review request into the project (.aftermath/), then blocks in a background waiter — consuming no tokens — until the human releases work in the After Math VS Code extension (per-file "Revise" or the session-level "Revise all"); it fixes only the requested changes, re-submits, and repeats until the human clicks "Commit changes" (every file accepted, with commit options: local commit or pull request, optional new branch, optional squash), at which point it commits the session's files exactly as configured, optionally opens a GitHub PR, and cleans up. Works from any agent harness that can run a background bash task.
---

# Local Code Review Request

After Math reviews live on disk in the project you are working in:

```
<project>/.aftermath/reviews/<sessionId>/
  manifest.json            # session: id, baseRef, summary, submission, files[]
  <sha1(path)>.json        # one per changed file: status, comments[], discussion[]
```

The full file format is in `references/protocol.md`. The folder is gitignored (`.aftermath/`); other agents may have their own session folders there — **never touch another session's folder**.

The waiter script ships with this skill: `scripts/wait-for-review.sh` (same folder as this SKILL.md; on a normal install that is `~/.claude/skills/after-math/scripts/wait-for-review.sh`).

## 1. Submit (when a coding session finishes)

1. Record `baseRef` = the commit HEAD **before your session's changes** (the HEAD you started from).
2. Ensure `.aftermath/` is in the project's `.gitignore` (create it if missing).
3. List your changed files: `git diff --name-only <baseRef>` plus your new untracked files (`git status --porcelain`).
4. Create `.aftermath/reviews/<sessionId>/` where `<sessionId>` is a short unique id (e.g. 7-char hex). If you already have a session folder for this work, **reuse its sessionId**.
5. Write `manifest.json` with a **brief description** of what you did, `baseRef`, `files[]`, `submittedAt` (ISO 8601), and `submission` (1 on first submit; see step 3). The description is what the human sees as the review title in the After Math left panel (small text; it expands to a markdown tab). **Keep it as brief as possible** — one tight sentence (a second only if needed); no filler, no restating the file list. Markdown is supported.
6. Write `README.md` in the session folder: the same description as `summary` (it is the review's description page; the GUI opens it as a markdown tab and will regenerate it from the manifest if missing, but keep it current). Refresh it on re-submission if the description changed.
7. Write one JSON file per changed file (name: first 12 hex chars of `sha1(<path as in manifest>)` + `.json`) with `status: "needs_review"`, empty `comments`/`discussion`, and `updatedAt`.
8. **Do NOT commit.** Changes stay in the working tree until the review is accepted.
9. **Start waiting** (step 2 below).

## 2. Wait (block until the human acts)

Run the waiter as a **background task** (e.g. Claude Code: Bash with `run_in_background: true`; any harness: a detached background process):

```bash
bash <skill-dir>/scripts/wait-for-review.sh <absolute-path-to-session-dir>
```

Then **stop and wait for the task to complete**. Do not poll, do not take other actions on this work — the process blocks (polling every 5 s) and consumes no model tokens until it exits. When it exits, **read its stdout** (the task notification provides it; do not re-read the review files unless the output is truncated):

- `EVENT=fix` → at least one file is **releasable**: marked `ready: true` by the human **with open feedback** (unresolved comments or unanswered discussion). The human releases a file either per-file ("Revise" button) or for the whole session ("Revise all" button, which releases every file that has open feedback). The `PAYLOAD<<AM_EOF … AM_EOF` block is JSON listing exactly those files with their `comments` (line-anchored — each is flagged `resolved: true` because you will address it) and open `discussion` entries. Files that are **not** ready are still waiting for the human — leave them alone. → go to step 3.
- `EVENT=done` → the human clicked **Commit changes** for this session: the manifest has a `commit` field and every file is `accepted`. The human's **commit options** are in `manifest.json` under `commit` (see step 4). Accepting every file WITHOUT "Commit changes" is NOT done — the waiter keeps blocking; do not act. → go to step 4.

## 3. Respond to feedback (after `EVENT=fix`)

1. Make **only** the requested changes, per the payload. Do not refactor, rename, reformat, or touch anything that was not requested — including files not in the payload (they are not released yet).
2. **Reply to every piece of feedback you address** — a line comment or a file discussion entry — with a `reply` on that exact item (see `references/protocol.md`). Keep it **as brief as possible: 1–3 sentences** stating what you changed (or why). Also set `replyAt` (now, ISO 8601 UTC). Do not pad it, and do not restate the feedback.
3. If a comment or question is unclear, or you believe the reviewer is wrong, do NOT change that code — instead put your short explanation in that item's `reply` and leave it **unresolved/unanswered** (do not flip `resolved`/`answered`) so the human can respond. For a comment you can't act on you may additionally add a new `discussion` entry (`answered: false`).
4. Mark each comment you addressed as `resolved: true` (payload comments already carry `resolved: true` — keep it; leave comments you did NOT address unresolved). For each discussion entry you answered (a question or change request), set `answered: true` once your `reply` is written. Set `revised: true` on every comment or discussion entry you made a **code change** for — the GUI shows those items with a "revised" pill in the code view and flags the file with a "revised" icon in the left panel. Do NOT set `revised` on items you only replied to without changing code (pushback or clarification); those just get a `reply`.
5. Set each fixed file's `status` back to `"needs_review"`, **set `agentTouched: true`** (so the GUI shows the file was changed by the agent), **clear its `ready` flag (set `ready: false`)** — your new version needs a fresh review — and update `updatedAt`.
6. Bump `submission` in `manifest.json` (and refresh `submittedAt`).
7. **Start a new waiter** (step 2). Repeat until `EVENT=done`.

## 4. Finalize (after `EVENT=done`)

The human chose how the work lands in the "Commit changes" dialog — read `manifest.json`'s `commit` field: `{ "mode": "local" | "pr", "branch"?: string, "squash"?: boolean }`. Follow it exactly:

1. **Branch:** if `commit.branch` is set, put the changes on that branch first — `git switch -c <branch>` (it does not exist yet; the working-tree changes carry over). If the branch already exists, stop and ask. If `commit.branch` is absent, commit on the current branch.
2. **Commit only the files listed in `manifest.json`:** `git add -A -- <paths...>` (includes new/deleted files).
   - `squash` applies to PRs only and is natural here: all session changes are uncommitted working-tree edits, so a **single commit** of the staged paths is already the squashed commit — use the session summary as its message.
   - For `mode: "local"`: that single commit is the final step of the git work.
3. **`mode: "local"`** → stop after the commit (do NOT push, do NOT open a PR).
   **`mode: "pr"`** → push the branch and create the PR: `gh pr create` with the session summary as the title/body (the single commit from step 2 is the PR's squashed commit).
4. **Delete the session folder** `.aftermath/reviews/<sessionId>/`. Keep the `.aftermath/` directory itself — other agents may be using it.
5. Done.

## Notes

- The human reviews in the After Math VS Code extension (or by editing the JSON files directly — the waiter watches the files, not the GUI).
- **Ready gating:** the human releases work via the per-file "Revise" button (or the session-level "Revise all" button, which releases every file that has open feedback) — or by setting `ready: true` in the file's JSON directly. A file is releasable when `ready: true` **and** it has open feedback. The waiter only wakes for releasable files, so the agent works on released files while the rest of the session waits. Never set `ready` to `true` yourself — it is human-only; you only ever clear it (step 3.4).
- **Accept is not a release:** the per-file **Accept** button (green, toggle — click again to un-accept) marks just that file `accepted` without waking the agent. Accepted files are final: never change their status or their content on a re-submission of other files — re-submit only the files in the payload, leaving every other file's JSON exactly as it is.
- **Commit options:** "Revise all" marks every file with open feedback `rejected` and releases it (this session only — other sessions' waiters are never affected). "Commit changes" is available at any time (the dialog shows "n of m files accepted" and asks for confirmation when some are not) and marks **every** file `accepted` — including ones the human had not accepted yet — and records the human's commit options in the manifest (`commit.mode` local or pr, optional `commit.branch`, `commit.squash` for PRs) — **that confirmation is what produces `EVENT=done`**, and step 4 follows it. Accepting all files alone (without "Commit changes") does not wake the agent. You never set these yourself.
- If your session is interrupted while waiting (crash, user abort), on resume just start a new waiter for the existing session dir: if rejections already exist it wakes immediately with the payload.
- Never set a file's status to `accepted`/`rejected`/`in_review`, nor set `ready: true` — those are human-only. You DO set `agentTouched` (to `true` on each file you re-submit after working on it), the per-item `reply`/`replyAt` on the feedback you address, and `revised: true` on the feedback items you made a code change for — those are yours to write.
