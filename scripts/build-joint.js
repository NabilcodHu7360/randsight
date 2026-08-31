#!/usr/bin/env node
/*
 * Build the joint set tables in src/data/.
 *
 * Why this exists
 * ---------------
 * pkmn/randbats publishes *marginals*: how often each move, item, ability and
 * Tera type appears. engine.js reconstructs a joint distribution over MOVES
 * from those marginals, which works well — but it has to assume the item and
 * Tera type are independent of the moves once the role is known.
 *
 * They are not. Showdown's generator picks the item from the chosen moves, so
 * e.g. Terapagos with Rest always carries a Chesto Berry, and Volcanion with
 * Flame Charge always carries an Assault Vest. Measured across 42,000 generated
 * Pokemon, a single revealed move shifts the item distribution by 22 percentage
 * points on average and up to 74.
 *
 * No marginal-only model can recover that, so we sample the joint distribution
 * directly from Showdown's own generator and ship the result. It costs ~47 KB
 * gzipped per format.
 *
 * Usage:  node scripts/build-joint.js [teams] [format ...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { Teams, Dex } = require('pokemon-showdown');

// The generator emits move IDs ("stoneedge") while items, abilities, Tera types
// and roles already come through as display names. The client and the published
// stats both speak display names, so normalise moves here — otherwise nothing
// downstream matches and every lookup silently falls back.
const moveName = mv => {
  const e = Dex.moves.get(mv);
  return (e && e.exists && e.name) ? e.name : String(mv);
};

const OUT_DIR = path.resolve(__dirname, '..', 'src', 'data');
const TEAMS = parseInt(process.argv[2], 10) || 100000;
// Every format src/formats.js claims to support. Older generations have no
// role concept at all; the row format stores roleIdx -1 for those and both
// models already handle it.
const FORMATS = process.argv.slice(3).length ? process.argv.slice(3) : [
  'gen9randombattle',
  'gen9randomdoublesbattle',
  'gen9championsrandomdoublesbattle',
  'gen9babyrandombattle',
  'gen8randombattle',
  'gen8bdsprandombattle',
  'gen7randombattle',
  'gen7letsgorandombattle',
  'gen6randombattle',
  'gen5randombattle',
  'gen4randombattle',
  'gen3randombattle',
  'gen2randombattle',
  'gen1randombattle'
];

const id = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A fingerprint of what the published marginals say this species can do.
 * At runtime we recompute it from the live stats file; if it differs, the sets
 * have changed since this table was built and we fall back to the marginal
 * model for that species rather than serving stale joint data.
 */
