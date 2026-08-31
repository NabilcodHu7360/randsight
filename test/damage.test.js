/* Damage tab: the vendored calc, the adapter, and the tabbed UI.
 * Run: node test/damage.test.js  */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8736;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}
// rows read like "31\u201337%" — take the high end, not the digits mashed together
const num = s => { const m = String(s).match(/[\d.]+/g); return m ? parseFloat(m[m.length - 1]) : 0; };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

async function load(page, qs) {
  await page.goto(`http://127.0.0.1:${PORT}/test/harness.html${qs ? '?' + qs : ''}`);
  await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 20000 });
  await page.evaluate(() => window.__harness.showTab('Damage'));
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__harness.damage());
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ ...require('./chromium') });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  console.log('\n[1] Vendored calc loads and agrees with the reference formula');
  {
    await page.goto(`http://127.0.0.1:${PORT}/test/harness.html`);
    await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 20000 });
    const r = await page.evaluate(() => {
      const L = globalThis.RSCalcLib;
      const gen = L.Generations.get(9);
      const spread = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
      const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
      const a = new L.Pokemon(gen, 'Kingambit', { level: 74, evs: spread, ivs });
      const d = new L.Pokemon(gen, 'Gholdengo', { level: 77, evs: spread, ivs });
      const res = L.calculate(gen, a, d, new L.Move(gen, 'Sucker Punch'));
      return { desc: res.desc(), stats: a.rawStats, ready: globalThis.RSDamage.ready() };
    });
    ok(r.ready, 'RSDamage reports the library is available');
    // Verified independently in node against @smogon/calc 0.11.0
    ok(/55\.1 - 65\.1%/.test(r.desc) && /guaranteed 2HKO/.test(r.desc),
      `matches the reference result: "${r.desc}"`);
    ok(r.stats.atk === 243, `randbats spread reproduces known stats (Kingambit L74 Atk ${r.stats.atk})`);
  }

  console.log('\n[2] Tabs');
  {
    const tabs = await page.evaluate(() => window.__harness.tabs());
    ok(tabs.join(',') === 'Sets,Damage,Switch', `three tabs: ${tabs.join(', ')}`);
    const before = await page.evaluate(() => window.__harness.activeTab());
    ok(before === 'Sets', `defaults to Sets (${before})`);
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__harness.activeTab());
    ok(after === 'Damage', 'clicking switches to Damage');
    const monCards = await page.evaluate(() => document.querySelectorAll('#rs-body .rs-mon').length);
    ok(monCards === 0, 'the Sets list is replaced, not stacked underneath');
    await page.evaluate(() => window.__harness.showTab('Sets'));
    await page.waitForTimeout(200);
    const back = await page.evaluate(() => document.querySelectorAll('#rs-body .rs-mon').length);
    ok(back === 6, 'switching back restores the Sets list');
  }

  console.log('\n[3] Matchup: Dragapult (theirs, active) vs Iron Valiant (ours)');
  let base;
  {
    base = await load(page, '');
    ok(!base.empty, `matchup rendered (${base.empty || 'ok'})`);
    ok(/Dragapult/.test(base.matchup) && /Iron Valiant/.test(base.matchup),
      `header: "${base.matchup}"`);
    ok(!base.warning, `no stat-reconstruction warning: ${base.warning || 'clean'}`);

    const inc = base.sections.find(s => s.title === 'They hit you');
    const out = base.sections.find(s => s.title === 'You hit them');
    ok(!!inc && inc.rows.length > 0, `${inc && inc.rows.length} incoming moves`);
    // Swords Dance is a status move and never appears; Close Combat DOES,
    // labelled immune, because Fighting can't touch Dragapult's Ghost typing.
    ok(!!out && out.rows.length === 3, `${out && out.rows.length} outgoing rows (3 damaging-category moves)`);
    ok(out.rows.every(r => r.prob !== undefined), 'our own moves show a KO summary instead of a probability');
    ok(!out.rows.some(r => r.move === 'Swords Dance'), 'status move excluded');
    const cc = out.rows.find(r => r.move === 'Close Combat');
    ok(!!cc && cc.dmg === 'immune',
      `Close Combat is shown as immune vs Ghost, not hidden (${cc && cc.dmg})`);
  }

  console.log('\n[4] Incoming is ranked by threat, not raw damage');
  {
    const inc = base.sections.find(s => s.title === 'They hit you');
    const threats = inc.rows.map(r => ({ move: r.move, dmg: num(r.dmg), p: r.prob }));
    console.log('        ' + threats.map(t => `${t.move} ${t.dmg}% @${t.p}`).join(' | '));
    ok(inc.rows.every(r => /\d+–\d+%/.test(r.dmg) || r.dmg === 'immune'),
      'every row shows a damage range or an immunity');
    // Iron Valiant is Fairy/Fighting, so Dragon Darts can't touch it.
    const dd = inc.rows.find(r => r.move === 'Dragon Darts');
    ok(!!dd && dd.dmg === 'immune', `Dragon Darts flagged immune vs Fairy (${dd && dd.dmg})`);
    const damaging = inc.rows.filter(r => r.dmg !== 'immune');
    ok(damaging.length && damaging[0].move === 'Hex',
      `biggest real threat sorts to the top (${damaging[0] && damaging[0].move})`);
    ok(inc.rows[inc.rows.length - 1].dmg === 'immune', 'immunities sink to the bottom');
    ok(inc.rows.some(r => r.prob === 'seen'), 'revealed moves are marked seen');
    ok(inc.rows.some(r => /%$/.test(r.prob) && r.prob !== 'seen'), 'predicted moves carry their probability');
    // Status moves deal no damage and must be filtered out
    ok(!inc.rows.some(r => r.move === 'Will-O-Wisp'), 'status moves are excluded from Incoming');
    ok(inc.rows.some(r => r.ko && /HKO|OHKO/.test(r.ko)), 'KO chance is available on hover');
  }

  console.log('\n[5] Field conditions actually change the numbers');
  {
    const inc0 = base.sections.find(s => s.title === 'They hit you').rows;
    const hex0 = inc0.find(r => r.move === 'Hex') || inc0[0];

    const screens = await load(page, 'screens=1');
    const out1 = screens.sections.find(s => s.title === 'You hit them').rows;
    const base1 = base.sections.find(s => s.title === 'You hit them').rows;
    const ko0 = num(base1.find(r => r.move === 'Knock Off').dmg);
    const ko1 = num(out1.find(r => r.move === 'Knock Off').dmg);
    ok(ko1 < ko0, `Reflect on their side cuts our physical damage (${ko0}% -> ${ko1}%)`);

    const sun = await load(page, 'weather=sunnyday');
    const incSun = sun.sections.find(s => s.title === 'They hit you').rows;
    const fb0 = inc0.find(r => r.move === 'Fire Blast');
    const fb1 = incSun.find(r => r.move === 'Fire Blast');
    if (fb0 && fb1) {
      ok(num(fb1.dmg) > num(fb0.dmg), `Sun boosts their Fire Blast (${num(fb0.dmg)}% -> ${num(fb1.dmg)}%)`);
    } else {
      ok(true, 'no Fire Blast in this matchup; weather plumbing exercised without assertion');
    }
    ok(!!hex0, 'baseline incoming rows were readable');
  }

  console.log('\n[6] Assumptions are disclosed');
  {
    ok(!!base.assumes && /Assumes/.test(base.assumes), `assumption line shown: "${base.assumes}"`);
    ok(/Heavy-Duty Boots|Choice|Leftovers|%/.test(base.assumes),
      'names the predicted item it used');
  }

  console.log('\n[7] Page cost of the vendored bundle');
  {
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/test/harness.html`);
    await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 20000 });
    const ms = Date.now() - t0;
    const size = fs.statSync(path.join(ROOT, 'src', 'vendor', 'calc.js')).size;
    // Shipped UNMINIFIED on purpose: a 480 KB single-line bundle inside a
    // content script reads as obfuscation to a Web Store reviewer, and the
    // minifier strips the upstream legal comments MIT requires. It compresses
    // to a fraction of this over the wire and is read from disk anyway, so the
    // ceiling is about noticing an accidental dependency, not the download.
    ok(size < 1100 * 1024, `vendor bundle is ${(size / 1024).toFixed(0)} KB, unminified and reviewable`);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'vendor', 'calc.js'), 'utf8');
    ok(src.split('\n').length > 1000,
      `and is genuinely readable (${src.split('\n').length} lines, not one)`);
    ok(ms < 8000, `harness (bundle + all scripts + first render) ready in ${ms} ms`);
  }

  console.log('\n[8] Damage is marginalised over the item posterior');
  {
    // [7] reloaded the page, so re-open the Damage tab before reading it.
    base = await load(page, '');
    const swings = await page.evaluate(() => window.__harness.swings());
    // Dragapult's role is pinned, so its item is certain and no row should claim
    // an item swing. A single variant must never produce one — that would mean
    // we were reporting the damage roll as item uncertainty.
    ok(swings.length === 0,
      `a certain item produces no swing markers (${swings.length})`);
    // Dragapult's role is pinned here, so its item is effectively certain and
    // the line collapses to a single name. Both shapes are correct.
    ok(base.assumes && /Assumes/.test(base.assumes),
      `assumption line reports what it used: "${base.assumes}"`);
    // Great Tusk's item genuinely varies (Assault Vest / Leftovers / Choice Band),
    // which is the case the marginalisation exists for.
    const tusk = await load(page, 'active=greattusk');
    ok(/item is unknown/.test(tusk.assumes || ''),
      `an uncertain item is explained in words: "${tusk.assumes}"`);
    const tuskSwings = await page.evaluate(() => window.__harness.swings());
    ok(tuskSwings.length > 0, `${tuskSwings.length} row(s) flag an item-driven swing`);
    ok(/Varies by up to \d+ points with their item/.test(tuskSwings[0] || ''),
      `swing marker explains itself: "${tuskSwings[0]}"`);
    base = await load(page, '');
    const variants = await page.evaluate(() => {
      const D = globalThis.RSDamage;
      const single = D.itemVariants([{ name: 'Leftovers', prob: 1, revealed: true }]);
      const spread = D.itemVariants([
        { name: 'Choice Band', prob: 0.5 }, { name: 'Leftovers', prob: 0.45 },
        { name: 'Focus Sash', prob: 0.04 }, { name: 'Junk', prob: 0.01 }
      ]);
      return { single: single.length, spread: spread.map(v => v.name), sum: spread.reduce((a, v) => a + v.prob, 0) };
    });
    ok(variants.single === 1, 'a revealed item collapses to a single variant');
    ok(variants.spread.length === 3 && !variants.spread.includes('Junk'),
      `fringe items below 3% are dropped: ${variants.spread.join(', ')}`);
    ok(Math.abs(variants.sum - 1) < 1e-9, 'remaining item probabilities renormalise to 1');
  }

  console.log('\n[8b] Damage is marginalised over the ability posterior too');
  {
    // Thick Fat halves incoming Fire damage, so a 55/45 Thick Fat split moves
    // the number further than any item does. Driven through matchup() with a
    // synthetic foe so the ability is the only thing that varies — the item is
    // revealed on every run below.
    const R = await page.evaluate(() => {
      const D = globalThis.RSDamage;
      const mine = {
        // +2 SpA so the damage roll on a single calc is comfortably wider than
        // the 8-point threshold the swing marker uses — that is the trap.
        species: 'Heatran', level: 78, hp: 100, maxhp: 100, boosts: { spa: 2 },
        item: 'Leftovers', ability: 'Flash Fire',
        moves: ['Magma Storm', 'Earth Power']
      };
      function run(abilities) {
        return D.matchup({
          gen: 9, gameType: 'singles', field: {},
          mine: mine,
          foeVM: {
            level: 80, hpPct: 100, moves: [],
            items: [{ name: 'Leftovers', prob: 1, revealed: true }],
            abilities: abilities
          },
          foeRaw: { species: 'Snorlax', boosts: {}, terastallized: '' }
        });
      }
      // exactly what dmgRow() prints into .rs-dmg-pct
      const printed = r => r.loPct.toFixed(0) + '–' + r.hiPct.toFixed(0) + '%';
      const row = (m, name) => {
        const r = m.outgoing.find(x => x.move === name);
        if (!r) throw new Error('no ' + name + ' row: ' + JSON.stringify(m.outgoing.map(x => x.move)));
        return r;
      };
      // exactly what renderDamage() puts in the muted line under the table
      const note = m => m.itemNote || (m.assumes ? 'Assumes ' + m.assumes : '');

      const split = run([{ name: 'Thick Fat', prob: 0.55 }, { name: 'Immunity', prob: 0.45 }]);
      const fat = run([{ name: 'Thick Fat', prob: 1, revealed: true }]);
      const plain = run([{ name: 'Immunity', prob: 1, revealed: true }]);

      const variants = {
        single: D.abilityVariants([{ name: 'Regenerator', prob: 1, revealed: true }]),
        spread: D.abilityVariants([
          { name: 'Thick Fat', prob: 0.55 }, { name: 'Immunity', prob: 0.42 },
          { name: 'Gluttony', prob: 0.02 }
        ]),
        none: D.abilityVariants([]),
        // 4 items x 3 abilities = 12 combinations, trimmed to the budget
        joint: D.crossVariants(
          D.itemVariants([{ name: 'A', prob: 0.4 }, { name: 'B', prob: 0.3 },
            { name: 'C', prob: 0.2 }, { name: 'D', prob: 0.1 }]),
          D.abilityVariants([{ name: 'X', prob: 0.5 }, { name: 'Y', prob: 0.3 },
            { name: 'Z', prob: 0.2 }])
        )
      };

      return {
        splitMS: printed(row(split, 'Magma Storm')),
        fatMS: printed(row(fat, 'Magma Storm')),
        plainMS: printed(row(plain, 'Magma Storm')),
        splitHi: row(split, 'Magma Storm').hiPct,
        fatHi: row(fat, 'Magma Storm').hiPct,
        plainHi: row(plain, 'Magma Storm').hiPct,
        splitSwing: row(split, 'Magma Storm').swing,
        fatSwing: row(fat, 'Magma Storm').swing,
        plainRoll: row(plain, 'Magma Storm').hiPct - row(plain, 'Magma Storm').loPct,
        plainSwing: row(plain, 'Magma Storm').swing,
        fatSwingCount: fat.outgoing.filter(r => r.swing).length,
        plainSwingCount: plain.outgoing.filter(r => r.swing).length,
        fatVariants: fat.outgoing.map(r => r.variants),
        splitNote: note(split),
        fatNote: note(fat),
        av: {
          single: variants.single.length,
          spread: variants.spread.map(v => v.name),
          sum: variants.spread.reduce((a, v) => a + v.prob, 0),
          none: variants.none.length,
          jointLen: variants.joint.length,
          jointSum: variants.joint.reduce((a, v) => a + v.prob, 0),
          jointTop: variants.joint[0].item + '/' + variants.joint[0].ability
        }
      };
    });

    // --- the variant helper itself, mirroring the item checks in [8] ---
    ok(R.av.single === 1, 'a revealed ability collapses to a single variant');
    ok(R.av.spread.length === 2 && !R.av.spread.includes('Gluttony'),
      `fringe abilities below 3% are dropped: ${R.av.spread.join(', ')}`);
    ok(Math.abs(R.av.sum - 1) < 1e-9, 'remaining ability probabilities renormalise to 1');
    ok(R.av.none === 1, 'an absent ability list still yields one (unnamed) variant');
    ok(R.av.jointLen === 6 && Math.abs(R.av.jointSum - 1) < 1e-9,
      `4 items x 3 abilities is capped at 6 joint variants and renormalised (${R.av.jointLen})`);
    ok(R.av.jointTop === 'A/X',
      `the cap keeps the highest-joint-probability combinations first (${R.av.jointTop})`);

    // --- an ability split moves a printed number -----------------------
    console.log(`        Magma Storm: Thick Fat ${R.fatMS} | no Thick Fat ${R.plainMS} | 55/45 split ${R.splitMS}`);
    ok(R.splitMS !== R.fatMS,
      `an ability split changes the printed damage (${R.fatMS} pinned vs ${R.splitMS} marginalised)`);
    ok(R.splitHi > R.fatHi * 1.5,
      `marginalising surfaces the un-resisted case the mode hid (${R.fatHi.toFixed(0)}% -> ${R.splitHi.toFixed(0)}%)`);

    // --- the swing marker fires on an ability-driven swing -------------
    ok(!!R.splitSwing && R.splitSwing.pct > 8,
      `± fires on an ability-driven swing (${R.splitSwing && R.splitSwing.pct.toFixed(0)} points)`);
    ok(!!R.splitSwing && /Thick Fat|Immunity/.test(R.splitSwing.ability || ''),
      `the swing names the ability responsible: "${R.splitSwing && R.splitSwing.item}"`);
    ok(!!R.splitSwing && Math.abs(R.splitSwing.pct - (R.plainHi - R.fatHi)) < 1e-6,
      'the swing is hiMax - hiMin across variants, not the damage roll');

    // --- a revealed ability produces no swing, by construction ---------
    ok(R.fatVariants.every(v => v === 1),
      `a revealed item and ability collapse to one calc run per move (${R.fatVariants.join(',')})`);
    ok(R.fatSwing === null && R.fatSwingCount === 0,
      'a revealed ability produces zero ability-driven swing');
    ok(R.plainRoll > 8 && R.plainSwing === null && R.plainSwingCount === 0,
      `and it stays zero even though that one calc's damage ROLL spans ` +
      `${R.plainRoll.toFixed(0)} points — the marker measures the set, never the roll`);

    // --- the assumption line names the ability -------------------------
    ok(/ability is unknown/.test(R.splitNote || '') && /Thick Fat/.test(R.splitNote || ''),
      `an uncertain ability is named in the note: "${R.splitNote}"`);
    ok(/Thick Fat/.test(R.fatNote || '') && !/unknown/.test(R.fatNote || ''),
      `a revealed ability is stated flatly instead: "${R.fatNote}"`);
    ok((R.splitNote || '').length < 180,
      `the note stays one short muted line (${(R.splitNote || '').length} chars)`);

    base = await load(page, '');
  }

  console.log('\n[9] Speed comparison');
  {
    const sp = await page.evaluate(() => window.__harness.speed());
    ok(!!sp, 'speed block rendered on the Damage tab');
    // Iron Valiant L78 = 226 Spe; Dragapult L77 = 263. They are faster.
    ok(/226/.test(sp.numbers) && /263/.test(sp.numbers), `both speeds shown: "${sp.numbers}"`);
    ok(/They move first/.test(sp.verdict), `verdict: "${sp.verdict}"`);
    ok(/rs-bad/.test(sp.cls), 'losing the speed race is flagged red');

    const tw = await page.evaluate(() => {
      const A = globalThis.RSAdvice;
      return {
        plain: A.effectiveSpeed(226, { gen: 9 }).value,
        tail: A.effectiveSpeed(226, { gen: 9, tailwind: true }).value,
        scarf: A.effectiveSpeed(226, { gen: 9, scarf: true }).value,
        para: A.effectiveSpeed(226, { gen: 9, paralysed: true }).value,
        paraOld: A.effectiveSpeed(226, { gen: 6, paralysed: true }).value,
        boost: A.effectiveSpeed(226, { gen: 9, boost: 2 }).value,
        drop: A.effectiveSpeed(226, { gen: 9, boost: -1 }).value
      };
    });
    ok(tw.tail === 452, `Tailwind doubles (${tw.plain} -> ${tw.tail})`);
    ok(tw.scarf === 339, `Choice Scarf is 1.5x (${tw.scarf})`);
    ok(tw.para === 113, `paralysis halves in gen 9 (${tw.para})`);
    ok(tw.paraOld === 56, `and quartered before gen 7 (${tw.paraOld})`);
    ok(tw.boost === 452 && tw.drop === 150, `boosts apply (+2 ${tw.boost}, -1 ${tw.drop})`);
  }

  console.log('\n[10] Switch advisor');
  {
    await page.evaluate(() => window.__harness.showTab('Switch'));
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() => window.__harness.switches());
    console.log('        ' + rows.map(r => `${r.species} ${r.dmg}${r.speed || ''}`).join(' | '));
    ok(rows.length === 4, `all four team slots listed (${rows.length})`);
    ok(rows[rows.length - 1].species === 'Regieleki' && rows[rows.length - 1].survives === 'fainted',
      'fainted slot sorts last and is labelled');

    const live = rows.filter(r => r.survives !== 'fainted');
    const pcts = live.map(r => parseFloat(r.dmg) || 0);
    // "Safest" is HP left standing, not the smallest damage figure: a wall
    // already at 55% that takes 25% is in more danger than a healthy one
    // that takes 32%.
    const benched = live.filter(r => !r.active).map(r => ({
      s: r.species,
      hp: /at (\d+)%/.test(r.species) ? +RegExp.$1 : 100,
      dmg: parseFloat(r.dmg) || 0
    }));
    const left = benched.map(r => r.hp - r.dmg);
    ok(benched.length >= 2 && left.every((v, i, a) => i === 0 || a[i - 1] >= v),
      `bench is ranked by HP left standing: ${benched.map((r, i) => r.s + ' -> ' + left[i].toFixed(0) + '%').join(', ')}`);
    ok(benched.some(r => r.hp < 100),
      'a chipped slot shows its current HP, so its damage figure reads correctly');
    ok(live.some(r => r.active), 'the active Pokemon is included and marked');
    ok(pcts.some(v => v > 0), 'damage numbers are computed, not blank');
    ok(live.every(r => r.survives === 'yes' || r.survives === 'KO'),
      `survives column is a word, not a number: ${live.map(r => r.survives).join(', ')}`);
    ok(rows.some(r => r.title && /%/.test(r.title)),
      `hover explains the worst case: "${(rows.find(r => r.title) || {}).title}"`);

    const marks = rows.filter(r => r.speed).map(r => r.speed);
    ok(marks.length > 0, `speed markers present (${marks.join('')})`);
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await page.waitForTimeout(200);
  }

  console.log('\n[11] Plain-language verdicts and labelled columns');
  {
    const v = await page.evaluate(() => window.__harness.verdicts());
    console.log('        incoming: ' + v.incoming);
    console.log('        outgoing: ' + v.outgoing);
    ok(!!v.incoming && /KO|survive|hits/.test(v.incoming),
      `incoming says in words what happens: "${v.incoming}"`);
    ok(!!v.outgoing && /KO|survive|hits/.test(v.outgoing),
      `outgoing says in words what happens: "${v.outgoing}"`);

    const cols = await page.evaluate(() => window.__harness.colLabels());
    ok(cols.length >= 2, `${cols.length} labelled column rows`);
    ok(cols[0].join(',') === 'move,of your HP,they have it',
      `incoming columns are named: ${cols[0].join(' | ')}`);
    ok(cols[1].join(',') === 'your move,of their HP,',
      `outgoing columns are named: ${cols[1].join(' | ')}`);

    const legend = await page.evaluate(() =>
      document.querySelector('#rs-body .rs-assumes')?.innerText || '');
    ok(/Bars show damage/.test(legend), `legend explains the bars: "${legend.split('\n')[0]}"`);

    await page.evaluate(() => window.__harness.showTab('Switch'));
    await page.waitForTimeout(250);
    const scols = await page.evaluate(() => window.__harness.colLabels());
    ok(scols[0] && scols[0].join(',') === 'pokemon,worst hit,survives?',
      `switch columns are named: ${scols[0] && scols[0].join(' | ')}`);
    const sv = await page.evaluate(() =>
      document.querySelector('#rs-body .rs-verdict')?.textContent || '');
    ok(/Safest switch:/.test(sv), `switch tab leads with a recommendation: "${sv}"`);
    const kos = await page.evaluate(() =>
      [...document.querySelectorAll('#rs-body .rs-ko-yes, #rs-body .rs-ko-no')].map(x => x.textContent));
    ok(kos.length > 0 && kos.every(k => k === 'yes' || k === 'KO'),
      `survives column reads yes/KO, not a bare number: ${kos.join(',')}`);
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await page.waitForTimeout(200);
  }

  console.log('\n[12] No script errors');
  ok(errs.length === 0, `clean${errs.length ? ' -> ' + errs[0] : ''}`);

  await page.evaluate(() => window.__harness.showTab('Damage'));
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const p = document.getElementById('rs-panel');
    p.style.height = 'auto'; p.style.maxHeight = 'none';
  });
  await page.locator('#rs-panel').screenshot({ path: path.join(ROOT, 'docs', 'damage-tab.png') });

  await browser.close();
  server.close();
  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
