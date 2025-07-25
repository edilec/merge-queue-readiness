import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/merge-queue-readiness.mjs', import.meta.url);
const goodPolicy = { requiredChecks: ['build'], minApprovals: 1, maxAgeMinutes: 60 };
const goodSnapshot = { headSha: 'a'.repeat(40), capturedAt: '2026-01-01T00:00:00Z', mergeable: true, unresolvedThreads: 0, checksComplete: true, reviewsComplete: true, checks: [{ name: 'build', sha: 'a'.repeat(40), status: 'success' }], approvals: [{ reviewer: 'reviewer-1', sha: 'a'.repeat(40), state: 'approved' }] };

function run(policy = goodPolicy, snapshot = goodSnapshot, more = [], at = '2026-01-01T00:30:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'queue-test-'));
  try {
    writeFileSync(join(root, 'policy.json'), JSON.stringify(policy));
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify(snapshot));
    const result = spawnSync(process.execPath, [cli.pathname, '--root', root, '--policy', 'policy.json', '--snapshot', 'snapshot.json', '--at', at, ...more], { encoding: 'utf8' });
    return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('complete current evidence passes and is deterministic', () => {
  const a = run(), b = run();
  assert.equal(a.status, 0);
  assert.equal(a.report.status, 'pass');
  assert.equal(a.report.tool, 'merge-queue-readiness');
  assert.equal(a.stdout, b.stdout);
});

test('a successful check on another commit blocks readiness', () => {
  const snapshot = structuredClone(goodSnapshot);
  snapshot.checks[0].sha = 'b'.repeat(40);
  const result = run(goodPolicy, snapshot);
  assert.equal(result.status, 1);
  assert.equal(result.report.status, 'fail');
  assert.ok(result.report.findings.some(f => f.ruleId === 'check-wrong-commit'));
});

test('unresolved thread and conflict each block readiness', () => {
  for (const change of [{ unresolvedThreads: 1 }, { mergeable: false }]) {
    const result = run(goodPolicy, { ...goodSnapshot, ...change });
    assert.equal(result.status, 1);
    assert.equal(result.report.status, 'fail');
  }
});

test('stale capture is incomplete, never ready', () => {
  assert.equal(run(goodPolicy, goodSnapshot, [], '2026-01-01T01:00:00Z').status, 0);
  const result = run(goodPolicy, goodSnapshot, [], '2026-01-01T01:01:00Z');
  assert.equal(result.status, 2);
  assert.equal(result.report.status, 'incomplete');
  assert.ok(result.report.findings.some(f => f.ruleId === 'capture-stale'));
});

test('a current changes-requested review blocks readiness', () => {
  const snapshot = structuredClone(goodSnapshot);
  snapshot.approvals = [{ reviewer: 'reviewer-2', sha: snapshot.headSha, state: 'changes-requested' }];
  const result = run(goodPolicy, snapshot);
  assert.equal(result.status, 1);
  assert.ok(result.report.findings.some(f => f.ruleId === 'changes-requested'));
});

test('conflicting states for one reviewer are unknown without ordering', () => {
  const snapshot = structuredClone(goodSnapshot);
  snapshot.approvals.push({ reviewer: 'reviewer-1', sha: snapshot.headSha, state: 'changes-requested' });
  const r = run(goodPolicy, snapshot);
  assert.equal(r.status, 2);
  assert.equal(r.report.status, 'incomplete');
  assert.ok(r.report.findings.some(f => f.ruleId === 'review-ambiguous'));
});

test('partial check and review exports are incomplete, not blockers', () => {
  const snapshot = structuredClone(goodSnapshot);
  snapshot.checks = [];
  snapshot.approvals = [];
  snapshot.checksComplete = false;
  snapshot.reviewsComplete = false;
  const r = run(goodPolicy, snapshot);
  assert.equal(r.status, 2);
  assert.equal(r.report.status, 'incomplete');
  assert.ok(r.report.findings.some(f => f.ruleId === 'missing-evidence'));
  assert.ok(!r.report.findings.some(f => f.ruleId === 'check-missing' || f.ruleId === 'approval-insufficient'));
});

test('records bound is complete at N and incomplete at N plus one', () => {
  const snapshot = structuredClone(goodSnapshot);
  snapshot.checks = Array.from({ length: 1000 }, (_, i) => ({ name: `check-${i}`, sha: snapshot.headSha, status: 'success' }));
  snapshot.checks[0].name = 'build';
  assert.equal(run(goodPolicy, snapshot).status, 0);
  snapshot.checks.push({ name: 'overflow', sha: snapshot.headSha, status: 'success' });
  const result = run(goodPolicy, snapshot);
  assert.equal(result.status, 2);
  assert.ok(result.report.findings.some(f => f.ruleId === 'input-invalid'));
});

test('symlink escaping root is refused without exposing target', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-test-'));
  const outside = mkdtempSync(join(tmpdir(), 'queue-outside-'));
  try {
    writeFileSync(join(outside, 'private.json'), 'TOP-SECRET');
    symlinkSync(join(outside, 'private.json'), join(root, 'policy.json'));
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify(goodSnapshot));
    const r = spawnSync(process.execPath, [cli.pathname, '--root', root, '--policy', 'policy.json', '--snapshot', 'snapshot.json', '--at', '2026-01-01T00:30:00Z'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).status, 'incomplete');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('TOP-SECRET'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('malformed JSON yields privacy-safe incomplete report', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-test-'));
  try {
    writeFileSync(join(root, 'policy.json'), 'AKIAIOSFODNN7EXAMPLE');
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify(goodSnapshot));
    const r = spawnSync(process.execPath, [cli.pathname, '--root', root, '--policy', 'policy.json', '--snapshot', 'snapshot.json', '--at', '2026-01-01T00:30:00Z'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).status, 'incomplete');
    assert.ok(!`${r.stdout}${r.stderr}`.includes('AKIA'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown option is a usage error with empty stdout', () => {
  const r = run(goodPolicy, goodSnapshot, ['--typo', 'x']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
});
