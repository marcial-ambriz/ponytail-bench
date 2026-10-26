// Converts a Playwright JSON report into the CONTRACT.md result format.
// usage: node to-result.js <report.json> <result.json> <suite> <scope> <suite_root>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [reportPath, outPath, suite, scope, root] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

// Hash of every file that defines the suite (tests + shared support), so runs can prove they used the frozen suite.
function suiteHash() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|sh|json)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['support', `${suite}/tests`]) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  for (const f of ['playwright.config.ts', 'package.json', 'package-lock.json']) if (fs.existsSync(path.join(root, f))) files.push(path.join(root, f));
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) h.update(path.relative(root, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  return h.digest('hex');
}

const tests = [];
const walk = (s) => {
  for (const c of s.suites || []) walk(c);
  for (const spec of s.specs || []) {
    for (const t of spec.tests || []) {
      const results = t.results || [];
      const last = results[results.length - 1];
      const raw = t.status === 'skipped' ? 'skipped' : last ? last.status : 'skipped';
      const title = spec.title;
      const id = (title.match(/^\[([a-z]+\d*\.\d+)\]/) || [])[1] || title;
      const requirement = (title.match(/\[((?:R|M)\d+\.\d+)\]/) || [])[1] || null;
      const hz = title.match(/\[H:([a-z-]+):([123])\]/);
      const crit = (title.match(/\[(C[25])\]/) || [])[1];
      const cp = (id.match(/^(?:cp|hz)(\d)\./) || [])[1];
      const err = last && (last.error || (last.errors || [])[0]);
      const message = raw === 'passed' ? '' : raw === 'skipped' ? 'skipped' : String((err && err.message) || raw).replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 3).join(' ').slice(0, 500);
      const entry = {
        id,
        requirement,
        category: hz ? hz[1] : suite === 'maintenance' ? 'maintenance' : crit || 'C1',
        checkpoint: cp ? `cp${cp}` : null,
        title,
        status: raw === 'passed' ? 'pass' : 'fail',
        message,
      };
      if (hz) entry.severity = Number(hz[2]);
      tests.push(entry);
    }
  }
};
for (const s of report.suites || []) walk(s);
if (tests.length === 0 && (report.errors || []).length) {
  console.error((report.errors || []).map((e) => e.message).join('\n'));
  process.exit(1);
}
const passed = tests.filter((t) => t.status === 'pass').length;
fs.writeFileSync(outPath, JSON.stringify({ passed, total: tests.length, suite, scope, suite_sha256: suiteHash(), tests }, null, 2) + '\n');
