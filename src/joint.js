/*
 * Randbats Live — joint set model.
 *
 * engine.js reconstructs a distribution over MOVES from the published marginals.
 * That part is well calibrated, but it has to assume the item, ability and Tera
 * type are independent of the moves once the role is known — and they aren't.
 * Showdown's generator picks the item *from* the chosen moves, so:
 *
 *     Terapagos + Rest       -> Chesto Berry, always      (marginal model: 54%)
 *     Volcanion + Flame Charge -> Assault Vest, always    (marginal model: 35%)
 *     Bruxish + Swords Dance -> Life Orb, always          (marginal model: 26%)
 *
 * Across 42,000 generated Pokemon a single revealed move moves the item
 * distribution by 22 percentage points on average, and up to 74. No amount of
 * cleverness recovers that from marginals — the information isn't in them.
 *
 * So this module uses the joint distribution sampled directly from Showdown's
 * own generator (see scripts/build-joint.js). Prediction becomes simple and
 * exact: keep the observed sets consistent with what's been revealed, weight by
 * how often each occurred, and read the answers off.
 *
 * engine.js remains the fallback for anything the table doesn't cover — an
 * unlisted species, a format with no table, or a species whose published sets
 * have changed since the table was built.
 *
 * Pure: no DOM, no network.
 */
