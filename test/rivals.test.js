/*
 * Benchmark against the approaches the other extensions actually use.
 *
 * These are faithful reimplementations of their *algorithms*, taken from their
 * published source — not the extensions themselves, which have their own UI,
 * data sources and edge cases. The point is to measure the modelling choice,
 * not to score someone else's product.
 *
 *   FILTER+MARGINALS — what both maintained extensions do.
 *     Randbats Tooltip (pkmn), extension/index.js, filter():
 *         drop a role if the revealed Tera type isn't in role.teraTypes,
 *         drop a role if any revealed move isn't in role.moves,
 *         then print each surviving role's published percentages unchanged.
 *     Showdex, src/utils/presets/guessMatchingPresets.ts: the same boolean
 *         filter on moves and Tera — and in Random Battles it *deliberately*
 *         skips the item and ability gates ("a sampled, NON-discriminative
 *         drop"), then shows marginal usage.
 *     So for Random Battles the two converge on one model, implemented once here.
 *
 *   MARGINALS-ONLY — a static set list. No conditioning at all. The floor.
 *
 *   OURS — joint table shrunk toward the conditional-Bernoulli model.
 *
 * Every model is scored on the same held-out sets over the same candidate
 * support, so none is excused for omitting an option.
 *
 * Run: node test/rivals.test.js [teams]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
require('../src/joint.js');
const E = globalThis.RSEngine;
const J = globalThis.RSJoint;

const FORMAT = 'gen9randombattle';
const TABLE = path.resolve(__dirname, '..', 'src', 'data', `joint-${FORMAT}.json`);
const DATA = process.env.RBL_DATA || '/tmp/rb';
const STATS = path.join(DATA, 'g9stats.json');
const TEAMS = parseInt(process.argv[2], 10) || 2500;

let Teams;
try { Teams = require('pokemon-showdown').Teams; }
catch (e) { console.log('SKIP  pokemon-showdown not installed'); process.exit(0); }
if (!fs.existsSync(TABLE) || !fs.existsSync(STATS)) {
  console.log('SKIP  need the joint table and the stats fixture'); process.exit(0);
}

let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures++; };
const id = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

const table = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
J.register(FORMAT, table);
const stats = JSON.parse(fs.readFileSync(STATS, 'utf8'));
const statsById = {};
Object.keys(stats).forEach(k => { statsById[id(k)] = stats[k]; });
const statsFor = sp => statsById[id(sp)] || statsById[id(String(sp).split('-')[0])] || null;

// ---------------------------------------------------------------------------
// The rival model: filter roles by revealed moves and Tera, then report each
// surviving role's PUBLISHED percentages, unchanged.
// ---------------------------------------------------------------------------
function filterMarginals(species, obs) {
  const e = statsFor(species);
  if (!e) return null;
  const roles = e.roles ? Object.entries(e.roles) : [['Standard', e]];

  const survivors = roles.filter(([, r]) => {
    if (obs.teraType && r.teraTypes && Object.keys(r.teraTypes).length &&
        !r.teraTypes[obs.teraType]) return false;
    for (const mv of (obs.moves || [])) if (!(r.moves || {})[mv]) return false;
    return true;
  });
  const live = survivors.length ? survivors : roles;   // both tools fall back to showing everything

  // Weight the survivors by their published role weight, renormalised. This is
  // the most charitable numeric reading of a UI that simply lists them.
  let wsum = 0;
  live.forEach(([, r]) => { wsum += (typeof r.weight === 'number' ? r.weight : 1 / live.length); });

  function mix(field) {
    const acc = {};
    live.forEach(([, r]) => {
      const w = (typeof r.weight === 'number' ? r.weight : 1 / live.length) / (wsum || 1);
      const d = r[field] || {};
      // NOTE: no renormalisation and no slot competition — the published
      // number is printed as-is. That is precisely the limitation being tested.
      Object.keys(d).forEach(k => { acc[k] = (acc[k] || 0) + w * d[k]; });
    });
    return Object.keys(acc).map(k => ({ name: k, prob: Math.min(acc[k], 1) }));
  }

  return { moves: mix('moves'), items: mix('items'), teraTypes: mix('teraTypes') };
}

function marginalsOnly(species) {
  return filterMarginals(species, { moves: [] });
}

const modelCache = {};
function ours(species, obs) {
  const e = statsFor(species);
  if (!e) return null;
  const k = id(species);
  if (!modelCache[k]) modelCache[k] = E.buildSpecies(e);
  const prior = E.predict(modelCache[k], obs);
  const joint = J.predict(FORMAT, species, obs, e);
  return joint ? J.blend(joint, prior) : prior;
}

// ---------------------------------------------------------------------------
console.log(`\nGenerating ${TEAMS} held-out teams…`);
const nameById = {};
Object.values(table.species).forEach(e => {
  ['m', 'i', 'a', 't'].forEach(f => (e[f] || []).forEach(n => { nameById[id(n)] = n; }));
});
const toName = x => (x == null ? null : (nameById[id(x)] || null));

const mons = [];
for (let i = 0; i < TEAMS; i++) {
  for (const s of Teams.generate(FORMAT)) {
    const moves = (s.moves || []).map(toName);
    const item = toName(s.item);
    if (moves.length !== 4 || moves.some(m => !m) || !statsFor(s.species || s.name)) continue;
    mons.push({ species: s.species || s.name, moves, item, tera: s.teraType || null });
  }
}
console.log(`  ${mons.length} Pokemon\n`);

// Every move the published stats list for a species, across all its roles.
const pubCache = {};
function publishedMoves(species) {
  const k = id(species);
  if (pubCache[k]) return pubCache[k];
  const e = statsFor(species);
  const set = new Set();
  if (e) {
    (e.roles ? Object.values(e.roles) : [e]).forEach(r => {
      Object.keys(r.moves || {}).forEach(mv => set.add(mv));
    });
  }
  pubCache[k] = set;
  return set;
}

const candidates = {};
Object.entries(table.species).forEach(([name, e]) => {
  candidates[id(name)] = { moves: e.m.slice(), items: e.i.slice() };
});
const candFor = (sp, f) =>
  ((candidates[id(sp)] || candidates[id(String(sp).split('-')[0])] || {})[f]) || [];

/** Score a model over a shared candidate support. */
function score(predict, field, truthOf, mkObs) {
  let logLoss = 0, n = 0, brier = 0, top1 = 0, top1n = 0;
  for (const m of mons) {
    const obs = mkObs(m);
    const pred = predict(m.species, obs);
    if (!pred) continue;
    const probs = {};
    (pred[field] || []).forEach(r => { probs[r.name] = r.prob; });

    const truth = truthOf(m, obs);
    const shown = new Set(obs.moves || []);
    const cands = candFor(m.species, field).filter(c => field !== 'moves' || !shown.has(c));

    for (const name of cands) {
      const actual = (field === 'moves')
        ? (m.moves.includes(name) ? 1 : 0)
        : (name === truth ? 1 : 0);
      const p = Math.min(Math.max(probs[name] || 0, 1e-6), 1 - 1e-6);
      logLoss += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
      brier += Math.pow((probs[name] || 0) - actual, 2);
      n++;
    }

    // Top-1: the single most likely remaining option. Directly interpretable.
    if (cands.length) {
      let best = null, bp = -1;
      cands.forEach(c => { const p = probs[c] || 0; if (p > bp) { bp = p; best = c; } });
      const hit = (field === 'moves') ? m.moves.includes(best) : (best === truth);
      if (hit) top1++;
      top1n++;
    }
  }
  return { logLoss: logLoss / n, brier: brier / n, top1: top1 / top1n, n, top1n };
}

