/*
 * Randsight — tactical derivations.
 *
 * Two questions a player asks every single turn, neither of which the raw
 * numbers answer directly:
 *
 *   "Do I move first?"   -> speed(), which has to fold in the things that
 *                           actually decide it: boosts, paralysis, Tailwind,
 *                           Trick Room, and the Choice Scarf we can only assign
 *                           a probability to.
 *
 *   "Who do I bring in?" -> switches(), which runs their active's predicted
 *                           moves against every bench slot and ranks by what
 *                           actually threatens each one.
 *
 * Pure: takes plain objects, returns plain objects. Damage numbers come from
 * damage.js, which wraps the vendored @smogon/calc.
 */
(function (root) {
  'use strict';

  var DEFAULT_EV = 85;
  var DEFAULT_IV = 31;

  /** Standard stat-stage multiplier. */
  function boostMult(stage) {
    var s = Math.max(-6, Math.min(6, stage || 0));
    return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
  }

  /**
   * Speed at a given level, per generation. Randbats: 85 EVs, 31 IVs, neutral.
   *
   * Gens 1-2 use DVs and stat experience, not EVs/IVs, so the Gen 3+ formula is
   * ~13% low there — enough to invert the "who moves first" verdict. The
   * vendored calc implements every generation correctly, so ask it rather than
   * maintaining a second copy of the rules that only covers some of them.
   */
  function rawSpeed(baseSpe, level, evs, ivs, gen, species) {
    if (!baseSpe || !level) return null;
    var ev = (evs && typeof evs.spe === 'number') ? evs.spe : DEFAULT_EV;
    var iv = (ivs && typeof ivs.spe === 'number') ? ivs.spe : DEFAULT_IV;

    if (species && root.RSCalcLib) {
      try {
        var lib = root.RSCalcLib;
        var g = lib.Generations.get(gen || 9);
        var pk = new lib.Pokemon(g, species, {
          level: level,
          evs: { hp: ev, atk: ev, def: ev, spa: ev, spd: ev, spe: ev },
          ivs: { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv }
        });
        if (pk && pk.rawStats && pk.rawStats.spe) return pk.rawStats.spe;
      } catch (e) { /* unknown species — fall through */ }
    }
    // Gen 3+ formula. Only reached when the calc cannot help, and only correct
    // from gen 3 on, so refuse to guess for the generations it does not fit.
    if (gen && gen < 3) return null;
    return Math.floor((Math.floor(((2 * baseSpe + iv + Math.floor(ev / 4)) * level) / 100) + 5));
  }

  /**
   * Apply everything that modifies speed in battle.
   * @returns { value, parts:[] } — parts explains the modifiers applied.
   */
  function effectiveSpeed(base, opts) {
    opts = opts || {};
    var v = base;
    var parts = [];

    var bm = boostMult(opts.boost);
    if (bm !== 1) { v = Math.floor(v * bm); parts.push((opts.boost > 0 ? '+' : '') + opts.boost + ' Spe'); }

    if (opts.tailwind) { v = Math.floor(v * 2); parts.push('Tailwind'); }

    // Gen 7 onward paralysis halves Speed (it was a quarter before).
    if (opts.paralysed) {
      v = Math.floor(v * ((opts.gen >= 7) ? 0.5 : 0.25));
      parts.push('paralysed');
    }

    if (opts.scarf) { v = Math.floor(v * 1.5); parts.push('Choice Scarf'); }

    return { value: v, parts: parts };
  }

  function likeliestItem(items) {
    if (!items || !items.length) return null;
    var revealed = items.find(function (x) { return x.revealed; });
    if (revealed) return { name: revealed.name, prob: 1, revealed: true };
    var best = items[0];
    items.forEach(function (x) { if (x.prob > best.prob) best = x; });
    return { name: best.name, prob: best.prob, revealed: false };
  }

  function scarfChance(items) {
    if (!items || !items.length) return 0;
    var s = items.find(function (x) { return x.name === 'Choice Scarf'; });
    return s ? s.prob : 0;
  }

  /**
   * Who moves first?
   *
   * @param o.gen        generation
   * @param o.mine       our active, from the bridge (exact stats)
   * @param o.foeVM      the opposing active's prediction view model
   * @param o.foeRaw     the opposing active's raw battle state
   * @param o.field      field state from the bridge
   */
  function speed(o) {
    if (!o || !o.mine || !o.foeRaw) return null;
    var gen = o.gen || 9;
    var field = o.field || {};

    var mineBase = (o.mine.stats && o.mine.stats.spe) || null;
    if (!mineBase) return null;

    var mineEff = effectiveSpeed(mineBase, {
      gen: gen,
      boost: (o.mine.boosts || {}).spe,
      tailwind: !!(field.near && field.near.tailwind),
      paralysed: o.mine.status === 'par',
      scarf: o.mine.item === 'Choice Scarf'
    });

    // We only know their base stat and level, so reconstruct from the set data.
    var foeBase = o.foeRaw.baseSpe
      ? rawSpeed(o.foeRaw.baseSpe, o.foeVM.level || o.foeRaw.level, o.foeVM.evs, o.foeVM.ivs,
                 gen, o.foeRaw.species)
      : null;
    if (!foeBase) return null;

    var foeOpts = {
      gen: gen,
      boost: (o.foeRaw.boosts || {}).spe,
      tailwind: !!(field.far && field.far.tailwind),
      paralysed: o.foeRaw.status === 'par',
      scarf: false
    };
    var foeEff = effectiveSpeed(foeBase, foeOpts);
    foeOpts.scarf = true;
    var foeScarfed = effectiveSpeed(foeBase, foeOpts);

    var scarfP = scarfChance(o.foeVM.items);
    var item = likeliestItem(o.foeVM.items);
    var scarfKnown = item && item.revealed && item.name === 'Choice Scarf';
    if (scarfKnown) { foeEff = foeScarfed; scarfP = 1; }

    var trickRoom = !!field.trickRoom;
    // Trick Room reverses the comparison; ties are still broken the same way.
    function fasterThan(a, b) { return trickRoom ? a < b : a > b; }

    var winsNow = fasterThan(mineEff.value, foeEff.value);
    var winsIfScarf = fasterThan(mineEff.value, foeScarfed.value);

    var verdict;
    if (scarfKnown || scarfP < 0.005) {
      verdict = winsNow ? 'you' : (mineEff.value === foeEff.value ? 'tie' : 'them');
    } else if (winsNow && !winsIfScarf) {
      verdict = 'unless-scarf';           // the interesting case
    } else {
      verdict = winsNow ? 'you' : 'them';
    }

    return {
      trickRoom: trickRoom,
      you: { species: o.mine.species, value: mineEff.value, parts: mineEff.parts },
      them: {
        species: o.foeRaw.species, value: foeEff.value, parts: foeEff.parts,
        scarfValue: foeScarfed.value, scarfProb: scarfP, scarfKnown: !!scarfKnown
      },
      verdict: verdict
    };
  }

  /**
   * Who should I switch to?
   *
   * For every bench slot, run their active's predicted moves against it and
   * keep the worst realistic outcome. "Realistic" matters: a 40%-likely OHKO
   * is a bigger problem than a certain 20% chip, so each move's damage is
   * discounted by how likely they actually have it.
   *
   * @param o.team    our full team from the bridge
   * @param o.damage  the RSDamage module
   */
  function switches(o) {
    var D = o && o.damage;
    if (!D || !D.ready() || !o.team || !o.team.length || !o.foeVM || !o.foeRaw) return null;

    var lib = root.RSCalcLib;
    var gen;
    try { gen = lib.Generations.get(o.gen || 9); } catch (e) { return null; }
    var fieldParts = D.buildField(gen, o.field, o.gameType);

    // In doubles both of their actives can hit you on the turn you switch, so
    // "safe" has to mean safe from the field, not safe from the left-hand one.
    var threats = (o.foes && o.foes.length)
      ? o.foes
      : [{ vm: o.foeVM, raw: o.foeRaw }];

    var foeItem = likeliestItem(o.foeVM.items);
    var foeAbility = likeliestItem(o.foeVM.abilities);
    var foe;
    try {
      foe = D.makePokemon(gen, {
        species: o.foeRaw.species,
        level: o.foeVM.level || o.foeRaw.level,
        evs: o.foeVM.evs, ivs: o.foeVM.ivs,
        boosts: o.foeRaw.boosts || {},
        item: foeItem && foeItem.name,
        ability: foeAbility && foeAbility.name,
        teraType: o.foeRaw.terastallized || undefined
      });
    } catch (e) { return null; }

    // One attacker object per opposing active, each with its own move list.
    var attackers = [];
    threats.forEach(function (t) {
      if (!t || !t.vm || !t.raw) return;
      var pk;
      try {
        pk = D.makePokemon(gen, {
          species: t.raw.species,
          level: t.vm.level || t.raw.level,
          evs: t.vm.evs, ivs: t.vm.ivs,
          boosts: t.raw.boosts || {},
          item: (likeliestItem(t.vm.items) || {}).name,
          ability: (likeliestItem(t.vm.abilities) || {}).name,
          teraType: t.raw.terastallized || undefined
        });
      } catch (e) { return; }
      attackers.push({
        pk: pk,
        species: t.raw.species,
        moves: (t.vm.moves || []).filter(function (m) {
          // A move with no PP left cannot be the thing that kills you.
          return !m.spent && (m.revealed || m.prob >= 0.02);
        })
      });
    });
    if (!attackers.length) return null;

    var rows = o.team.map(function (slot) {
      var row = {
        species: slot.species,
        level: slot.level,
        active: !!slot.active,
        fainted: !!slot.fainted,
        hpPct: slot.maxhp ? Math.round((slot.hp / slot.maxhp) * 100) : 100,
        worstPct: 0, worstMove: '', worstProb: 0, threat: 0, ko: '', speed: null
      };
      // Defaults must be set BEFORE any early return. A row that escapes with
      // `survives` undefined renders as a guaranteed KO, which is the most
      // dangerous possible thing for this tab to get wrong.
      row.survives = true;
      row.left = row.hpPct;
      row.unknown = false;
      if (slot.fainted) { row.survives = false; row.left = 0; return row; }

      var me;
      try {
        me = D.makePokemon(gen, {
          species: slot.species,
          level: slot.level,
          boosts: slot.active ? (slot.boosts || {}) : {},   // boosts reset on switch
          item: slot.item || undefined,
          ability: slot.ability || undefined,
          teraType: slot.terastallized || undefined
        });
      } catch (e) {
        // The calc does not know this species — a brand-new Pokemon against a
        // pinned library snapshot. Say we don't know, never imply it dies.
        row.unknown = true;
        return row;
      }

      attackers.forEach(function (att) {
        att.moves.forEach(function (m) {
          var r = D.calcMove(gen, att.pk, me, m.name, fieldParts, false);
          if (!r || r.immune) return;
          var weight = m.revealed ? 1 : m.prob;
          var threat = r.hiPct * weight;
          if (threat > row.threat) {
            row.threat = threat;
            row.worstPct = r.hiPct;
            row.worstLo = r.loPct;
            row.worstMove = m.name;
            row.worstProb = weight;
            row.worstFrom = att.species;
            row.ko = r.ko;
          }
        });
      });

      // Does this slot outspeed their active once it's in?
      if (slot.stats && slot.stats.spe && o.speed && o.speed.them) {
        var mySpe = effectiveSpeed(slot.stats.spe, {
          gen: o.gen || 9,
          tailwind: !!(o.field && o.field.near && o.field.near.tailwind),
          scarf: slot.item === 'Choice Scarf'
        }).value;
        row.speed = { value: mySpe, faster: (o.field && o.field.trickRoom)
          ? mySpe < o.speed.them.value : mySpe > o.speed.them.value };
      }

      // Damage is a share of MAX hp; survival is against what's left.
      row.survives = row.worstPct > 0 ? (row.worstPct < row.hpPct) : true;
      // How much HP is still standing after the worst hit. This, not raw
      // damage, is what "safest" means — a chip-damaged wall that takes 68%
      // is dead, and a healthy one that takes 64% is not.
      row.left = Math.max(row.hpPct - row.worstPct, 0);
      return row;
    });

    var live = rows.filter(function (r) { return !r.fainted; });
    live.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? 1 : -1;   // bench first
      // A slot we could not evaluate sinks below every slot we could — it is
      // not a recommendation, and it must not masquerade as one.
      if (!a.unknown !== !b.unknown) return a.unknown ? 1 : -1;
      if (a.survives !== b.survives) return a.survives ? -1 : 1;
      return (b.left || 0) - (a.left || 0);                   // most HP left first
    });

    return {
      foe: attackers.map(function (a) { return a.species; }).join(' + '),
      foes: attackers.map(function (a) { return a.species; }),
      assumes: [foeItem && foeItem.name, foeAbility && foeAbility.name].filter(Boolean).join(' · '),
      rows: live.concat(rows.filter(function (r) { return r.fainted; }))
    };
  }

  root.RSAdvice = {
    speed: speed,
    switches: switches,
    effectiveSpeed: effectiveSpeed,
    rawSpeed: rawSpeed,
    boostMult: boostMult
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
