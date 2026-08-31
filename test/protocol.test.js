/* Feeds a whole, realistic Gen 9 Random Battle protocol log through the REAL
 * src/inject.js protocol reader (reader 2) and asserts the state it builds,
 * turn by turn.
 *
 * The other suites all drive the client-object reader through a mock page.
 * This one leaves window.app / window.PS undefined so the protocol branch is
 * the only thing running, stubs window.WebSocket the way the real Showdown
 * client uses it, and pushes SockJS frames at it.
 *
 * Run: node test/protocol.test.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'battle-gen9randombattle-log.txt');
const PORT = 8736;
const ROOMID = 'battle-gen9randombattle-2312345678';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Fixture -> SockJS frames
// ---------------------------------------------------------------------------

/** Strip `#` comments, then cut the log into frames at each `>roomid` line. */
function readFrames(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .filter(l => l.charAt(0) !== '#');
  const frames = [];
  let cur = [];
  lines.forEach(l => {
    if (l.charAt(0) === '>') { if (cur.length) frames.push(cur.join('\n')); cur = [l]; return; }
    cur.push(l);
  });
  if (cur.length) frames.push(cur.join('\n'));
  return frames.filter(f => f.trim());
}

/** Showdown ships these as SockJS array frames. */
function sockFrame(chunk) { return 'a' + JSON.stringify([chunk]); }

// ---------------------------------------------------------------------------
// The harness page. Kept here rather than in a .html file so the whole
// protocol scenario lives in one place.
// ---------------------------------------------------------------------------

const HARNESS = `<!doctype html>
<meta charset="utf-8">
<title>randsight — protocol harness</title>
<body>
<script>
// A socket that behaves like the client's, so inject.js taps a real EventTarget.
// Deliberately no window.app / window.PS: the client-object reader must find
// nothing so the protocol reader is what we are measuring.
window.WebSocket = class FakeSocket extends EventTarget {
  constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.readyState = 1; window.__sock = this; }
  send() {}
  close() { this.readyState = 3; }
};
</script>
<script src="/src/inject.js"></script>
<script>
var TAG = '__randsight__';
window.__last = null;
window.__pending = null;
window.addEventListener('message', function (ev) {
  if (ev.source !== window || !ev.data || ev.data.__rs !== TAG) return;
  if (ev.data.type !== 'battles') return;
  window.__last = ev.data.payload;
  if (window.__pending) window.__pending(ev.data.payload);
});
// the client opens its socket after boot; inject.js has already proxied the ctor
new WebSocket('wss://sim3.psim.us/showdown/websocket');
window.__push = function (frame) {
  window.__sock.dispatchEvent(new MessageEvent('message', { data: frame }));
};
// Ask inject.js to re-post immediately instead of waiting out its 500ms timer.
// 'resync' is the same message src/content.js sends, so this is its own API.
window.__snap = function () {
  return new Promise(function (res) {
    var done = false;
    window.__pending = function (p) { if (done) return; done = true; window.__pending = null; res(p); };
    setTimeout(function () { if (done) return; done = true; window.__pending = null; res(window.__last); }, 400);
    window.postMessage({ __rs: TAG, type: 'resync' }, location.origin);
  });
};
</script>
</body>`;

// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/protocol-harness.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HARNESS);
    return;
  }
  const p = path.join(ROOT, decodeURIComponent(url));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  const frames = readFrames(FIXTURE);
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ ...require('./chromium') });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/protocol-harness.html`);
  await page.waitForFunction(() => typeof window.__snap === 'function', { timeout: 15000 });

  // Push one frame at a time and photograph the parser after each.
  const shots = [];
  for (const f of frames) {
    await page.evaluate(fr => window.__push(fr), sockFrame(f));
    shots.push(await page.evaluate(() => window.__snap()));
  }

  // Index by turn: every frame in the fixture ends on its `|turn|N` line, so
  // `at(n)` is the state the panel would show at the start of turn n.
  const byTurn = {};
  shots.forEach(s => {
    if (!s || !s.length) return;
    byTurn[s[0].turn] = s;
  });
  const final = shots[shots.length - 1];

  const at = n => byTurn[n];
  const room = s => (s && s[0]) || {};
  const near = s => room(s).near || { pokemon: [] };
  const far = s => room(s).far || { pokemon: [] };
  const find = (sideObj, ident) => (sideObj.pokemon || []).find(p => p.ident === ident) || null;
  const foe = (n, ident) => find(far(at(n)), ident);
  const us = (n, ident) => find(near(at(n)), ident);
  const has = (m, mv) => !!m && m.moves.indexOf(mv) !== -1;

  console.log(`\nfed ${frames.length} frames, captured ${shots.length} snapshots, ` +
    `turns seen: ${Object.keys(byTurn).filter(k => k !== '-1').join(',')}`);

  // The `|win|` frame carries no `|turn|` line, so it re-photographs turn 28 and
  // overwrites byTurn[28]. This is the snapshot taken one frame earlier — the
  // state at the START of turn 28, before its moves resolve.
  const beforeWin = shots[shots.length - 2];
  const total = uses => Object.keys(uses).reduce((a, k) => a + uses[k], 0);

  console.log('\n[1] Wiring');
  {
    // the bare harness has no favicon; that 404 is not a script error
    const errs = pageErrors.filter(e => !/Failed to load resource/.test(e));
    ok(errs.length === 0, `no script errors${errs.length ? ' -> ' + errs[0] : ''}`);
    ok(!!final && final.length === 1, `exactly one battle room reported (got ${final ? final.length : 0})`);
    ok(room(final).source === 'protocol', 'payload came from the protocol reader, not the client poll');
    ok(room(final).roomid === ROOMID, `roomid is ${ROOMID}`);
    ok(near(final).id === 'p1' && near(final).name === 'AlphaTester',
      `|updateuser| + |player| put us on p1 (got ${near(final).id}/${near(final).name})`);
    ok(far(final).id === 'p2' && far(final).name === 'RandomLadderer',
      `the opponent is p2 RandomLadderer (got ${far(final).id}/${far(final).name})`);
    ok(!!at(1) && !!at(14) && !!at(28), 'turns 1, 14 and 28 all produced a snapshot');
    ok(room(final).turn === 28, `final turn is 28 (got ${room(final).turn})`);
    ok(room(final).ended === true, '|win| marked the battle ended');
  }

  console.log('\n[2] Identity: nicknames that are not the species');
  {
    const e = foe(9, 'p2: Éclair♪');
    ok(!!e, 'the foe nicknamed "Éclair♪" is tracked');
    ok(!!e && e.species === 'Furret', `"Éclair♪" resolves to species Furret (got ${e && e.species})`);
    ok(!!e && e.name === 'Éclair♪', 'the nickname is kept as the display name');
    ok(!!e && e.level === 94 && e.gender === 'F', `details parsed: L94 F (got L${e && e.level} ${e && e.gender})`);

    // "Big Nap:Zzz" contains a colon, which is also parseIdent's own delimiter.
    const s = foe(12, 'p2: Big Nap:Zzz');
    ok(!!s, 'a nickname containing a colon survives parseIdent ("p2a: Big Nap:Zzz")');
    ok(!!s && s.species === 'Snorlax' && s.level === 82,
      `"Big Nap:Zzz" resolves to Snorlax L82 (got ${s && s.species} L${s && s.level})`);

    // Randbats itself does this: the ident carries the base name, the details
    // carry the forme.  |switch|p1a: Rotom|Rotom-Wash, L82|
    const r = us(12, 'p1: Rotom');
    ok(!!r && r.species === 'Rotom-Wash',
      `an ident of "Rotom" with details "Rotom-Wash" reads as Rotom-Wash (got ${r && r.species})`);
  }

  console.log('\n[3] Roster accounting');
  {
    const f = far(final), n = near(final);
    ok(f.pokemon.length <= 6,
      `the foe side never lists more than 6 Pokemon (got ${f.pokemon.length}: ` +
      `${f.pokemon.map(p => p.ident).join(' / ')})`);
    ok(n.pokemon.length <= 6,
      `our side never lists more than 6 Pokemon (got ${n.pokemon.length}: ` +
      `${n.pokemon.map(p => p.ident).join(' / ')})`);
    ok(f.revealed <= f.totalPokemon,
      `revealed (${f.revealed}) never exceeds totalPokemon (${f.totalPokemon})`);
    const species = far(final).pokemon.map(p => p.species);
    ok(new Set(species).size === species.length,
      `no species appears twice on the foe side (${species.join(', ')})`);
  }

  console.log('\n[4] Items: Frisk, Trick, Knock Off, an eaten berry, a consumed Booster Energy');
  {
    ok(us(1, 'p1: Skarmory').item === 'Rocky Helmet',
      'Frisk revealed Skarmory\'s Rocky Helmet before turn 1');
    const t2 = us(2, 'p1: Skarmory');
    ok(t2.item === 'Life Orb' && t2.itemLost === false,
      `Trick swapped a Life Orb onto Skarmory (got ${t2.item}, lost=${t2.itemLost})`);
    ok(foe(2, 'p2: Éclair♪').item === 'Rocky Helmet',
      'the other half of the Trick put Rocky Helmet on Éclair♪');
    const t3 = us(3, 'p1: Skarmory');
    ok(t3.item === 'Life Orb' && t3.itemLost === true,
      `Knock Off removed the Life Orb but the identity is remembered (got ${t3.item}, lost=${t3.itemLost})`);
    const ori = foe(8, 'p2: Oricorio');
    ok(ori.item === 'Heavy-Duty Boots' && ori.itemLost === true,
      `Knock Off took Oricorio's Heavy-Duty Boots (got ${ori.item}, lost=${ori.itemLost})`);
    const lax = foe(12, 'p2: Big Nap:Zzz');
    ok(lax.item === 'Chesto Berry' && lax.itemLost === true,
      `the eaten Chesto Berry is recorded as a lost item (got ${lax.item}, lost=${lax.itemLost})`);
    const gt = us(21, 'p1: Great Tusk');
    ok(gt.item === 'Booster Energy' && gt.itemLost === true,
      `a self-consumed Booster Energy is recorded (got ${gt.item}, lost=${gt.itemLost})`);
  }

  console.log('\n[5] Abilities');
  {
    ok(foe(4, 'p2: Gyarados').ability === 'Intimidate',
      'Intimidate on switch-in reveals Gyarados\'s ability');
    ok(foe(19, 'p2: Gyarados').ability === 'Intimidate',
      'a second Intimidate reveal on the same Pokemon leaves the ability alone');
    ok(us(24, 'p1: Corviknight').ability === 'Pressure',
      'Pressure on switch-in reveals Corviknight\'s ability');
    ok(!foe(4, 'p2: Éclair♪').ability,
      'Frisk fires without an |-ability| line, so Éclair♪\'s ability stays unknown (correct)');
  }

  console.log('\n[6] HP, status and fainting');
  {
    const w = us(10, 'p1: Weavile');
    ok(w.hp === 38 && w.maxhp === 240, `our HP is exact (got ${w.hp}/${w.maxhp})`);
    ok(w.status === 'par', `Body Slam's paralysis recorded (got "${w.status}")`);
    const e = foe(4, 'p2: Éclair♪');
    ok(e.hp === 54 && e.maxhp === 100, `foe HP arrives as a percentage (got ${e.hp}/${e.maxhp})`);
    ok(foe(12, 'p2: Big Nap:Zzz').status === '',
      'the Chesto Berry\'s |-curestatus| cleared the sleep');
    ok(foe(14, 'p2: Big Nap:Zzz').status === 'slp',
      'the second Rest, with no berry left, leaves Snorlax asleep');
    const ori = foe(9, 'p2: Oricorio');
    ok(ori.fainted === true && ori.hp === 0, `|faint| recorded (fainted=${ori.fainted}, hp=${ori.hp})`);
  }

  console.log('\n[7] Whirlwind: |drag| swaps the active Pokemon');
  {
    const f = far(at(5));
    const active = f.pokemon.filter(p => p.active).map(p => p.ident);
    ok(active.length === 1 && active[0] === 'p2: Oricorio',
      `exactly one foe is active and it is the dragged-in Oricorio (got ${active.join(',') || 'none'})`);
    ok(has(foe(5, 'p2: Gyarados'), 'Dragon Dance'),
      'the blown-out Gyarados keeps the Dragon Dance it just used');
  }

  console.log('\n[8] A move called by another effect is not the caller\'s move');
  {
    const ori = foe(7, 'p2: Oricorio');
    ok(!has(ori, 'Swords Dance'),
      `Dancer's copy of our Swords Dance is not credited to Oricorio (moves: ${ori.moves.join(', ') || 'none'})`);
    ok(has(ori, 'Hurricane'), 'a move that MISSED still counts as revealed (Hurricane)');
    ok(has(ori, 'Roost'), 'Roost recorded');
    ok(has(us(7, 'p1: Weavile'), 'Swords Dance'), 'the real Swords Dance user keeps it');
  }

  console.log('\n[9] Sleep Talk: the called move IS one of the sleeper\'s four');
  {
    const lax15 = foe(15, 'p2: Big Nap:Zzz');
    ok(has(lax15, 'Sleep Talk'), 'Sleep Talk itself is recorded');
    ok(has(lax15, 'Body Slam'), 'Body Slam, used directly on turn 9, is recorded');
    ok(has(lax15, 'Rest'), 'Rest is recorded');
    // Curse is only ever seen through Sleep Talk in this log. Sleep Talk can
    // only select a move the user actually knows, so this is a genuine reveal
    // and inject.js's own comment says it means to keep it.
    ok(has(lax15, 'Curse'),
      `Curse, revealed only via "|[from] move: Sleep Talk", is recorded ` +
      `(moves: ${lax15.moves.join(', ') || 'none'})`);
    const lax17 = foe(17, 'p2: Big Nap:Zzz');
    ok(lax17.moves.length === 4,
      `Snorlax's full set is known by turn 17 (got ${lax17.moves.length}: ${lax17.moves.join(', ')})`);
  }

  console.log('\n[10] lockedmove: an Outrage continuation is the user\'s own move');
  {
    const d18 = us(18, 'p1: Dragonite');
    ok(has(d18, 'Outrage'), 'Outrage recorded');
    ok(d18.moves.filter(m => m === 'Outrage').length === 1,
      `the "|[from] lockedmove" repeat did not duplicate the entry (moves: ${d18.moves.join(', ')})`);
    ok(us(19, 'p1: Dragonite').moves.length === 1,
      'three turns of locked Outrage still read as exactly one known move');
  }

  console.log('\n[11] Terastallization');
  {
    ok(us(17, 'p1: Dragonite').terastallized === 'Normal',
      `our Tera type recorded (got "${us(17, 'p1: Dragonite').terastallized}")`);
    ok(foe(20, 'p2: Gyarados').terastallized === 'Water',
      `the foe's Tera type recorded (got "${foe(20, 'p2: Gyarados').terastallized}")`);
    ok(us(28, 'p1: Dragonite').terastallized === 'Normal',
      'the Tera type persists after the Pokemon switches out');
  }

  console.log('\n[12] Forme change: Zero to Hero');
  {
    ok(foe(18, 'p2: Palafin').species === 'Palafin',
      `before it switches out it is plain Palafin (got ${foe(18, 'p2: Palafin').species})`);
    const p19 = foe(19, 'p2: Palafin');
    ok(p19.species === 'Palafin-Hero',
      `|detailschange| moved the species to Palafin-Hero (got ${p19.species})`);
    ok(has(p19, 'Flip Turn'), 'the moves it revealed as Palafin survive the forme change');
    ok(p19.active === false, 'and it is correctly no longer the active Pokemon');
  }

  console.log('\n[13] Switching out does not reset what a Pokemon revealed');
  {
    // Gyarados: in on turn 3, Dragon Dance on turn 4, whirlwinded out on turn 4,
    // back in on turn 18, Waterfall on 19, Earthquake on 20.
    const g21 = foe(21, 'p2: Gyarados');
    ok(JSON.stringify(g21.moves) === JSON.stringify(['Dragon Dance', 'Waterfall', 'Earthquake']),
      `Gyarados carries all three moves across 14 turns on the bench (got ${g21.moves.join(', ')})`);
    ok(g21.terastallized === 'Water' && g21.ability === 'Intimidate',
      'and its Tera type and ability with them');
    const e12 = foe(12, 'p2: Éclair♪');
    ok(JSON.stringify(e12.moves) === JSON.stringify(['Trick', 'Knock Off', 'U-turn']),
      `Éclair♪ keeps its three moves after U-turning out on turn 3 (got ${e12.moves.join(', ')})`);
    const e28 = foe(28, 'p2: Éclair♪');
    ok(JSON.stringify(e28.moves) === JSON.stringify(['Trick', 'Knock Off', 'U-turn']),
      'and still has them when it comes back in on turn 28');
    ok(e28.item === 'Rocky Helmet', 'and still has the item it tricked for');
  }

  console.log('\n[14] Illusion: |replace| must move the record to the real Pokemon');
  {
    const s23 = far(at(23));
    const zoro = find(s23, 'p2: Zoroark');
    ok(!!zoro && zoro.species === 'Zoroark-Hisui',
      `|replace| produced a Zoroark-Hisui entry (got ${zoro && zoro.species})`);
    ok(!!zoro && zoro.active === true, 'and it is the active foe');
    ok(has(zoro, 'Bitter Malice'),
      `the Bitter Malice it used while disguised belongs to Zoroark ` +
      `(moves: ${zoro ? (zoro.moves.join(', ') || 'none') : 'n/a'})`);
    const pal = find(s23, 'p2: Palafin');
    ok(!!pal && !has(pal, 'Bitter Malice'),
      `Palafin is not credited with Bitter Malice, which it cannot learn ` +
      `(moves: ${pal ? (pal.moves.join(', ') || 'none') : 'n/a'})`);
    ok(!!pal && pal.level === 77,
      `Palafin's level is not overwritten by the disguise's L80 (got L${pal && pal.level})`);
  }

  console.log('\n[15] Struggle is not a move');
  {
    const c = us(28, 'p1: Corviknight');
    ok(!has(c, 'Struggle'), `Struggle is filtered out (moves: ${c.moves.join(', ') || 'none'})`);
    ok(has(c, 'Brave Bird'), 'the real move it used is still there');
    ok(c.hp === 0 && c.fainted === true, 'and it is recorded as fainted');
  }

  console.log('\n[16] End state');
  {
    const idents = ['p2: Éclair♪', 'p2: Big Nap:Zzz', 'p2: Gyarados',
      'p2: Palafin', 'p2: Oricorio', 'p2: Zoroark'];
    const alive = idents.filter(i => { const m = find(far(final), i); return !m || !m.fainted; });
    ok(alive.length === 0, `all six of the opponent's Pokemon are fainted${alive.length ? ' — still standing: ' + alive.join(', ') : ''}`);
    const ourDead = near(final).pokemon.filter(p => p.fainted).map(p => p.ident);
    ok(ourDead.length === 2 && ourDead.indexOf('p1: Great Tusk') !== -1 && ourDead.indexOf('p1: Corviknight') !== -1,
      `we lost exactly Great Tusk and Corviknight (got ${ourDead.join(', ') || 'none'})`);
    const seenMoves = near(final).pokemon.reduce((a, p) => a + p.moves.length, 0);
    ok(seenMoves >= 12, `${seenMoves} of our own moves were read off the wire`);
  }

  console.log('\n[17] Tera is once per side per battle');
  {
    // Dragonite Terastallizes on turn 16, Gyarados on turn 19. Each `|-terastallize|`
    // must flip its OWN side's flag and leave the other side's alone — the whole
    // point of the field is that the five Pokemon behind the one that used it no
    // longer have a Tera type in play.
    ok(near(at(16)).teraUsed === false && near(at(16)).teraUsedBy === '',
      `before turn 16 our side has not Terastallized (got ${near(at(16)).teraUsed}/"${near(at(16)).teraUsedBy}")`);
    ok(near(at(17)).teraUsed === true && near(at(17)).teraUsedBy === 'Dragonite',
      `Dragonite's Tera spends our side's one use (got ${near(at(17)).teraUsed}/"${near(at(17)).teraUsedBy}")`);
    ok(far(at(17)).teraUsed === false && far(at(17)).teraUsedBy === '',
      `and it does NOT touch the opponent's side (got ${far(at(17)).teraUsed}/"${far(at(17)).teraUsedBy}")`);
    ok(far(at(19)).teraUsed === false,
      'the opponent is still holding its Tera at the start of turn 19');
    ok(far(at(20)).teraUsed === true && far(at(20)).teraUsedBy === 'Gyarados',
      `Gyarados's Tera spends theirs (got ${far(at(20)).teraUsed}/"${far(at(20)).teraUsedBy}")`);
    ok(near(final).teraUsedBy === 'Dragonite' && far(final).teraUsedBy === 'Gyarados',
      `both stay spent to the end of the battle, after Dragonite switched out and ` +
      `Gyarados fainted (got "${near(final).teraUsedBy}" / "${far(final).teraUsedBy}")`);
  }

  console.log('\n[18] Choice lock: lastMove and movesSinceSwitch');
  {
    // Rotom: Will-O-Wisp on 11, Hydro Pump on 12/13/14, then out on turn 15.
    ok(us(15, 'p1: Rotom').movesSinceSwitch === 4,
      `four moves counted across one stint (got ${us(15, 'p1: Rotom').movesSinceSwitch})`);
    const r16 = us(16, 'p1: Rotom');
    ok(r16.movesSinceSwitch === 0,
      `|switch| winds the counter back to 0 (got ${r16.movesSinceSwitch})`);
    ok(r16.moveUses['Hydro Pump'] === 3 && r16.lastMove === 'Hydro Pump',
      `but the PP counts and lastMove survive the switch ` +
      `(got ${JSON.stringify(r16.moveUses)}, last="${r16.lastMove}")`);

    // Whirlwind on turn 4 blows Gyarados out the turn it used Dragon Dance.
    const g5 = foe(5, 'p2: Gyarados');
    ok(g5.movesSinceSwitch === 0 && g5.moveUses['Dragon Dance'] === 1,
      `|drag| resets the counter too (got ${g5.movesSinceSwitch}, uses ${JSON.stringify(g5.moveUses)})`);
    const g21 = foe(21, 'p2: Gyarados');
    ok(g21.lastMove === 'Earthquake' && g21.movesSinceSwitch === 2,
      `back in on 18, Waterfall on 19, Earthquake on 20 (got last="${g21.lastMove}", ` +
      `since=${g21.movesSinceSwitch})`);

    // Snorlax is asleep for turns 14-16: each of those turns is `|cant|slp`
    // followed by Sleep Talk and the move Sleep Talk picked. The `|cant|` is the
    // sleep itself and must count for nothing.
    ok(foe(14, 'p2: Big Nap:Zzz').movesSinceSwitch === 5,
      `five moves through turn 13 (got ${foe(14, 'p2: Big Nap:Zzz').movesSinceSwitch})`);
    ok(foe(15, 'p2: Big Nap:Zzz').movesSinceSwitch === 7,
      `turn 14's |cant|slp adds nothing: only Sleep Talk and the Curse it called ` +
      `move it 5 -> 7 (got ${foe(15, 'p2: Big Nap:Zzz').movesSinceSwitch})`);
    const lax17 = foe(17, 'p2: Big Nap:Zzz');
    ok(lax17.movesSinceSwitch === 11 && total(lax17.moveUses) === 11,
      `after three |cant| turns the counter still equals the PP actually spent ` +
      `(since=${lax17.movesSinceSwitch}, uses total ${total(lax17.moveUses)})`);

    // Turn 19: Dragonite is confused and hits itself. No |move| line at all, so
    // nothing about a lock changed.
    ok(us(19, 'p1: Dragonite').movesSinceSwitch === 3 &&
      us(20, 'p1: Dragonite').movesSinceSwitch === 3,
      `a turn spent hitting itself in confusion does not count as a move ` +
      `(got ${us(19, 'p1: Dragonite').movesSinceSwitch} -> ${us(20, 'p1: Dragonite').movesSinceSwitch})`);

    // Éclair♪ Knocks the Choice Specs off Rotom on turn 28 BEFORE Rotom moves.
    // Rotom was on 1 move since switching in; the item leaving zeroes that, and
    // only the Hydro Pump that follows counts. Without the reset it would read 2,
    // and the panel would claim a lock that no longer exists.
    ok(find(near(beforeWin), 'p1: Rotom').movesSinceSwitch === 1,
      `Rotom is on one move since switching in when turn 28 starts ` +
      `(got ${find(near(beforeWin), 'p1: Rotom').movesSinceSwitch})`);
    const rf = us(28, 'p1: Rotom');
    ok(rf.item === 'Choice Specs' && rf.itemLost === true,
      `Knock Off is recorded as removing the Choice Specs (got ${rf.item}, lost=${rf.itemLost})`);
    ok(rf.moveUses['Hydro Pump'] === 5,
      `Rotom did use a fifth Hydro Pump on turn 28 (got ${rf.moveUses['Hydro Pump']})`);
    ok(rf.movesSinceSwitch === 1,
      `losing the Choice item mid-turn reset the counter, so it reads 1 and not 2 ` +
      `(got ${rf.movesSinceSwitch})`);
    // The Chesto Berry Snorlax ate on turn 11 is also an |-enditem|, and it must
    // NOT reset anything — only a Choice item does.
    ok(foe(12, 'p2: Big Nap:Zzz').movesSinceSwitch === 3,
      `an eaten Chesto Berry leaves the counter alone ` +
      `(got ${foe(12, 'p2: Big Nap:Zzz').movesSinceSwitch})`);

    // Struggle is not one of the four, but it is what the Pokemon last did and it
    // did consume the turn.
    const c26 = us(26, 'p1: Corviknight');
    ok(c26.lastMove === 'Struggle' && c26.movesSinceSwitch === 2,
      `Struggle is the last move used and counts as a use (got last="${c26.lastMove}", ` +
      `since=${c26.movesSinceSwitch})`);
    ok(c26.moveUses['Struggle'] === undefined && c26.moveUses['Brave Bird'] === 1,
      `but it never gets PP of its own (uses ${JSON.stringify(c26.moveUses)})`);

    // |replace|: the Illusion's counters belong to the Pokemon that was really there.
    const zo = foe(23, 'p2: Zoroark');
    ok(zo.movesSinceSwitch === 0 && zo.moveUses['Bitter Malice'] === 1,
      `the Bitter Malice used while disguised is Zoroark's PP, and |replace| ` +
      `restarts its counter (since=${zo.movesSinceSwitch}, uses ${JSON.stringify(zo.moveUses)})`);
    const pl = foe(23, 'p2: Palafin');
    ok(total(pl.moveUses) === 0 && pl.lastMove === '',
      `and Palafin, which was never on the field, is left with no uses at all ` +
      `(uses ${JSON.stringify(pl.moveUses)}, last="${pl.lastMove}")`);
  }

  console.log('\n[19] PP: moveUses counts what actually went off');
  {
    ok(foe(6, 'p2: Oricorio').moveUses['Hurricane'] === 1,
      `a Hurricane that MISSED still burned its PP ` +
      `(got ${foe(6, 'p2: Oricorio').moveUses['Hurricane']})`);
    ok(foe(7, 'p2: Oricorio').moveUses['Swords Dance'] === undefined,
      `Dancer's copy of our Swords Dance costs Oricorio nothing ` +
      `(uses ${JSON.stringify(foe(7, 'p2: Oricorio').moveUses)})`);
    ok(us(7, 'p1: Weavile').moveUses['Swords Dance'] === 1,
      'the real user pays for it');

    // Sleep Talk spends its own PP; the move it calls is one of the sleeper's own
    // four and is what the panel needs counted.
    ok(foe(15, 'p2: Big Nap:Zzz').moveUses['Curse'] === 1,
      `the Curse called by Sleep Talk is counted for Snorlax ` +
      `(got ${foe(15, 'p2: Big Nap:Zzz').moveUses['Curse']})`);
    const lax17 = foe(17, 'p2: Big Nap:Zzz');
    ok(lax17.moveUses['Sleep Talk'] === 3 && lax17.moveUses['Curse'] === 2 &&
      lax17.moveUses['Body Slam'] === 4 && lax17.moveUses['Rest'] === 2,
      `every one of Snorlax's four has an honest count (got ${JSON.stringify(lax17.moveUses)})`);

    const d19 = us(19, 'p1: Dragonite');
    ok(d19.moveUses['Outrage'] === 3 && d19.moves.length === 1,
      `three locked Outrage turns are three uses of one known move ` +
      `(uses ${JSON.stringify(d19.moveUses)}, moves ${d19.moves.join(', ')})`);

    ok(foe(28, 'p2: Éclair♪').moveUses['Knock Off'] === 2,
      `counts accumulate across stints: Knock Off on turn 2 and again on turn 28 ` +
      `(got ${foe(28, 'p2: Éclair♪').moveUses['Knock Off']})`);

    // A count for a move that was never revealed would be a bug in either
    // direction, so hold the two together for every Pokemon in the payload.
    const stray = [].concat(near(final).pokemon, far(final).pokemon)
      .map(p => Object.keys(p.moveUses).filter(mv => p.moves.indexOf(mv) === -1)
        .map(mv => p.ident + '/' + mv))
      .reduce((a, b) => a.concat(b), []);
    ok(stray.length === 0,
      `every moveUses key is also a revealed move${stray.length ? ' -> ' + stray.join(', ') : ''}`);
    const counted = [].concat(near(final).pokemon, far(final).pokemon)
      .reduce((a, p) => a + total(p.moveUses), 0);
    ok(counted >= 40, `${counted} move uses counted across both teams`);
  }

  await browser.close();
  server.close();
  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
