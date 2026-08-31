/*
 * Calibration: are the predicted probabilities honest?
 *
 * Everything else in the suite checks internal consistency — that the model
 * reproduces the published marginals, that probabilities sum to the slot count.
 * None of that proves the CONDITIONAL numbers are right. A model can be
 * perfectly self-consistent and still be badly wrong about "given Glare, how
 * likely is Knock Off?".
 *
 * So this suite generates real Random Battle teams with Pokemon Showdown's own
 * generator, hides some of each set, asks the engine to predict the rest, and
 * compares the predictions against the truth we hid.
 *
 * When the engine says 70%, the move should be there about 70% of the time.
 *
 * Requires the optional `pokemon-showdown` dev dependency:
 *   npm install pokemon-showdown
 *
 * Run: node test/calibration.test.js [teamCount]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
const E = globalThis.RSEngine;

const DATA = process.env.RBL_DATA || '/tmp/rb';
const STATS_FILE = path.join(DATA, 'g9stats.json');
const FORMAT = 'gen9randombattle';
const TEAMS = parseInt(process.argv[2], 10) || 2000;

let Teams;
try {
  Teams = require('pokemon-showdown').Teams;
} catch (e) {
  console.log('SKIP  pokemon-showdown not installed (npm install pokemon-showdown)');
  process.exit(0);
}
if (!fs.existsSync(STATS_FILE)) {
  console.log('SKIP  no stats fixture at ' + STATS_FILE + ' (npm run fetch-fixtures)');
  process.exit(0);
}

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
const byId = {};
Object.keys(stats).forEach(k => { byId[k.toLowerCase().replace(/[^a-z0-9]+/g, '')] = k; });
const modelCache = {};
function modelFor(species) {
  const key = byId[species.toLowerCase().replace(/[^a-z0-9]+/g, '')]
    || byId[species.split('-')[0].toLowerCase().replace(/[^a-z0-9]+/g, '')];
  if (!key) return null;
  if (!modelCache[key]) modelCache[key] = E.buildSpecies(stats[key]);
  return modelCache[key];
}

// Showdown gives move/item/ability ids; the stats file uses display names.
const nameById = {};
Object.values(stats).forEach(entry => {
  const roles = entry.roles || { _: entry };
  Object.values(roles).forEach(r => {
    ['moves', 'items', 'abilities', 'teraTypes'].forEach(f => {
      Object.keys(r[f] || {}).forEach(n => { nameById[n.toLowerCase().replace(/[^a-z0-9]+/g, '')] = n; });
    });
  });
});
const toName = id => nameById[String(id).toLowerCase().replace(/[^a-z0-9]+/g, '')] || null;

// ---------------------------------------------------------------------------
console.log(`\nGenerating ${TEAMS} ${FORMAT} teams with Showdown's own generator…`);
const mons = [];
let unmapped = 0;
for (let i = 0; i < TEAMS; i++) {
  for (const set of Teams.generate(FORMAT)) {
    const model = modelFor(set.species || set.name);
    if (!model) { unmapped++; continue; }
    const moves = (set.moves || []).map(toName);
    if (moves.some(m => !m)) { unmapped++; continue; }
    mons.push({
      species: set.species || set.name,
      model,
      moves,
      item: toName(set.item),
      ability: toName(set.ability),
      tera: set.teraType || null
    });
  }
}
console.log(`  ${mons.length} Pokemon usable, ${unmapped} skipped (data-version drift)\n`);

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rand = rng(12345);
const shuffled = a => a.map(x => [rand(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);

/**
 * Hide part of each set, predict the rest, record (predicted, actual) pairs.
 * @param useSideInfo whether to also reveal the item/ability/tera as evidence
 */
function collect(revealCount, useSideInfo) {
  const points = [];
  let logLoss = 0, n = 0, brier = 0;

  for (const m of mons) {
    if (m.moves.length < 4) continue;
    const order = shuffled(m.moves.slice());
    const shown = order.slice(0, revealCount);
    const hidden = new Set(order.slice(revealCount));

    const obs = { moves: shown };
    if (useSideInfo) {
      if (m.item) obs.item = m.item;
      if (m.ability) obs.ability = m.ability;
      if (m.tera) obs.teraType = m.tera;
    }

    const pred = E.predict(m.model, obs);
    for (const row of pred.moves) {
      if (shown.includes(row.name)) continue;       // already known, not a prediction
      const actual = hidden.has(row.name) ? 1 : 0;
      const p = Math.min(Math.max(row.prob, 1e-6), 1 - 1e-6);
      points.push([row.prob, actual]);
      logLoss += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
      brier += (row.prob - actual) ** 2;
      n++;
    }
  }
  return { points, logLoss: logLoss / n, brier: brier / n, n };
}

