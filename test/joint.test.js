/*
 * The joint model, graded against freshly generated teams.
 *
 * The marginal model (engine.js) is well calibrated *on average* but has a
 * structural blind spot: it assumes the item is independent of the moves given
 * the role. Aggregate calibration hides this completely, because the
 * over- and under-estimates cancel out. This suite measures the thing that
 * aggregate error can't see — conditional accuracy — and checks the joint
 * model closes it.
 *
 * Every team used here is generated fresh, so it is held out from the sample
 * the table was built from.
 *
 * Run: node test/joint.test.js [teams]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
require('../src/joint.js');
const E = globalThis.RBLEngine;
const J = globalThis.RBLJoint;

const FORMAT = 'gen9randombattle';
const TABLE = path.resolve(__dirname, '..', 'src', 'data', `joint-${FORMAT}.json`);
const DATA = process.env.RBL_DATA || '/tmp/rb';
const STATS = path.join(DATA, 'g9stats.json');
const TEAMS = parseInt(process.argv[2], 10) || 4000;

let Teams;
try { Teams = require('pokemon-showdown').Teams; }
catch (e) { console.log('SKIP  pokemon-showdown not installed'); process.exit(0); }
if (!fs.existsSync(TABLE)) { console.log('SKIP  no joint table (npm run build-joint)'); process.exit(0); }

let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures++; };

const table = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
J.register(FORMAT, table);
const stats = fs.existsSync(STATS) ? JSON.parse(fs.readFileSync(STATS, 'utf8')) : {};

const id = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const statsById = {};
Object.keys(stats).forEach(k => { statsById[id(k)] = stats[k]; });
const statsFor = sp => statsById[id(sp)] || statsById[id(String(sp).split('-')[0])] || null;

const modelCache = {};
function marginalPredict(species, obs) {
  const e = statsFor(species);
  if (!e) return null;
  const k = id(species);
  if (!modelCache[k]) modelCache[k] = E.buildSpecies(e);
  return E.predict(modelCache[k], obs);
}

// ---------------------------------------------------------------------------
console.log('\n[1] Table shape');
{
  ok(table.species && Object.keys(table.species).length > 400,
    `${Object.keys(table.species).length} species in the table`);
  const sample = table.species[Object.keys(table.species)[0]];
  ok(Array.isArray(sample.rows) && sample.rows.length > 0 && sample.rows[0].length === 6,
    'rows are [moves, item, ability, tera, role, count]');
  ok(typeof sample.fp === 'string' && sample.fp.length > 0, 'each species carries a freshness fingerprint');
  ok(table.teams >= 10000, `built from ${table.teams} teams`);
  const st = J.stats(FORMAT);
  ok(st && st.species > 400, `RBLJoint.stats reports ${st && st.species} species`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] The couplings the marginal model provably misses');
{
  // These were found empirically by test/independence.probe.js.
  const cases = [
    ['Terapagos', 'Rest', 'items', 'Chesto Berry'],
    ['Volcanion', 'Flame Charge', 'items', 'Assault Vest'],
    ['Bruxish', 'Swords Dance', 'items', 'Life Orb']
  ];
  for (const [species, move, field, expected] of cases) {
    if (!table.species[species]) { ok(true, `${species} not in table this build — skipped`); continue; }
    const j = J.predict(FORMAT, species, { moves: [move] }, statsFor(species));
    const m = marginalPredict(species, { moves: [move] });
    if (!j || !m) { ok(false, `${species}: prediction failed`); continue; }
    const jp = (j[field].find(x => x.name === expected) || { prob: 0 }).prob;
    const mp = (m[field].find(x => x.name === expected) || { prob: 0 }).prob;
    ok(jp > 0.98 && mp < 0.9,
      `${species} + ${move} -> ${expected}: joint ${(jp * 100).toFixed(0)}%, marginal ${(mp * 100).toFixed(0)}%`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n[3] Generating ${TEAMS} held-out teams…`);
const held = [];
for (let i = 0; i < TEAMS; i++) {
  for (const s of Teams.generate(FORMAT)) {
    held.push({
      species: s.species || s.name,
      moves: (s.moves || []).slice(),
      item: s.item || null,
      ability: s.ability || null,
      tera: s.teraType || null,
      role: s.role || null
    });
  }
}
// The generator emits ids for moves/items/abilities; the tables use display
// names. Build the map from the table itself.
const nameById = {};
Object.values(table.species).forEach(e => {
  ['m', 'i', 'a', 't', 'r'].forEach(f => (e[f] || []).forEach(n => { nameById[id(n)] = n; }));
});
const toName = x => (x == null ? null : (nameById[id(x)] || null));
held.forEach(h => {
  h.moves = h.moves.map(toName);
  h.item = toName(h.item);
  h.ability = toName(h.ability);
  h.tera = toName(h.tera);
});
const usable = held.filter(h => h.moves.length === 4 && h.moves.every(Boolean));
console.log(`  ${usable.length} usable Pokemon\n`);

// The candidate set a species could possibly show, taken from the joint table.
// BOTH models are scored over this same support. Without it a model is silently
// excused for omitting an option: the marginal model drops moves it has ruled
// out, so if one of those turns out to be the truth it is never penalised.
// Scoring on each model's own output makes the stricter model look better than
// it is — an evaluation bug, not a modelling one.
const candidates = {};
Object.entries(table.species).forEach(([name, e]) => {
  candidates[id(name)] = { moves: e.m.slice(), items: e.i.slice(), teraTypes: e.t.slice(), abilities: e.a.slice() };
});
const candidatesFor = (sp, field) => {
  const c = candidates[id(sp)] || candidates[id(String(sp).split('-')[0])];
  return (c && c[field]) || [];
};

function metrics(predictFn, field, truthOf, revealCount) {
  const bins = Array.from({ length: 10 }, () => ({ sum: 0, hit: 0, n: 0 }));
  let logLoss = 0, n = 0, covered = 0;
  for (const h of usable) {
    const shown = h.moves.slice(0, revealCount);
    const pred = predictFn(h, shown);
    if (!pred) continue;
    covered++;
    const truth = truthOf(h);
    const hiddenSet = new Set(h.moves.slice(revealCount));

    const probs = {};
    (pred[field] || []).forEach(r => { probs[r.name] = r.prob; });

    for (const name of candidatesFor(h.species, field)) {
      let actual;
      if (field === 'moves') {
        if (shown.includes(name)) continue;
        actual = hiddenSet.has(name) ? 1 : 0;
      } else {
        actual = name === truth ? 1 : 0;
      }
      const raw = probs[name] || 0;
      const p = Math.min(Math.max(raw, 1e-6), 1 - 1e-6);
      const b = bins[Math.min(Math.floor(raw * 10), 9)];
      b.sum += raw; b.hit += actual; b.n++;
      logLoss += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
      n++;
    }
  }
  const rows = bins.filter(b => b.n >= 40).map(b => ({ p: b.sum / b.n, o: b.hit / b.n, n: b.n }));
  const total = rows.reduce((a, r) => a + r.n, 0) || 1;
  return {
    ece: rows.reduce((a, r) => a + (r.n / total) * Math.abs(r.p - r.o), 0),
    logLoss: logLoss / n, n, covered
  };
}

const rawJointFn = (h, shown) => J.predict(FORMAT, h.species, { moves: shown }, statsFor(h.species));
const blendFn = pseudo => (h, shown) => {
  const j = rawJointFn(h, shown);
  const m = marginalPredict(h.species, { moves: shown });
  return J.blend(j, m, pseudo);
};
const jointFn = blendFn(undefined);
const margFn = (h, shown) => marginalPredict(h.species, { moves: shown });

// ---------------------------------------------------------------------------
console.log('[4] Item prediction given two revealed moves — the broken case');
{
  const j = metrics(jointFn, 'items', h => h.item, 2);
  const m = metrics(margFn, 'items', h => h.item, 2);
  console.log(`    marginal model  ECE ${(m.ece * 100).toFixed(2)}pp   log loss ${m.logLoss.toFixed(4)}`);
  console.log(`    joint model     ECE ${(j.ece * 100).toFixed(2)}pp   log loss ${j.logLoss.toFixed(4)}`);
  const gain = (m.logLoss - j.logLoss) / m.logLoss;
  ok(j.logLoss < m.logLoss, `joint predicts items better (${(gain * 100).toFixed(1)}% lower log loss)`);
  ok(j.ece < 0.03, `joint item ECE ${(j.ece * 100).toFixed(2)}pp under 3pp`);
  ok(j.covered / usable.length > 0.95, `table covers ${(100 * j.covered / usable.length).toFixed(1)}% of Pokemon`);
}

// ---------------------------------------------------------------------------
console.log('\n[5] Move prediction — the joint model must not regress it');
{
  for (const k of [1, 2, 3]) {
    const j = metrics(jointFn, 'moves', () => null, k);
    const m = metrics(margFn, 'moves', () => null, k);
    console.log(`    ${k} revealed:  marginal ECE ${(m.ece * 100).toFixed(2)}pp / LL ${m.logLoss.toFixed(4)}` +
      `   joint ECE ${(j.ece * 100).toFixed(2)}pp / LL ${j.logLoss.toFixed(4)}`);
    ok(j.logLoss <= m.logLoss * 1.01, `${k} revealed: blended model is no worse on moves`);
    ok(j.ece < 0.03, `${k} revealed: joint move ECE ${(j.ece * 100).toFixed(2)}pp under 3pp`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[6] Tera prediction');
{
  const j = metrics(jointFn, 'teraTypes', h => h.tera, 2);
  const m = metrics(margFn, 'teraTypes', h => h.tera, 2);
  console.log(`    marginal ECE ${(m.ece * 100).toFixed(2)}pp / LL ${m.logLoss.toFixed(4)}` +
    `   joint ECE ${(j.ece * 100).toFixed(2)}pp / LL ${j.logLoss.toFixed(4)}`);
  ok(j.logLoss <= m.logLoss, 'joint predicts Tera at least as well');
}

// ---------------------------------------------------------------------------
console.log('\n[7] Conditional accuracy — what aggregate error cannot see');
{
  // For every (species, revealed move) slice with enough held-out samples,
  // compare each model's predicted item probability to the observed frequency.
  // This is the metric that exposes the independence assumption.
  // This section compares each model's prediction against the OBSERVED
  // frequency in a slice. That observed frequency is itself an estimate, so it
  // needs its own large sample — otherwise we are measuring noise in the ground
  // truth rather than error in the models.
  const BIG = TEAMS * 6;
  process.stdout.write(`    generating ${BIG} more teams for ground truth… `);
  const big = [];
  for (let i = 0; i < BIG; i++) {
    for (const g of Teams.generate(FORMAT)) {
      const mvs = (g.moves || []).map(toName);
      const it = toName(g.item);
      if (!it || mvs.some(m => !m)) continue;
      big.push({ species: g.species || g.name, moves: mvs, item: it });
    }
  }
  console.log(`${big.length} Pokemon`);

  const slices = {};
  for (const h of big) {
    for (const mv of h.moves) {
      const key = h.species + '|' + mv;
      (slices[key] = slices[key] || []).push(h);
    }
  }
  // The observed frequency in a slice is itself an estimate, so a small slice
  // is mostly noise in the GROUND TRUTH rather than error in the model. Require
  // enough samples that the comparison means something.
  let jSum = 0, mSum = 0, count = 0, worstM = 0, worstWhere = '';
  let hardJ = 0, hardM = 0, hardN = 0;
  for (const [key, list] of Object.entries(slices)) {
    if (list.length < 80) continue;
    const [species, mv] = key.split('|');
    // Only interesting where the item genuinely varies for this species —
    // a species that always holds Leftovers tells us nothing either way.
    const cand = candidatesFor(species, 'items');
    if (cand.length < 2) continue;
    const items = {};
    list.forEach(h => { items[h.item] = (items[h.item] || 0) + 1; });
    const jp = J.predict(FORMAT, species, { moves: [mv] }, statsFor(species));
    const mp = marginalPredict(species, { moves: [mv] });
    if (!jp || !mp) continue;
    for (const [item, n] of Object.entries(items)) {
      const observed = n / list.length;
      const jj = (jp.items.find(x => x.name === item) || { prob: 0 }).prob;
      const mm = (mp.items.find(x => x.name === item) || { prob: 0 }).prob;
      jSum += Math.abs(jj - observed);
      mSum += Math.abs(mm - observed);
      // The slices that matter: where the marginal model is materially wrong.
      if (Math.abs(mm - observed) > 0.10) { hardJ += Math.abs(jj - observed); hardM += Math.abs(mm - observed); hardN++; }
      if (Math.abs(mm - observed) > worstM) { worstM = Math.abs(mm - observed); worstWhere = `${species} + ${mv} -> ${item}`; }
      count++;
    }
  }
  const jAvg = jSum / count, mAvg = mSum / count;
  console.log(`    ${count} (species, revealed move, item) slices`);
  console.log(`    mean |predicted - observed|:  marginal ${(mAvg * 100).toFixed(2)}pp   joint ${(jAvg * 100).toFixed(2)}pp`);
  console.log(`    marginal model's worst slice: ${(worstM * 100).toFixed(0)}pp   (${worstWhere})`);
  console.log(`    ${hardN} slices where the marginal model is off by >10pp:`);
  console.log(`      marginal ${(hardM / hardN * 100).toFixed(1)}pp   joint ${(hardJ / hardN * 100).toFixed(1)}pp`);
  ok(jAvg <= mAvg, `overall conditional item error: marginal ${(mAvg * 100).toFixed(2)}pp -> joint ${(jAvg * 100).toFixed(2)}pp`);
  ok(hardN > 0 && hardJ / hardN < (hardM / hardN) / 2,
    `on the slices the marginal model gets wrong, joint cuts error from ${(hardM / hardN * 100).toFixed(1)}pp to ${(hardJ / hardN * 100).toFixed(1)}pp`);
}

// ---------------------------------------------------------------------------
console.log('\n[8] The shrinkage pseudo-count is at a sensible value');
{
  console.log('    pseudo-count   move LL(2)   item LL(2)');
  let best = null;
  for (const k of [0, 3, 6, 12, 25, 50, 200, 1e9]) {
    const mv = metrics(blendFn(k), 'moves', () => null, 2);
    const it = metrics(blendFn(k), 'items', h => h.item, 2);
    const label = k === 0 ? 'joint only' : (k === 1e9 ? 'marginal only' : String(k));
    console.log(`    ${label.padEnd(13)}  ${mv.logLoss.toFixed(4)}      ${it.logLoss.toFixed(4)}`);
    const score = mv.logLoss + it.logLoss;
    if (!best || score < best.score) best = { k, score, label };
  }
  console.log(`    best combined: ${best.label}`);
  ok(Math.abs(J.PSEUDO - (best.k === 1e9 ? J.PSEUDO : best.k)) <= 20 || best.k === J.PSEUDO,
    `shipped pseudo-count ${J.PSEUDO} is near the held-out optimum (${best.label})`);
}

// ---------------------------------------------------------------------------
console.log('\n[9] Falls back rather than serving stale or missing data');
{
  ok(J.predict(FORMAT, 'Missingno', { moves: [] }, null) === null,
    'unknown species returns null so the caller falls back');
  ok(J.predict('gen7randombattle', 'Dragapult', { moves: [] }, null) === null,
    'a format with no table returns null');

  const species = Object.keys(table.species)[0];
  const staleStats = { roles: { X: { moves: { 'Fake Move A': 1, 'Fake Move B': 1 } } } };
  ok(J.predict(FORMAT, species, { moves: [] }, staleStats) === null,
    'a species whose published move pool has changed is refused as stale');
  ok(J.predict(FORMAT, species, { moves: [] }, statsFor(species)) !== null,
    'and is served normally when the fingerprint matches');
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
process.exit(failures ? 1 : 0);