function tableOf(rows) {
  const w = Math.max.apply(null, rows.map(r => r[0].length));
  rows.forEach(r => {
    console.log('    ' + r[0].padEnd(w + 2) + r.slice(1).join('   '));
  });
}

const MODELS = [
  ['marginals only (static set list)', (sp, o) => marginalsOnly(sp)],
  ['filter + marginals (Showdex / Tooltip)', filterMarginals],
  ['ours (joint + shrinkage)', ours]
];

// ---------------------------------------------------------------------------
console.log('[1] Predicting the remaining moves after N reveals');
const moveResults = {};
for (const k of [1, 2, 3]) {
  console.log(`\n  ${k} move${k > 1 ? 's' : ''} revealed`);
  tableOf([['model', 'log loss', 'Brier', 'top-1']].concat(
    MODELS.map(([label, fn]) => {
      const r = score(fn, 'moves', () => null, m => ({ moves: m.moves.slice(0, k) }));
      moveResults[label + '|' + k] = r;
      return [label, r.logLoss.toFixed(4), r.brier.toFixed(4), (r.top1 * 100).toFixed(1) + '%'];
    })
  ));
}
{
  const rival = moveResults['filter + marginals (Showdex / Tooltip)|3'];
  const mine = moveResults['ours (joint + shrinkage)|3'];
  ok(mine.logLoss < rival.logLoss,
    `with 3 revealed, we beat filter+marginals on log loss (${mine.logLoss.toFixed(4)} vs ${rival.logLoss.toFixed(4)})`);
  ok(mine.top1 > rival.top1,
    `and on guessing the last move outright (${(mine.top1 * 100).toFixed(1)}% vs ${(rival.top1 * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] Predicting the ITEM from revealed moves');
console.log('    Both rivals ignore the coupling between moves and item.\n');
{
  const rows = MODELS.map(([label, fn]) => {
    const r = score(fn, 'items', m => m.item, m => ({ moves: m.moves.slice(0, 2) }));
    return [label, r.logLoss.toFixed(4), r.brier.toFixed(4), (r.top1 * 100).toFixed(1) + '%', r];
  });
  tableOf([['model', 'log loss', 'Brier', 'top-1']].concat(rows.map(r => r.slice(0, 4))));
  const rival = rows[1][4], mine = rows[2][4];
  ok(mine.logLoss < rival.logLoss,
    `item log loss ${mine.logLoss.toFixed(4)} vs ${rival.logLoss.toFixed(4)} (${((1 - mine.logLoss / rival.logLoss) * 100).toFixed(0)}% better)`);
  ok(mine.top1 > rival.top1 + 0.02,
    `naming their item: ${(mine.top1 * 100).toFixed(1)}% vs ${(rival.top1 * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] Predicting MOVES when the item is revealed');
console.log('    Showdex explicitly discards this evidence in Random Battles.\n');
{
  const rows = MODELS.map(([label, fn]) => {
    const r = score(fn, 'moves', () => null, m => ({ moves: [], item: m.item }));
    return [label, r.logLoss.toFixed(4), r.brier.toFixed(4), (r.top1 * 100).toFixed(1) + '%', r];
  });
  tableOf([['model', 'log loss', 'Brier', 'top-1']].concat(rows.map(r => r.slice(0, 4))));
  const rival = rows[1][4], mine = rows[2][4];
  ok(mine.logLoss < rival.logLoss,
    `a revealed item alone improves our move prediction (${mine.logLoss.toFixed(4)} vs ${rival.logLoss.toFixed(4)})`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] Do the models keep their promises?');
console.log('    A number shown as 100% should happen 100% of the time.\n');
{
  const rows = MODELS.map(([label, fn]) => {
    let sure = 0, sureHit = 0, dead = 0, deadWrong = 0, over = 0;
    for (const m of mons) {
      const obs = { moves: m.moves.slice(0, 2) };
      const pred = fn(m.species, obs);
      if (!pred) continue;
      const shown = new Set(obs.moves);
      (pred.moves || []).forEach(r => {
        if (shown.has(r.name)) return;
        const actual = m.moves.includes(r.name);
        if (r.prob >= 0.999) { sure++; if (actual) sureHit++; }
        if (r.prob <= 0.001) { dead++; if (actual) deadWrong++; }
      });
      // Do the predicted moves add up to the number of slots left?
      // Only meaningful when the published data for this species actually
      // contains both revealed moves. Zacian is generated under its team forme
      // but its Behemoth Blade set is published under Zacian-Crowned, so no
      // model can account for that slot — scoring it would penalise honesty.
      if (obs.moves.some(mv => !publishedMoves(m.species).has(mv))) continue;
      const total = (pred.moves || []).filter(r => !shown.has(r.name))
        .reduce((a, r) => a + r.prob, 0);
      if (total > 2.5) over++;
    }
    return [label,
      sure ? (sureHit / sure * 100).toFixed(1) + '%' : 'n/a',
      dead ? deadWrong : 0,
      over,
      { sure, sureHit, dead, deadWrong, over }];
  });
  tableOf([['model', '"certain" correct', 'ruled-out but present', 'slot budget broken']]
    .concat(rows.map(r => r.slice(0, 4))));

  const rival = rows[1][4], mine = rows[2][4];
  ok(mine.sure === 0 || mine.sureHit === mine.sure,
    `we never call a move certain and get it wrong (${mine.sureHit}/${mine.sure})`);
  ok(mine.over === 0,
    `our remaining-move probabilities always fit the slots left (${mine.over} violations)`);
  ok(rival.over > 0,
    `filter+marginals overshoots the slot budget on ${rival.over} of ${mons.length} Pokemon ` +
    `— printing unconditioned percentages for 2 open slots can sum well past 2`);
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
process.exit(failures ? 1 : 0);
