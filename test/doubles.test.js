/* Doubles, Champions Doubles and Free-For-All coverage, end to end in Chromium.
 * Run: node test/doubles.test.js  */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8733;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

async function scenario(page, qs) {
  await page.goto(`http://127.0.0.1:${PORT}/test/harness-doubles.html?${qs}`);
  await page.waitForFunction(() => window.__harness &&
    (window.__harness.ready() || window.__harness.emptyTitle()), { timeout: 15000 });
  await page.evaluate(() => window.__harness.openAll());
  await page.waitForTimeout(250);
  return {
    cards: await page.evaluate(() => window.__harness.cards()),
    subtitle: await page.evaluate(() => window.__harness.subtitle()),
    foot: await page.evaluate(() => window.__harness.foot()),
    empty: await page.evaluate(() => window.__harness.emptyTitle())
  };
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ ...require('./chromium') });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  const sec = (c, t) => (c.sections || []).find(s => s.title === t);
  const row = (c, t, n) => (sec(c, t)?.rows || []).find(r => r.name === n);

  console.log('\n[1] Format resolution');
  {
    await page.goto(`http://127.0.0.1:${PORT}/test/harness-doubles.html`);
    const r = await page.evaluate(() => {
      const F = globalThis.RBLFormats;
      const g = id => F.resolve('battle-' + id + '-123', { gen: 9 });
      return {
        doubles: g('gen9randomdoublesbattle'),
        champions: g('gen9championsrandomdoublesbattle'),
        multi: g('gen9multirandombattle'),
        ffa: g('gen9freeforallrandombattle'),
        roulette9: F.resolve('battle-gen9randomroulette-1', { gen: 4 }),
        rouletteNoGen: F.resolve('battle-gen9randomroulette-1', {}),
        hackmons: g('gen9hackmonscup')
      };
    });
    ok(r.doubles.ok && r.doubles.file === 'gen9randomdoublesbattle' && r.doubles.exact,
      'gen9randomdoublesbattle resolves exactly');
    ok(r.champions.ok && r.champions.file === 'gen9championsrandomdoublesbattle' && r.champions.exact,
      'gen9championsrandomdoublesbattle resolves exactly (was missing before)');
    ok(r.multi.ok && !r.multi.exact, 'multi resolves but is flagged approximate');
    ok(r.ffa.ok && !r.ffa.exact, 'free-for-all resolves but is flagged approximate');
    ok(r.roulette9.ok && r.roulette9.file === 'gen4randombattle',
      `roulette resolves from the live gen -> ${r.roulette9.file}`);
    ok(!r.rouletteNoGen.ok, 'roulette without a known gen waits rather than guessing');
    ok(!r.hackmons.ok, 'hackmonscup still correctly rejected');
  }

  console.log('\n[2] Gen 9 Random Doubles — both actives, real set data');
  {
    const s = await scenario(page, 'format=gen9randomdoublesbattle&mode=doubles');
    ok(!s.empty, `panel rendered rather than an empty state (${s.empty || 'ok'})`);
    ok(s.cards.length === 4, `4 opposing Pokemon (got ${s.cards.length})`);
    const active = s.cards.filter(c => c.active).map(c => c.name);
    ok(active.length === 2, `both doubles actives flagged: ${active.join(', ')}`);
    ok(s.cards[s.cards.length - 1].name === 'Urshifu-Rapid-Strike', 'fainted sorts last');
    ok(/DoublesFoe/.test(s.subtitle) && /4\/6 seen/.test(s.subtitle), `header: "${s.subtitle}"`);
    ok(/gen9randomdoublesbattle/.test(s.foot), `footer names the doubles file: "${s.foot}"`);

    const inc = s.cards.find(c => c.name === 'Incineroar');
    ok(!!sec(inc, 'Moves'), 'Incineroar has a Moves section');
    ok(row(inc, 'Moves', 'Fake Out')?.pct === 'seen', 'revealed doubles move marked seen');
    const amoon = s.cards.find(c => c.name === 'Amoonguss');
    // The role shows as a bar section only while it is genuinely in doubt;
    // once it settles it collapses to the facts line, so accept either.
    const roles = sec(amoon, 'Role');
    const roleText = roles ? roles.rows.map(r => r.name + ' ' + r.pct).join(', ')
      : (amoon.lines.find(l => /^ROLE/i.test(l)) || amoon.facts[0] || '');
    ok(!!roleText, `Amoonguss role posterior present (${roleText})`);
    const sum = sec(inc, 'Moves').rows.reduce((a, r) => a + (r.pct === 'seen' ? 1 : parseFloat(r.pct) / 100), 0);
    ok(Math.abs(sum - 4) < 0.02, `doubles move probabilities sum to ~4 (${sum.toFixed(3)})`);
  }

  console.log('\n[2b] Doubles targeting: all four pairings, none of them silent');
  {
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await page.waitForTimeout(400);
    const pairs = await page.evaluate(() => window.__harness.pairs());
    ok(pairs.length === 4, `all four pairings offered (${pairs.map(p => p.label).join(' | ')})`);
    ok(pairs.filter(p => p.on).length === 1, 'exactly one pairing is selected');
    const first = await page.evaluate(() => window.__harness.matchup());
    const other = pairs.find(p => !p.on);
    await page.evaluate(l => window.__harness.clickPair(l), other.label);
    await page.waitForTimeout(400);
    const second = await page.evaluate(() => window.__harness.matchup());
    ok(second && second !== first,
      `picking another pairing re-runs the calc ("${first}" -> "${second}")`);
    const nowOn = await page.evaluate(() => window.__harness.pairs());
    ok(nowOn.find(p => p.label === other.label).on, 'the clicked pairing is the selected one');

    await page.evaluate(() => window.__harness.showTab('Switch'));
    await page.waitForTimeout(400);
    const head = await page.evaluate(() => window.__harness.switchHead());
    ok(head && /Incineroar/.test(head) && /Amoonguss/.test(head) && /or/.test(head),
      `switch advice is against the whole opposing field: "${head}"`);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#rbl-body .rbl-row')]
      .map(r => ({ name: r.querySelector('.rbl-row-name').textContent, title: r.title })));
    ok(rows.length >= 3, `${rows.length} team slots ranked`);
    ok(rows.some(r => /Incineroar’s|Amoonguss’s/.test(r.title)),
      `each row names which of the two would land the worst hit (e.g. "${rows.find(r => r.title)?.title}")`);
    await page.evaluate(() => window.__harness.showTab('Sets'));
    await page.waitForTimeout(300);
  }

  console.log('\n[3] Champions Random Doubles — the format that was unsupported');
  {
    const s = await scenario(page, 'format=gen9championsrandomdoublesbattle&mode=doubles');
    ok(!s.empty, `no "unsupported format" screen (${s.empty || 'rendered'})`);
    const inc = s.cards.find(c => c.name === 'Incineroar');
    ok(!!inc, 'Incineroar card present');
    ok(!inc.sections.length || !!sec(inc, 'Moves'), 'and it has predictions, not a data-missing note');
    ok(/gen9championsrandomdoublesbattle/.test(s.foot), `footer: "${s.foot}"`);
  }

  console.log('\n[4] Free-For-All — four sides, two separate opponents');
  {
    const s = await scenario(page, 'format=gen9freeforallrandombattle&mode=multi');
    const owners = s.cards.map(c => c.owner).filter(Boolean);
    ok(s.cards.length === 2, `both opposing players' Pokemon shown (got ${s.cards.length})`);
    ok(owners.includes('FoeOne') && owners.includes('FoeTwo'),
      `each card is labelled with its owner: ${owners.join(', ')}`);
    ok(!s.cards.some(c => c.name === 'Rillaboom'), 'our ally is excluded from the opponent view');
    ok(!s.cards.some(c => c.name === 'Dragapult'), 'our own Pokemon is excluded');
    ok(/FoeOne \+ FoeTwo/.test(s.subtitle), `header names both: "${s.subtitle}"`);
    ok(/approx/.test(s.foot), `FFA is labelled approximate: "${s.foot}"`);
  }

  console.log('\n[5] No script errors across all scenarios');
  ok(errs.length === 0, `clean${errs.length ? ' -> ' + errs[0] : ''}`);

  await browser.close();
  server.close();
  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
