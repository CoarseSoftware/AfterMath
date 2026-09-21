<table>
  <tr>
    <td align="left" width="78%">
      <h1>After Math</h1>
      <p><strong>Coarse Software, LLC</strong></p>
      <p>MIT Open Source License</p>
    </td>
    <td align="right" width="22%">
      <img src="extensions/review-gui/media/icon.svg" width="240" alt="After Math icon">
    </td>
  </tr>
</table>

---

After Math is a **local code review pipeline for AI coding sessions**: a human review gate that sits between an agent's finished changes and a formal pull request. The AI agent submits its work, a human reviews it in VS Code — inline comments, discussion, per-file accept — the agent fixes exactly what was requested, and only when the human confirms does the agent commit the changes and (optionally) open the PR. Nothing is pushed that a human hasn't reviewed.

## How the agent interacts with the review

The whole loop is file-based (a gitignored `.aftermath/` folder in your project), so it works with any AI agent that can run a shell — Claude Code, Copilot, or others:

```
1. agent finishes coding
   └─> submits a review session: manifest + one file per changed file
       (changes stay UNCOMMITTED in the working tree)
2. agent blocks in a background waiter — zero tokens consumed while it waits
3. human reviews in the After Math VS Code extension
   └─> per file: Accept, line comments, discussion
   └─> "Revise" releases one file early · "Revise all" releases every file with feedback
4. released files wake the agent ──> it fixes ONLY the requested changes
   └─> re-submits, blocks again (repeat until the review is clean)
5. human clicks "Commit changes" (local commit or pull request, optional
   new branch, optional squash)
   └─> agent commits exactly the session's files, opens the PR if asked, cleans up
```

## Install

**1. The VS Code extension** (the review GUI)

- **From the command line (no store needed)** — a packaged installer ships with this repo and with every GitHub Release:

  ```bash
  code --install-extension dist/after-math-0.1.0.vsix
  ```

  (or download `after-math-<version>.vsix` from [Releases](https://github.com/CoarseSoftware/AfterMath/releases) and run the same command on it).

- **From the VS Code Marketplace** — not yet published. Publishing requires a free Microsoft publisher account: register at [marketplace.visualstudio.com](https://marketplace.visualstudio.com/manage/publishers), then from `extensions/review-gui`:

  ```bash
  npm install
  npm run build
  npx @vscode/vsce login <publisher-id>   # one-time browser login
  npx @vscode/vsce publish
  ```

  After that, anyone can install it with `ext install <publisher-id>.after-math`. Until then, the `.vsix` command above is the supported path.

**2. The AI skill** (teaches the agent the submit → wait → fix → finalize workflow)

```bash
cp -r skill/after-math ~/.claude/skills/
```

The agent picks it up automatically; otherwise just point it at `skill/after-math/SKILL.md`. That's the whole setup — no daemon, no server, no accounts. Reviews live on disk, diffs are computed from git, and multiple agents can review the same branch concurrently (one session folder each).

## Repository layout

| Component | Location | What it does |
| --- | --- | --- |
| Protocol | `packages/protocol` | Shared file format, store, and diff engine (hunks, scroll rules, hybrid threshold) |
| Extension | `extensions/review-gui` | VS Code GUI: session tree, full-file review (unified / side-by-side / hybrid), inline comments, discussion, Accept / Revise / Commit controls |
| Skill | `skill/after-math` | The agent-side workflow (submit, background waiter, fix, finalize) |
| Daemon | `daemon` | Optional: toast + sound when a review is submitted or re-submitted |

## Building from source

```bash
npm install
npm run build
npm test
```

## Built for the AI coding era

After Math brings human-in-the-loop code review to agentic coding workflows: AI code review, LLM code review, and code review automation for AI coding assistants (Claude Code, Claude, Copilot, ChatGPT, GPT, and other LLM-powered agents). It is a guardrail for AI-generated code — a pre-PR review gate where an AI agent submits, a human approves, and only then does the pull request exist. Human oversight of AI coding, local-first and private: your code never leaves your machine.
