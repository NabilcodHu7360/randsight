/*
 * Format resolution: map a Showdown room id to a randbats data file.
 * Shared by the service worker and the content script.
 *
 * The supported list and the alias tables were checked against the live
 * client's own format list and against what pkmn/randbats actually publishes,
 * rather than guessed from format names.
 */
(function (root) {
  'use strict';

  // Formats pkmn/randbats publishes stats for. Verified 200 on the CDN.
  var SUPPORTED = [
    'gen1randombattle', 'gen2randombattle', 'gen3randombattle', 'gen4randombattle',
    'gen5randombattle', 'gen6randombattle', 'gen7randombattle', 'gen8randombattle',
    'gen9randombattle',
    'gen9randomdoublesbattle', 'gen9championsrandomdoublesbattle',
    'gen9babyrandombattle', 'gen8bdsprandombattle', 'gen7letsgorandombattle'
  ];

  // Same set generator, different lobby rules (timer, ladder). Sets are identical.
  var EXACT_ALIASES = {
    gen9randombattleblitz: 'gen9randombattle',
    gen9unratedrandombattle: 'gen9randombattle',
    gen9randomdoublesbattleblitz: 'gen9randomdoublesbattle',
    gen8unratedrandombattle: 'gen8randombattle',
    gen8randombattleblitz: 'gen8randombattle'
  };

  // Related but not identical — the panel labels these "approx sets" so the
  // numbers aren't presented as if they were exact.
  var APPROX_ALIASES = {
    gen9randombattlemayhem: 'gen9randombattle',      // randbats sets, then scrambled
    gen9freeforallrandombattle: 'gen9randombattle',  // FFA-specific generator tweaks
    gen8freeforallrandombattle: 'gen8randombattle',
    gen9multirandombattle: 'gen9randomdoublesbattle',
    gen8multirandombattle: 'gen8randombattle'
  };

  // Roulette rolls a different generation every battle, so the room id alone
  // doesn't identify the sets — we resolve it from the live battle's gen.
  var PER_BATTLE_GEN = { gen9randomroulette: true, gen9randomlettercup: false };

  function toId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  /**
   * "battle-gen9randomdoublesbattle-2312345678" -> resolved format info.
   * Also accepts a bare format id (so a resolved file round-trips).
   *
   * @param {object} [hints] { gen } from the live battle, used for formats
   *                         whose generation isn't fixed by the room id.
   */
  function resolve(roomOrFormat, hints) {
    var raw = String(roomOrFormat || '');
    var id;
    if (/^battle-/.test(raw)) {
      id = toId(raw.split('-')[1]);
    } else {
      id = toId(raw);
    }
    if (!id) return { ok: false, reason: 'no format in room id', raw: raw };

    if (SUPPORTED.indexOf(id) !== -1) return { ok: true, id: id, file: id, exact: true, raw: id };
    if (EXACT_ALIASES[id]) return { ok: true, id: id, file: EXACT_ALIASES[id], exact: true, raw: id };
    if (APPROX_ALIASES[id]) return { ok: true, id: id, file: APPROX_ALIASES[id], exact: false, raw: id };

    if (PER_BATTLE_GEN[id]) {
      var gen = hints && hints.gen;
      var file = 'gen' + gen + 'randombattle';
      if (gen && SUPPORTED.indexOf(file) !== -1) {
        return { ok: true, id: id, file: file, exact: true, raw: id, fromGen: true };
      }
      return { ok: false, reason: 'waiting for the battle to reveal its generation', id: id, raw: id };
    }

    return { ok: false, reason: 'not a Random Battle format with published set data', id: id, raw: id };
  }

  function generation(fileId) {
    var m = /^gen(\d+)/.exec(fileId || '');
    return m ? parseInt(m[1], 10) : 9;
  }

  function isDoubles(fileId) { return /doubles/.test(fileId || ''); }

  // -------------------------------------------------------------------
  // Latent formes
  // -------------------------------------------------------------------
  /*
   * Some Pokemon are generated as a forme but appear under their BASE name for
   * most or all of the battle. Greninja-Bond is the case that found this: in
   * gen9randomdoublesbattle the only Greninja the generator makes is the Battle
   * Bond one, so the data file has `Greninja-Bond` and no `Greninja` — while the
   * protocol says `Greninja`, because that is what is standing on the field
   * until it transforms. The panel showed no data at all for it.
   *
   * The existing fallback only walks forme -> base ("Greninja-Bond" -> a
   * "Greninja" key). This is the other direction, and it has to be narrower,
   * because most hyphenated formes are NOT display-identical to their base:
   * Qwilfish-Hisui and Basculin-White-Striped are different Pokemon that appear
   * under their own full names, and quietly serving their sets for a plain
   * "Qwilfish" would be worse than serving nothing.
   *
   * So this is an allowlist of suffixes where the base name is genuinely what
   * the client shows, and it resolves only when exactly one candidate exists.
   * Urshifu in gen8 has three (-Gmax, -Rapid-Strike, -Rapid-Strike-Gmax) and
   * stays unresolved rather than guessed at.
   */
  var LATENT_SUFFIX = {
    bond: true,        // Greninja-Bond — shows as Greninja until it becomes Ash
    resolute: true,    // Keldeo-Resolute — cosmetic, always shows as Keldeo
    gmax: true,        // shows as the base until it Gigantamaxes
    mega: true,        // shows as the base until it Mega Evolves
    megax: true,
    megay: true,
    starter: true,     // Let's Go partner Pikachu / Eevee
    eternamax: true
  };

  /**
   * baseId -> the single data key it should resolve to.
   * Built once per data file; pass it that file's species keys.
   */
  function formeIndex(keys) {
    var byBase = {};
    var have = {};
    (keys || []).forEach(function (k) { have[toId(k)] = true; });

    (keys || []).forEach(function (k) {
      var cut = String(k).indexOf('-');
      if (cut < 1) return;
      var bid = toId(k.slice(0, cut));
      // A base that exists in its own right is never overridden — the plain
      // species is the right answer for the plain name.
      if (have[bid]) return;
      if (!LATENT_SUFFIX[toId(k.slice(cut + 1))]) return;
      (byBase[bid] = byBase[bid] || []).push(k);
    });

    var out = {};
    Object.keys(byBase).forEach(function (b) {
      if (byBase[b].length === 1) out[b] = byBase[b][0];
    });
    return out;
  }

  root.RSFormats = {
    SUPPORTED: SUPPORTED,
    EXACT_ALIASES: EXACT_ALIASES,
    APPROX_ALIASES: APPROX_ALIASES,
    LATENT_SUFFIX: LATENT_SUFFIX,
    resolve: resolve,
    generation: generation,
    isDoubles: isDoubles,
    formeIndex: formeIndex,
    toId: toId
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
