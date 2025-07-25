export const TOOL_ID = 'merge-queue-readiness';

export function evaluate(policy, snapshot, at) {
  const observations = [];
  const add = (ruleId, pointer, message) => observations.push({ ruleId, pointer, message });
  let checked = 0;
  const age = Date.parse(at) - Date.parse(snapshot.capturedAt);
  if (age < 0) add('capture-future', '/capturedAt', 'Capture is later than the evaluation time');
  else if (age > policy.maxAgeMinutes * 60000) add('capture-stale', '/capturedAt', 'Capture exceeds policy maximum age');
  checked++;
  if (!snapshot.mergeable) add('merge-conflict', '/mergeable', 'Branch is not mergeable');
  checked++;
  if (snapshot.unresolvedThreads > 0) add('review-unresolved', '/unresolvedThreads', 'Review threads remain unresolved');
  if (!snapshot.checksComplete) add('missing-evidence', '/checksComplete', 'Check export is not complete');
  for (const [index, name] of policy.requiredChecks.entries()) {
    checked++;
    if (!snapshot.checksComplete) continue;
    const matching = snapshot.checks.filter(c => c.name === name);
    const pointer = `/checks/${index}`;
    if (!matching.length) add('check-missing', pointer, `Required check ${name} is absent`);
    else if (!matching.some(c => c.sha === snapshot.headSha)) add('check-wrong-commit', pointer, `Required check ${name} has no result for the head commit`);
    else if (!matching.some(c => c.sha === snapshot.headSha && c.status === 'success')) add('check-unsuccessful', pointer, `Required check ${name} has no successful head result`);
    if (matching.filter(c => c.sha === snapshot.headSha).length > 1) add('missing-evidence', pointer, `Required check ${name} has ambiguous head results`);
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
  return { checked, observations };
}