(function (root) {
  'use strict';

  var tables = {};       // format -> parsed table

  function id(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  /** Must match fingerprint() in scripts/build-joint.js. */
  function fingerprint(moveNames) {
    var s = moveNames.slice().sort().join('|');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function register(format, table) {
    if (!table || !table.species) return false;
    var index = {};
    Object.keys(table.species).forEach(function (k) { index[id(k)] = k; });
    tables[format] = { table: table, index: index };
    return true;
  }

  function lookup(format, species) {
    var t = tables[format];
    if (!t) return null;
    var s = t.table.species;
    if (s[species]) return { key: species, entry: s[species] };
    var byId = t.index[id(species)];
    if (byId) return { key: byId, entry: s[byId] };
    var base = t.index[id(String(species).split('-')[0])];
    if (base) return { key: base, entry: s[base] };
    return null;
  }

  /**
   * The published stats are refreshed hourly; our table is a snapshot. If a
   * species' move pool has changed since the table was built, its joint rows
   * are stale — fall back rather than serve wrong numbers.
   */
  function isFresh(entry, statsEntry) {
    if (!statsEntry) return true;                 // nothing to compare against
    var names = {};
    var roles = statsEntry.roles || { _: statsEntry };
    Object.keys(roles).forEach(function (rn) {
      Object.keys(roles[rn].moves || {}).forEach(function (m) { names[m] = 1; });
    });
    var live = Object.keys(names);
    if (!live.length) return true;
    return fingerprint(live) === entry.fp;
  }

  function pct(map, total) {
    var out = [];
    Object.keys(map).forEach(function (k) { out.push({ name: k, prob: map[k] / total }); });
    return out;
  }

  /**
   * @param format   e.g. 'gen9randombattle'
   * @param species  speciesForme as the client reports it
   * @param obs      { moves:[], item, ability, teraType }
   * @param statsEntry the live marginal entry, used only for the freshness check
   * @returns a prediction in the same shape engine.predict() returns, or null
   *          if this species isn't covered (caller should fall back).
   */
  function predict(format, species, obs, statsEntry) {
    var found = lookup(format, species);
    if (!found) return null;
    var e = found.entry;
    if (!isFresh(e, statsEntry)) return null;

    obs = obs || {};
    var notes = [];

    var moveIdx = {};
    e.m.forEach(function (name, i) { moveIdx[name] = i; });

    // Revealed moves the table has never seen for this species: off-model
    // (a called move, a forme quirk). Report and ignore, as engine.js does.
    var wanted = [], unknown = [];
    (obs.moves || []).forEach(function (m) {
      if (moveIdx[m] === undefined) unknown.push(m); else wanted.push(moveIdx[m]);
    });
    if (unknown.length) notes.push('Not in any known set: ' + unknown.join(', '));

    var itemIdx = obs.item ? e.i.indexOf(obs.item) : -1;
    var abilIdx = obs.ability ? e.a.indexOf(obs.ability) : -1;
    var teraIdx = obs.teraType ? e.t.indexOf(obs.teraType) : -1;

    // Same graceful degradation as the marginal model: if an observation
    // matches nothing, drop the fewest of them that restores a consistent set.
    var DROP_ITEM = 1, DROP_ABILITY = 2, DROP_TERA = 4;
    var masks = [0, 1, 2, 4, 3, 5, 6, 7];
    var rows = null, usedMask = 0;

    for (var mi = 0; mi < masks.length; mi++) {
      var mask = masks[mi];
      var wantItem = (mask & DROP_ITEM) ? -1 : itemIdx;
      var wantAbil = (mask & DROP_ABILITY) ? -1 : abilIdx;
      var wantTera = (mask & DROP_TERA) ? -1 : teraIdx;
      if (obs.item && itemIdx < 0 && !(mask & DROP_ITEM)) continue;
      if (obs.ability && abilIdx < 0 && !(mask & DROP_ABILITY)) continue;
      if (obs.teraType && teraIdx < 0 && !(mask & DROP_TERA)) continue;

      var keep = e.rows.filter(function (r) {
        for (var i = 0; i < wanted.length; i++) if (r[0].indexOf(wanted[i]) < 0) return false;
        if (wantItem >= 0 && r[1] !== wantItem) return false;
        if (wantAbil >= 0 && r[2] !== wantAbil) return false;
        if (wantTera >= 0 && r[3] !== wantTera) return false;
        return true;
      });
      if (keep.length) { rows = keep; usedMask = mask; break; }
    }

    if (!rows) return null;      // even the moves alone are inconsistent — fall back

    if ((usedMask & DROP_ITEM) && obs.item) notes.push('Item ' + obs.item + ' matches no known set — ignored.');
    if ((usedMask & DROP_ABILITY) && obs.ability) notes.push('Ability ' + obs.ability + ' matches no known set — ignored.');
    if ((usedMask & DROP_TERA) && obs.teraType) notes.push('Tera ' + obs.teraType + ' matches no known set — ignored.');

    // ---- marginalise over the surviving sets -------------------------
    var total = 0, moveHits = {}, itemHits = {}, abilHits = {}, teraHits = {}, roleHits = {};
    var slots = 0;

    rows.forEach(function (r) {
      var c = r[5];
      total += c;
      if (r[0].length > slots) slots = r[0].length;
      r[0].forEach(function (m) { moveHits[m] = (moveHits[m] || 0) + c; });
      if (r[1] >= 0) itemHits[r[1]] = (itemHits[r[1]] || 0) + c;
      if (r[2] >= 0) abilHits[r[2]] = (abilHits[r[2]] || 0) + c;
      if (r[3] >= 0) teraHits[r[3]] = (teraHits[r[3]] || 0) + c;
      if (r[4] >= 0) roleHits[r[4]] = (roleHits[r[4]] || 0) + c;
    });

    var obsSet = {};
    (obs.moves || []).forEach(function (m) { obsSet[m] = 1; });

    var moves = Object.keys(moveHits).map(function (i) {
      return { name: e.m[i], prob: moveHits[i] / total, revealed: !!obsSet[e.m[i]] };
    });
    (obs.moves || []).forEach(function (m) {
      if (!moves.some(function (x) { return x.name === m; })) moves.push({ name: m, prob: 1, revealed: true });
    });
    moves.sort(function (a, b) {
      if (a.revealed !== b.revealed) return a.revealed ? -1 : 1;
      return b.prob - a.prob || a.name.localeCompare(b.name);
    });

    function named(hits, names, observed) {
      var arr = Object.keys(hits).map(function (i) {
        return { name: names[i], prob: hits[i] / total, revealed: observed === names[i] };
      });
      if (observed) {
        if (!arr.some(function (x) { return x.name === observed; })) arr.push({ name: observed, prob: 1, revealed: true });
        arr.forEach(function (x) { x.prob = x.revealed ? 1 : 0; });
      }
      return arr.sort(function (a, b) { return b.prob - a.prob || a.name.localeCompare(b.name); })
        .filter(function (x) { return x.prob > 0.0005 || x.revealed; });
    }

    var roles = Object.keys(roleHits).map(function (i) {
      return { name: (e.r && e.r[i]) || 'Standard', prob: roleHits[i] / total };
    }).sort(function (a, b) { return b.prob - a.prob; });

    return {
      source: 'joint',
      level: e.lv,
      slotsTotal: slots || 4,
      slotsKnown: Math.min((obs.moves || []).length, slots || 4),
      roles: roles,
      rolesTotal: (e.r && e.r.length) || 1,
      moves: moves,
      items: named(itemHits, e.i, obs.item),
      abilities: named(abilHits, e.a, obs.ability),
      teraTypes: named(teraHits, e.t, obs.teraType),
      evs: null, ivs: null,
      matchedSets: rows.length,
      sampleSize: total,
      notes: notes
    };
  }

  // -------------------------------------------------------------------
  // Shrinkage
  //
  // The joint table is an empirical sample, so a narrow slice — three moves
  // revealed, only a handful of matching sets — gives noisy estimates and, worse,
  // hard zeros for combinations that simply never came up while sampling. A hard
  // zero that turns out to be wrong is catastrophic under log loss.
  //
  // So we shrink the empirical estimate toward the marginal model, which is
  // smooth and never assigns a spurious zero:
  //
  //     p = (n * p_joint + k * p_marginal) / (n + k)
  //
  // k is a pseudo-count: a slice backed by many samples keeps its own estimate,
  // a thin one leans on the prior. This is a Dirichlet prior centred on the
  // marginal model rather than on uniform, which is the right prior here because
  // the marginal model is already well calibrated on its own.
  //
  // k was tuned on held-out generated teams (see test/joint.test.js).
  // -------------------------------------------------------------------

  // Tuned on held-out teams: the curve is flat between 0 and ~12, so we keep a
  // small non-zero value. It costs ~0.0003 log loss versus the raw optimum and
  // buys protection against combinations the sample never happened to produce.
  var PSEUDO = 6;

  function blendList(jointList, priorList, weight) {
    var prior = {};
    (priorList || []).forEach(function (p) { prior[p.name] = p.prob; });
    var seen = {};
    var out = [];

    (jointList || []).forEach(function (j) {
      seen[j.name] = 1;
      if (j.revealed) { out.push(j); return; }
      var pm = prior[j.name] || 0;
      out.push({ name: j.name, prob: weight * j.prob + (1 - weight) * pm, revealed: false });
    });

    // Options the joint sample never produced but the marginal model still
    // allows — exactly the hard zeros we need to soften.
    (priorList || []).forEach(function (p) {
      if (seen[p.name] || p.revealed) return;
      out.push({ name: p.name, prob: (1 - weight) * p.prob, revealed: false });
    });

    return out.filter(function (x) { return x.prob > 0.0005 || x.revealed; })
      .sort(function (a, b) {
        if (a.revealed !== b.revealed) return a.revealed ? -1 : 1;
        return b.prob - a.prob || a.name.localeCompare(b.name);
      });
  }

  /**
   * Blend a joint prediction with the marginal one. Returns a prediction in the
   * same shape. `pseudo` overrides the tuned pseudo-count (used by the tests).
   */
  function blend(jointPred, priorPred, pseudo) {
    if (!jointPred) return priorPred;
    if (!priorPred) return jointPred;
    var k = (typeof pseudo === 'number') ? pseudo : PSEUDO;
    var n = jointPred.sampleSize || 0;
    var w = n / (n + k);

    return {
      source: 'joint+prior',
      level: jointPred.level || priorPred.level,
      slotsTotal: jointPred.slotsTotal,
      slotsKnown: jointPred.slotsKnown,
      roles: blendList(jointPred.roles.map(function (r) { return { name: r.name, prob: r.prob }; }),
        priorPred.roles, w).map(function (r) { return { name: r.name, prob: r.prob }; }),
      rolesTotal: jointPred.rolesTotal || priorPred.rolesTotal || 1,
      moves: blendList(jointPred.moves, priorPred.moves, w),
      items: blendList(jointPred.items, priorPred.items, w),
      abilities: blendList(jointPred.abilities, priorPred.abilities, w),
      teraTypes: blendList(jointPred.teraTypes, priorPred.teraTypes, w),
      evs: priorPred.evs, ivs: priorPred.ivs,
      matchedSets: jointPred.matchedSets,
      sampleSize: n,
      shrinkWeight: w,
      notes: jointPred.notes && jointPred.notes.length ? jointPred.notes : priorPred.notes
    };
  }

  root.RBLJoint = {
    register: register,
    predict: predict,
    blend: blend,
    PSEUDO: PSEUDO,
    lookup: lookup,
    fingerprint: fingerprint,
    has: function (format) { return !!tables[format]; },
    stats: function (format) {
      var t = tables[format];
      if (!t) return null;
      return { format: format, species: Object.keys(t.table.species).length, teams: t.table.teams, generated: t.table.generated };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
