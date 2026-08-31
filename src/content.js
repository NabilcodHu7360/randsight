/*
 * Randbats Live — content script (isolated world).
 *
 * Glue: takes battle state from the page bridge, pulls the matching randbats
 * set data from the service worker, runs the inference engine, and hands a
 * view model to the renderer. Holds no page references and injects no script.
 */
(function () {
  'use strict';

  var TAG = '__randbats_live__';
  var E = globalThis.RBLEngine;
  var F = globalThis.RBLFormats;
  var UI = globalThis.RBLUI;

  var settings = { enabled: true, side: 'far', refreshedAt: 0 };
  var latest = { rooms: [], at: 0 };
  var stalled = null;   // the bridge could not read the page this tick
  var setsCache = {};
  // Failures live here, separately, so they can be reported without ever
  // standing in for data. Retried on a short backoff rather than at poll rate.
  var lastFetchError = {};
  var FETCH_RETRY_MS = 4000;              // fileId -> { sets, index, fetchedAt, stale, error }
  var modelCache = {};             // fileId + '|' + speciesKey -> built model
  var pending = {};
  var lastRenderKey = '';

  // Joint set tables (src/data/joint-*.json). Loaded lazily per format, since
  // most sessions only ever need one. Until a table arrives — or for a format
  // that has none — predictions come from the marginal model alone.
  var jointState = {};        // file -> 'loading' | 'ready' | 'none'

  function ensureJoint(file) {
    if (jointState[file]) return;
    if (!globalThis.RBLJoint || !chrome.runtime || typeof chrome.runtime.getURL !== 'function') {
      jointState[file] = 'none';
      return;
    }
    jointState[file] = 'loading';
    var url = chrome.runtime.getURL('src/data/joint-' + file + '.json');
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('no table');
      return r.json();
    }).then(function (table) {
      jointState[file] = globalThis.RBLJoint.register(file, table) ? 'ready' : 'none';
      lastRenderKey = '';
      rerender();
    }).catch(function () {
      jointState[file] = 'none';       // marginal model only; not an error
    });
  }

  // Descriptions live in the page's Dex, so we ask the bridge for the names
  // currently on screen and cache the answers. `asked` stops us re-requesting
  // names the page has no entry for.
  var descs = { items: {}, abilities: {}, moves: {} };
  var asked = { items: {}, abilities: {}, moves: {} };

  // -------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------

  chrome.storage.local.get(['rblSettings', 'rblUi'], function (got) {
    if (got.rblSettings) settings = Object.assign(settings, got.rblSettings);
    UI.applyState(got.rblUi || null);
    UI.setVisible(settings.enabled !== false);
    UI.onPersist(function (st) {
      chrome.storage.local.set({ rblUi: st });
      // Some UI state changes what has to be COMPUTED, not just what is drawn —
      // picking a different doubles pairing means a whole new calc. Drop the
      // memo so the next render actually redoes the work.
      lastRenderKey = null;
      rerender();
    });
    rerender();
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    // The popup can reset the panel's saved geometry — apply it live rather
    // than making the user reload the page they're mid-battle on.
    if (changes.rblUi) {
      UI.applyState(changes.rblUi.newValue || {});
      lastRenderKey = '';
      rerender();
    }
    if (!changes.rblSettings) return;
    var next = changes.rblSettings.newValue || {};
    // The popup's "Refresh now" bumps refreshedAt after clearing the service
    // worker's cache; drop our in-page copies so the next render refetches.
    if ((next.refreshedAt || 0) > (settings.refreshedAt || 0)) {
      setsCache = {};
      modelCache = {};
      pending = {};
    }
    settings = Object.assign(settings, next);
    UI.setVisible(settings.enabled !== false);
    lastRenderKey = '';
    rerender();
  });

  // -------------------------------------------------------------------
  // data
  // -------------------------------------------------------------------

  function toId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  function indexSets(sets) {
    var idx = {};
    Object.keys(sets).forEach(function (k) { idx[toId(k)] = k; });
    return idx;
  }

  function requestSets(format) {
    var info = F.resolve(format);
    if (!info.ok) return null;
    var file = info.file;
    if (setsCache[file]) return setsCache[file];
    if (pending[file]) return null;
    // A failure must not be cached. The service worker is torn down whenever
    // Chrome feels like it, so "the message port closed" is a routine, entirely
    // recoverable event — caching it left the panel dead until the extension
    // was reloaded. Back off instead, and let the next tick try again.
    if (lastFetchError[file] && Date.now() - lastFetchError[file].at < FETCH_RETRY_MS) return null;
    pending[file] = true;
    chrome.runtime.sendMessage({ __rbl: true, type: 'getSets', format: format }, function (res) {
      delete pending[file];
      if (chrome.runtime.lastError || !res) {
        lastFetchError[file] = {
          at: Date.now(),
          error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no response'
        };
      } else if (!res.ok) {
        lastFetchError[file] = { at: Date.now(), error: res.error };
      } else {
        delete lastFetchError[file];
        setsCache[file] = {
          sets: res.sets, index: indexSets(res.sets), fetchedAt: res.fetchedAt,
          stale: res.stale, error: res.error, species: res.species
        };
      }
      lastRenderKey = '';
      rerender();
    });
    return null;
  }

  /** exact forme -> id match -> base forme */
  function lookupSpecies(bundle, species) {
    if (!bundle || !bundle.sets) return null;
    if (bundle.sets[species]) return { key: species, entry: bundle.sets[species] };
    var id = toId(species);
    if (bundle.index[id]) return { key: bundle.index[id], entry: bundle.sets[bundle.index[id]] };
    var base = String(species).split('-')[0];
    var bid = toId(base);
    if (bundle.index[bid]) return { key: bundle.index[bid], entry: bundle.sets[bundle.index[bid]] };
    return null;
  }

  function getModel(file, key, entry) {
    var ck = file + '|' + key;
    if (!modelCache[ck]) modelCache[ck] = E.buildSpecies(entry);
    return modelCache[ck];
  }

  // -------------------------------------------------------------------
  // view model
  // -------------------------------------------------------------------

  /** Attach cached descriptions and note anything we still need to ask for. */
  function decorate(kind, arr, wanted) {
    (arr || []).forEach(function (row) {
      var have = descs[kind][row.name];
      if (have) { row.info = have; return; }
      if (!asked[kind][row.name]) { asked[kind][row.name] = true; wanted[kind].push(row.name); }
    });
  }

  function requestDescs(wanted) {
    if (!wanted.items.length && !wanted.abilities.length && !wanted.moves.length) return;
    window.postMessage({ __rbl: TAG, type: 'describe', payload: wanted }, window.location.origin);
  }

  // Items that lock the holder into the move it just used.
  var CHOICE = ['Choice Band', 'Choice Specs', 'Choice Scarf'];

  /** Null rather than NaN when either side of the ratio is missing. */
  function hpPercent(hp, maxhp) {
    if (typeof hp !== 'number' || typeof maxhp !== 'number') return null;
    if (!isFinite(hp) || !isFinite(maxhp) || maxhp <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((hp / maxhp) * 100)));
  }

  function spriteUrl(species) {
    return 'https://play.pokemonshowdown.com/sprites/gen5/' +
      String(species).toLowerCase().replace(/[^a-z0-9-]+/g, '') + '.png';
  }

  function buildMonVM(bundle, file, gen, p, side) {
    var found = lookupSpecies(bundle, p.species);
    var vm = {
      key: p.ident || p.species,
      species: p.species,
      level: p.level || (found ? found.entry.level : 0),
      active: !!p.active,
      fainted: !!p.fainted,
      status: p.fainted ? 'fnt' : (p.status || ''),
      tera: p.terastallized || '',
      icon: p.icon || '',
      spriteUrl: spriteUrl(p.species),
      hpPct: hpPercent(p.hp, p.maxhp),
      slotsKnown: (p.moves || []).length,
      slotsTotal: 4,
      moves: [], roles: [], items: [], abilities: [], teraTypes: [], notes: []
    };

    if (!found) {
      vm.unsupported = 'No randbats data for ' + p.species + ' in this format.';
      return vm;
    }

    var obs = {
      moves: p.moves || [],
      item: p.itemLost ? null : (p.item || null),
      ability: p.ability || null,
      teraType: p.terastallized || null
    };

    // The marginal model is always computed: it's the prior the joint estimate
    // is shrunk toward, and the fallback when the table doesn't cover this
    // species or its published sets have changed since the table was built.
    var model = getModel(file, found.key, found.entry);
    var pred = E.predict(model, obs);

    var J = globalThis.RBLJoint;
    if (J && J.has(file)) {
      var joint = J.predict(file, p.species, obs, found.entry);
      if (joint) pred = J.blend(joint, pred);
    }
    vm.modelSource = pred.source || 'marginal';

    vm.level = p.level || pred.level;
    vm.slotsTotal = pred.slotsTotal;
    vm.slotsKnown = pred.slotsKnown;
    vm.roles = pred.roles;
    vm.rolesTotal = pred.rolesTotal || pred.roles.length;
    vm.moves = pred.moves;
    vm.items = pred.items;
    vm.abilities = pred.abilities;
    vm.teraTypes = pred.teraTypes;
    vm.notes = pred.notes.slice();

    if (p.itemLost && p.item) vm.notes.push(p.item + ' already used or removed.');

    // ---- evidence the battle gives away that the set data cannot ----------
    // A side may Terastallize once. Once it has, every OTHER Pokemon on that
    // side has a Tera type it will never get to use, so showing a distribution
    // for it is noise dressed up as information.
    if (side && side.teraUsed && !p.terastallized &&
        String(side.teraUsedBy || '') !== String(p.species)) {
      vm.teraSpent = side.teraUsedBy || '';
      vm.teraTypes = [];
    }

    // Choice lock. We never see their item directly, so this is stated as the
    // conditional it is: locked INTO that move IF the item is a Choice item.
    if (p.lastMove && (p.movesSinceSwitch || 0) >= 1) {
      var choiceProb = 0;
      (vm.items || []).forEach(function (it) {
        if (CHOICE.indexOf(it.name) !== -1) choiceProb += (it.revealed ? 1 : it.prob);
      });
      if (choiceProb >= 0.05) {
        vm.lock = { move: p.lastMove, prob: Math.min(choiceProb, 1) };
      }
    }

    // PP. Counts come off the wire; the maximum arrives with the description,
    // so buildCards() finishes this once descriptions are attached.
    var uses = p.moveUses || {};
    vm.moves.forEach(function (m) {
      if (uses[m.name]) m.uses = uses[m.name];
    });

    if (gen >= 3 && p.baseSpe) {
      var base = E.speedStat(p.baseSpe, vm.level, pred.evs, pred.ivs);
      if (base) {
        var scarf = (pred.items.find(function (i) { return i.name === 'Choice Scarf'; }) || null);
        vm.speed = {
          base: base,
          scarf: scarf ? Math.floor(base * 1.5) : null,
          scarfProb: scarf ? scarf.prob : 0
        };
      }
    }

    var evParts = [];
    if (pred.evs) Object.keys(pred.evs).forEach(function (k) { evParts.push(pred.evs[k] + ' ' + k.toUpperCase() + ' EV'); });
    if (pred.ivs) Object.keys(pred.ivs).forEach(function (k) { evParts.push(pred.ivs[k] + ' ' + k.toUpperCase() + ' IV'); });
    if (evParts.length) vm.evNote = evParts.join(' · ');

    return vm;
  }

  function chooseRoom(rooms) {
    if (!rooms.length) return null;
    var focused = rooms.filter(function (r) { return r.focused; });
    var pool = focused.length ? focused : rooms;
    // Prefer client-sourced state over the protocol fallback, then live over ended.
    pool = pool.slice().sort(function (a, b) {
      if ((a.source === 'client') !== (b.source === 'client')) return a.source === 'client' ? -1 : 1;
      if (a.ended !== b.ended) return a.ended ? 1 : -1;
      return (b.turn || 0) - (a.turn || 0);
    });
    return pool[0];
  }

  function ago(ts) {
    if (!ts) return '';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }

  // -------------------------------------------------------------------
  // render
  //
  // rerender() is deliberately a short pipeline of named steps:
  //   pick a room -> resolve the format -> get the set data -> pick the sides
  //   -> build a card per Pokemon -> add the damage matchup -> hand to the UI.
  // Each step that can't continue returns a "notice" view explaining why.
  // -------------------------------------------------------------------

  /** A whole-panel message: no battle, unsupported format, data still loading. */
  function notice(subtitle, title, bodyText) {
    return {
      subtitle: subtitle || '', mons: [], damage: null,
      emptyTitle: title, emptyBody: bodyText,
      footLeft: 'randbats-live', footRight: ''
    };
  }

  /**
   * Which sides count as "them"? Multi and Free-For-All have four sides, so the
   * opponent can be up to three separate players. Anything that isn't ours or
   * our ally's is a foe.
   */
  function pickSides(room, wantNear) {
    var all = room.sides && room.sides.length ? room.sides : null;
    var chosen = all
      ? all.filter(function (s) { return wantNear ? s.isNear : !s.isNear; })
      : [];
    if (!chosen.length) chosen = [wantNear ? room.near : room.far].filter(Boolean);
    return chosen;
  }

  /** One card per Pokemon on the chosen sides, active first and fainted last. */
  function buildCards(sides, bundle, file, gen) {
    var multiSide = sides.length > 1;
    var cards = [];

    sides.forEach(function (side) {
      (side.pokemon || []).forEach(function (p) {
        var vm = buildMonVM(bundle, file, gen, p, side);
        vm.key = (side.id || '') + '|' + vm.key;
        if (multiSide) vm.owner = side.name || side.id || '';
        vm.raw = p;                        // kept for the damage calculation
        cards.push(vm);
      });
    });

    var wanted = { items: [], abilities: [], moves: [] };
    cards.forEach(function (vm) {
      decorate('moves', vm.moves, wanted);
      decorate('items', vm.items, wanted);
      decorate('abilities', vm.abilities, wanted);
    });
    requestDescs(wanted);

    // Max PP only exists once the description has landed. A move used as many
    // times as it has PP cannot be used again — a hard fact, not a probability.
    cards.forEach(function (vm) {
      (vm.moves || []).forEach(function (m) {
        if (!m.uses || !m.info || !m.info.pp) return;
        if (m.uses >= m.info.pp) m.spent = true;
        else if (m.info.pp - m.uses <= 2) m.ppLeft = m.info.pp - m.uses;
      });
    });

    cards.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.fainted !== b.fainted) return a.fainted ? 1 : -1;
      return 0;
    });
    return cards;
  }

  /**
   * Every opposing Pokemon on the field, not just the leftmost. In doubles this
   * is two, and the panel used to analyse slot 0 without saying so.
   */
  function foeActivesOf(cards) {
    return cards.filter(function (m) { return m.active && !m.fainted; });
  }

  function foeActiveOf(cards) {
    return foeActivesOf(cards)[0] || null;
  }

  function myActivesOf(room) {
    if (room.myActives && room.myActives.length) return room.myActives;
    return room.myActive ? [room.myActive] : [];
  }

  /**
   * The matchup grid. Singles has one cell; doubles has up to four, and which
   * one is on screen is the user's choice, never an unstated default.
   */
  function buildDamage(room, cards, gen, pick) {
    if (!globalThis.RBLDamage || !globalThis.RBLDamage.ready()) {
      return { available: false, reason: 'Damage library did not load.' };
    }
    var foes = foeActivesOf(cards);
    var mine = myActivesOf(room);
    if (!mine.length) return { available: false, reason: 'Waiting for your active Pokemon.' };
    if (!foes.length) return { available: false, reason: 'Waiting for an opposing Pokemon to switch in.' };

    // Every pairing that is actually on the field, so the UI can offer them.
    var pairs = [];
    mine.forEach(function (me, mi) {
      foes.forEach(function (foe, fi) {
        pairs.push({ mineIdx: mi, foeIdx: fi, mine: me.species, foe: foe.species });
      });
    });
    var at = 0;
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i].mineIdx + ':' + pairs[i].foeIdx === pick) { at = i; break; }
    }
    var sel = pairs[at];

    var out = globalThis.RBLDamage.matchup({
      gen: gen,
      gameType: room.gameType,
      field: room.field,
      mine: mine[sel.mineIdx],
      foeVM: foes[sel.foeIdx],
      foeRaw: foes[sel.foeIdx].raw
    });
    if (out) {
      out.pairs = pairs;
      out.pairKey = sel.mineIdx + ':' + sel.foeIdx;
      out.multi = pairs.length > 1;
    }
    return out;
  }

  function headerText(sides, room, wantNear) {
    var revealed = sides.reduce(function (a, s) { return a + (s.revealed || 0); }, 0);
    var total = sides.reduce(function (a, s) { return a + (s.totalPokemon || 6); }, 0);
    var names = sides.map(function (s) { return s.name; }).filter(Boolean);
    var who = names.length ? names.join(' + ') : (wantNear ? 'your team' : 'opponent');
    return who + ' \u00b7 ' + revealed + '/' + total + ' seen' +
      (room.turn > 0 ? ' \u00b7 turn ' + room.turn : '');
  }

  function footerText(bundle, info) {
    var right = (bundle.stale ? 'cached ' : 'data ') + ago(bundle.fetchedAt);
    return info.exact ? right : 'approx sets \u00b7 ' + right;
  }

  function rerender() {
    try { rerenderInner(); }
    catch (e) {
      // Never leave a half-drawn panel presenting itself as current.
      lastRenderKey = '';
      try {
        UI.render(notice('', 'Something went wrong',
          'The panel stopped updating: ' + String((e && e.message) || e) +
          '. Reload the page to restart it.'));
      } catch (e2) { /* the UI itself is gone; nothing left to do */ }
      if (typeof console !== 'undefined') console.error('[randbats-live]', e);
    }
  }

  function rerenderInner() {
    if (settings.enabled === false) return;

    var room = chooseRoom(latest.rooms || []);
    if (!room) {
      return UI.render(notice('', 'No battle open',
        'Join or spectate a Random Battle and the opposing team shows up here.'));
    }

    var info = F.resolve(room.roomid || room.tier, { gen: room.gen });
    if (!info.ok) {
      return UI.render(notice(room.tier || room.roomid, 'Unsupported format',
        (info.id || room.roomid) + ' has no published randbats set data.'));
    }

    if (stalled) {
      return UI.render(notice(info.id, 'Lost track of the battle',
        'The page\u2019s battle data could not be read, so these numbers would be out of date. ' +
        'Reload the page to reconnect.'));
    }

    var bundle = requestSets(info.file);
    if (!bundle) {
      var failed = lastFetchError[info.file];
      if (failed) {
        return UI.render(notice(info.id, 'Could not load set data',
          String(failed.error || 'unknown error') + ' \u2014 retrying.'));
      }
      return UI.render(notice(info.id, 'Loading set data\u2026',
        'Fetching ' + info.file + ' from pkmn/randbats.'));
    }

    ensureJoint(info.file);

    var wantNear = settings.side === 'near';
    var sides = pickSides(room, wantNear);
    var gen = room.gen || F.generation(info.file);
    var cards = buildCards(sides, bundle, info.file, gen);
    var uiState = (UI.getState && UI.getState()) || {};
    var damage = buildDamage(room, cards, gen, uiState.pair);

    // Tactical views: who moves first, and who to bring in.
    var A = globalThis.RBLAdvice;
    var foes = foeActivesOf(cards);
    var mine = myActivesOf(room);
    var speedInfo = null, switchInfo = null;
    if (A && foes.length && mine.length) {
      // The speed line belongs to the pairing the Damage tab is showing.
      var pairIdx = damage && damage.pairKey ? damage.pairKey.split(':') : ['0', '0'];
      var speedMine = mine[+pairIdx[0]] || mine[0];
      var speedFoe = foes[+pairIdx[1]] || foes[0];
      speedInfo = A.speed({
        gen: gen, mine: speedMine, foeVM: speedFoe,
        foeRaw: speedFoe.raw, field: room.field
      });
      // Switching is a decision against the whole opposing field, so every
      // active threat counts — in doubles, being safe from one of them is not
      // being safe.
      switchInfo = A.switches({
        gen: gen, gameType: room.gameType, field: room.field,
        team: room.myTeam || [],
        foes: foes.map(function (f) { return { vm: f, raw: f.raw }; }),
        foeVM: foes[0], foeRaw: foes[0].raw,
        damage: globalThis.RBLDamage, speed: speedInfo
      });
    }

    var sub = headerText(sides, room, wantNear);
    var footRight = footerText(bundle, info);

    // Skip the DOM work when nothing observable changed — the bridge polls
    // twice a second and most ticks are identical.
    var key = JSON.stringify([room.roomid, settings.side, cards, sub, footRight, damage, speedInfo, switchInfo]);
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    UI.render({
      subtitle: sub,
      subtitleFull: sub + ' \u00b7 ' + info.id,
      mons: cards,
      damage: damage,
      speed: speedInfo,
      switches: switchInfo,
      footLeft: info.file + (jointState[info.file] === 'ready' ? ' \u00b7 joint' : '') +
        (room.source === 'protocol' ? ' \u00b7 fallback reader' : ''),
      footRight: footRight
    });
  }

  // -------------------------------------------------------------------
  // bridge
  // -------------------------------------------------------------------

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__rbl !== TAG) return;
    if (d.type === 'battles') {
      latest = { rooms: d.payload || [], at: Date.now() };
      stalled = null;
      rerender();
      return;
    }
    if (d.type === 'stalled') {
      // The page's own objects threw while being read. The panel must stop
      // presenting stale numbers as if they were current.
      stalled = d.payload || { at: Date.now() };
      lastRenderKey = '';
      rerender();
      return;
    }
    if (d.type === 'descs') {
      var got = d.payload || {};
      ['items', 'abilities', 'moves'].forEach(function (kind) {
        var bag = got[kind] || {};
        Object.keys(bag).forEach(function (n) {
          if (bag[n] && bag[n].short) descs[kind][n] = bag[n];
        });
      });
      lastRenderKey = '';
      rerender();
    }
  });

  // Nudge the bridge in case it loaded before we did.
  window.postMessage({ __rbl: TAG, type: 'resync' }, window.location.origin);
})();
