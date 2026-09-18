import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FileReview, hasOpenFeedback, isReleasable } from '../src';

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
