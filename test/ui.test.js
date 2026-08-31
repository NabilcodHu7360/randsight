/* End-to-end check of bridge -> engine -> overlay, driven through a mock
 * Showdown page in real Chromium. Run: node test/ui.test.js  */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8731;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ ...require('./chromium') });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

  const pageErrors = [];
  const blockedSprites = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  // The sandbox can't reach play.pokemonshowdown.com, so sprite requests fail
  // here. Record them separately instead of counting them as script errors.
  page.on('requestfailed', r => blockedSprites.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) blockedSprites.push(r.url()); });

  await page.goto(`http://127.0.0.1:${PORT}/test/harness.html`);
  await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
  await page.evaluate(() => window.__harness.openAll());
  await page.waitForTimeout(300);

  const cards = await page.evaluate(() => window.__harness.dump());
  const subtitle = await page.evaluate(() => window.__harness.subtitle());
  const foot = await page.evaluate(() => window.__harness.foot());

  console.log('\n[1] Wiring');
  const realErrors = pageErrors.filter(e => !/Failed to load resource/.test(e));
  const offsite = blockedSprites.filter(u => !u.startsWith(`http://127.0.0.1:${PORT}/`));
  ok(realErrors.length === 0, `no script errors${realErrors.length ? ' -> ' + realErrors[0] : ''}`);
  ok(blockedSprites.length === offsite.length,
    `every local asset loaded; ${offsite.length} offsite sprite request(s) blocked by the sandbox` +
    (offsite.length ? ` (e.g. ${offsite[0]})` : ''));
  ok(cards.length === 6, `6 opposing Pokemon rendered (got ${cards.length})`);
  ok(/RandomLadderer/.test(subtitle) && /6\/6 seen/.test(subtitle) && /turn 14/.test(subtitle),
    `header reads "${subtitle}"`);
  ok(/gen9randombattle/.test(foot), `footer names the data file: "${foot}"`);

  const by = {};
  cards.forEach(c => { by[c.name] = c; });
  const sec = (c, t) => (c.sections || []).find(s => s.title === t);
  const row = (c, t, n) => (sec(c, t)?.rows || []).find(r => r.name === n);
  // Anything settled collapses out of its section into the muted facts line,
  // so a lookup has to check both places.
  const fact = (c, n) => (c.facts || []).find(f => f.name === n);
  const pick = (c, t, n) => row(c, t, n) || fact(c, n);

  console.log('\n[2] Dragapult: Dragon Darts + U-turn rules out Fast Attacker');
  {
    const c = by['Dragapult'];
    ok(!sec(c, 'Role'), 'the role is settled, so it drops the bar section');
    ok(!!fact(c, 'Fast Support'),
      `role reads "Fast Support" (the only role with both) -> ${(c.facts || []).map(f => f.name).join(', ')}`);
    ok(!fact(c, 'Fast Attacker'), 'Fast Attacker eliminated (it has no Dragon Darts)');
    ok(row(c, 'Moves', 'Hex')?.pct === '100%', 'Hex is now certain');
    ok(row(c, 'Moves', 'Will-O-Wisp')?.pct === '100%', 'Will-O-Wisp is now certain');
    ok(row(c, 'Moves', 'Dragon Darts')?.revealed === true, 'revealed moves flagged as seen');
    ok(c.chips.includes('2/4'), `slot chip shows 2/4 (${c.chips.join(',')})`);
  }

  console.log('\n[3] Great Tusk: three revealed moves collapse to one role');
  {
    const c = by['Great Tusk'];
    ok(!!fact(c, 'Bulky Support'),
      'role collapses to "Bulky Support" (the only role with Headlong Rush)');
    const moves = sec(c, 'Moves').rows.filter(r => !r.revealed);
    ok(moves.length >= 3, `${moves.length} candidate 4th moves still live`);
    const sum = sec(c, 'Moves').rows.reduce((a, r) =>
      a + (r.pct === 'seen' ? 1 : parseFloat(r.pct) / 100), 0);
    ok(Math.abs(sum - 4) < 0.02, `move probabilities still sum to ~4 (${sum.toFixed(3)})`);
    ok(c.chips.includes('3/4'), 'slot chip shows 3/4');
  }

  console.log('\n[4] Gholdengo: a revealed item and tera type feed the posterior');
  {
    const c = by['Gholdengo'];
    const item = pick(c, 'Item', 'Choice Scarf');
    ok(item && item.revealed, 'Choice Scarf shown as revealed');
    ok(c.chips.some(x => /Tera Ghost/.test(x)), `tera chip present (${c.chips.join(',')})`);
    ok((c.notes || []).length === 0, 'a consistent reveal produces no warning note');
    ok(row(c, 'Moves', 'Shadow Ball')?.pct === '100%', 'Shadow Ball certain (in both roles)');
    const speed = (c.meta || []).find(m => /Speed/.test(m));
    ok(!!speed && /Scarf/.test(speed) && !/100%/.test(speed),
      `speed line names the Scarf figure without a redundant 100%: "${speed}"`);
  }

  console.log('\n[5] Slowking-Galar: full set known, fainted');
  {
    const c = by['Slowking-Galar'];
    ok(c.chips.includes('4/4'), 'slot chip shows 4/4');
    const uncertain = sec(c, 'Moves').rows.filter(r => r.pct !== 'seen' && r.pct !== '100%');
    ok(uncertain.length === 0, `no residual move uncertainty (${uncertain.length} rows)`);
    ok(!!fact(c, 'AV Pivot'), 'AV Pivot pinned');
  }

  console.log('\n[6] Kingambit: nothing revealed yet, single role, priors shown');
  {
    const c = by['Kingambit'];
    ok(!sec(c, 'Role'), 'no role section for a single-role species');
    const rows = sec(c, 'Moves').rows;
    ok(rows.length === 4 && rows.every(r => r.pct === '100%'),
      `all four moves certain from the prior (${rows.map(r => r.name).join(', ')})`);
    ok(c.chips.some(x => /BRN/i.test(x)), 'status chip rendered');
    ok(sec(c, 'Moves').title === 'Moves', 'moves section present');
    const label = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#rs-panel .rs-mon')]
        .find(x => /Kingambit/.test(x.querySelector('.rs-name').textContent));
      const s = [...card.querySelectorAll('.rs-sec')]
        .find(x => x.querySelector('.rs-sec-t span').textContent === 'Moves');
      return s.querySelectorAll('.rs-sec-t span')[1].textContent;
    });
    ok(label === 'set is fixed', `header reads "${label}", not "4 unknown"`);
  }

  console.log('\n[7] Corviknight: partial reveal keeps fractional probabilities');
  {
    const c = by['Corviknight'];
    const defog = row(c, 'Moves', 'Defog');
    const uturn = row(c, 'Moves', 'U-turn');
    ok(defog && /%$/.test(defog.pct) && defog.pct !== '100%', `Defog uncertain at ${defog && defog.pct}`);
    ok(uturn && /%$/.test(uturn.pct), `U-turn uncertain at ${uturn && uturn.pct}`);
    ok(row(c, 'Moves', 'Roost')?.pct === '100%', 'guaranteed moves still read 100%');
  }

  console.log('\n[8] Density: only live options on screen');
  {
    // The complaint was that a card showed everything at once. Settled facts
    // are one muted line, long-tail moves sit behind a click, and nothing that
    // mattered got lost.
    const rows = {};
    for (const n of Object.keys(by)) rows[n] = await page.evaluate(
      x => window.__harness.cardRowCount(x), n);
    const worst = Math.max(...Object.values(rows));
    ok(worst <= 8, `busiest card shows ${worst} rows up front (was 12+ before)`);

    const settled = Object.values(by).filter(c => (c.facts || []).length);
    ok(settled.length >= 4, `${settled.length} cards collapsed a settled distribution to text`);
    ok(Object.values(by).every(c => !sec(c, 'Tera')),
      'no card spends a bar section on a Tera type it already knows');

    // Secondary attributes are one line each now, not a section of bars.
    const lines = await page.evaluate(() => [...document.querySelectorAll('#rs-panel .rs-mon')]
      .map(c => [...c.querySelectorAll('.rs-line')].map(l => l.textContent)));
    ok(lines.some(l => l.length), 'uncertain item/ability/Tera render as compact lines');
    ok(Object.values(by).every(c => !sec(c, 'Item') && !sec(c, 'Ability')),
      'no card spends a bar section on an item or ability');

    // Corviknight has genuinely uncertain moves, so they must stay visible.
    ok(sec(by['Corviknight'], 'Moves').rows.some(r => r.name === 'U-turn'),
      'a 29% move is still shown up front, not hidden as a long tail');

    const hidden = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#rs-panel .rs-mon')]
        .find(c => c.querySelector('.rs-more'));
      if (!card) return 'none';
      const name = card.querySelector('.rs-name').firstChild.textContent.trim();
      const vis = () => [...card.querySelectorAll('.rs-row')]
        .filter(r => !r.closest('[hidden]')).length;
      const before = vis();
      card.querySelector('.rs-more').click();
      const after = [...card.querySelectorAll('.rs-row')]
        .filter(r => !r.closest('[hidden]')).length;
      const label = card.querySelector('.rs-more').textContent;
      return { name, before, after, label };
    });
    if (hidden === 'none') {
      ok(true, 'no card needed a long-tail toggle on this fixture');
    } else {
      ok(hidden.after > hidden.before,
        `${hidden.name}: clicking the toggle reveals ${hidden.after - hidden.before} more (${hidden.before} -> ${hidden.after})`);
      ok(/hide/.test(hidden.label), `toggle flips to "${hidden.label}"`);
    }
  }

  console.log('\n[9] Description tooltips');
  {
    const tipRows = await page.evaluate(() => window.__harness.tipRows());
    ok(tipRows.length > 0, `${tipRows.length} rows offer a description`);

    const item = await page.evaluate(() => window.__harness.hover('Choice Scarf'));
    ok(item && /Speed is 1\.5x/.test(item.desc), `item tooltip: "${item && item.desc}"`);
    ok(item && item.title === 'Choice Scarf', 'tooltip is titled with the item name');
    ok(item && item.meta === '', 'items get no stat line');

    const abil = await page.evaluate(() => window.__harness.hover('Good as Gold'));
    ok(abil && /immune to Status moves/.test(abil.desc), `ability tooltip: "${abil && abil.desc}"`);

    const move = await page.evaluate(() => window.__harness.hover('Knock Off'));
    ok(move && /Removes item/.test(move.desc), `move tooltip: "${move && move.desc}"`);
    ok(move && /Dark/.test(move.meta) && /65 BP/.test(move.meta) && /100%/.test(move.meta),
      `move stat line: "${move && move.meta}"`);

    const prio = await page.evaluate(() => window.__harness.hover('Sucker Punch'));
    ok(prio && /\+1 prio/.test(prio.meta), `priority surfaced: "${prio && prio.meta}"`);

    const status = await page.evaluate(() => window.__harness.hover('Will-O-Wisp'));
    ok(status && !/Status/.test(status.meta) && /85%/.test(status.meta),
      `status move omits BP/category: "${status && status.meta}"`);

    const unknown = await page.evaluate(() => window.__harness.hover('Stealth Rock'));
    ok(unknown === null, 'a name with no dex entry gets no tooltip rather than an empty one');

    ok(item.inPanel, 'tooltip lives inside the panel, so it inherits the theme');
  }

  console.log('\n[9b] Evidence the battle gives away');
  {
    const page2 = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await page2.goto(`http://127.0.0.1:${PORT}/test/harness.html?evidence=1`);
    await page2.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
    await page2.evaluate(() => window.__harness.openAll());

    // Their side has already Terastallized, so nobody else on it can.
    const facts = await page2.evaluate(() => [...document.querySelectorAll('#rs-panel .rs-mon')]
      .map(c => ({
        name: c.querySelector('.rs-name').firstChild.textContent.trim(),
        facts: [...c.querySelectorAll('.rs-fact')].map(f => f.textContent),
        tera: [...c.querySelectorAll('.rs-line')].some(l => /^TERA/i.test(l.textContent))
      })));
    const others = facts.filter(f => f.name !== 'Gholdengo');
    ok(others.every(f => f.facts.some(x => /no Tera left/.test(x))),
      'every other Pokemon on that side is marked as having no Tera left');
    ok(others.every(f => !f.tera),
      'and none of them wastes a line on a Tera type it can never use');
    ok(facts.find(f => f.name === 'Gholdengo').facts.every(x => !/no Tera left/.test(x)),
      'the Pokemon that actually Terastallized is not told it has none left');

    // A move with no PP left cannot happen, whatever the posterior says.
    const spent = await page2.evaluate(() => [...document.querySelectorAll('#rs-panel .rs-row.rs-spent')]
      .map(r => r.querySelector('.rs-row-name').textContent));
    ok(spent.some(x => /Hex/.test(x) && /no PP/.test(x)),
      `a move used to its PP limit is struck through and labelled (${spent.join(', ') || 'none'})`);

    // The lock appears only once they have actually committed to a move.
    const before = await page2.evaluate(() => !!document.querySelector('#rs-panel .rs-lock'));
    ok(!before, 'no lock is claimed on the first sighting — the bridge has no baseline yet');
    await page2.waitForTimeout(2200);
    const lock = await page2.evaluate(() =>
      document.querySelector('#rs-panel .rs-lock')?.textContent || null);
    ok(lock && /Locked into Make It Rain/.test(lock),
      `once they commit, the Choice lock is stated: "${lock}"`);
    ok(lock && !/if Choice/.test(lock),
      'a revealed Choice item states the lock outright rather than hedging');
    await page2.close();
  }

  console.log('\n[10] Ordering and screenshots');
  {
    ok(cards[0].name === 'Dragapult', `active Pokemon sorts first (${cards[0].name})`);
    ok(cards[cards.length - 1].name === 'Slowking-Galar',
      `fainted Pokemon sorts last (${cards[cards.length - 1].name})`);
  }

  const panel = page.locator('#rs-panel');
  await page.evaluate(() => {
    const p = document.getElementById('rs-panel');
    p.style.height = 'auto'; p.style.maxHeight = 'none';
  });
  await panel.screenshot({ path: path.join(ROOT, 'test', 'shot-dark.png') });
  await page.evaluate(() => window.__harness.setLight(true));
  await page.waitForTimeout(150);
  await panel.screenshot({ path: path.join(ROOT, 'test', 'shot-light.png') });
  ok(fs.existsSync(path.join(ROOT, 'test', 'shot-dark.png')), 'dark screenshot written');
  ok(fs.existsSync(path.join(ROOT, 'test', 'shot-light.png')), 'light screenshot written');

  await browser.close();
  server.close();
  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
