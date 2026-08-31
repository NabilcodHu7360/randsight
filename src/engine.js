/*
 * Randbats Live — inference engine
 *
 * Models a Random Battle set as a Conditional Bernoulli (CB) sample:
 *
 *   A role r is drawn with prior weight w_r (from randbats stats "weight").
 *   Given r, exactly k moves are drawn from that role's pool without
 *   replacement, with P(S) proportional to prod_{m in S} theta_m, where the
 *   theta_m are calibrated so that the marginal inclusion probability of each
 *   move matches the observed frequency pi_m published in the stats file.
 *   (Those frequencies sum to exactly k, which is what makes this well posed.)
 *
 * Everything downstream is then exact, not sampled:
 *
 *   P(O subset of S) and P(m in S | O subset of S) are ratios of elementary
 *   symmetric polynomials of theta, computed by DP. Pools are tiny (n <= ~14,
 *   k <= 4) so this costs nothing.
 *
 *   Role posterior: P(r | O) proportional to w_r * P(O | r), with the move,
 *   item, ability and tera observations all multiplying into P(O | r).
 *
 * No network, no DOM, no globals other than the export. Pure and testable.
 */
(function (root) {
  'use strict';

  var LOCKED = 0.999;   // treat pi >= this as a guaranteed slot
  var EPS = 1e-12;

  // ---------------------------------------------------------------------
  // Elementary symmetric polynomials
  // ---------------------------------------------------------------------

  /** e[j] = sum over all j-subsets of `w` of the product of their entries. */
  function esp(w, kmax) {
    var e = new Array(kmax + 1).fill(0);
    e[0] = 1;
    for (var i = 0; i < w.length; i++) {
      var hi = Math.min(kmax, i + 1);
      for (var j = hi; j >= 1; j--) e[j] += e[j - 1] * w[i];
    }
    return e;
  }

  /** esp of `w` with the indices in `skip` (a Set) removed. */
  function espSkip(w, kmax, skip) {
    var e = new Array(kmax + 1).fill(0);
    e[0] = 1;
    for (var i = 0; i < w.length; i++) {
      if (skip.has(i)) continue;
      var hi = Math.min(kmax, i + 1);
      for (var j = hi; j >= 1; j--) e[j] += e[j - 1] * w[i];
    }
    return e;
  }

  /**
   * Calibrate CB weights so the size-k sample reproduces the target marginal
   * inclusion probabilities. Iterative proportional fitting on the odds.
   */
  function calibrate(pis, k) {
    var n = pis.length;
    if (n === 0 || k <= 0 || k >= n) return pis.map(function () { return 1; });

    var w = pis.map(function (p) {
      var c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
      return c / (1 - c);
    });

    for (var iter = 0; iter < 200; iter++) {
      var e = esp(w, k);
      if (!(e[k] > EPS)) break;
      var worst = 0;
      for (var i = 0; i < n; i++) {
        var skip = new Set([i]);
        var eMinus = espSkip(w, k, skip);
        var marg = (w[i] * eMinus[k - 1]) / e[k];
        var err = Math.abs(marg - pis[i]);
        if (err > worst) worst = err;
        if (marg > EPS) w[i] *= pis[i] / marg;
      }
      if (worst < 1e-10) break;
    }
    return w;
  }

  // ---------------------------------------------------------------------
  // Model construction
  // ---------------------------------------------------------------------

  function normalizeDist(obj) {
    var out = {}, total = 0, kk;
    if (!obj) return out;
    for (kk in obj) if (Object.prototype.hasOwnProperty.call(obj, kk)) total += obj[kk];
    if (!(total > 0)) return out;
    for (kk in obj) if (Object.prototype.hasOwnProperty.call(obj, kk)) out[kk] = obj[kk] / total;
    return out;
  }

  /**
   * Turn one role's raw stats blob into a solved CB model.
   * Moves with pi ~ 1 are pulled out as guaranteed slots, which both speeds
   * things up and avoids the numerical mess of odds -> infinity.
   */
  function buildRole(name, raw, fallbackWeight) {
    var moves = raw.moves || {};
    var locked = [], freeNames = [], freePis = [];
    var totalPi = 0, m;

    for (m in moves) {
      if (!Object.prototype.hasOwnProperty.call(moves, m)) continue;
      var p = moves[m];
      totalPi += p;
      if (p >= LOCKED) locked.push(m);
      else { freeNames.push(m); freePis.push(p); }
    }

    var k = Math.round(totalPi);                 // moves per set (normally 4)
    if (!(k > 0)) k = Math.min(4, locked.length + freeNames.length);
    var kFree = k - locked.length;
    if (kFree < 0) kFree = 0;

    // Renormalize the free marginals to sum to exactly kFree (guards against
    // rounding in the published frequencies).
    var freeSum = freePis.reduce(function (a, b) { return a + b; }, 0);
    if (freeSum > EPS && kFree > 0) {
      var scale = kFree / freeSum;
      freePis = freePis.map(function (p) { return Math.min(p * scale, 1 - 1e-6); });
    }

    return {
      name: name,
      weight: typeof raw.weight === 'number' ? raw.weight : fallbackWeight,
      k: k,
      locked: locked,
      freeNames: freeNames,
      freePis: freePis,
      theta: calibrate(freePis, kFree),
      kFree: kFree,
      poolSet: new Set(locked.concat(freeNames)),
      items: normalizeDist(raw.items),
      abilities: normalizeDist(raw.abilities),
      teraTypes: normalizeDist(raw.teraTypes),
      evs: raw.evs || null,
      ivs: raw.ivs || null
    };
  }

  /**
   * Build the full species model. Handles both stats shapes:
   *   - gen8/gen9 style, with a `roles` object
   *   - gen1-7 / bdsp / letsgo style, flat, which we treat as one role.
   */
  function buildSpecies(entry) {
    if (!entry) return null;
    var roles = [];
    if (entry.roles && Object.keys(entry.roles).length) {
      var names = Object.keys(entry.roles);
      for (var i = 0; i < names.length; i++) {
        roles.push(buildRole(names[i], entry.roles[names[i]], 1 / names.length));
      }
    } else {
      roles.push(buildRole('Standard', {
        weight: 1,
        moves: entry.moves,
        items: entry.items,
        abilities: entry.abilities,
        teraTypes: entry.teraTypes,
        evs: entry.evs,
        ivs: entry.ivs
      }, 1));
    }

    var wsum = roles.reduce(function (a, r) { return a + r.weight; }, 0);
    if (wsum > 0) roles.forEach(function (r) { r.weight /= wsum; });

    return {
      level: entry.level || 100,
      roles: roles,
      evs: entry.evs || null,
      ivs: entry.ivs || null,
      hasTera: roles.some(function (r) { return Object.keys(r.teraTypes).length > 0; }),
      hasItems: roles.some(function (r) { return Object.keys(r.items).length > 0; }),
      hasAbilities: roles.some(function (r) { return Object.keys(r.abilities).length > 0; })
    };
  }

  // ---------------------------------------------------------------------
  // Conditional queries within one role
  // ---------------------------------------------------------------------

  /** P(observed free moves all present) for this role, and the conditional
   *  inclusion probability of every other free move given that. */
  function roleMoveInference(role, observedFree) {
    var idx = {}, i;
    for (i = 0; i < role.freeNames.length; i++) idx[role.freeNames[i]] = i;

    var obsIdx = [];
    for (i = 0; i < observedFree.length; i++) {
      var j = idx[observedFree[i]];
      if (j === undefined) return { likelihood: 0, cond: {} };
      obsIdx.push(j);
    }

    var need = role.kFree - obsIdx.length;   // free slots still open
    if (need < 0) return { likelihood: 0, cond: {} };

    var obsSet = new Set(obsIdx);
    var w = role.theta;
    var full = esp(w, role.kFree);
    var denomAll = full[role.kFree];
    if (!(denomAll > EPS)) return { likelihood: obsIdx.length === 0 ? 1 : 0, cond: {} };

    var eMinusObs = espSkip(w, role.kFree, obsSet);
    var prodObs = 1;
    for (i = 0; i < obsIdx.length; i++) prodObs *= w[obsIdx[i]];

    var likelihood = (prodObs * (eMinusObs[need] || 0)) / denomAll;

    // P(move m also in the set | observed moves in the set)
    var cond = {};
    var base = eMinusObs[need] || 0;
    for (i = 0; i < role.freeNames.length; i++) {
      var nm = role.freeNames[i];
      if (obsSet.has(i)) { cond[nm] = 1; continue; }
      if (need <= 0 || !(base > EPS)) { cond[nm] = 0; continue; }
      var skip = new Set(obsSet); skip.add(i);
      var eMinusBoth = espSkip(w, role.kFree, skip);
      cond[nm] = (w[i] * (eMinusBoth[need - 1] || 0)) / base;
    }
    return { likelihood: likelihood, cond: cond };
  }

  // ---------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------

  /**
   * @param {object} model     from buildSpecies()
   * @param {object} obs       { moves:[], item:string|null, ability:string|null,
   *                             teraType:string|null }
   * @returns prediction bundle for the UI
   */
  function predict(model, obs) {
    obs = obs || {};
    var obsMoves = (obs.moves || []).slice();
    var notes = [];

    // Any revealed move that appears in no role at all is off-model (called
    // moves, Copycat, transform, a stale data file). Flag it, don't let it
    // zero out every hypothesis.
    var known = [], unknownMoves = [];
    obsMoves.forEach(function (m) {
      var inSome = model.roles.some(function (r) { return r.poolSet.has(m); });
      if (inSome) known.push(m); else unknownMoves.push(m);
    });
    if (unknownMoves.length) {
      notes.push('Not in any known set: ' + unknownMoves.join(', '));
    }

    /** Score every role against a given bundle of evidence. */
    function scoreWith(item, ability, teraType) {
      var rows = model.roles.map(function (role) {
        var lockedSet = new Set(role.locked);
        var freeObs = [], ok = true;
        known.forEach(function (m) {
          if (lockedSet.has(m)) return;
          if (!role.poolSet.has(m)) { ok = false; return; }
          freeObs.push(m);
        });
        if (!ok) return { role: role, post: 0, cond: {}, lockedSet: lockedSet };

        var inf = roleMoveInference(role, freeObs);
        var lik = inf.likelihood;

        if (item && role.items && Object.keys(role.items).length) {
          lik *= (role.items[item] || 0);
        }
        if (ability && role.abilities && Object.keys(role.abilities).length) {
          lik *= (role.abilities[ability] || 0);
        }
        if (teraType && role.teraTypes && Object.keys(role.teraTypes).length) {
          lik *= (role.teraTypes[teraType] || 0);
        }

        return { role: role, post: role.weight * lik, cond: inf.cond, lockedSet: lockedSet };
      });
      var t = rows.reduce(function (a, x) { return a + x.post; }, 0);
      return { rows: rows, total: t };
    }

    // A single impossible observation (a forme the data doesn't cover, a
    // knocked-off item we mis-attributed, stale set data) shouldn't wipe out
    // everything else we know. Drop the fewest observations that restore a
    // consistent hypothesis, and say which ones we ignored.
    var DROP_ITEM = 1, DROP_ABILITY = 2, DROP_TERA = 4;
    var masks = [0, 1, 2, 4, 3, 5, 6, 7];
    var per = null, total = 0, usedMask = 0;
    for (var mi = 0; mi < masks.length; mi++) {
      var mask = masks[mi];
      var s = scoreWith(
        (mask & DROP_ITEM) ? null : obs.item,
        (mask & DROP_ABILITY) ? null : obs.ability,
        (mask & DROP_TERA) ? null : obs.teraType
      );
      if (s.total > EPS) { per = s.rows; total = s.total; usedMask = mask; break; }
    }

    var ignored = { item: false, ability: false, tera: false };
    if (per) {
      if ((usedMask & DROP_ITEM) && obs.item) { ignored.item = true; notes.push('Item ' + obs.item + ' matches no known set — ignored.'); }
      if ((usedMask & DROP_ABILITY) && obs.ability) { ignored.ability = true; notes.push('Ability ' + obs.ability + ' matches no known set — ignored.'); }
      if ((usedMask & DROP_TERA) && obs.teraType) { ignored.tera = true; notes.push('Tera ' + obs.teraType + ' matches no known set — ignored.'); }
    } else {
      // The revealed moves themselves are mutually inconsistent.
      notes.push('Revealed moves match no known set — showing priors. The set data may be out of date.');
      var fb = scoreWith(null, null, null);
      per = fb.rows;
      per.forEach(function (x) { x.post = x.role.weight; });
      total = per.reduce(function (a, y) { return a + y.post; }, 0) || 1;
      ignored = { item: !!obs.item, ability: !!obs.ability, tera: !!obs.teraType };
    }
    per.forEach(function (x) { x.post /= total; });

    // ---- aggregate move probabilities -------------------------------
    var obsSetAll = new Set(obsMoves);
    var moveProb = {};
    per.forEach(function (x) {
      if (x.post <= 0) return;
      x.role.locked.forEach(function (m) {
        moveProb[m] = (moveProb[m] || 0) + x.post;
      });
      x.role.freeNames.forEach(function (m) {
        var p = x.cond[m];
        if (p === undefined) p = 0;
        moveProb[m] = (moveProb[m] || 0) + x.post * p;
      });
    });
    obsMoves.forEach(function (m) { moveProb[m] = 1; });

    var moves = Object.keys(moveProb).map(function (m) {
      return { name: m, prob: Math.min(moveProb[m], 1), revealed: obsSetAll.has(m) };
    }).sort(function (a, b) {
      if (a.revealed !== b.revealed) return a.revealed ? -1 : 1;
      return b.prob - a.prob || a.name.localeCompare(b.name);
    });

    // ---- items / abilities / tera -----------------------------------
    function mix(field, observed) {
      var acc = {};
      per.forEach(function (x) {
        if (x.post <= 0) return;
        var d = x.role[field];
        for (var kk in d) {
          if (Object.prototype.hasOwnProperty.call(d, kk)) acc[kk] = (acc[kk] || 0) + x.post * d[kk];
        }
      });
      var arr = Object.keys(acc).map(function (kk) {
        return { name: kk, prob: acc[kk], revealed: observed === kk };
      });
      if (observed && !acc[observed]) arr.push({ name: observed, prob: 1, revealed: true });
      if (observed) arr.forEach(function (e) { e.prob = e.revealed ? 1 : 0; });
      return arr.sort(function (a, b) { return b.prob - a.prob || a.name.localeCompare(b.name); })
        .filter(function (e) { return e.prob > 0.0005 || e.revealed; });
    }

    var slots = model.roles.length ? model.roles[0].k : 4;
    per.forEach(function (x) { if (x.post > 0) slots = Math.max(slots, x.role.k); });

    return {
      level: model.level,
      slotsTotal: slots,
      slotsKnown: Math.min(obsMoves.length, slots),
      roles: per.map(function (x) { return { name: x.role.name, prob: x.post }; })
        .sort(function (a, b) { return b.prob - a.prob; }),
      // How many roles this species has at all — the UI hides the Role section
      // for species that never had a choice, but must still show it when a
      // genuine choice has been narrowed down to one.
      rolesTotal: model.roles.length,
      moves: moves,
      items: model.hasItems ? mix('items', obs.item) : [],
      abilities: model.hasAbilities ? mix('abilities', obs.ability) : [],
      teraTypes: model.hasTera ? mix('teraTypes', obs.teraType) : [],
      evs: model.evs,
      ivs: model.ivs,
      notes: notes
    };
  }

  // ---------------------------------------------------------------------
  // Speed helper (gen 3+ formula; randbats default to 85 EVs / 31 IVs and a
  // neutral nature unless the set data overrides them)
  // ---------------------------------------------------------------------

  function speedStat(baseSpe, level, evs, ivs) {
    if (!baseSpe || !level) return null;
    var ev = (evs && typeof evs.spe === 'number') ? evs.spe : 85;
    var iv = (ivs && typeof ivs.spe === 'number') ? ivs.spe : 31;
    return Math.floor((Math.floor(((2 * baseSpe + iv + Math.floor(ev / 4)) * level) / 100) + 5));
  }

  root.RBLEngine = {
    buildSpecies: buildSpecies,
    predict: predict,
    speedStat: speedStat,
    _internal: { calibrate: calibrate, esp: esp, espSkip: espSkip, roleMoveInference: roleMoveInference }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
