export const TOOL_ID = 'merge-queue-readiness';

export function evaluate(policy, snapshot, at, deadline = Infinity, now = () => Date.now()) {
  const observations = [];
  const add = (ruleId, pointer, message) => observations.push({ ruleId, pointer, message });
  let checked = 0;
  const expired = () => deadline !== Infinity && now() > deadline;
  const timeout = () => ({ checked, observations: [{ ruleId: 'timeout', pointer: '', message: 'Evaluation exceeded 5000 milliseconds' }] });
  if (expired()) return timeout();
  const age = Date.parse(at) - Date.parse(snapshot.capturedAt);
  if (age < 0) add('capture-future', '/capturedAt', 'Capture is later than the evaluation time');
  else if (age > policy.maxAgeMinutes * 60000) add('capture-stale', '/capturedAt', 'Capture exceeds policy maximum age');
  checked++;
  if (!snapshot.mergeable) add('merge-conflict', '/mergeable', 'Branch is not mergeable');
  checked++;
  if (snapshot.unresolvedThreads > 0) add('review-unresolved', '/unresolvedThreads', 'Review threads remain unresolved');
  if (!snapshot.checksComplete) add('missing-evidence', '/checksComplete', 'Check export is not complete');
  for (const name of policy.requiredChecks) {
    if (expired()) return timeout();
    checked++;
    if (!snapshot.checksComplete) continue;
    const matching = snapshot.checks.filter(c => c.name === name);
    const first = snapshot.checks.findIndex(c => c.name === name);
    const head = snapshot.checks.findIndex(c => c.name === name && c.sha === snapshot.headSha);
    if (!matching.length) add('check-missing', '/checks', `Required check ${name} is absent`);
    else if (head === -1) add('check-wrong-commit', `/checks/${first}`, `Required check ${name} has no result for the head commit`);
    else if (!matching.some(c => c.sha === snapshot.headSha && c.status === 'success')) add('check-unsuccessful', `/checks/${head}`, `Required check ${name} has no successful head result`);
    if (matching.filter(c => c.sha === snapshot.headSha).length > 1) add('missing-evidence', '/checks', `Required check ${name} has ambiguous head results`);
  }
  checked++;
  if (!snapshot.reviewsComplete) add('missing-evidence', '/reviewsComplete', 'Review export is not complete');
  else {
    const headReviews = snapshot.approvals.filter(a => a.sha === snapshot.headSha);
    const reviewers = new Set(headReviews.map(a => a.reviewer));
    if (reviewers.size !== headReviews.length) add('review-ambiguous', '/approvals', 'Multiple effective reviews for one reviewer have no ordering');
    else {
      const headApprovals = new Set(headReviews.filter(a => a.state === 'approved').map(a => a.reviewer));
      if (headApprovals.size < policy.minApprovals) {
        const wrong = snapshot.approvals.some(a => a.state === 'approved' && a.sha !== snapshot.headSha);
        add(wrong ? 'approval-wrong-commit' : 'approval-insufficient', '/approvals', 'Current commit has too few approvals');
      }
      if (headReviews.some(a => a.state === 'changes-requested')) add('changes-requested', '/approvals', 'Current commit has a changes-requested review');
    }
  }
  if (expired()) return timeout();
  return { checked, observations };
}
