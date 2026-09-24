/** After Math review protocol types. */

export type ReviewStatus = 'needs_review' | 'in_review' | 'accepted' | 'rejected';

export const REVIEW_STATUSES: ReviewStatus[] = [
  'needs_review',
  'in_review',
  'accepted',
  'rejected',
];

export interface ReviewComment {
  id: string;
  /** Line number the comment is anchored to (1-based, current/right side of the file). */
  line: number;
  side: 'left' | 'right';
  text: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  /** Set when the human edits the comment text. */
  updatedAt?: string;
  /**
   * The agent's brief reply, set when it addresses the comment. Kept short on
   * purpose: 1–3 sentences describing what it changed. Absent until the agent
   * responds.
   */
  reply?: string;
  /** ISO 8601 time the agent wrote {@link reply}. */
  replyAt?: string;
  /**
   * Agent-written: `true` when the agent changed the code in response to this
   * comment (as opposed to just replying to push back or ask a question).
   * The GUI shows such comments with a "revised" pill in the code view and
   * flags the file with a distinct "revised" icon in the left panel. Absent
   * until the agent sets it; the human's Accept clears it implicitly.
   */
  revised?: boolean;
}

export interface DiscussionEntry {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  answered: boolean;
  /**
   * The agent's brief reply to this discussion entry (a change request or an
   * answer to a question). 1–3 sentences. Absent until the agent responds.
   */
  reply?: string;
  /** ISO 8601 time the agent wrote {@link reply}. */
  replyAt?: string;
  /**
   * Agent-written: `true` when the agent changed the code in response to this
   * discussion entry (a change request it acted on). Not set when the agent
   * only answered a question or pushed back. See
   * {@link ReviewComment.revised}.
   */
  revised?: boolean;
}

/** One per changed file: <sha1(path)>.json inside the session folder. */
export interface FileReview {
  path: string;
  status: ReviewStatus;
  comments: ReviewComment[];
  discussion: DiscussionEntry[];
  /**
   * Human-only release gate. When `true`, the human has reviewed this file and
   * the agent may act on its open feedback right now — without waiting for the
   * rest of the session to be reviewed. Absent/false = the file waits.
   * The agent must clear it on re-submission (its new round needs a fresh review).
   */
  ready?: boolean;
  /**
   * Set `true` by the agent on every (re-)submission of a file it just worked
   * on — i.e. it changed this file since the human last reviewed it. The GUI
   * uses it to flag the file in the left panel (colored name + a "changed by
   * the agent" icon). The human clears it implicitly by accepting the file
   * (the GUI sets it back to `false`). Absent/false = nothing new to point at.
   */
  agentTouched?: boolean;
  /**
   * ISO 8601 stamp written by the GUI when the human's review view for this
   * file is closed (panel closed, or a different file took over the review
   * tab). Feedback the HUMAN created AFTER this stamp (comments / discussion
   * with a `createdAt` later than it) counts as "the human left a discussion"
   * and gets the matching icon in the left panel — the agent's own initial
   * review feedback predates the stamp and never counts. Absent = the human
   * has not (re)looked at this file since the last submission.
   */
  reviewedAt?: string;
  updatedAt: string;
}

/**
 * How the human wants the accepted changes to land. Written to the manifest
 * when the human confirms "Commit changes" in the GUI.
 */
export interface CommitOptions {
  /** `local` = commit to a local branch, stop. `pr` = commit and open a pull request. */
  mode: 'local' | 'pr';
  /**
   * Optional branch name. When set, the agent commits to that branch
   * (creating it if needed) instead of the current one — e.g. when the dev
   * was working directly on `main`.
   */
  branch?: string;
  /**
   * Only for `mode: 'pr'`: squash all of the session's work into a single
   * commit for the pull request. Ignored for local commits.
   */
  squash?: boolean;
}

/** manifest.json inside the session folder. */
export interface Manifest {
  session: string;
  /** Commit the changes are diffed against (HEAD at session start). Changes stay uncommitted until accepted. */
  baseRef: string;
  /** 1-4 line summary of what the agent did. */
  summary: string;
  submittedAt: string;
  /** Submission round, bumped by the agent on every re-submission. */
  submission: number;
  files: string[];
  agent: string;
  /** Set by the human when confirming "Commit changes"; the agent follows it at finalize. */
  commit?: CommitOptions;
}

export interface Session {
  /** Absolute path to the session directory. */
  dir: string;
  manifest: Manifest;
  files: FileReview[];
}

export function unresolvedComments(fr: FileReview): ReviewComment[] {
  return fr.comments.filter((c) => !c.resolved);
}

export function unansweredDiscussion(fr: FileReview): DiscussionEntry[] {
  return fr.discussion.filter((d) => !d.answered);
}

export function hasOpenFeedback(fr: FileReview): boolean {
  return unresolvedComments(fr).length > 0 || unansweredDiscussion(fr).length > 0;
}

/**
 * Whether the agent has made changes to this file that are still awaiting a
 * fresh look (the agent set `agentTouched` on a re-submission and the human
 * has not accepted since). Drives the "agent changed this" color/icon in the
 * left panel.
 */
export function fileHasAgentChanges(fr: FileReview): boolean {
  return fr.agentTouched === true && fr.status !== 'accepted';
}

/**
 * Feedback items the agent has already revised — i.e. it changed the code in
 * response (it set `revised: true` alongside its reply). Drives the "revised"
 * pill in the code view and the "revised" icon in the left panel.
 */
export function revisedFeedback(
  fr: FileReview
): (ReviewComment | DiscussionEntry)[] {
  return [
    ...fr.comments.filter((c) => c.revised === true),
    ...fr.discussion.filter((d) => d.revised === true),
  ];
}

export function hasRevisedFeedback(fr: FileReview): boolean {
  return revisedFeedback(fr).length > 0;
}

/**
 * Did the human leave feedback (a comment or discussion entry) AFTER the
 * view-close stamp? That is the "I looked at this file and added a
 * discussion" state for the left panel icon. Without a stamp the answer is
 * no (the human has not looked at the file since the last submission — the
 * agent's initial review feedback is not a human discussion).
 */
export function hasHumanDiscussionSince(fr: FileReview, sinceIso?: string): boolean {
  if (!sinceIso) return false;
  const after = (t: string) => t > sinceIso; // ISO 8601 strings compare chronologically
  return (
    fr.comments.some((c) => after(c.createdAt)) ||
    fr.discussion.some((d) => after(d.createdAt))
  );
}

/**
 * A file is releasable to the agent when the human marked it ready ("Ready to
 * work") and it still has open feedback (unresolved comments or unanswered
 * discussion). Release is per-file and independent of the session-level
 * buttons: it lets the human stream feedback file-by-file.
 */
export function isReleasable(fr: FileReview): boolean {
  return fr.ready === true && hasOpenFeedback(fr);
}

export function isSessionFinalized(session: Session): boolean {
  return session.files.length > 0 && session.files.every((f) => f.status === 'accepted');
}

/**
 * "Request revision": the file has open feedback (unresolved comments or
 * unanswered discussion) — ready or not.
 */
export function isRevisionRequested(fr: FileReview): boolean {
  return hasOpenFeedback(fr);
}

/**
 * "Commit changes" is allowed only when NO file in the session has open
 * feedback (unresolved comments or unanswered discussion).
 */
export function sessionHasOpenFeedback(session: Session): boolean {
  return session.files.some(hasOpenFeedback);
}
