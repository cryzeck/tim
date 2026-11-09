// Automated puzzle checks: every reference solution must win, keep winning when the
// starting positions are nudged, and the bench must NOT win with nothing added.
// Usage:  node tests/verify-levels.js            (needs Playwright + network for the CDN)
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.waitForFunction(() => window.__IA && window.__IA.Game.mode !== 'boot', null, { timeout: 60000 });
  const results = await page.evaluate(() => __IA.levels.map((L, i) => {
    const sol = __IA.headlessRun(L, L.solution, 45);
    let robust = 0;
    for (let s = 1; s <= 4; s++) if (__IA.headlessRun(L, L.solution, 45, 0.01, s * 7).won) robust++;
    const empty = __IA.headlessRun(L, [], 30).won;
    const need = {};
    for (const s of L.solution) need[s[0]] = (need[s[0]] || 0) + 1;
    const binOk = Object.entries(need).every(([t, c]) => L.bin[t] >= c);
    return { n: i + 1, name: L.name, won: sol.won, time: sol.time, robust, empty, binOk, problems: sol.problems };
  }));
  let failed = 0;
  for (const r of results) {
    const ok = r.won && r.robust === 4 && !r.empty && r.binOk && !r.problems.length;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)} ${r.name.padEnd(24)} solved in ${r.time}s, ${r.robust}/4 nudged runs, empty bench ${r.empty ? 'WINS (bad)' : 'fails (good)'}${r.binOk ? '' : ', bin too small'}${r.problems.length ? ', ' + r.problems.join('; ') : ''}`);
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
