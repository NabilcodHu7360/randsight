/*
 * Probe: is the model's independence assumption sound?
 *
 * engine.js factorises the likelihood as
 *     P(role) · P(moves | role) · P(item | role) · P(ability | role) · P(tera | role)
 * which assumes item/ability/tera are independent of the MOVES once the role is
 * known. Showdown's generator picks the item *after* and *from* the chosen moves
 * (`getItem(ability, types, moves, counter, ...)`), so that assumption is
 * suspect. This script measures whether it actually costs us anything.
 *
 * Not a test — a measurement. Run: node test/independence.probe.js [teams]
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
const E = globalThis.RBLEngine;

const DATA = process.env.RBL_DATA || '/tmp/rb';
const TEAMS = parseInt(process.argv[2], 10) || 3000;
const { Teams } = require('pokemon-showdown');
const stats = JSON.parse(fs.readFileSync(path.join(DATA, 'g9stats.json'), 'utf8'));

const id = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const byId = {};
Object.keys(stats).forEach(k => { byId[id(k)] = k; });
const nameById = {};
Object.values(stats).forEach(e => {
  const roles = e.roles || { _: e };
  Object.values(roles).forEach(r => ['moves', 'items', 'abilities', 'teraTypes'].forEach(f =>
    Object.keys(r[f] || {}).forEach(n => { nameById[id(n)] = n; })));
});
const toName = x => nameById[id(x)] || null;

console.log(`Generating ${TEAMS} teams…`);
const mons = [];
for (let i = 0; i < TEAMS; i++) {
  for (const s of Teams.generate('gen9randombattle')) {
    const key = byId[id(s.species || s.name)] || byId[id(String(s.species).split('-')[0])];
    if (!key) continue;
    const moves = (s.moves || []).map(toName);
    if (moves.some(m => !m)) continue;
    mons.push({ key, moves: moves.sort(), item: toName(s.item), ability: toName(s.ability), tera: s.teraType });
  }
}
console.log(`${mons.length} Pokemon\n`);

// Group by species, then infer which role each observed set belongs to by
// matching its moves against the role pools (unambiguous ones only).
const bySpecies = {};
mons.forEach(m => { (bySpecies[m.key] = bySpecies[m.key] || []).push(m); });

function rolesOf(key) {
  const e = stats[key];
  return e.roles ? Object.entries(e.roles) : [['_', e]];
}

function assignRole(key, m) {
  const matches = rolesOf(key).filter(([, r]) => m.moves.every(mv => (r.moves || {})[mv]));
  return matches.length === 1 ? matches[0][0] : null;
}

// ---------------------------------------------------------------------------
// How much does knowing the MOVES tell you about the ITEM, beyond the role?
//
// For each (species, role) with a genuinely varying item, compare:
//   P(item | role)                 -- what the model uses
//   P(item | role, one revealed move)  -- the truth
// and report the largest divergence, weighted by how often it comes up.
// ---------------------------------------------------------------------------
let checked = 0, biggestGap = 0, biggestWhere = '', gapSum = 0, gapN = 0;
const offenders = [];

for (const [key, list] of Object.entries(bySpecies)) {
  if (list.length < 80) continue;
  const groups = {};
  list.forEach(m => {
    const r = assignRole(key, m);
    if (!r) return;
    (groups[r] = groups[r] || []).push(m);
  });

  for (const [role, sets] of Object.entries(groups)) {
    if (sets.length < 50) continue;
    const items = {};
    sets.forEach(s => { if (s.item) items[s.item] = (items[s.item] || 0) + 1; });
    const itemNames = Object.keys(items);
    if (itemNames.length < 2) continue;          // no variation, nothing to learn

    // candidate moves that are NOT in every set of this role
    const moveCount = {};
    sets.forEach(s => s.moves.forEach(mv => { moveCount[mv] = (moveCount[mv] || 0) + 1; }));
    const optional = Object.keys(moveCount).filter(mv => moveCount[mv] < sets.length * 0.98);

    for (const mv of optional) {
      const withMove = sets.filter(s => s.moves.includes(mv));
      if (withMove.length < 25 || sets.length - withMove.length < 25) continue;
      for (const it of itemNames) {
        const pUncond = items[it] / sets.length;
        const pCond = withMove.filter(s => s.item === it).length / withMove.length;
        const gap = Math.abs(pCond - pUncond);
        checked++;
        gapSum += gap; gapN++;
        if (gap > biggestGap) { biggestGap = gap; biggestWhere = `${key} / ${role}: P(${it} | ${mv}) ${(pCond * 100).toFixed(0)}% vs P(${it}) ${(pUncond * 100).toFixed(0)}%`; }
        if (gap > 0.25) offenders.push(`${key} ${role}: ${mv} -> ${it}  ${(pUncond * 100).toFixed(0)}% => ${(pCond * 100).toFixed(0)}%`);
      }
    }
  }
}

console.log('--- Does a revealed move shift the item distribution within a role? ---');
console.log(`  comparisons:      ${checked}`);
console.log(`  mean |shift|:     ${(gapSum / gapN * 100).toFixed(2)} percentage points`);
console.log(`  largest shift:    ${(biggestGap * 100).toFixed(1)} pp`);
console.log(`    ${biggestWhere}`);
console.log(`  shifts over 25pp: ${offenders.length}`);
offenders.slice(0, 12).forEach(o => console.log('    ' + o));

// ---------------------------------------------------------------------------
// The practical question: does our predicted ITEM distribution match reality?
// ---------------------------------------------------------------------------
const modelCache = {};
const modelFor = k => (modelCache[k] = modelCache[k] || E.buildSpecies(stats[k]));

function grade(field, truthOf, revealCount) {
  const bins = [];
  for (let i = 0; i < 10; i++) bins.push({ sum: 0, hit: 0, n: 0 });
  let n = 0;
  for (const m of mons) {
    if (m.moves.length < 4) continue;
    const shown = m.moves.slice(0, revealCount);
    const pred = E.predict(modelFor(m.key), { moves: shown });
    const truth = truthOf(m);
    const list = pred[field] || [];
    if (!list.length) continue;
    for (const row of list) {
      const actual = row.name === truth ? 1 : 0;
      const b = bins[Math.min(Math.floor(row.prob * 10), 9)];
      b.sum += row.prob; b.hit += actual; b.n++;
      n++;
    }
  }
  const rows = bins.filter(b => b.n >= 50).map(b => ({ p: b.sum / b.n, o: b.hit / b.n, n: b.n }));
  const total = rows.reduce((a, r) => a + r.n, 0);
  const ece = rows.reduce((a, r) => a + (r.n / total) * Math.abs(r.p - r.o), 0);
  return { rows, ece, n };
}

console.log('\n--- Calibration of the non-move predictions (2 moves revealed) ---');
for (const [field, truthOf] of [
  ['items', m => m.item],
  ['abilities', m => m.ability],
  ['teraTypes', m => m.tera && toName(m.tera)]
]) {
  const g = grade(field, truthOf, 2);
  console.log(`\n  ${field}  (${g.n} predictions)   ECE ${(g.ece * 100).toFixed(2)} pp`);
  console.log('    predicted   observed        n');
  g.rows.forEach(r => console.log(`     ${(r.p * 100).toFixed(1).padStart(7)}%  ${(r.o * 100).toFixed(1).padStart(8)}%  ${String(r.n).padStart(7)}`));
}
