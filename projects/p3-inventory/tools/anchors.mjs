// Captures the fixed C10 anchors (visual/anchors/{0,3,5}.png) from a running reference seeded with seed/seed.mjs.
//   BASE_URL=http://localhost:5173 node tools/anchors.mjs   (run with acceptance/node_modules on NODE_PATH)
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../acceptance/package.json'));
const { chromium } = require('playwright');
const { login } = await import(path.join(here, '../visual/auth.mjs'));

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const out = path.join(here, '../visual/anchors');
const FLAT = `* { font-family: Georgia, "Times New Roman", serif !important; color: #000 !important;
  background: #fff !important; box-shadow: none !important; border-radius: 0 !important; }
  input, select, button, table, th, td { border: 1px solid #000 !important; }`;

const browser = await chromium.launch();
for (const [score, mode] of [[5, 'as-built'], [3, 'flat'], [0, 'unstyled']]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, 'admin', base);
  await page.goto(new URL('/products', base).href, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'HW-BOLT', exact: true }).click();
  await page.getByRole('heading', { name: 'History' }).waitFor();
  await page.waitForTimeout(500);
  if (mode === 'flat') await page.addStyleTag({ content: FLAT });
  if (mode === 'unstyled') await page.evaluate(() => document.querySelectorAll('style, link[rel="stylesheet"]').forEach((n) => n.remove()));
  await page.screenshot({ path: path.join(out, `${score}.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(`anchors written to ${out}`);
