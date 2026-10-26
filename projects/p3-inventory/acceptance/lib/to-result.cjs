#!/usr/bin/env node
// Converts a Playwright JSON report into the round-2 RESULT_JSON contract:
//   { passed, total, suite, tests: [{ id, requirement, category, severity?, checkpoint, status, message }] }
// Title tags: "[cp1.07][R1.6][C2] ..." (acceptance), "[H03][concurrency:3][cp3][R3.4] ..." (hazards),
// "[M04][RM.2][C2] ..." (maintenance). No criterion tag means C1.
const fs = require('fs');
const [reportPath, outPath, suite] = process.argv.slice(2);
const tests = [];
const strip = (s) => (s || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n').slice(0, 800);

function parse(title) {
  const tags = [...title.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  let id = null, requirement = null, category = 'C1', severity = null, checkpoint = null;
  for (const t of tags) {
    if (/^(cp\d+\.\d+|H\d+|M\d+)$/.test(t) && !id) id = t;
    else if (/^R[\dM]/.test(t)) requirement = t;
    else if (/^C\d+$/.test(t)) category = t;
    else if (/^cp\d+$/.test(t)) checkpoint = t;
    else if (/^[a-z-]+:\d$/.test(t)) [category, severity] = [t.split(':')[0], Number(t.split(':')[1])];
  }
  if (!checkpoint && id && id.startsWith('cp')) checkpoint = id.split('.')[0];
  return { id: id || title, requirement, category, severity, checkpoint };
}

let error = null;
try {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const walk = (s) => {
    for (const child of s.suites || []) walk(child);
    for (const spec of s.specs || []) {
      for (const t of spec.tests || []) {
        const last = (t.results || [])[t.results.length - 1];
        const raw = t.status === 'skipped' ? 'skipped' : last ? last.status : 'skipped';
        const status = raw === 'passed' ? 'pass' : 'fail';
        const meta = parse(spec.title);
        const message = status === 'pass' ? '' : strip((last && last.error && last.error.message) || raw);
        const entry = { id: meta.id, title: spec.title, requirement: meta.requirement, category: meta.category, checkpoint: meta.checkpoint, status, message };
        if (meta.severity) entry.severity = meta.severity;
        tests.push(entry);
      }
    }
  };
  for (const s of report.suites || []) walk(s);
  if ((report.errors || []).length) error = strip(report.errors.map((e) => e.message).join('\n'));
} catch (e) {
  error = `no readable Playwright report: ${e.message}`;
}
const passed = tests.filter((t) => t.status === 'pass').length;
const out = { suite, passed, total: tests.length, error, tests };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`${suite}: passed=${passed} total=${tests.length}${error ? ` error=${error.split('\n')[0]}` : ''}`);