function calibrationTable(points) {
  const bins = [];
  for (let i = 0; i < 10; i++) bins.push({ lo: i / 10, hi: (i + 1) / 10, sum: 0, hit: 0, n: 0 });
  for (const [p, a] of points) {
    const b = bins[Math.min(Math.floor(p * 10), 9)];
    b.sum += p; b.hit += a; b.n++;
  }
  return bins.filter(b => b.n >= 30).map(b => ({
    range: `${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`,
    predicted: b.sum / b.n,
    observed: b.hit / b.n,
    n: b.n
  }));
}

/** Expected calibration error: average |predicted - observed|, weighted by bin size. */
function ece(rows) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  return rows.reduce((a, r) => a + (r.n / total) * Math.abs(r.predicted - r.observed), 0);
}

// ---------------------------------------------------------------------------
console.log('[1] Calibration — when the engine says X%, does it happen X% of the time?');
let baseline;
for (const k of [1, 2, 3]) {
  const res = collect(k, false);
  const rows = calibrationTable(res.points);
  if (k === 2) baseline = res;
  console.log(`\n  ${k} move${k > 1 ? 's' : ''} revealed  (${res.n} predictions)`);
  console.log('    bucket      predicted   observed      n');
  rows.forEach(r => {
    console.log(`    ${r.range.padEnd(10)}  ${(r.predicted * 100).toFixed(1).padStart(7)}%  ${(r.observed * 100).toFixed(1).padStart(8)}%  ${String(r.n).padStart(7)}`);
  });
  const err = ece(rows);
  console.log(`    expected calibration error: ${(err * 100).toFixed(2)} percentage points`);
  ok(err < 0.03, `${k} revealed: ECE ${(err * 100).toFixed(2)}pp is under 3pp`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] Certainty means certainty');
{
  const res = collect(2, false);
  const sure = res.points.filter(([p]) => p >= 0.999);
  const hit = sure.filter(([, a]) => a === 1).length;
  const impossible = res.points.filter(([p]) => p <= 0.001);
  const wrong = impossible.filter(([, a]) => a === 1).length;
  ok(sure.length > 0 && hit === sure.length,
    `${sure.length} moves called certain, ${sure.length - hit} were absent`);
  ok(wrong === 0,
    `${impossible.length} moves ruled out, ${wrong} actually appeared`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] Does the item/ability/tera evidence actually help?');
{
  const without = collect(2, false);
  const withInfo = collect(2, true);
  console.log(`    log loss   without: ${without.logLoss.toFixed(4)}   with: ${withInfo.logLoss.toFixed(4)}`);
  console.log(`    Brier      without: ${without.brier.toFixed(4)}   with: ${withInfo.brier.toFixed(4)}`);
  const gain = (without.logLoss - withInfo.logLoss) / without.logLoss;
  console.log(`    log-loss reduction: ${(gain * 100).toFixed(1)}%`);
  ok(withInfo.logLoss < without.logLoss,
    `using the item/ability/tera as evidence improves predictions (${(gain * 100).toFixed(1)}% lower log loss)`);
  const rows = calibrationTable(withInfo.points);
  ok(ece(rows) < 0.03, `and stays calibrated (ECE ${(ece(rows) * 100).toFixed(2)}pp)`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] Beating the naive baseline (published marginals, no conditioning)');
{
  // What a tool that only shows usage percentages would score.
  let naive = 0, n = 0;
  for (const m of mons) {
    if (m.moves.length < 4) continue;
    const order = shuffled(m.moves.slice());
    const shown = order.slice(0, 2);
    const hidden = new Set(order.slice(2));
    const prior = E.predict(m.model, {});          // no observations at all
    for (const row of prior.moves) {
      if (shown.includes(row.name)) continue;
      const actual = hidden.has(row.name) ? 1 : 0;
      const p = Math.min(Math.max(row.prob, 1e-6), 1 - 1e-6);
      naive += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
      n++;
    }
  }
  naive /= n;
  console.log(`    log loss   marginals only: ${naive.toFixed(4)}   conditioned: ${baseline.logLoss.toFixed(4)}`);
  const gain = (naive - baseline.logLoss) / naive;
  ok(baseline.logLoss < naive,
    `conditioning beats showing raw usage percentages by ${(gain * 100).toFixed(1)}% log loss`);
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
process.exit(failures ? 1 : 0);
