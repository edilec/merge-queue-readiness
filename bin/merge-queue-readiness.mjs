#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { TOOL_ID, evaluate } from '../src/index.mjs';

const SEVERITY = Object.freeze({ 'input-unreadable': 'warning', 'input-invalid': 'warning', 'input-too-large': 'warning', 'capture-stale': 'warning', 'capture-future': 'warning', 'missing-evidence': 'warning', 'review-ambiguous': 'warning', 'check-missing': 'error', 'check-wrong-commit': 'error', 'check-unsuccessful': 'error', 'approval-insufficient': 'error', 'approval-wrong-commit': 'error', 'changes-requested': 'error', 'review-unresolved': 'error', 'merge-conflict': 'error' });
const INCOMPLETE = new Set(['input-unreadable', 'input-invalid', 'input-too-large', 'capture-stale', 'capture-future', 'missing-evidence', 'review-ambiguous']);
const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120);
const byCode = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = value => typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).every(k => expected.includes(k));
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const usage = () => 'Usage: merge-queue-readiness --root DIR --policy RELATIVE.json --snapshot RELATIVE.json --at UTC_ISO';

function args(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--root', '--policy', '--snapshot', '--at'].includes(key) || !argv[i + 1] || out[key]) throw Error(usage());
    out[key] = argv[i + 1];
  }
  if (Object.keys(out).length !== 4 || !instant(out['--at'])) throw Error(usage());
  for (const key of ['--policy', '--snapshot']) {
    const p = out[key];
    if (isAbsolute(p) || p.split(/[\\/]/).includes('..') || p.startsWith('-') || !p.endsWith('.json')) throw Error('Input paths must be relative JSON files inside --root');
  }
  return out;
}

function finding(ruleId, file, pointer, message) {
  if (!SEVERITY[ruleId]) throw Error('Unknown rule');
  return { ruleId, severity: SEVERITY[ruleId], message, location: { file, pointer } };
}

function report(findings, checked) {
  findings.sort((a, b) => byCode(a.location.file, b.location.file) || byCode(a.location.pointer, b.location.pointer) || byCode(a.ruleId, b.ruleId));
  const status = findings.some(f => INCOMPLETE.has(f.ruleId)) ? 'incomplete' : findings.some(f => f.severity === 'error') ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length }, findings };
}

function readJson(root, name, role) {
  let path;
  try {
    path = realpathSync(resolve(root, name));
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${String.fromCharCode(47)}`) || isAbsolute(rel)) throw Error();
    const stat = statSync(path);
    if (!stat.isFile()) throw Error();
    if (stat.size > 262144) return { error: finding('input-too-large', role, '', 'Input exceeds 262144 bytes') };
    const bytes = readFileSync(path);
    if (bytes.length > 262144) return { error: finding('input-too-large', role, '', 'Input exceeds 262144 bytes') };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(text) };
  } catch {
    return { error: finding('input-unreadable', role, '', 'Input could not be read, decoded or parsed') };
  }
}

function validPolicy(p) {
  return keys(p, ['requiredChecks', 'minApprovals', 'maxAgeMinutes']) && Array.isArray(p.requiredChecks) && p.requiredChecks.length > 0 && p.requiredChecks.length <= 100 && p.requiredChecks.every(x => typeof x === 'string' && /^[A-Za-z0-9_. /-]{1,80}$/.test(x)) && new Set(p.requiredChecks).size === p.requiredChecks.length && Number.isInteger(p.minApprovals) && p.minApprovals >= 0 && p.minApprovals <= 100 && Number.isInteger(p.maxAgeMinutes) && p.maxAgeMinutes >= 1 && p.maxAgeMinutes <= 10080;
}
function validSnapshot(s) {
  return keys(s, ['headSha', 'capturedAt', 'mergeable', 'unresolvedThreads', 'checksComplete', 'reviewsComplete', 'checks', 'approvals']) && sha(s.headSha) && instant(s.capturedAt) && typeof s.mergeable === 'boolean' && typeof s.checksComplete === 'boolean' && typeof s.reviewsComplete === 'boolean' && Number.isInteger(s.unresolvedThreads) && s.unresolvedThreads >= 0 && s.unresolvedThreads <= 10000 && Array.isArray(s.checks) && s.checks.length <= 1000 && s.checks.every(c => keys(c, ['name', 'sha', 'status']) && typeof c.name === 'string' && /^[A-Za-z0-9_. /-]{1,80}$/.test(c.name) && sha(c.sha) && ['success', 'failure', 'pending', 'cancelled'].includes(c.status)) && Array.isArray(s.approvals) && s.approvals.length <= 1000 && s.approvals.every(a => keys(a, ['reviewer', 'sha', 'state']) && typeof a.reviewer === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(a.reviewer) && sha(a.sha) && ['approved', 'changes-requested', 'dismissed'].includes(a.state));
}

function main(argv) {
  let opt;
  try { opt = args(argv); } catch (e) { process.stderr.write(`${clean(e.message)}\n`); return 2; }
  if (opt.help) { process.stdout.write(`${usage()}\n`); return 0; }
  let root;
  try { root = realpathSync(opt['--root']); if (!statSync(root).isDirectory()) throw Error(); }
  catch { process.stderr.write('Root must be a readable directory\n'); return 2; }
  const findings = [];
  const policy = readJson(root, opt['--policy'], '@policy');
  const snapshot = readJson(root, opt['--snapshot'], '@snapshot');
  for (const input of [policy, snapshot]) if (input.error) findings.push(input.error);
  if (!policy.error && !validPolicy(policy.value)) findings.push(finding('input-invalid', '@policy', '', 'Policy schema is invalid or bounded limits were exceeded'));
  if (!snapshot.error && !validSnapshot(snapshot.value)) findings.push(finding('input-invalid', '@snapshot', '', 'Snapshot schema is invalid or bounded limits were exceeded'));
  let checked = 0;
  if (findings.length === 0) {
    const result = evaluate(policy.value, snapshot.value, opt['--at']);
    checked = result.checked;
    for (const row of result.observations) findings.push(finding(row.ruleId, '@snapshot', row.pointer, clean(row.message)));
  }
  const out = report(findings, checked);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.stderr.write(`${out.status}: ${out.summary.checked} checks, ${out.findings.length} findings\n`);
  return out.status === 'pass' ? 0 : out.status === 'fail' ? 1 : 2;
}
process.exitCode = main(process.argv.slice(2));
