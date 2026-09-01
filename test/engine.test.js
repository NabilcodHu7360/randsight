/* Sanity + correctness checks for the inference engine, run against the real
 * randbats stats files. Run: node test/engine.test.js  */
'use strict';
const fs = require('fs');
const path = require('path');
require('../src/engine.js');
const E = globalThis.RSEngine;

const DATA_DIR = process.env.RBL_DATA || '/tmp/rb';
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
function close(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg + ` (${a} vs ${b})`); }

function load(fmt) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fmt), 'utf8'));
}

// ---------------------------------------------------------------------------
console.log('\n[1] CB calibration reproduces target marginals');
{
  const pis = [0.7931, 0.6998, 0.5740, 0.4949, 0.4381, 1.0 - 1e-9].slice(0, 5);
  // rescale to sum to 3
  const s = pis.reduce((a, b) => a + b, 0);
  const target = pis.map(p => p * 3 / s);
  const k = 3;
  const w = E._internal.calibrate(target, k);
  const e = E._internal.esp(w, k);
  let worst = 0;
  for (let i = 0; i < w.length; i++) {
    const eMinus = E._internal.espSkip(w, k, new Set([i]));
    const marg = w[i] * eMinus[k - 1] / e[k];
    worst = Math.max(worst, Math.abs(marg - target[i]));
  }
  ok(worst < 1e-8, `max marginal error ${worst.toExponential(2)} < 1e-8`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] With no observations, predictions match published frequencies');
{
  const stats = load('g9stats.json');
  let worst = 0, worstName = '';
  for (const [name, entry] of Object.entries(stats)) {
    const model = E.buildSpecies(entry);
    const pred = E.predict(model, {});
    // marginal move prob under the prior = sum_r weight_r * pi_{r,m}
    const expect = {};
    for (const r of model.roles) {
      const raw = entry.roles ? entry.roles[r.name].moves : entry.moves;
      for (const [m, p] of Object.entries(raw)) expect[m] = (expect[m] || 0) + r.weight * p;
    }
    for (const mv of pred.moves) {
      const d = Math.abs(mv.prob - (expect[mv.name] || 0));
      if (d > worst) { worst = d; worstName = `${name}/${mv.name}`; }
    }
  }
  // The published frequencies are rounded to 4dp, so a role's move marginals
  // can sum to e.g. 4.0002. The engine renormalises them to sum to exactly the
  // slot count, which shifts each move by at most rounding-scale error.
  ok(worst < 5e-4, `max deviation ${worst.toExponential(2)} across all ${Object.keys(stats).length} species (worst: ${worstName}, rounding-scale)`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] Move probabilities sum to the number of slots');
{
  const stats = load('g9stats.json');
  let worst = 0, worstName = '';
  for (const [name, entry] of Object.entries(stats)) {
    const model = E.buildSpecies(entry);
    const pred = E.predict(model, {});
    const total = pred.moves.reduce((a, m) => a + m.prob, 0);
    const d = Math.abs(total - pred.slotsTotal);
    if (d > worst) { worst = d; worstName = name; }
  }
  ok(worst < 1e-6, `max |sum - slots| = ${worst.toExponential(2)} (worst: ${worstName})`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] Revealing a move that only one role has collapses the posterior');
{
  const stats = load('g9stats.json');
  const arbok = E.buildSpecies(stats['Arbok']);
  // Trailblaze is unique to Bulky Setup
  const p = E.predict(arbok, { moves: ['Trailblaze'] });
  const top = p.roles[0];
  ok(top.name === 'Bulky Setup' && top.prob > 0.999,
    `Arbok + Trailblaze -> ${top.name} @ ${(top.prob * 100).toFixed(1)}%`);
  const coil = p.moves.find(m => m.name === 'Coil');
  ok(coil && coil.prob > 0.999, `and Coil is then certain (${(coil.prob * 100).toFixed(1)}%)`);
  const tspikes = p.moves.find(m => m.name === 'Toxic Spikes');
  ok(!tspikes || tspikes.prob < 1e-6, 'Fast Support-only moves drop to ~0');
}

// ---------------------------------------------------------------------------
console.log('\n[5] Conditioning increases the probability of co-occurring moves');
{
  const stats = load('g9stats.json');
  const arbok = E.buildSpecies(stats['Arbok']);
  const prior = E.predict(arbok, {});
  const post = E.predict(arbok, { moves: ['Glare'] });      // Fast Support only
  const g = (p, n) => (p.moves.find(m => m.name === n) || { prob: 0 }).prob;
  ok(post.roles[0].name === 'Fast Support' && post.roles[0].prob > 0.999,
    'Glare pins Fast Support');
  ok(g(post, 'Knock Off') > g(prior, 'Knock Off'),
    `Knock Off rises ${(g(prior, 'Knock Off') * 100).toFixed(1)}% -> ${(g(post, 'Knock Off') * 100).toFixed(1)}%`);
  ok(g(post, 'Sucker Punch') < 1 && g(post, 'Sucker Punch') > 0, 'Sucker Punch stays uncertain');
  close(post.moves.reduce((a, m) => a + m.prob, 0), 4, 1e-6, 'posterior still sums to 4');
}

// ---------------------------------------------------------------------------
console.log('\n[6] Revealing 4 moves leaves no uncertainty');
{
  const stats = load('g9stats.json');
  let checked = 0, bad = 0;
  for (const [name, entry] of Object.entries(stats)) {
    const model = E.buildSpecies(entry);
    const role = model.roles[0];
    const pool = role.locked.concat(role.freeNames);
    if (pool.length < role.k) continue;
    // take a genuinely possible set: all locked + highest-pi free moves
    const set = role.locked.concat(role.freeNames.slice(0, role.k - role.locked.length));
    if (set.length !== role.k) continue;
    const p = E.predict(model, { moves: set });
    const uncertain = p.moves.filter(m => m.prob > 1e-6 && m.prob < 1 - 1e-6);
    checked++;
    if (uncertain.length) { bad++; if (bad < 4) console.log('       ', name, uncertain.map(u => u.name)); }
  }
  ok(bad === 0, `${checked} full sets checked, ${bad} with residual uncertainty`);
}

// ---------------------------------------------------------------------------
console.log('\n[7] Item / ability / tera observations feed the posterior');
{
  const stats = load('g9stats.json');
  const arbok = E.buildSpecies(stats['Arbok']);
  const p = E.predict(arbok, { item: 'Life Orb' });   // only Fast Support runs it
  ok(p.roles[0].name === 'Fast Support' && p.roles[0].prob > 0.999,
    `Life Orb pins Fast Support (${(p.roles[0].prob * 100).toFixed(1)}%)`);
  const item = p.items.find(i => i.name === 'Life Orb');
  ok(item && item.revealed && item.prob === 1, 'revealed item shows as certain');
  const tera = p.teraTypes.reduce((a, t) => a + t.prob, 0);
  close(tera, 1, 1e-6, 'tera distribution normalises');
}

// ---------------------------------------------------------------------------
console.log('\n[8] Every format parses, including the roleless (pre-gen8) shape');
{
  const files = ['g9stats.json', 'gen8randombattle.stats.json', 'gen1randombattle.stats.json',
    'gen9randomdoublesbattle.stats.json', 'gen9babyrandombattle.stats.json',
    'gen7letsgorandombattle.stats.json', 'gen8bdsprandombattle.stats.json'];
  for (const f of files) {
    if (!fs.existsSync(path.join(DATA_DIR, f))) { console.log('  skip  ' + f); continue; }
    const stats = load(f);
    let n = 0, err = null, worst = 0;
    for (const [name, entry] of Object.entries(stats)) {
      try {
        const model = E.buildSpecies(entry);
        const pred = E.predict(model, {});
        worst = Math.max(worst, Math.abs(pred.moves.reduce((a, m) => a + m.prob, 0) - pred.slotsTotal));
        n++;
      } catch (e) { err = `${name}: ${e.message}`; break; }
    }
    ok(!err && worst < 1e-6, `${f}: ${n} species, max slot error ${worst.toExponential(2)}${err ? ' ERR ' + err : ''}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[9] Off-model moves are flagged, not fatal');
{
  const stats = load('g9stats.json');
  const arbok = E.buildSpecies(stats['Arbok']);
  const p = E.predict(arbok, { moves: ['Coil', 'Hyper Beam'] });
  ok(p.notes.some(n => /Hyper Beam/.test(n)), 'unknown move is reported in notes');
  ok(p.roles.reduce((a, r) => a + r.prob, 0) > 0.999, 'posterior still normalised');
}

// ---------------------------------------------------------------------------
console.log('\n[10] An impossible observation is dropped, not the whole posterior');
{
  const stats = load('g9stats.json');
  const gho = E.buildSpecies(stats['Gholdengo']);

  // Choice Scarf is Bulky Attacker only; Tera Flying exists on no Gholdengo set.
  const p = E.predict(gho, { item: 'Choice Scarf', teraType: 'Flying' });
  ok(p.notes.some(n => /Tera Flying/.test(n)), 'the impossible tera is named in the notes');
  ok(!p.notes.some(n => /Choice Scarf/.test(n)), 'the valid item is not blamed');
  ok(p.roles[0].name === 'Bulky Attacker' && p.roles[0].prob > 0.999,
    `the valid item still pins the role (${p.roles[0].name} @ ${(p.roles[0].prob * 100).toFixed(1)}%)`);
  ok((p.moves.find(m => m.name === 'Focus Blast') || {}).prob > 0.999,
    'and its role-specific moves stay certain');
  const recover = p.moves.find(m => m.name === 'Recover');
  ok(!recover || recover.prob < 1e-6,
    `the other role's moves stay eliminated (Recover: ${recover ? recover.prob : 'dropped'})`);

  // Both valid: no notes at all.
  const clean = E.predict(gho, { item: 'Choice Scarf', teraType: 'Ghost' });
  ok(clean.notes.length === 0, 'a fully consistent reveal produces no notes');
  ok(clean.roles[0].name === 'Bulky Attacker' && clean.roles[0].prob > 0.999, 'and pins the role');

  // Contradictory moves: only then do we fall back to priors.
  const arbok = E.buildSpecies(stats['Arbok']);
  const bad = E.predict(arbok, { moves: ['Trailblaze', 'Glare'] });  // different roles
  ok(bad.notes.some(n => /priors/.test(n)), 'mutually exclusive moves fall back to priors, with a note');
  close(bad.roles.reduce((a, r) => a + r.prob, 0), 1, 1e-9, 'posterior still normalised');
}

// ---------------------------------------------------------------------------
console.log('\n[11] Speed formula');
{
  // Randbats default: 85 EVs, 31 IVs, neutral nature.
  // base 142 -> 2*142 + 31 + floor(85/4) = 336;  L100: floor(336) + 5 = 341
  ok(E.speedStat(142, 100, null, null) === 341, 'Dragapult L100 -> ' + E.speedStat(142, 100, null, null));
  //                                              L74:  floor(336*74/100) + 5 = 253
  ok(E.speedStat(142, 74, null, null) === 253, 'Dragapult L74 -> ' + E.speedStat(142, 74, null, null));
  // an EV override in the set data is respected
  ok(E.speedStat(142, 100, { spe: 0 }, null) === 320, 'spe EV override honoured -> ' + E.speedStat(142, 100, { spe: 0 }, null));
  ok(E.speedStat(142, 100, null, { spe: 0 }) === 310, 'spe IV override honoured -> ' + E.speedStat(142, 100, null, { spe: 0 }));
}

// ---------------------------------------------------------------------------
console.log('\n[12] A species the file only has as a forme still resolves');
{
  // Reported from a live gen9 doubles game: Greninja showed no data at all.
  // gen9randomdoublesbattle publishes `Greninja-Bond` and no plain `Greninja`,
  // because Battle Bond is the only Greninja that format generates — but the
  // protocol says "Greninja", which is what is standing on the field until it
  // transforms. Both lookups walked forme -> base and neither walked back.
  require('../src/formats.js');
  const F = globalThis.RSFormats;

  const idOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  // The reported case, against the real published file.
  const dbl = 'gen9randomdoublesbattle.stats.json';
  if (!fs.existsSync(path.join(DATA_DIR, dbl))) {
    console.log('  skip  ' + dbl);
  } else {
    const keys = Object.keys(load(dbl));
    const formes = F.formeIndex(keys);
    ok(!keys.includes('Greninja'), 'doubles really has no plain "Greninja" key');
    ok(keys.includes('Greninja-Bond'), 'doubles really does have "Greninja-Bond"');
    ok(formes.greninja === 'Greninja-Bond',
      `"Greninja" resolves to ${formes.greninja || 'NOTHING'}`);
  }

  // A forme that is a genuinely different Pokemon must NOT be borrowed for the
  // base name. Serving Hisuian Qwilfish's set for a plain Qwilfish would be a
  // worse failure than serving none, because it looks like an answer.
  const baby = 'gen9babyrandombattle.stats.json';
  if (fs.existsSync(path.join(DATA_DIR, baby))) {
    const formes = F.formeIndex(Object.keys(load(baby)));
    ok(!formes.qwilfish, 'Qwilfish-Hisui is not offered up as plain "Qwilfish"');
    ok(!formes.basculin, 'Basculin-White-Striped is not offered up as plain "Basculin"');
  }

  // Ambiguity is left unresolved rather than guessed at. Let's Go is where the
  // real ambiguity lives: a Charizard on the field could be heading for either
  // Mega, and nothing in the data says which.
  const lg = 'gen7letsgorandombattle.stats.json';
  if (fs.existsSync(path.join(DATA_DIR, lg))) {
    const keys = Object.keys(load(lg));
    const formes = F.formeIndex(keys);
    const zard = keys.filter(k => idOf(k).startsWith('charizard'));
    ok(zard.length === 2 && !formes.charizard,
      `Charizard has ${zard.length} Mega formes and stays unresolved`);
    ok(!formes.mewtwo, 'and so does Mewtwo');
    ok(formes.pikachu === 'Pikachu-Starter',
      `partner Pikachu resolves to ${formes.pikachu || 'NOTHING'}`);
  }

  // Urshifu reads like ambiguity but is not: -Rapid-Strike appears under its
  // own name, so the only forme that shows as plain "Urshifu" is the Gmax one.
  const g8 = 'gen8randombattle.stats.json';
  if (fs.existsSync(path.join(DATA_DIR, g8))) {
    const formes = F.formeIndex(Object.keys(load(g8)));
    ok(formes.urshifu === 'Urshifu-Gmax',
      `Urshifu resolves past -Rapid-Strike to ${formes.urshifu || 'NOTHING'}`);
    ok(formes.gengar === 'Gengar-Gmax', `Gengar resolves to ${formes.gengar || 'NOTHING'}`);
  }

  // A base that exists in its own right is never overridden by a forme.
  {
    const formes = F.formeIndex(['Greninja', 'Greninja-Bond', 'Keldeo-Resolute']);
    ok(!formes.greninja, 'a real "Greninja" key wins over "Greninja-Bond"');
    ok(formes.keldeo === 'Keldeo-Resolute', 'and Keldeo still resolves');
  }
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
process.exit(failures ? 1 : 0);
