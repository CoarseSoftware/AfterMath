import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FileReview, fileHasAgentChanges, hasOpenFeedback, isReleasable, hasRevisedFeedback, revisedFeedback } from '../src';

function fr(partial: Partial<FileReview>): FileReview {
  return {
    path: 'src/a.ts',
    status: 'needs_review',
    comments: [],
    discussion: [],
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

const openComment = {
  id: 'c1',
  line: 1,
  side: 'right' as const,
  text: 'fix',
  author: 'h',
  createdAt: 'x',
  resolved: false,
};

test('hasOpenFeedback reflects unresolved comments and discussion', () => {
  assert.equal(hasOpenFeedback(fr({})), false);
  assert.equal(hasOpenFeedback(fr({ comments: [openComment] })), true);
  assert.equal(hasOpenFeedback(fr({ comments: [{ ...openComment, resolved: true }] })), false);
  assert.equal(
    hasOpenFeedback(fr({ discussion: [{ id: 'd1', text: 'q', author: 'h', createdAt: 'x', answered: false }] })),
    true
  );
});

test('isReleasable: ready + open feedback, regardless of status', () => {
  const open = fr({ comments: [openComment] }); // needs_review by default
  assert.equal(isReleasable(open), false, 'not ready yet');
  assert.equal(isReleasable({ ...open, ready: true }), true, 'released by the human (any status)');
  assert.equal(isReleasable({ ...open, status: 'rejected', ready: true }), true, 'rejected + ready + open');
  assert.equal(isReleasable({ ...open, ready: true, comments: [{ ...openComment, resolved: true }] }), false, 'no open feedback');
  assert.equal(isReleasable(fr({ status: 'accepted', ready: true })), false, 'accepted without feedback needs no work');
  assert.equal(isReleasable(fr({ status: 'needs_review', ready: true })), false, 'ready but nothing to work on');
});

test('fileHasAgentChanges: set by agent, cleared on accept', () => {
  assert.equal(fileHasAgentChanges(fr({})), false, 'no flag = no indication');
  assert.equal(fileHasAgentChanges(fr({ agentTouched: true })), true, 'agent re-submitted the file');
  assert.equal(
    fileHasAgentChanges(fr({ agentTouched: true, status: 'rejected' })),
    true,
    'flagged even while rejected'
  );
  assert.equal(fileHasAgentChanges(fr({ agentTouched: true, status: 'accepted' })), false, 'accepted clears the indication');
  assert.equal(fileHasAgentChanges(fr({ agentTouched: false })), false, 'explicitly false');
});

test('revisedFeedback / hasRevisedFeedback: only agent-revised items count', () => {
  assert.equal(hasRevisedFeedback(fr({})), false, 'no feedback at all');
  assert.equal(
    hasRevisedFeedback(fr({ comments: [openComment] })),
    false,
    'open (unresolved, unrevised) comment is not revised'
  );
  assert.equal(
    hasRevisedFeedback(fr({ comments: [{ ...openComment, resolved: true, reply: 'done' }] })),
    false,
    'resolved with a reply but no revised flag is not revised (pushback case)'
  );
  const revised = fr({
    comments: [{ ...openComment, resolved: true, reply: 'done', revised: true }],
    discussion: [{ id: 'd1', text: 'q', author: 'h', createdAt: 'x', answered: true }],
  });
  assert.equal(hasRevisedFeedback(revised), true, 'a revised comment counts');
  assert.equal(revisedFeedback(revised).length, 1, 'only the revised item is returned');

  const revisedDiscussion = fr({
    discussion: [{ id: 'd1', text: 'change this', author: 'h', createdAt: 'x', answered: true, reply: 'changed', revised: true }],
  });
  assert.equal(hasRevisedFeedback(revisedDiscussion), true, 'a revised discussion entry counts');
});
