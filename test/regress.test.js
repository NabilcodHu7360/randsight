/* Regression lock for the pre-release audit.
 *
 * Every block below reproduces a bug that was CONFIRMED live on the panel and
 * asserts the user-visible consequence is gone. The bugs were all invisible
 * from the inside — a frozen panel, a half-drawn body, a banner that
 * contradicted the table under it — so these drive the real rendered overlay
 * through the mock Showdown page wherever they possibly can.
 *
 * Run: node test/regress.test.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'battle-gen9randombattle-log.txt');
const PORT = 8741;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

// --- protocol fixture -> SockJS frames (same shape as test/protocol.test.js)
function readFrames(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.charAt(0) !== '#');
  const frames = [];
  let cur = [];
  lines.forEach(l => {
    if (l.charAt(0) === '>') { if (cur.length) frames.push(cur.join('\n')); cur = [l]; return; }
    cur.push(l);
  });
  if (cur.length) frames.push(cur.join('\n'));
  return frames.filter(f => f.trim());
}
function sockFrame(chunk) { return 'a' + JSON.stringify([chunk]); }

// A bare page for reader 2 only: no window.app, no window.PS, so the protocol
// reader is the only thing running. Used by the reconnect block.
const PROTO_HARNESS = `<!doctype html>
<meta charset="utf-8">
<title>randbats-live — regress protocol harness</title>
<body>
<script>
window.WebSocket = class FakeSocket extends EventTarget {
  constructor(url) { super(); this.url = url; this.readyState = 1; window.__sock = this; }
  send() {}
  close() { this.readyState = 3; }
};
</script>
<script src="/src/inject.js"></script>
<script>
var TAG = '__randbats_live__';
window.__last = null;
window.__pending = null;
window.addEventListener('message', function (ev) {
  if (ev.source !== window || !ev.data || ev.data.__rbl !== TAG) return;
  if (ev.data.type !== 'battles') return;
  window.__last = ev.data.payload;
  if (window.__pending) window.__pending(ev.data.payload);
});
new WebSocket('wss://sim3.psim.us/showdown/websocket');
window.__push = function (frame) {
  window.__sock.dispatchEvent(new MessageEvent('message', { data: frame }));
};
window.__snap = function () {
  return new Promise(function (res) {
    var done = false;
    window.__pending = function (p) { if (done) return; done = true; window.__pending = null; res(p); };
    setTimeout(function () { if (done) return; done = true; window.__pending = null; res(window.__last); }, 400);
    window.postMessage({ __rbl: TAG, type: 'resync' }, location.origin);
  });
};
</script>
</body>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/regress-protocol.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PROTO_HARNESS);
    return;
  }
  const p = path.join(ROOT, decodeURIComponent(url));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const frames = readFrames(FIXTURE);
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ ...require('./chromium') });

  /** A fresh tab on the mock Showdown page, waited until the panel exists. */
  async function open(qs, opts) {
    opts = opts || {};
    const page = await browser.newPage({ viewport: opts.viewport || { width: 1180, height: 820 } });
    page.__errors = [];
    page.on('pageerror', e => page.__errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/test/harness.html${qs ? '?' + qs : ''}`);
    if (opts.waitForPanelOnly) {
      await page.waitForFunction(() => !!document.getElementById('rbl-panel'), { timeout: 20000 });
    } else {
      await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 20000 });
    }
    return page;
  }

  // ===================================================================
  console.log('\n[1] The silent freeze: a throwing client property used to leave the');
  console.log('    panel showing an old turn forever, with nothing on screen to say so');
  // ===================================================================
  {
    const page = await open('');
    const before = await page.evaluate(() => window.__harness.subtitle());
    ok(/turn 14/.test(before), `the panel starts on the real turn: "${before}"`);

    // The reader now walks a property that throws, and the battle moves on.
    const newTurn = await page.evaluate(() => window.__harness.breakReader());
    await sleep(1800);

    const after = await page.evaluate(() => ({
      sub: window.__harness.subtitle(),
      text: window.__harness.text(),
      notice: window.__harness.notice(),
      cards: document.querySelectorAll('#rbl-panel .rbl-mon').length,
      log: window.__harness.bridgeLog()
    }));

    ok(!/turn 14/.test(after.sub),
      `the panel stops showing turn 14 once the battle has moved on to turn ${newTurn} ` +
      `(header now reads "${after.sub}")`);
    ok(after.notice && /Lost track of the battle/.test(after.notice.title),
      `the user is told the panel lost the battle instead of being shown stale numbers ` +
      `(notice: "${after.notice && after.notice.title}")`);
    ok(/could not be read/.test(after.text) && /Reload the page/.test(after.text),
      'the notice says why the numbers stopped and what to do about it');
    ok(after.cards === 0,
      'the six stale team cards are cleared, so nothing on screen still looks current');
    ok(after.log.some(e => e.type === 'stalled'),
      'the bridge reports the failed read rather than posting nothing at all');
    await page.close();
  }

  // ===================================================================
  console.log('\n[2] A throw inside rerender used to freeze the body half-drawn while the');
  console.log('    header kept ticking, so the panel looked alive');
  // ===================================================================
  {
    const page = await open('');
    const cardsBefore = await page.evaluate(() => document.querySelectorAll('#rbl-panel .rbl-mon').length);
    ok(cardsBefore === 6, `the panel is drawing normally first (${cardsBefore} cards)`);

    await page.evaluate(() => {
      globalThis.RBLDamage.matchup = function () { throw new Error('calc exploded'); };
      window.__harness.bumpTurn(1);
    });
    await sleep(1200);

    const after = await page.evaluate(() => ({
      sub: window.__harness.subtitle(),
      notice: window.__harness.notice(),
      cards: document.querySelectorAll('#rbl-panel .rbl-mon').length
    }));
    ok(after.notice && /Something went wrong/.test(after.notice.title),
      `a failed render says so on screen (notice: "${after.notice && after.notice.title}")`);
    ok(after.cards === 0,
      'no half-drawn team list is left behind pretending to be the current state');
    ok(!/turn \d+/.test(after.sub),
      `the header stops ticking a turn counter over a body that never drew (header: "${after.sub}")`);
    ok(page.__errors.length === 0,
      `the throw is contained rather than escaping as an uncaught page error` +
      `${page.__errors.length ? ' -> ' + page.__errors[0] : ''}`);

    // The other half of the bug: a tab bar pointing at a tab whose body never
    // rendered, permanently.
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await sleep(800);
    const tabbed = await page.evaluate(() => ({
      tab: window.__harness.activeTab(),
      cards: document.querySelectorAll('#rbl-body .rbl-mon').length,
      empty: !!document.querySelector('#rbl-body .rbl-empty'),
      rows: document.querySelectorAll('#rbl-body .rbl-row').length
    }));
    ok(tabbed.tab === 'Damage' && tabbed.cards === 0 && tabbed.empty && tabbed.rows === 0,
      'switching tabs after a failed render still shows a body that matches the tab — ' +
      `never the previous tab's contents stranded underneath (tab ${tabbed.tab}, ` +
      `${tabbed.cards} cards, ${tabbed.rows} rows)`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[3] Both readers used to tick at once, so the cruder one won every other');
  console.log('    tick and the Damage/Switch tabs blinked out');
  // ===================================================================
  {
    // Control: with no client objects the fall-through must actually happen,
    // which is what proves the frames below are real and being parsed.
    const ctrl = await open('socket=1&noclient=1', { waitForPanelOnly: true });
    for (const f of frames.slice(0, 16)) {
      await ctrl.evaluate(fr => window.__harness.pushFrame(fr), sockFrame(f));
    }
    await sleep(1500);
    const ctrlFoot = await ctrl.evaluate(() => window.__harness.foot());
    const ctrlCards = await ctrl.evaluate(() => document.querySelectorAll('#rbl-panel .rbl-mon').length);
    ok(/fallback reader/.test(ctrlFoot || ''),
      `with no client object the panel still works off the socket and says so: "${ctrlFoot}"`);
    ok(ctrlCards > 0, `the fallback really is driving the panel (${ctrlCards} cards)`);
    await ctrl.close();

    // The real case: a working client object AND protocol frames arriving.
    const page = await open('socket=1');
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await sleep(400);

    const foots = [];
    const matchups = [];
    for (let i = 0; i < 16; i++) {
      await page.evaluate(fr => window.__harness.pushFrame(fr), sockFrame(frames[i % frames.length]));
      await page.evaluate(() => window.__harness.bumpTurn(1));
      await sleep(260);
      const shot = await page.evaluate(() => ({
        foot: window.__harness.foot(),
        matchup: window.__harness.damage().matchup || null
      }));
      foots.push(shot.foot);
      matchups.push(shot.matchup);
    }
    const log = await page.evaluate(() => window.__harness.bridgeLog());
    const sources = log.filter(e => e.type === 'battles')
      .reduce((a, e) => a.concat(e.sources), []);

    ok(foots.every(f => !/fallback reader/.test(f || '')),
      `across ${foots.length} ticks with socket frames arriving the panel never falls back ` +
      `to the cruder reader (footers seen: ${[...new Set(foots)].join(' | ')})`);
    ok(sources.length > 0 && sources.every(s => s === 'client'),
      `every tick came from the same reader, so the panel never alternates ` +
      `(${sources.length} ticks, sources: ${[...new Set(sources)].join(',')})`);
    ok(matchups.every(Boolean),
      `the Damage tab stays on screen for all ${matchups.length} ticks instead of blinking out ` +
      `(${matchups.filter(Boolean).length}/${matchups.length} ticks had a matchup)`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[4] A failed set-data fetch used to be cached, killing the panel for good');
  // ===================================================================
  {
    const page = await open('setsfail=1', { waitForPanelOnly: true });
    await sleep(600);
    const first = await page.evaluate(() => ({
      notice: window.__harness.notice(),
      attempts: window.__harness.setsAttempts()
    }));
    ok(first.notice && /Could not load set data/.test(first.notice.title),
      `the first failure is reported to the user, not swallowed ` +
      `(notice: "${first.notice && first.notice.title}")`);
    ok(/retrying/.test((first.notice && first.notice.text) || ''),
      'and the notice promises a retry rather than telling the user to reload the extension');

    // No reload, no extension restart: just the battle carrying on.
    let cards = 0, attempts = first.attempts;
    for (let i = 0; i < 20 && cards === 0; i++) {
      await page.evaluate(() => window.__harness.bumpTurn(1));
      await sleep(800);
      const shot = await page.evaluate(() => ({
        cards: document.querySelectorAll('#rbl-panel .rbl-mon').length,
        attempts: window.__harness.setsAttempts()
      }));
      cards = shot.cards; attempts = shot.attempts;
    }
    ok(attempts > 1, `the panel asks for the set data again after a failure (${attempts} attempts)`);
    ok(cards === 6,
      `the panel comes back to life on its own without the user reloading the page ` +
      `(${cards} cards)`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[5] A bench slot the calc cannot build used to read "worst hit: nothing"');
  console.log('    and "KO" in the same row, and poisoned the safest-switch ordering');
  // ===================================================================
  {
    const page = await open('unknownmon=1');
    await page.evaluate(() => window.__harness.showTab('Switch'));
    await sleep(500);
    const view = await page.evaluate(() => ({
      rows: window.__harness.switches(),
      verdicts: window.__harness.verdicts(),
      text: window.__harness.text()
    }));
    const odd = view.rows.find(r => /Zzzynthian/.test(r.species));
    ok(!!odd, `the unbuildable Pokemon still gets a row instead of vanishing off your team ` +
      `(rows: ${view.rows.map(r => r.species).join(', ')})`);
    ok(!!odd && odd.survives === 'unknown',
      `that row says "unknown" rather than claiming an outcome ` +
      `(it reads "${odd && odd.survives}")`);
    ok(!!odd && odd.survives !== 'KO',
      'a bench slot the calc cannot build is never reported as a guaranteed knockout');
    ok(!!odd && !(odd.dmg === 'nothing' && odd.survives === 'KO'),
      `the row no longer contradicts itself with "nothing" damage and a KO verdict ` +
      `(worst hit "${odd && odd.dmg}", verdict "${odd && odd.survives}")`);
    ok(!/Safest switch: Zzzynthian/.test(view.verdicts.all.join(' ')),
      `a Pokemon nobody could evaluate is never recommended as the safest switch ` +
      `(banner: "${view.verdicts.all[0] || 'none'}")`);

    const bench = view.rows.filter(r => !r.active && r.survives !== 'fainted');
    const idx = bench.findIndex(r => /Zzzynthian/.test(r.species));
    ok(idx === bench.length - 1,
      `it sorts below every bench slot that could actually be worked out, so it is not ` +
      `at the top of the list the player reads first (bench order: ${bench.map(r => r.species).join(' > ')})`);
    ok(!/NaN/.test(view.text),
      'and it does not poison the ordering with NaN anywhere on the Switch tab');
    await page.close();
  }

  // ===================================================================
  console.log('\n[6] Gen 1-2 speed used the Gen 3+ formula, which inverted the');
  console.log('    "who moves first" banner in two shipped formats');
  console.log('    (direct RBLAdvice/RBLCalcLib call in the page — the harness fixture is Gen 9 only)');
  // ===================================================================
  {
    const page = await open('');
    const res = await page.evaluate(() => {
      const L = globalThis.RBLCalcLib;
      const A = globalThis.RBLAdvice;
      const EV = 85, IV = 31;
      // The formula the panel used for every generation before the fix.
      const gen3Formula = (base, level) =>
        Math.floor(Math.floor(((2 * base + IV + Math.floor(EV / 4)) * level) / 100) + 5);
      const probe = (species, base, level, gen) => {
        const g = L.Generations.get(gen);
        const pk = new L.Pokemon(g, species, {
          level,
          evs: { hp: EV, atk: EV, def: EV, spa: EV, spd: EV, spe: EV },
          ivs: { hp: IV, atk: IV, def: IV, spa: IV, spd: IV, spe: IV }
        });
        return {
          species, gen, level,
          calc: pk.rawStats.spe,
          advice: A.rawSpeed(base, level, null, null, gen, species),
          oldFormula: gen3Formula(base, level)
        };
      };
      return {
        rows: [
          probe('Jolteon', 130, 80, 1),
          probe('Jolteon', 130, 80, 2),
          probe('Jolteon', 130, 80, 9),
          probe('Snorlax', 30, 80, 1),
          probe('Snorlax', 30, 80, 2),
          probe('Snorlax', 30, 80, 9)
        ],
        // With no species the calc cannot be consulted at all.
        noSpeciesGen1: A.rawSpeed(130, 80, null, null, 1, null),
        noSpeciesGen2: A.rawSpeed(130, 80, null, null, 2, null),
        noSpeciesGen9: A.rawSpeed(130, 80, null, null, 9, null)
      };
    });

    res.rows.forEach(r => {
      ok(r.advice === r.calc,
        `${r.species} L${r.level} gen ${r.gen}: the Speed the panel compares is the Speed the ` +
        `game gives it — ${r.advice} vs the calc's ${r.calc}`);
    });
    const oldWrong = res.rows.filter(r => r.gen < 3 && r.oldFormula !== r.calc);
    ok(oldWrong.length === 4,
      `all four gen 1/2 cases would have been wrong under the old formula, so this test ` +
      `has teeth (e.g. ${oldWrong[0].species} gen ${oldWrong[0].gen}: ` +
      `${oldWrong[0].oldFormula} instead of ${oldWrong[0].calc})`);
    ok(res.rows.filter(r => r.gen < 3).every(r => r.advice !== r.oldFormula),
      'no gen 1/2 Speed on screen is the old Gen 3 number any more');
    ok(res.noSpeciesGen1 === null && res.noSpeciesGen2 === null,
      `when the calc cannot help, gen 1/2 Speed is left blank rather than guessed wrong ` +
      `(got ${res.noSpeciesGen1} / ${res.noSpeciesGen2})`);
    ok(typeof res.noSpeciesGen9 === 'number',
      `gen 9 still gets a number without the calc (${res.noSpeciesGen9})`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[7] The verdict used the threat-ranked first row, so the banner could say');
  console.log('    "You survive" directly above a row showing 105-124%');
  console.log('    (matchup built by a direct RBLDamage call, then drawn by the real renderer)');
  // ===================================================================
  {
    const page = await open('');
    const res = await page.evaluate(() => {
      const D = globalThis.RBLDamage;
      // A weak move they almost certainly have, and a lethal one they probably
      // do not. Threat ranking (damage x probability) puts the weak one first.
      const out = D.matchup({
        gen: 9, gameType: 'singles',
        field: { weather: '', terrain: '', near: {}, far: {} },
        mine: { species: 'Iron Valiant', level: 78, hp: 244, maxhp: 244, boosts: {},
                moves: ['Moonblast'], item: '', ability: '' },
        foeVM: { level: 74, hpPct: 100, items: [], abilities: [], evs: null, ivs: null,
                 moves: [{ name: 'Fake Out', prob: 0.95, revealed: false },
                         { name: 'Explosion', prob: 0.05, revealed: false }] },
        foeRaw: { species: 'Kingambit', level: 74, boosts: { atk: 2 }, terastallized: '' }
      });
      // Draw it with the real renderer so the assertion is on what a player reads.
      const st = globalThis.RBLUI.getState();
      st.tab = 'damage';
      globalThis.RBLUI.render({
        subtitle: 'regression', mons: [], damage: out, speed: null, switches: null,
        footLeft: '', footRight: ''
      });
      return {
        rows: out.incoming.map(r => ({ move: r.move, hi: Math.round(r.hiPct), lo: Math.round(r.loPct) })),
        banner: (document.querySelector('#rbl-body .rbl-verdict') || {}).textContent || '',
        shownRows: [...document.querySelectorAll('#rbl-body .rbl-row .rbl-row-name')].map(n => n.textContent)
      };
    });

    const worst = res.rows.reduce((a, b) => (b.hi > a.hi ? b : a));
    ok(res.rows[0].move !== worst.move,
      `the table is still ranked by threat, so the hardest hit is not the first row ` +
      `(first "${res.rows[0].move}" at ${res.rows[0].hi}%, hardest "${worst.move}" at ${worst.hi}%)`);
    ok(worst.hi >= 100,
      `the hardest hit really is lethal (${worst.move} ${worst.lo}-${worst.hi}%)`);
    ok(!/You survive/.test(res.banner),
      `the banner never claims survival above a row that kills you (banner: "${res.banner}")`);
    ok(new RegExp(worst.move).test(res.banner),
      `the banner names the move that actually kills you (banner: "${res.banner}")`);
    ok(/KO/.test(res.banner),
      'and calls it a knockout in plain words');
    await page.close();
  }

  // ===================================================================
  console.log('\n[8] "about NaN hits" reached the screen, because typeof NaN === "number"');
  console.log('    (the visible failure was the damage banner; the HP-bar gate in ui.js means');
  console.log('     content.js\'s hpPercent() is belt-and-braces behind it)');
  // ===================================================================
  {
    const page = await open('nanhp=1');
    const seen = [];
    for (const tab of ['Sets', 'Damage', 'Switch']) {
      await page.evaluate(t => window.__harness.showTab(t), tab);
      await sleep(500);
      seen.push({ tab, text: await page.evaluate(() => window.__harness.text()) });
    }
    seen.forEach(s => {
      const bad = (s.text.match(/[^\s]*NaN[^\s]*/g) || []).slice(0, 3);
      ok(!/NaN/.test(s.text),
        `nothing on the ${s.tab} tab reads NaN to the player when our own HP is missing` +
        `${bad.length ? ' -> ' + bad.join(', ') : ''}`);
    });

    await page.evaluate(() => window.__harness.showTab('Damage'));
    await sleep(400);
    const verdicts = await page.evaluate(() => window.__harness.verdicts().all);
    ok(verdicts.length > 0 && verdicts.every(v => !/NaN/.test(v)),
      `the damage banners still read as sentences rather than "about NaN hits" ` +
      `(${verdicts.map(v => '"' + v + '"').join(' / ')})`);
    ok(verdicts.some(v => /\bhits\b|KO/.test(v)),
      'and they still say something useful about how many hits it takes');

    // The same tick has a foe whose HP cannot be read at all.
    await page.evaluate(() => window.__harness.showTab('Sets'));
    await page.evaluate(() => window.__harness.openAll());
    await sleep(400);
    const corv = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#rbl-panel .rbl-mon')]
        .find(c => /Corviknight/.test(c.querySelector('.rbl-name').textContent));
      if (!card) return null;
      const bar = card.querySelector('.rbl-hp');
      return { text: card.textContent, hasBar: !!bar, barLabel: bar ? bar.getAttribute('aria-label') : null };
    });
    ok(!!corv && !/NaN/.test(corv.text),
      `a Pokemon whose HP the page will not give up shows no NaN on its card` +
      `${corv && /NaN/.test(corv.text) ? ' -> ' + corv.text.slice(0, 120) : ''}`);
    ok(!!corv && !corv.hasBar,
      `and shows no HP reading at all rather than a nonsense one ` +
      `(bar label: ${corv && corv.barLabel})`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[9] A saved panel position was re-applied with no viewport clamp, so a');
  console.log('    position from a big monitor put the whole panel off a laptop screen');
  // ===================================================================
  {
    const page = await open('pos=off', { waitForPanelOnly: true, viewport: { width: 1180, height: 820 } });
    await sleep(500);
    const r = await page.evaluate(() => window.__harness.rect());
    ok(r.left >= 0 && r.top >= 0 && r.left < r.vw && r.top < r.vh,
      `a position saved on a 5200x4100 desktop still lands on screen ` +
      `(panel at ${Math.round(r.left)},${Math.round(r.top)} in a ${r.vw}x${r.vh} viewport)`);
    ok(r.right > 0 && r.left <= r.vw - 120 + 1,
      `at least 120px of the panel is reachable with the mouse (right edge ${Math.round(r.right)})`);
    ok(r.top <= r.vh - 30 + 1,
      `the drag handle at the top of the panel is on screen, so the panel can be moved back ` +
      `(top ${Math.round(r.top)}, viewport height ${r.vh})`);

    // The other half: the window shrinks under a position that was fine before.
    await page.setViewportSize({ width: 640, height: 460 });
    await sleep(500);
    const r2 = await page.evaluate(() => window.__harness.rect());
    ok(r2.left >= 0 && r2.top >= 0 && r2.left <= r2.vw - 120 + 1 && r2.top <= r2.vh - 30 + 1,
      `shrinking the window drags the panel back into view instead of stranding it ` +
      `(panel at ${Math.round(r2.left)},${Math.round(r2.top)} in ${r2.vw}x${r2.vh})`);

    // The escape hatch the popup offers, played back through chrome.storage
    // exactly as popup/popup.js writes it. (The popup's own DOM is not driven
    // by any harness; this is the half that reaches the panel.)
    await page.evaluate(() => window.__harness.resetPanelPosition());
    await sleep(400);
    const r3 = await page.evaluate(() => window.__harness.rect());
    ok(r3.left >= 0 && r3.top >= 0 && r3.right <= r3.vw + 1 && r3.top <= r3.vh - 30 + 1,
      `"Reset panel position" puts the panel back in its corner without a page reload ` +
      `(panel at ${Math.round(r3.left)},${Math.round(r3.top)} in ${r3.vw}x${r3.vh})`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[10] The protocol reader double-counted PP on reconnect, and a move counted');
  console.log('     as out of PP is dropped from the threat ranking — a lethal move went');
  console.log('     invisible');
  // ===================================================================
  {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/regress-protocol.html`);
    await page.waitForFunction(() => typeof window.__snap === 'function', { timeout: 20000 });

    async function feedAll() {
      for (const f of frames) await page.evaluate(fr => window.__push(fr), sockFrame(f));
      return page.evaluate(() => window.__snap());
    }
    const summarise = payload => {
      const room = (payload || [])[0] || {};
      const out = {};
      ['near', 'far'].forEach(k => {
        ((room[k] || {}).pokemon || []).forEach(p => {
          out[p.ident] = { uses: p.moveUses, moves: p.moves.slice(), since: p.movesSinceSwitch };
        });
      });
      return { mons: out, turn: room.turn, nearCount: ((room.near || {}).pokemon || []).length,
               farCount: ((room.far || {}).pokemon || []).length };
    };

    const once = summarise(await feedAll());
    // A reconnect: the server replays the whole log, starting with |init|battle|.
    const twice = summarise(await feedAll());

    ok(errs.length === 0, `replaying the log twice throws nothing${errs.length ? ' -> ' + errs[0] : ''}`);
    ok(once.farCount === twice.farCount && once.nearCount === twice.nearCount,
      `a reconnect does not duplicate the teams on screen ` +
      `(${once.nearCount}v${once.farCount} before, ${twice.nearCount}v${twice.farCount} after)`);
    ok(once.turn === twice.turn, `the turn counter is not doubled (${once.turn} then ${twice.turn})`);

    const doubled = Object.keys(once.mons).filter(id => {
      const a = once.mons[id].uses, b = (twice.mons[id] || {}).uses || {};
      return Object.keys(a).some(mv => a[mv] !== b[mv]);
    });
    ok(doubled.length === 0,
      `after a reconnect every move still shows the PP it has really spent, so nothing is ` +
      `wrongly written off as out of PP and dropped from the threat ranking` +
      `${doubled.length ? ' -> ' + doubled.map(id => id + ' ' + JSON.stringify(once.mons[id].uses) +
        ' became ' + JSON.stringify(twice.mons[id].uses)).join('; ') : ''}`);

    const lax = 'p2: Big Nap:Zzz';
    ok(once.mons[lax] && once.mons[lax].uses['Body Slam'] === 4,
      `single pass: Snorlax's Body Slam counts 4 uses (got ${once.mons[lax] && once.mons[lax].uses['Body Slam']})`);
    ok(twice.mons[lax] && twice.mons[lax].uses['Body Slam'] === 4,
      `after the replay it is still 4, not 8 — a 15 PP move is not falsely spent ` +
      `(got ${twice.mons[lax] && twice.mons[lax].uses['Body Slam']})`);

    const movesDiffer = Object.keys(once.mons).filter(id =>
      JSON.stringify(once.mons[id].moves) !== JSON.stringify(((twice.mons[id] || {}).moves) || null));
    ok(movesDiffer.length === 0,
      `and the revealed move lists are identical either way${movesDiffer.length ? ' -> ' + movesDiffer.join(', ') : ''}`);
    await page.close();
  }

  // ===================================================================
  console.log('\n[11] Spectating leaked "*"-prefixed Transform moves and Struggle into');
  console.log('     "your moves" on the Damage tab');
  // ===================================================================
  {
    const page = await open('spectate=1');
    await page.evaluate(() => window.__harness.showTab('Damage'));
    await page.evaluate(() => window.__harness.bumpTurn(1));
    await sleep(700);

    const view = await page.evaluate(() => ({
      damage: window.__harness.damage(),
      names: window.__harness.bodyMoveNames(),
      text: window.__harness.text(),
      log: window.__harness.bridgeLog()
    }));
    const outSec = (view.damage.sections || []).find(s => /You hit them/.test(s.title || ''));
    const outMoves = (outSec ? outSec.rows : []).map(r => r.move);

    ok(!!outSec && outMoves.length > 0,
      `a spectated battle still gets a "You hit them" table (${outMoves.join(', ') || 'empty'})`);
    ok(outMoves.indexOf('Struggle') === -1,
      `Struggle is never listed as one of the moves that side can choose ` +
      `(shown: ${outMoves.join(', ')})`);
    ok(view.names.every(n => n.charAt(0) !== '*'),
      `no move on screen is a Transform-tagged "*" copy (rows: ${view.names.join(', ')})`);
    ok(!/Hyper Beam/.test(view.text),
      'and the borrowed Transform move never appears anywhere in the panel');
    ok(outMoves.indexOf('Moonblast') !== -1 && outMoves.indexOf('Knock Off') !== -1,
      `the real moves it actually revealed are still there (${outMoves.join(', ')})`);

    // Belt and braces: the same thing one step earlier, on what the bridge
    // handed the panel, so a filter that moved rather than vanished is caught.
    const last = view.log.filter(e => e.type === 'battles' && e.myMoves).pop();
    ok(!!last && last.spectating === true,
      'the bridge marks the numbers as being about a team we are only watching');
    ok(!!last && last.myMoves.every(m => m.charAt(0) !== '*' && m !== 'Struggle'),
      `and hands the panel only real moves in the first place ` +
      `(bridge payload: ${last ? last.myMoves.join(', ') : 'none'})`);
    await page.close();
  }

  console.log('\n[12] An active stat boost is not a broken spread');
  {
    // Found in a real ladder game, not the harness: their Intimidate dropped
    // our Attack, the client reported the reduced number, and the panel warned
    // "Stat reconstruction differs on atk — damage numbers may be off" on turn
    // one of most doubles games. A warning that cries wolf gets ignored.
    const p = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await p.goto(`http://127.0.0.1:${PORT}/test/harness.html?intimidate=1`);
    await p.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
    await p.evaluate(() => window.__harness.showTab('Damage'));
    await p.waitForTimeout(400);

    const d = await p.evaluate(() => window.__harness.damage());
    ok(!d.warning || !/reconstruction/.test(d.warning),
      `an Intimidate drop raises no "your numbers may be wrong" warning (${d.warning || 'none'})`);
    ok(d.sections.some(s => s.rows.length),
      'and the damage table still renders');

    await p.close();
  }

  server.close();
  await browser.close();

  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