function fingerprint(moveNames) {
  const s = moveNames.slice().sort().join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * Rebuild a subset of one species' rows as a standalone entry whose index
 * arrays hold only the values those rows actually use.
 */
function compact(S, rows) {
  const T = { m: [], i: [], a: [], t: [], r: [], lv: S.lv, rows: new Map() };
  const reindex = (arr, from, i) => {
    if (i < 0) return -1;
    const v = from[i];
    let j = arr.indexOf(v);
    if (j < 0) { arr.push(v); j = arr.length - 1; }
    return j;
  };
  for (const [key, count] of rows) {
    const [mv, it, ab, te, ro] = key.split('/');
    const mi = mv.split('.').map(Number)
      .map(i => reindex(T.m, S.m, i)).sort((a, b) => a - b);
    const nk = mi.join('.') + '/' + reindex(T.i, S.i, +it) + '/' +
      reindex(T.a, S.a, +ab) + '/' + reindex(T.t, S.t, +te) + '/' + reindex(T.r, S.r, +ro);
    T.rows.set(nk, (T.rows.get(nk) || 0) + count);
  }
  return T;
}

function build(format) {
  process.stdout.write(`\n${format}\n  generating ${TEAMS} teams… `);
  const t0 = Date.now();

  const species = {};
  let mons = 0, teams = 0;

  for (let i = 0; i < TEAMS; i++) {
    let team;
    try { team = Teams.generate(format); }
    catch (e) { console.log(`\n  cannot generate ${format}: ${e.message}`); return null; }
    teams++;
    for (const set of team) {
      const name = set.species || set.name;
      if (!name) continue;
      const S = species[name] || (species[name] = {
        m: [], i: [], a: [], t: [], r: [], lv: set.level || 100, rows: new Map()
      });
      const idx = (arr, v) => {
        if (v === undefined || v === null || v === '') return -1;
        let j = arr.indexOf(v);
        if (j < 0) { arr.push(v); j = arr.length - 1; }
        return j;
      };
      const moves = (set.moves || []).map(m => idx(S.m, moveName(m))).sort((a, b) => a - b);
      const key = moves.join('.') + '/' + idx(S.i, set.item) + '/' +
        idx(S.a, set.ability) + '/' + idx(S.t, set.teraType) + '/' + idx(S.r, set.role);
      S.rows.set(key, (S.rows.get(key) || 0) + 1);
      mons++;
    }
  }

  // Battle-only formes: the generator reports the TEAM forme (Zacian) while the
  // battle — and the published stats — use the battle forme (Zacian-Crowned).
  // Left merged, the entry's move pool matches neither, so the runtime freshness
  // check rejects it and those Pokemon silently lose the joint model. Split the
  // rows by the item that triggers the forme change.
  for (const [name, S] of Object.entries(species)) {
    let base;
    try { base = Dex.species.get(name); } catch (e) { continue; }
    if (!base || !base.exists || !base.otherFormes) continue;

    for (const formeName of base.otherFormes) {
      let forme;
      try { forme = Dex.species.get(formeName); } catch (e) { continue; }
      if (!forme || !forme.battleOnly || !forme.requiredItem) continue;

      const itemIdx = S.i.indexOf(forme.requiredItem);
      if (itemIdx < 0) continue;

      const moved = [];
      for (const [key, count] of [...S.rows]) {
        if (+key.split('/')[1] !== itemIdx) continue;
        moved.push([key, count]);
        S.rows.delete(key);
      }
      if (!moved.length) continue;

      species[forme.name] = compact(S, moved);
      // The leftovers must be compacted too. The fingerprint is taken over the
      // entry's move list, so a base forme still carrying the split-off forme's
      // moves (Zacian with Behemoth Blade) fails the runtime freshness check
      // and silently loses the joint model — the exact bug the split fixes.
      const rest = [...S.rows];
      const C = compact(S, rest);
      S.m = C.m; S.i = C.i; S.a = C.a; S.t = C.t; S.r = C.r; S.rows = C.rows;

      console.log(`  split ${name} -> ${forme.name} (${moved.length} sets, ${forme.requiredItem})`);
    }
    if (!S.rows.size) delete species[name];
  }

  const out = { format, teams, mons, generated: new Date().toISOString(), species: {} };
  let rowCount = 0, singletons = 0;

  for (const [name, S] of Object.entries(species)) {
    const rows = [];
    for (const [key, count] of S.rows) {
      const [mv, it, ab, te, ro] = key.split('/');
      // row = [ moveIndexes, itemIdx, abilityIdx, teraIdx, roleIdx, count ]
      rows.push([mv.split('.').map(Number), +it, +ab, +te, +ro, count]);
      rowCount++;
      if (count === 1) singletons++;
    }
    rows.sort((a, b) => b[5] - a[5]);
    out.species[name] = {
      lv: S.lv, m: S.m, i: S.i, a: S.a, t: S.t, r: S.r,
      fp: fingerprint(S.m),
      n: rows.reduce((a, r) => a + r[5], 0),
      rows: rows
    };
  }

  const json = JSON.stringify(out);
  const file = path.join(OUT_DIR, `joint-${format}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, json);

  const gz = zlib.gzipSync(Buffer.from(json)).length;
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  ${mons} Pokemon, ${Object.keys(out.species).length} species, ${rowCount} distinct sets`);
  console.log(`  ${singletons} seen once (${(100 * singletons / rowCount).toFixed(1)}% undersampled)`);
  console.log(`  ${(json.length / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gzipped -> ${path.relative(process.cwd(), file)}`);
  return { format, bytes: json.length, gz };
}

const built = FORMATS.map(build).filter(Boolean);
const totalGz = built.reduce((a, b) => a + b.gz, 0);
const totalRaw = built.reduce((a, b) => a + b.bytes, 0);
console.log(`\n${built.length} format(s): ${(totalRaw / 1024 / 1024).toFixed(2)} MB raw, ${(totalGz / 1024).toFixed(0)} KB gzipped total`);
