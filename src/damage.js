/*
 * Randbats Live — damage adapter.
 *
 * A thin layer over the vendored @smogon/calc. We do NOT reimplement the
 * damage formula; that library is the reference implementation and getting
 * Gen 9 mechanics right by hand is a losing game.
 *
 * The only interesting part is what we feed it. Random Battle sets use a fixed
 * spread — 85 EVs and 31 IVs in every stat, neutral nature — with per-stat
 * overrides carried in the set data. (Verified against Pokemon Showdown's own
 * generator: data/random-battles/gen9/teams.ts sets `evs = {hp:85,...}` and
 * returns no `nature` field, so the server defaults it to Serious. @smogon/calc
 * defaults to Serious too, so the two line up.)
 *
 * For the opponent we only have a probability distribution over sets. We do not
 * collapse it: damage is marginalised over the joint posterior of their item
 * and their ability, capped at a fixed number of calc runs, and we report both
 * what we assumed and how far the answer moves across those variants.
 */
(function (root) {
  'use strict';

  var DEFAULT_EV = 85;
  var DEFAULT_IV = 31;

  // Showdown's weather/terrain ids -> the names @smogon/calc expects.
  var WEATHER = {
    sunnyday: 'Sun', desolateland: 'Harsh Sunshine',
    raindance: 'Rain', primordialsea: 'Heavy Rain',
    sandstorm: 'Sand', snowscape: 'Snow', snow: 'Snow', hail: 'Hail',
    deltastream: 'Strong Winds'
  };
  var TERRAIN = {
    electricterrain: 'Electric', grassyterrain: 'Grassy',
    psychicterrain: 'Psychic', mistyterrain: 'Misty'
  };

  function lib() { return root.RBLCalcLib || null; }

  /** Merge a set's per-stat overrides onto the Random Battle default spread. */
  function spread(overrides, fallback) {
    var out = { hp: fallback, atk: fallback, def: fallback, spa: fallback, spd: fallback, spe: fallback };
    if (overrides) {
      Object.keys(overrides).forEach(function (k) {
        if (typeof overrides[k] === 'number') out[k] = overrides[k];
      });
    }
    return out;
  }

  function buildField(gen, field, gameType) {
    var L = lib();
    if (!L) return undefined;
    var f = field || {};
    var opts = {
      gameType: gameType === 'doubles' ? 'Doubles' : 'Singles',
      weather: WEATHER[String(f.weather || '').toLowerCase()] || undefined,
      terrain: TERRAIN[String(f.terrain || '').toLowerCase()] || undefined,
      isGravity: false
    };
    function side(s) {
      s = s || {};
      return new L.Side({
        isReflect: !!s.reflect,
        isLightScreen: !!s.lightscreen,
        isAuroraVeil: !!s.auroraveil,
        isTailwind: !!s.tailwind
      });
    }
    // "attacker" / "defender" are assigned per calculation below.
    return { opts: opts, nearSide: side(f.near), farSide: side(f.far) };
  }

  /**
   * @param spec {species, level, evs, ivs, item, ability, boosts, teraType,
   *              curHP, maxHP, stats}
   */
  function makePokemon(gen, spec) {
    var L = lib();
    var opts = {
      level: spec.level || 100,
      evs: spread(spec.evs, DEFAULT_EV),
      ivs: spread(spec.ivs, DEFAULT_IV),
      boosts: spec.boosts || {}
    };
    if (spec.item) opts.item = spec.item;
    if (spec.ability) opts.ability = spec.ability;
    if (spec.teraType) opts.teraType = spec.teraType;
    if (spec.curHP && spec.maxHP) {
      // battle HP is reported as a percentage in Random Battles
      opts.curHP = undefined;
    }
    return new L.Pokemon(gen, spec.species, opts);
  }

  function pctOf(dmgArray, maxHP) {
    var lo = Array.isArray(dmgArray) ? dmgArray[0] : dmgArray;
    var hi = Array.isArray(dmgArray) ? dmgArray[dmgArray.length - 1] : dmgArray;
    if (Array.isArray(lo)) lo = lo[0];
    if (Array.isArray(hi)) hi = hi[hi.length - 1];
    return { lo: (lo / maxHP) * 100, hi: (hi / maxHP) * 100 };
  }

  /**
   * One attacker move against one defender.
   * Returns null for moves that deal no damage (status moves, failures).
   */
  function calcMove(gen, attacker, defender, moveName, fieldParts, attackerIsNear) {
    var L = lib();
    if (!L) return null;
    try {
      // Note: @smogon/calc's Move has no `exists` flag and names its power
      // field `bp`, not `basePower`. An unrecognised name throws, which the
      // catch below turns into "no row". Status moves survive construction but
      // deal no damage, so they drop out on the zero-damage check further down.
      var move = new L.Move(gen, moveName);
      if (!move || !move.name) return null;
      if (move.category === 'Status') return null;

      var field = new L.Field(Object.assign({}, fieldParts.opts, {
        attackerSide: attackerIsNear ? fieldParts.nearSide : fieldParts.farSide,
        defenderSide: attackerIsNear ? fieldParts.farSide : fieldParts.nearSide
      }));

      var res = L.calculate(gen, attacker, defender, move, field);
      var dmg = res.damage;
      var total = Array.isArray(dmg)
        ? (Array.isArray(dmg[0]) ? dmg.reduce(function (a, d) { return a + d[d.length - 1]; }, 0) : dmg[dmg.length - 1])
        : dmg;

      // A damaging move that lands for nothing is an immunity (Fighting into a
      // Ghost, Ground into a Flier, Earthquake into Levitate). That's exactly
      // the thing a player needs told, so keep the row and label it.
      if (!total) {
        return {
          move: moveName, type: move.type, category: move.category,
          immune: true, loPct: 0, hiPct: 0, ko: 'no effect', desc: moveName + ' does not affect the target'
        };
      }

      var maxHP = defender.maxHP();
      var range = pctOf(dmg, maxHP);
      var desc = '';
      try { desc = res.desc(); } catch (e) { desc = ''; }

      // "-- 68.8% chance to OHKO" / "-- guaranteed 2HKO"
      var ko = '';
      var m = /--\s*(.+)$/.exec(desc);
      if (m) ko = m[1].trim();

      return {
        move: moveName,
        type: move.type,
        category: move.category,
        loPct: range.lo,
        hiPct: range.hi,
        ko: ko,
        desc: desc
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Keep the entries of a posterior worth calculating under.
   *
   * Shared by the item and the ability spread because the argument is the same
   * one in both cases: we hold a distribution, not a fact, and collapsing it to
   * its mode reports a single number with false confidence. Anything at or
   * above 3% is worth a calc; the rest is noise that only costs us time. What
   * survives is renormalised so the weights we later multiply together are a
   * real distribution over the variants we actually ran.
   *
   * A revealed value is a fact, so it collapses to exactly one variant.
   */
  function posteriorVariants(list, cap) {
    if (!list || !list.length) return [{ name: undefined, prob: 1, revealed: false }];
    var revealed = list.find(function (x) { return x.revealed; });
    if (revealed) return [{ name: revealed.name, prob: 1, revealed: true }];

    var sorted = list.slice().sort(function (a, b) { return b.prob - a.prob; })
      .filter(function (x) { return x.prob >= 0.03; })
      .slice(0, cap);
    if (!sorted.length) return [{ name: undefined, prob: 1, revealed: false }];

    var total = sorted.reduce(function (a, x) { return a + x.prob; }, 0) || 1;
    return sorted.map(function (x) { return { name: x.name, prob: x.prob / total, revealed: false }; });
  }

  /**
   * The plausible items, as a distribution rather than a single guess.
   *
   * Their item swings damage hard in both directions — Choice Band on offence,
   * Assault Vest on defence — and we only have a probability for it.
   */
  function itemVariants(items, cap) {
    return posteriorVariants(items, cap || 4);
  }

  /**
   * The plausible abilities, same treatment.
   *
   * Abilities move a damage number at least as hard as items do, and often
   * further: Thick Fat and Filter/Solid Rock cut a hit by a quarter to a half,
   * Multiscale halves it outright at full HP, Unaware throws away the boosts on
   * the sheet, Levitate turns a number into an immunity, and the
   * Protosynthesis/Quark Drive line is a 1.3x on whichever stat happens to
   * matter. A 55/45 ability split is ordinary in randbats, so picking the mode
   * and printing one number was the same mistake we already fixed for items.
   *
   * Three is the default cap rather than the item's four: randbats sets rarely
   * offer more than three abilities, and every extra one is a calc run.
   */
  function abilityVariants(abilities, cap) {
    return posteriorVariants(abilities, cap || 3);
  }

  // How many (item, ability) combinations we are willing to run a calc under.
  //
  // This whole path runs on every poll tick — twice a second, once per move,
  // on both sides — so the ceiling is a real budget and not a formality. Six
  // covers the shapes that actually occur intact: 2x2 and 3x2 are exact, and
  // a certain value on either axis costs nothing at all. Only a genuinely
  // wide-open 4x3 gets trimmed, and there the tail combinations are worth a
  // couple of percent each and move nothing.
  var MAX_JOINT_VARIANTS = 6;

  /**
   * The joint posterior over (item, ability), truncated to a fixed budget.
   *
   * Items and abilities are correlated through the role in the underlying set
   * data, but by the time the engine hands us marginals that structure is
   * already gone, so the product is the honest reconstruction available here.
   * We keep the highest-joint-probability combinations and renormalise over
   * what we kept, so the weights still sum to 1 over the calcs we ran.
   */
  function crossVariants(items, abilities, cap) {
    var limit = cap || MAX_JOINT_VARIANTS;
    // Fast path — the common case. Either both are known, or only one axis is
    // open, and there is no product to build, sort and throw away.
    if (items.length === 1 && abilities.length === 1) {
      return [{
        item: items[0].name, ability: abilities[0].name, prob: 1,
        itemRevealed: !!items[0].revealed, abilityRevealed: !!abilities[0].revealed
      }];
    }

    var out = [];
    for (var i = 0; i < items.length; i++) {
      for (var a = 0; a < abilities.length; a++) {
        out.push({
          item: items[i].name, ability: abilities[a].name,
          prob: items[i].prob * abilities[a].prob,
          itemRevealed: !!items[i].revealed, abilityRevealed: !!abilities[a].revealed
        });
      }
    }
    out.sort(function (x, y) { return y.prob - x.prob; });
    if (out.length > limit) out = out.slice(0, limit);

    var total = out.reduce(function (s, x) { return s + x.prob; }, 0) || 1;
    for (var k = 0; k < out.length; k++) out[k].prob = out[k].prob / total;
    return out;
  }

  /** "Assault Vest + Thick Fat" — how a variant is named back to the user. */
  function variantLabel(v) {
    if (!v) return undefined;
    var parts = [];
    if (v.item) parts.push(v.item);
    if (v.ability) parts.push(v.ability);
    return parts.length ? parts.join(' + ') : undefined;
  }

  /**
   * Run one move under every plausible (item, ability) combination and combine.
   * `variants` is a list of { pokemon, item, ability, prob } for the side whose
   * set is uncertain — always theirs.
   *
   * Kept under its old name because it is what the rest of the extension calls;
   * it now marginalises over both axes rather than the item alone.
   */
  function calcAcrossItems(gen, variants, other, moveName, fieldParts, foeAttacks) {
    var results = [];
    variants.forEach(function (v) {
      var r = foeAttacks
        ? calcMove(gen, v.pokemon, other, moveName, fieldParts, false)
        : calcMove(gen, other, v.pokemon, moveName, fieldParts, true);
      if (r) results.push({ r: r, prob: v.prob, item: v.item, ability: v.ability });
    });
    if (!results.length) return null;

    // Immune under every plausible set means immune, full stop.
    var live = results.filter(function (x) { return !x.r.immune; });
    if (!live.length) return results[0].r;

    var lo = Infinity, hi = -Infinity, expected = 0, worst = null;
    var hiMin = Infinity, hiMax = -Infinity;
    // Immune variants stay in the spread as a zero rather than being dropped.
    // A move that a 50%-likely Levitate blanks is the single most useful thing
    // the marker can flag, and zero is also the honest contribution to the
    // expectation the threat ranking uses.
    results.forEach(function (x) {
      var xHi = x.r.immune ? 0 : x.r.hiPct;
      if (xHi < hiMin) hiMin = xHi;
      if (xHi > hiMax) hiMax = xHi;
      expected += x.prob * xHi;
    });
    live.forEach(function (x) {
      if (x.r.loPct < lo) lo = x.r.loPct;
      if (x.r.hiPct > hi) { hi = x.r.hiPct; worst = x; }
    });

    var base = live[0].r;
    // The spread we care about is how much their SET moves the number — item or
    // ability, compared like with like across variants. `hi - lo` would instead
    // measure the damage roll, which is ~15% on every move, says nothing about
    // what we were uncertain of, and would put a marker on every row.
    var swing = results.length > 1 ? (hiMax - hiMin) : 0;
    return {
      move: base.move, type: base.type, category: base.category,
      loPct: lo, hiPct: hi, expected: expected,
      ko: (worst && worst.r.ko) || base.ko,
      desc: (worst && worst.r.desc) || base.desc,
      // Only worth mentioning when the choice actually changes the answer.
      // `item` carries the combined label so the existing marker text reads
      // right; `itemName` / `ability` are the pieces, split out.
      swing: swing > 8 ? {
        pct: swing,
        item: variantLabel(worst),
        itemName: worst && worst.item,
        ability: worst && worst.ability,
        prob: worst && worst.prob
      } : null,
      variants: results.length
    };
  }

  /**
   * Build the whole Damage tab view model.
   *
   * @param opts.gen        generation number
   * @param opts.gameType   'singles' | 'doubles'
   * @param opts.field      field state from the bridge
   * @param opts.mine       our active, from the bridge (exact set)
   * @param opts.foeVM      the opposing active's prediction view model
   * @param opts.foeRaw     the opposing active's raw battle state
   */
  function matchup(opts) {
    var L = lib();
    if (!L) return { available: false, reason: 'damage library not loaded' };
    if (!opts.mine || !opts.foeVM || !opts.foeRaw) {
      return { available: false, reason: 'waiting for both active Pokemon' };
    }

    var gen;
    try { gen = L.Generations.get(opts.gen || 9); } catch (e) { return { available: false, reason: 'unknown generation' }; }
    var fieldParts = buildField(gen, opts.field, opts.gameType);

    // --- the opponent, built once per plausible (item, ability) -------
    var itemVars = itemVariants(opts.foeVM.items);
    var abilityVars = abilityVariants(opts.foeVM.abilities);
    var combos = crossVariants(itemVars, abilityVars);
    var baseFoeSpec = {
      species: opts.foeRaw.species,
      level: opts.foeVM.level || opts.foeRaw.level,
      evs: opts.foeVM.evs, ivs: opts.foeVM.ivs,
      boosts: opts.foeRaw.boosts || {},
      teraType: opts.foeRaw.terastallized || undefined
    };

    var mineSpec = {
      species: opts.mine.species,
      level: opts.mine.level,
      evs: null, ivs: null,             // our own set uses the same default spread
      boosts: opts.mine.boosts || {},
      item: opts.mine.item || undefined,
      ability: opts.mine.ability || undefined,
      teraType: opts.mine.terastallized || undefined
    };

    var foeVariants, me;
    try {
      foeVariants = combos.map(function (v) {
        var spec = Object.assign({}, baseFoeSpec, { item: v.item, ability: v.ability });
        return { pokemon: makePokemon(gen, spec), item: v.item, ability: v.ability, prob: v.prob };
      });
      me = makePokemon(gen, mineSpec);
    } catch (e) {
      return { available: false, reason: 'could not build the matchup' };
    }
    // Representative, for speed/stat use. `combos` is sorted by joint
    // probability, so this is the single most likely set.
    var foe = foeVariants[0].pokemon;

    // Sanity check: the server told us our real stats, so if our reconstruction
    // disagrees the assumed spread is wrong and the numbers can't be trusted.
    var statsWarning = null;
    if (opts.mine.stats) {
      var myBoosts = opts.mine.boosts || {};
      var mismatched = ['atk', 'def', 'spa', 'spd', 'spe'].filter(function (k) {
        if (typeof opts.mine.stats[k] !== 'number') return false;
        // A stat with an active boost or drop is not comparable: the client
        // reports the modified value while we compute the base one, so they
        // differ by design. Intimidate alone made this fire on turn one of
        // most doubles games, and a warning that cries wolf is worse than no
        // warning — people stop reading it.
        if (myBoosts[k]) return false;
        return me.rawStats[k] !== opts.mine.stats[k];
      });
      if (mismatched.length) {
        statsWarning = 'Stat reconstruction differs on ' + mismatched.join(', ') +
          ' — damage numbers may be off.';
      }
    }

    // --- incoming: their predicted moves against us ------------------
    var incoming = [];
    (opts.foeVM.moves || []).forEach(function (m) {
      if (!m.revealed && m.prob < 0.02) return;         // ignore fringe options
      var r = calcAcrossItems(gen, foeVariants, me, m.name, fieldParts, true);
      if (!r) return;
      r.prob = m.prob;
      r.revealed = m.revealed;
      // rank by what actually threatens us: damage discounted by how likely it
      // is. Immunities score 0 and sink to the bottom, which is where they
      // belong — present, but out of the way.
      r.threat = (r.expected != null ? r.expected : r.hiPct) * (m.revealed ? 1 : m.prob);
      incoming.push(r);
    });
    incoming.sort(function (a, b) { return b.threat - a.threat; });

    // --- outgoing: our known moves against them ----------------------
    var outgoing = [];
    (opts.mine.moves || []).forEach(function (name) {
      var r = calcAcrossItems(gen, foeVariants, me, name, fieldParts, false);
      if (!r) return;
      r.prob = 1;
      r.revealed = true;
      outgoing.push(r);
    });
    outgoing.sort(function (a, b) { return b.hiPct - a.hiPct; });

    // Two separate sentences: what we pinned down, and what we covered a range
    // for. Lumping them together read as jargon. This is one muted line under
    // the table, so both halves stay terse \u2014 a name and a percentage each.
    function spreadText(vars) {
      return vars.map(function (v) {
        return v.name + ' ' + Math.round(v.prob * 100) + '%';
      }).join(', ');
    }
    var assumptions = [];
    var unknown = [];
    if (itemVars.length === 1 && itemVars[0].name) {
      assumptions.push(itemVars[0].name + (itemVars[0].revealed ? '' : ' (their likely item)'));
    } else if (itemVars.length > 1) {
      unknown.push('item is unknown (' + spreadText(itemVars) + ')');
    }
    if (abilityVars.length === 1 && abilityVars[0].name) {
      assumptions.push(abilityVars[0].name);
    } else if (abilityVars.length > 1) {
      unknown.push('ability is unknown (' + spreadText(abilityVars) + ')');
    }
    var itemNote = unknown.length
      ? 'Their ' + unknown.join(', their ') +
        '. \u00b1 marks moves where the choice changes the number.'
      : null;

    // The one thing a player needs at a glance is whether this kills. Work it
    // out here rather than leaving it buried in a hover tooltip.
    function verdictFor(rows, targetHpPct, theirs) {
      var real = rows.filter(function (r) { return !r.immune; });
      if (!real.length) return theirs ? 'Nothing they have can hurt you.' : 'Nothing you have can hurt them.';

      // The ROWS are ranked by threat — damage discounted by how likely they
      // have it — which is the right order to read them in. But "worst" in a
      // verdict means hardest hit, and taking row[0] made the banner say
      // "You survive" directly above a row showing 105-124%.
      var top = real[0];
      real.forEach(function (r) { if (r.hiPct > top.hiPct) top = r; });

      // typeof NaN === 'number', so an unguarded check let NaN through and the
      // panel rendered "about NaN hits".
      var hp = (typeof targetHpPct === 'number' && isFinite(targetHpPct) && targetHpPct > 0)
        ? targetHpPct : 100;
      var certain = top.loPct >= hp;
      var possible = top.hiPct >= hp;
      var who = theirs ? 'you' : 'them';
      if (certain) return top.move + ' KOs ' + who + '.';
      if (possible) return top.move + ' can KO ' + who + ' (' + Math.round(top.loPct) + '\u2013' + Math.round(top.hiPct) + '%).';
      var hits = Math.ceil(hp / Math.max(top.hiPct, 0.01));
      if (!isFinite(hits)) return (theirs ? 'You survive' : 'They survive') + ' the worst they have.';
      return (theirs ? 'You survive' : 'They survive') + ' \u2014 worst is ' + top.move +
        ' at ' + Math.round(top.hiPct) + '%, about ' + hits + ' hits.';
    }

    return {
      available: true,
      incomingVerdict: verdictFor(incoming, opts.mine.maxhp ? Math.round((opts.mine.hp / opts.mine.maxhp) * 100) : 100, true),
      outgoingVerdict: verdictFor(outgoing, opts.foeVM.hpPct, false),
      foe: { species: opts.foeRaw.species, level: baseFoeSpec.level, hpPct: opts.foeVM.hpPct },
      mine: {
        species: opts.mine.species, level: opts.mine.level,
        hpPct: opts.mine.maxhp ? Math.round((opts.mine.hp / opts.mine.maxhp) * 100) : 100
      },
      incoming: incoming,
      outgoing: outgoing,
      assumes: assumptions.join(' · '),
      itemNote: itemNote
        ? itemNote + (assumptions.length ? ' Assumes ' + assumptions.join(' · ') + '.' : '')
        : null,
      warning: statsWarning
    };
  }

  root.RBLDamage = {
    matchup: matchup,
    itemVariants: itemVariants,
    abilityVariants: abilityVariants,
    crossVariants: crossVariants,
    calcAcrossItems: calcAcrossItems,
    calcMove: calcMove,
    makePokemon: makePokemon,
    buildField: buildField,
    spread: spread,
    ready: function () { return !!lib(); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
