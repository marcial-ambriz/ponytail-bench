#!/usr/bin/env node
/**
 * Generic per-checkpoint screenshot capture + automated C10 checks (plan §6.1 C10; gap 13).
 *
 *   node capture-screens.mjs <screens.json> <base-url> <out-dir> [auth-module.mjs]
 *
 * screens.json (already filtered to the screens implemented at this checkpoint by the harness):
 *   [{id, title_es, role: "anon"|<role>, path, actions?: [{goto}|{click}|{fill:[sel,val]}|{press}|{wait}|{waitFor}],
 *     state?: "empty"|"error", expect_text?: "...", expect_role?: "alert"}]
 * auth module (optional, from project.json visual.auth): `export async function login(page, role, baseUrl)`.
 *
 * Writes <out-dir>/<id>-{desktop,mobile}.png and <out-dir>/index.json with per-screen checks:
 *   overflow_390 (no horizontal overflow at 390 px), contrast_aa (axe color-contrast, wcag2aa),
 *   target_size (interactive targets >= 24x24 px, inline text links excluded), state_present (for empty/error
 *   screens: expect_text visible or a role=alert/status element). A check that cannot run is "unavailable" and is
 *   excluded from the denominator (reported). Never fails on app behavior: a failed step is a note.
 * Playwright and axe-core are resolved from BENCH_PLAYWRIGHT_DIR (a directory with node_modules).
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const [screensPath, base, outDir, authModule] = process.argv.slice(2);
if (!screensPath || !base || !outDir) {
  console.error('usage: capture-screens.mjs <screens.json> <base-url> <out-dir> [auth-module]');
  process.exit(64);
}
const require = createRequire(path.join(process.env.BENCH_PLAYWRIGHT_DIR || process.cwd(), 'package.json'));
const { chromium } = require('playwright');
let axeSource = null;
try {
  axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
} catch {
  axeSource = null;
}
const auth = authModule ? await import(pathToFileURL(path.resolve(authModule)).href) : null;
const screens = JSON.parse(fs.readFileSync(screensPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };
const STEP_TIMEOUT = 8000;

async function steps(page, actions, notes) {
  for (const a of actions || []) {
    try {
      if (a.goto) await page.goto(new URL(a.goto, base).href, { waitUntil: 'networkidle', timeout: STEP_TIMEOUT });
      else if (a.click) await page.locator(a.click).first().click({ timeout: STEP_TIMEOUT });
      else if (a.fill) await page.locator(a.fill[0]).first().fill(a.fill[1], { timeout: STEP_TIMEOUT });
      else if (a.press) await page.keyboard.press(a.press);
      else if (a.waitFor) await page.locator(a.waitFor).first().waitFor({ timeout: STEP_TIMEOUT });
      else if (a.wait) await page.waitForTimeout(Math.min(a.wait, 5000));
    } catch (e) {
      notes.push(`step ${JSON.stringify(a)} failed: ${String(e.message || e).split('\n')[0]}`);
    }
  }
}

async function checks(page, s) {
  const out = {};
  out.overflow_390 = (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    ? 'pass' : 'fail';
  out.target_size = (await page.evaluate(() => {
    const els = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[tabindex]')];
    const bad = els.filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') return false;
      if (el.tagName === 'A' && st.display === 'inline' && el.parentElement && /P|LI|SPAN|TD/.test(el.parentElement.tagName)) return false;
      if (el.type === 'hidden') return false;
      return r.width < 24 || r.height < 24;
    });
    return bad.length === 0;
  })) ? 'pass' : 'fail';
  if (axeSource) {
    try {
      await page.addScriptTag({ content: axeSource });
      const res = await page.evaluate(async () =>
        // eslint-disable-next-line no-undef
        axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } }));
      out.contrast_aa = res.violations.length === 0 ? 'pass' : 'fail';
    } catch {
      out.contrast_aa = 'unavailable';
    }
  } else out.contrast_aa = 'unavailable';
  if (s.state) {
    let ok = false;
    if (s.expect_text) ok = await page.getByText(s.expect_text, { exact: false }).first().isVisible().catch(() => false);
    if (!ok) ok = await page.locator(`[role=${s.expect_role || 'alert'}],[role=status]`).first().isVisible().catch(() => false);
    out.state_present = ok ? 'pass' : 'fail';
  }
  return out;
}

const browser = await chromium.launch();
const index = { base: '[app]', screens: [] };
try {
  for (const s of screens) {
    const entry = { id: s.id, title_es: s.title_es, role: s.role, path: s.path, notes: [], files: {}, checks: {} };
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({ viewport: size });
      const page = await ctx.newPage();
      try {
        if (s.role && s.role !== 'anon' && s.role !== 'anonymous') {
          if (auth && auth.login) await auth.login(page, s.role, base);
          else entry.notes.push('no auth module: captured logged out');
        }
        await page.goto(new URL(s.path, base).href, { waitUntil: 'networkidle', timeout: 15000 });
        await steps(page, s.actions, entry.notes);
        const file = path.join(outDir, `${s.id}-${vp}.png`);
        await page.screenshot({ path: file, fullPage: true });
        entry.files[vp] = path.basename(file);
        if (vp === 'mobile') entry.checks = await checks(page, s);
      } catch (e) {
        entry.notes.push(`${vp}: ${String(e.message || e).split('\n')[0]}`);
      } finally {
        await ctx.close();
      }
    }
    index.screens.push(entry);
  }
} finally {
  await browser.close();
}
let passed = 0;
let total = 0;
for (const e of index.screens) {
  for (const v of Object.values(e.checks)) {
    if (v === 'unavailable') continue;
    total += 1;
    if (v === 'pass') passed += 1;
  }
}
index.summary = { passed, total, unavailable: index.screens.flatMap((e) => Object.entries(e.checks).filter(([, v]) => v === 'unavailable').map(([k]) => `${e.id}:${k}`)) };
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`screens=${index.screens.length} checks=${passed}/${total}`);
