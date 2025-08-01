import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_ID, evaluate } from '../src/index.mjs';

test('library identifies its tool and evaluates current-head checks', () => {
  assert.equal(TOOL_ID, 'merge-queue-readiness');
  const policy = { requiredChecks: ['build'], minApprovals: 0, maxAgeMinutes: 60 };
  const snapshot = { headSha: 'a'.repeat(40), capturedAt: '2026-01-01T00:00:00Z', mergeable: true, unresolvedThreads: 0, checksComplete: true, reviewsComplete: true, checks: [{ name: 'build', sha: 'b'.repeat(40), status: 'success' }], approvals: [] };
  const result = evaluate(policy, snapshot, '2026-01-01T00:30:00Z');
  assert.equal(result.checked, 4);
  assert.deepEqual(result.observations.map(x => x.ruleId), ['check-wrong-commit']);
});

test('injected deadline accepts equality and reports next tick as incomplete', () => {
  const policy = { requiredChecks: ['build'], minApprovals: 0, maxAgeMinutes: 60 };
  const snapshot = { headSha: 'a'.repeat(40), capturedAt: '2026-01-01T00:00:00Z', mergeable: true, unresolvedThreads: 0, checksComplete: true, reviewsComplete: true, checks: [{ name: 'build', sha: 'a'.repeat(40), status: 'success' }], approvals: [] };
  assert.deepEqual(evaluate(policy, snapshot, '2026-01-01T00:30:00Z', 5, () => 5).observations, []);
  assert.deepEqual(evaluate(policy, snapshot, '2026-01-01T00:30:00Z', 4, () => 5).observations.map(x => x.ruleId), ['timeout']);
});
