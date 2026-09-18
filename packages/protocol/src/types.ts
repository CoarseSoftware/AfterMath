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
}

export interface DiscussionEntry {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  answered: boolean;
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
