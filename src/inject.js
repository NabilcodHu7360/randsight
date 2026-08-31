/*
 * Randbats Live — page bridge (runs in the MAIN world at document_start).
 *
 * Two independent readers, because Showdown has two live clients and neither
 * is a stable API:
 *
 *   1. Client-object poll (primary). Reads `battle.farSide.pokemon` straight
 *      off the page's own Battle instance. This is the good source: the client
 *      already curates `moveTrack` (drops Struggle, tags transformed moves,
 *      attributes called moves to the caller), tracks consumed items in
 *      `prevItem`, and separates `baseAbility` from a swapped ability.
 *      Works with the legacy `window.app` client and the newer `window.PS` one.
 *
 *   2. Protocol reader (fallback). Taps the SockJS/WebSocket frames and parses
 *      the Showdown protocol itself. Slightly cruder, but it survives a client
 *      rewrite, so it covers us if reader 1 finds nothing.
 *
 * Whatever it reads, it posts to the isolated world via window.postMessage.
 * It never writes to the page, never patches client methods, and never touches
 * `battle.subscription`.
 */
(function () {
  'use strict';

  var TAG = '__randbats_live__';
  var POLL_MS = 500;

  function post(type, payload) {
    try { window.postMessage({ __rbl: TAG, type: type, payload: payload }, window.location.origin); }
    catch (e) { /* structured-clone failure; nothing we can do */ }
  }

  // =====================================================================
  // Reader 1 — client object
  // =====================================================================

  /** id of the battle room the user is actually looking at, if we can tell */
  function focusedRoomId() {
    try {
      var PS = window.PS;
      if (PS) {
        if (PS.room && PS.room.id) return String(PS.room.id);
        if (PS.panel && PS.panel.id) return String(PS.panel.id);
      }
    } catch (e) { /* ignore */ }
    try {
      var app = window.app;
      if (app && app.curRoom && app.curRoom.id) return String(app.curRoom.id);
    } catch (e) { /* ignore */ }
    try {
      var hash = String(window.location.hash || '').replace(/^#/, '');
      if (/^battle-/.test(hash)) return hash;
    } catch (e) { /* ignore */ }
    return '';
  }

  function eachBattleRoom(fn) {
    var seen = {};
    function visit(roomid, room) {
      if (!room || seen[roomid]) return;
      var battle = room.battle;
      if (!battle || !battle.sides) return;
      seen[roomid] = true;
      fn(String(roomid || room.id || ''), room, battle);
    }
    try {
      var PS = window.PS;
      if (PS && PS.rooms) for (var a in PS.rooms) visit(a, PS.rooms[a]);
    } catch (e) { /* ignore */ }
    try {
      var app = window.app;
      if (app && app.rooms) for (var b in app.rooms) visit(b, app.rooms[b]);
    } catch (e) { /* ignore */ }
  }

  function baseSpeed(speciesForme) {
    try {
      var sp = window.Dex && window.Dex.species && window.Dex.species.get(speciesForme);
      if (sp && sp.baseStats && typeof sp.baseStats.spe === 'number') {
        return { spe: sp.baseStats.spe, types: sp.types || [], num: sp.num };
      }
    } catch (e) { /* Dex not loaded yet */ }
    return null;
  }

  /** Reuse the client's own icon sheet so every forme renders correctly. */
  function iconStyle(speciesForme) {
    try {
      if (window.Dex && typeof window.Dex.getPokemonIcon === 'function') {
        return window.Dex.getPokemonIcon(speciesForme) || '';
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  /**
   * How many moves this Pokemon has used since it last switched in.
   *
   * The client hands us a whole-battle use count, not a per-stint one, so we
   * take our own baseline the first poll it is active and subtract. A Pokemon
   * we first see mid-stint reads 0 until it moves again — quiet, never wrong,
   * which is the right way round when the answer drives a recommendation.
   */
  var stintBase = {};
  function sinceSwitch(p, totalUses) {
    var room = (p.side && p.side.battle && p.side.battle.id) || '';
    var key = String(room) + '|' + String(p.side && p.side.sideid || '') +
      '|' + String(p.ident || p.speciesForme || '');
    if (!key || key === '|') return 0;
    var active = typeof p.isActive === 'function' ? !!p.isActive() : false;
    if (!active) { delete stintBase[key]; return 0; }
    if (!(key in stintBase)) stintBase[key] = totalUses;
    // A Choice item leaving resets the lock; the protocol reader sees the
    // event, and here the count simply keeps rising, so content.js gates on
    // the item posterior anyway.
    return Math.max(totalUses - stintBase[key], 0);
  }

  function readPokemon(p) {
    if (!p) return null;
    var moves = [];
    var uses = {};
    var track = p.moveTrack || [];
    for (var i = 0; i < track.length; i++) {
      var nm = track[i] && track[i][0];
      if (!nm) continue;
      if (nm.charAt(0) === '*') continue;          // move gained via Transform
      moves.push(nm);
      // A moveTrack entry is [moveName, ppUsed] — the client increments the
      // second slot every time the move goes off, which is exactly the PP
      // counter we want. If a future client ever stops shipping that number,
      // drop the move out of moveUses rather than inventing a count: an absent
      // count just makes the PP readout go quiet, a wrong one misleads.
      var used = track[i][1];
      if (typeof used === 'number' && isFinite(used) && used > 0) uses[nm] = used;
    }
    var total = 0;
    for (var k in uses) if (Object.prototype.hasOwnProperty.call(uses, k)) total += uses[k];
    var dex = baseSpeed(p.speciesForme);
    return {
      species: p.speciesForme || '',
      name: p.name || '',
      ident: p.ident || '',
      level: p.level || 0,
      gender: p.gender || 'N',
      fainted: !!p.fainted,
      hp: p.hp, maxhp: p.maxhp,
      status: p.status || '',
      moves: moves,
      moveUses: uses,
      // `lastMove` is a move id on the client ("hydropump"); nameOf() puts it
      // back into the display spelling every other field here uses.
      lastMove: nameOf('moves', p.lastMove || ''),
      // moveTrack counts are for the whole battle, and the client's own
      // `lastMove` reset semantics are not something we can verify from here.
      // So count it ourselves across polls instead of trusting either: total
      // uses now, minus total uses when this Pokemon last came in.
      movesSinceSwitch: sinceSwitch(p, total),
      item: p.item || p.prevItem || '',
      itemLost: !p.item && !!p.prevItem,
      ability: p.baseAbility || p.ability || '',
      terastallized: p.terastallized || '',
      boosts: p.boosts || {},
      active: typeof p.isActive === 'function' ? !!p.isActive() : false,
      baseSpe: dex ? dex.spe : null,
      types: dex ? dex.types : null,
      icon: iconStyle(p.speciesForme)
    };
  }

  /** Move/item/ability ids -> display names, using the page's own dex. */
  function nameOf(kind, id) {
    if (!id) return '';
    try {
      var e = window.Dex && window.Dex[kind] && window.Dex[kind].get(id);
      if (e && e.exists !== false && e.name) return e.name;
    } catch (err) { /* ignore */ }
    // The dex could not resolve it. Show something a human can read rather than
    // leaking a raw id like "makeitrain" into the panel.
    return String(id).replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  /**
   * Our own active Pokemon, as the server told us: exact stats, exact moves.
   * `battle.myPokemon` is the authoritative copy of our team; the client
   * Pokemon object only carries what a spectator could see.
   */
  /**
   * Every slot we control this turn. Singles has one; doubles has two, and the
   * panel must not silently analyse only the left one.
   */
  function readMyActives(battle) {
    var out = [];
    try {
      var near = battle.nearSide || battle.mySide;
      var slots = (near && near.active) || [];
      for (var i = 0; i < slots.length; i++) {
        if (!slots[i]) continue;
        var one = readMyActive(battle, i);
        if (one) { one.slot = i; out.push(one); }
      }
    } catch (e) { /* fall through to empty */ }
    return out;
  }

  function readMyActive(battle, slot) {
    try {
      var near = battle.nearSide || battle.mySide;
      var active = near && near.active && near.active[slot || 0];
      if (!active) return null;

      var server = null;
      var list = battle.myPokemon || [];
      for (var i = 0; i < list.length; i++) {
        var sp = list[i];
        if (!sp) continue;
        if (sp.ident === active.ident || sp.speciesForme === active.speciesForme) { server = sp; break; }
      }

      return {
        species: active.speciesForme || '',
        level: active.level || (server && server.level) || 100,
        hp: active.hp, maxhp: active.maxhp,
        boosts: active.boosts || {},
        terastallized: active.terastallized || '',
        teraType: (server && server.teraType) || '',
        status: active.status || '',
        // exact values when the server gave them to us, else best-effort
        stats: server ? server.stats : null,
        item: server ? nameOf('items', server.item) : (active.item || ''),
        ability: server ? nameOf('abilities', server.ability || server.baseAbility)
          : (active.ability || active.baseAbility || ''),
        // Spectating: there is no server copy, so fall back to what is visible —
        // applying the same filters readPokemon() uses, or Transform-tagged
        // "*Move" and Struggle leak into the panel as if they were real moves.
        moves: server && server.moves ? server.moves.map(function (m) { return nameOf('moves', m); })
          : (active.moveTrack || [])
            .map(function (t) { return t && t[0]; })
            .filter(function (n) { return n && n.charAt(0) !== '*' && n !== 'Struggle'; }),
        // Whether these numbers are about OUR team or a team we are watching.
        spectating: !server
      };
    } catch (e) { return null; }
  }

  /**
   * Our whole team, merging the two views the client keeps:
   *   battle.myPokemon  — what the server told us (exact stats, exact moves)
   *   nearSide.pokemon  — what's visible in battle (HP, status, fainted)
   * The switch advisor needs every bench slot, not just the active one.
   */
  function readMyTeam(battle) {
    var out = [];
    try {
      var near = battle.nearSide || battle.mySide;
      var visible = (near && near.pokemon) || [];
      var server = battle.myPokemon || [];

      server.forEach(function (sp) {
        if (!sp) return;
        var vis = null;
        for (var i = 0; i < visible.length; i++) {
          if (visible[i].ident === sp.ident || visible[i].speciesForme === sp.speciesForme) { vis = visible[i]; break; }
        }
        out.push({
          species: sp.speciesForme || (vis && vis.speciesForme) || '',
          level: sp.level || (vis && vis.level) || 100,
          stats: sp.stats || null,
          // hp and maxhp must come from the SAME source or the ratio is
          // nonsense — the battle view and the server copy can use different
          // scales. Prefer the battle view, which is what's actually current.
          maxhp: (vis && vis.maxhp) || sp.maxhp || 0,
          hp: vis ? vis.hp : (sp.hp || 0),
          fainted: vis ? !!vis.fainted : false,
          status: (vis && vis.status) || '',
          boosts: (vis && vis.boosts) || {},
          active: vis ? (typeof vis.isActive === 'function' ? !!vis.isActive() : false) : !!sp.active,
          terastallized: (vis && vis.terastallized) || sp.terastallized || '',
          teraType: sp.teraType || '',
          item: nameOf('items', sp.item),
          ability: nameOf('abilities', sp.ability || sp.baseAbility),
          moves: (sp.moves || []).map(function (m) { return nameOf('moves', m); })
        });
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  /** Weather, terrain and screens — all of which move damage numbers a lot. */
  function readField(battle) {
    var out = { weather: '', terrain: '', near: {}, far: {} };
    try {
      out.weather = battle.weather || '';
      var pw = battle.pseudoWeather || [];
      for (var i = 0; i < pw.length; i++) {
        var id = toId(pw[i][0]);
        if (/terrain$/.test(id)) out.terrain = id;
        if (id === 'trickroom') out.trickRoom = true;
      }
      function screens(side) {
        var sc = (side && side.sideConditions) || {};
        return {
          reflect: !!sc.reflect,
          lightscreen: !!sc.lightscreen,
          auroraveil: !!sc.auroraveil,
          tailwind: !!sc.tailwind
        };
      }
      out.near = screens(battle.nearSide || battle.mySide);
      out.far = screens(battle.farSide);
    } catch (e) { /* ignore */ }
    return out;
  }

  function readSide(side, mine, ally) {
    if (!side) return null;
    var list = (side.pokemon || []).map(readPokemon).filter(Boolean);
    // Terastallization is once per side per battle, so the first Pokemon on
    // this side wearing a Tera type has spent it for all six.
    var teraUsed = false, teraUsedBy = '';
    for (var i = 0; i < list.length; i++) {
      if (!list[i].terastallized) continue;
      teraUsed = true; teraUsedBy = list[i].species || '';
      break;
    }
    return {
      id: side.sideid || side.id || '',
      name: side.name || '',
      totalPokemon: side.totalPokemon || 6,
      revealed: list.length,
      teraUsed: teraUsed,
      teraUsedBy: teraUsedBy,
      // Multi and Free-For-All have four sides, so "the opponent" isn't a
      // single side — flag ours (and our ally's) and let the panel take the rest.
      isNear: side === mine || (!!ally && side === ally),
      isAlly: !!ally && side === ally,
      pokemon: list
    };
  }

  var lastSerialized = '';

  var readFailures = 0, lastReadError = '';

  function pollClient() {
    var payloads = [];
    var focus = focusedRoomId();
    eachBattleRoom(function (roomid, room, battle) {
      try {
        var mine = battle.mySide || battle.nearSide || battle.p1;
        var ally = mine && mine.ally;
        var allSides = (battle.sides || []).map(function (s) { return readSide(s, mine, ally); })
          .filter(Boolean);
        var near = readSide(battle.nearSide || battle.mySide || battle.p1, mine, ally);
        var far = readSide(battle.farSide || battle.p2, mine, ally);
        payloads.push({
          source: 'client',
          roomid: roomid || battle.id || '',
          tier: battle.tier || '',
          gen: battle.gen || 0,
          gameType: battle.gameType || 'singles',
          turn: typeof battle.turn === 'number' ? battle.turn : -1,
          ended: !!battle.ended,
          isReplay: !!battle.isReplay,
          focused: !!focus && String(roomid) === focus,
          sides: allSides,
          near: near,
          far: far,
          myActive: readMyActive(battle, 0),
          myActives: readMyActives(battle),
          myTeam: readMyTeam(battle),
          field: readField(battle)
        });
      } catch (e) {
        // One bad room must not kill the poll — but it must not be silent
        // either. A panel frozen on turn 14 while the battle is on turn 45
        // looks completely alive and is worse than no panel at all.
        readFailures++;
        lastReadError = String((e && e.message) || e);
      }
    });

    if (!payloads.length) {
      if (readFailures) post('stalled', { error: lastReadError, at: Date.now() });
      protocolTick();
      return;
    }
    readFailures = 0;

    var ser = JSON.stringify(payloads);
    if (ser === lastSerialized) return;
    lastSerialized = ser;
    post('battles', payloads);
  }

  // =====================================================================
  // Reader 2 — Showdown protocol over the socket
  // =====================================================================

  var proto = { me: '', rooms: {} };
  var protoDirty = false;

  function toId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  function parseIdent(s) {
    // "p2a: Nickname" / "p2: Nickname"
    var m = /^(p[1-4])[a-z]?:\s*(.*)$/.exec(String(s || ''));
    return m ? { side: m[1], nick: m[2] } : null;
  }

  function parseDetails(s) {
    var parts = String(s || '').split(',').map(function (x) { return x.trim(); });
    var out = { species: parts[0] || '', level: 100, gender: 'N' };
    for (var i = 1; i < parts.length; i++) {
      var lm = /^L(\d+)$/.exec(parts[i]);
      if (lm) { out.level = parseInt(lm[1], 10); continue; }
      if (parts[i] === 'M' || parts[i] === 'F') out.gender = parts[i];
    }
    return out;
  }

  function room(id) {
    if (!proto.rooms[id]) proto.rooms[id] = { id: id, players: {}, mons: {}, turn: -1, ended: false };
    return proto.rooms[id];
  }

  function mon(r, side, nick) {
    var key = side + '|' + nick;
    if (!r.mons[key]) {
      r.mons[key] = {
        species: nick, name: nick, ident: side + ': ' + nick, side: side, level: 100,
        gender: 'N', fainted: false, moves: [], item: '', ability: '', terastallized: '',
        status: '', hp: 100, maxhp: 100, active: false, order: Object.keys(r.mons).length,
        moveUses: {}, lastMove: '', movesSinceSwitch: 0
      };
    }
    return r.mons[key];
  }

  /** The three items that lock a Pokemon into the move it just used. */
  var CHOICE_ITEMS = { choiceband: 1, choicespecs: 1, choicescarf: 1 };

  /**
   * `|replace|` — the active Pokemon on this side was an Illusion, and its real
   * identity is `nick`. Move everything it revealed onto the real entry and
   * drop the impersonation, which was never a Pokemon.
   */
  function claimDisguise(r, side, nick) {
    var newKey = side + '|' + nick;
    var oldKey = null;
    Object.keys(r.mons).forEach(function (k) {
      if (k.indexOf(side + '|') === 0 && r.mons[k].active && k !== newKey) oldKey = k;
    });
    if (!oldKey) return;
    var old = r.mons[oldKey];
    var real = mon(r, side, nick);
    // Species, level and gender come from the |replace| line itself; everything
    // below is what the disguise did in battle, which was really this Pokemon.
    old.moves.forEach(function (mv) {
      if (real.moves.indexOf(mv) === -1) real.moves.push(mv);
    });
    // The PP the disguise burned was really this Pokemon's PP.
    Object.keys(old.moveUses || {}).forEach(function (mv) {
      real.moveUses[mv] = (real.moveUses[mv] || 0) + old.moveUses[mv];
    });
    if (old.lastMove) real.lastMove = old.lastMove;
    ['item', 'ability', 'terastallized', 'status'].forEach(function (f) {
      if (!real[f] && old[f]) real[f] = old[f];
    });
    if (old.itemLost) real.itemLost = true;
    real.hp = old.hp; real.maxhp = old.maxhp;

    if (old.preview) {
      // Team preview already told us this species is on their team, so it stays
      // — but nothing it appeared to do was real. Wind it back to unseen.
      old.moves = []; old.item = ''; old.ability = ''; old.terastallized = '';
      old.status = ''; old.itemLost = false; old.active = false;
      old.moveUses = {}; old.lastMove = ''; old.movesSinceSwitch = 0;
      old.hp = 100; old.maxhp = 100;
      old.species = old.preview.species;
      old.level = old.preview.level;
      old.gender = old.preview.gender;
    } else {
      // We only ever saw the disguise. There is no evidence this Pokemon has
      // been on the field at all, so counting it as seen would be a lie.
      real.order = old.order;
      delete r.mons[oldKey];
    }
    protoDirty = true;
  }

  /**
   * Team preview files a Pokemon under its species; `|switch|` files it under
   * its nickname. Re-key the preview entry the first time the real one appears
   * so one Pokemon isn't counted twice.
   */
  function claimPreview(r, side, nick, species) {
    var newKey = side + '|' + nick;
    if (r.mons[newKey] || !species || nick === species) return;
    var oldKey = side + '|' + species;
    var prev = r.mons[oldKey];
    if (!prev || !prev.preview || prev.moves.length) return;
    delete r.mons[oldKey];
    prev.name = nick;
    prev.ident = side + ': ' + nick;
    prev.preview = false;
    r.mons[newKey] = prev;
    protoDirty = true;
  }

  function addMove(m, name) {
    if (!name || name === 'Struggle' || name.charAt(0) === '*') return;
    if (m.moves.indexOf(name) === -1) { m.moves.push(name); protoDirty = true; }
  }

  /**
   * A move actually went off — it may have missed, or been walled by Protect,
   * but the PP is spent and the turn is used. `|cant|` never reaches here, so a
   * flinch, a full paralysis or a sleep turn correctly counts as nothing.
   *
   * Struggle and Transform-gained moves are not part of the user's four, so
   * they stay out of `moveUses` (the client's own moveTrack does the same), but
   * Struggle is still the last thing it did and still consumed the turn.
   */
  function recordUse(m, name) {
    if (!name) return;
    if (name !== 'Struggle' && name.charAt(0) !== '*') {
      m.moveUses[name] = (m.moveUses[name] || 0) + 1;
    }
    m.lastMove = name;
    m.movesSinceSwitch = (m.movesSinceSwitch || 0) + 1;
    protoDirty = true;
  }

  function handleLine(roomid, line) {
    if (!line || line.charAt(0) !== '|') return;
    var p = line.split('|');
    var cmd = p[1];

    if (cmd === 'updateuser') { proto.me = toId(p[2]); return; }
    if (!roomid) return;

    var r, id, m, i;
    switch (cmd) {
      case 'init':
        // A reconnect replays the entire battle log. Start clean, or every
        // move's use count doubles — and a move counted as out of PP is
        // dropped from the threat ranking, which turns a lethal hit invisible.
        if (p[2] === 'battle') {
          delete proto.rooms[roomid];
          room(roomid);
          protoDirty = true;
        }
        return;
      case 'player':
        r = room(roomid);
        if (p[2] && p[3]) { r.players[p[2]] = p[3]; protoDirty = true; }
        return;
      case 'poke':
        r = room(roomid);
        if (p[2] && p[3]) {
          var d0 = parseDetails(p[3]);
          m = mon(r, p[2], d0.species);
          m.species = d0.species; m.level = d0.level;
          // claimPreview() re-keys this on switch-in; claimDisguise() restores
          // it if the thing that switched in turned out to be an Illusion.
          m.preview = { species: d0.species, level: d0.level, gender: d0.gender };
          protoDirty = true;
        }
        return;
      case 'switch': case 'drag': case 'replace':
      case 'detailschange': case '-formechange':
        r = room(roomid); id = parseIdent(p[2]);
        if (!id) return;
        var d = parseDetails(p[3]);
        // Illusion breaking: everything this slot revealed while disguised
        // belongs to the Pokemon whose real name we're only now learning. Left
        // alone, Zoroark reads as a blank slate while the impersonated species
        // carries moves it cannot learn — and the side grows a seventh member.
        // Team preview keys by species, |switch| keys by nickname, so the same
        // Pokemon can be filed twice — once as a ghost that is never active.
        if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
          claimPreview(r, id.side, id.nick, d.species);
        }
        if (cmd === 'replace') claimDisguise(r, id.side, id.nick);
        m = mon(r, id.side, id.nick);
        m.species = d.species; m.level = d.level; m.gender = d.gender;
        if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
          Object.keys(r.mons).forEach(function (k) {
            // Leaving the field ends any Choice lock, and arriving on it starts
            // the count over, so the whole side goes back to zero here.
            if (k.indexOf(id.side + '|') === 0) {
              r.mons[k].active = false;
              r.mons[k].movesSinceSwitch = 0;
            }
          });
          m.active = true;
          m.movesSinceSwitch = 0;
        }
        protoDirty = true;
        return;
      case 'move':
        r = room(roomid); id = parseIdent(p[2]);
        if (!id) return;
        // Skip moves attributed to another effect (Copycat, Metronome, Dancer,
        // Magic Bounce...). Sleep Talk and lockedmove are genuinely theirs.
        for (i = 4; i < p.length; i++) {
          var fm = /^\[from\](.*)$/.exec(p[i]);
          if (!fm) continue;
          // The protocol sends the effect's FULLNAME, not its id — a move
          // arrives as "move: Sleep Talk", so toId() alone yields
          // "movesleeptalk" and matches nothing. lockedmove only survived that
          // because a Condition's fullname carries no prefix. Strip the prefix
          // first; otherwise every Rest/Sleep Talk set in the format silently
          // under-reports its moveset.
          var src = toId(String(fm[1]).replace(/^\s*(?:move|ability|item|condition):\s*/i, ''));
          if (src && src !== 'lockedmove' && src !== 'sleeptalk') return;
        }
        m = mon(r, id.side, id.nick);
        addMove(m, p[3]);
        recordUse(m, p[3]);
        return;
      case '-item':
        r = room(roomid); id = parseIdent(p[2]);
        if (id && p[3]) { mon(r, id.side, id.nick).item = p[3]; protoDirty = true; }
        return;
      case '-enditem':
        r = room(roomid); id = parseIdent(p[2]);
        if (id && p[3]) {
          m = mon(r, id.side, id.nick);
          m.item = p[3]; m.itemLost = true;
          // Knock Off / Trick / Corrosive Gas taking a Choice item ends the
          // lock mid-stint, so the moves it made before that prove nothing.
          if (CHOICE_ITEMS[toId(p[3])]) m.movesSinceSwitch = 0;
          protoDirty = true;
        }
        return;
      case '-ability':
        r = room(roomid); id = parseIdent(p[2]);
        if (id && p[3]) { m = mon(r, id.side, id.nick); if (!m.ability) m.ability = p[3]; protoDirty = true; }
        return;
      case '-terastallize':
        r = room(roomid); id = parseIdent(p[2]);
        if (id && p[3]) { mon(r, id.side, id.nick).terastallized = p[3]; protoDirty = true; }
        return;
      case 'faint':
        r = room(roomid); id = parseIdent(p[2]);
        if (id) { mon(r, id.side, id.nick).fainted = true; protoDirty = true; }
        return;
      case '-damage': case '-heal': case '-sethp':
        r = room(roomid); id = parseIdent(p[2]);
        if (id && p[3]) {
          m = mon(r, id.side, id.nick);
          var hm = /^(\d+)\s*\/\s*(\d+)/.exec(p[3]);
          if (hm) { m.hp = +hm[1]; m.maxhp = +hm[2]; }
          else if (/^0( |$)/.test(p[3])) m.hp = 0;
          var sm = /\b(brn|psn|tox|par|slp|frz)\b/.exec(p[3]);
          if (sm) m.status = sm[1];
          protoDirty = true;
        }
        return;
      case '-status':
        r = room(roomid); id = parseIdent(p[2]);
        if (id && p[3]) { mon(r, id.side, id.nick).status = p[3]; protoDirty = true; }
        return;
      case '-curestatus':
        r = room(roomid); id = parseIdent(p[2]);
        if (id) { mon(r, id.side, id.nick).status = ''; protoDirty = true; }
        return;
      case 'turn':
        r = room(roomid); r.turn = parseInt(p[2], 10) || r.turn; protoDirty = true;
        return;
      case 'win': case 'tie':
        r = room(roomid); r.ended = true; protoDirty = true;
        return;
      case 'deinit': case 'noinit':
        delete proto.rooms[roomid]; protoDirty = true;
        return;
      default:
        return;
    }
  }

  function handleChunk(text) {
    if (typeof text !== 'string' || !text) return;
    var lines = text.split('\n');
    var roomid = '';
    var start = 0;
    if (lines[0].charAt(0) === '>') { roomid = lines[0].slice(1).trim(); start = 1; }
    for (var i = start; i < lines.length; i++) {
      try { handleLine(roomid, lines[i]); } catch (e) { /* keep parsing */ }
    }
  }

  function handleFrame(data) {
    if (typeof data !== 'string' || !data.length) return;
    var c = data.charAt(0);
    if (c === 'o' || c === 'h' || c === 'c') return;          // SockJS control frames
    if (c === 'a') {                                          // SockJS array frame
      var arr;
      try { arr = JSON.parse(data.slice(1)); } catch (e) { return; }
      if (!Array.isArray(arr)) return;
      for (var i = 0; i < arr.length; i++) handleChunk(arr[i]);
      return;
    }
    if (c === 'm') {                                          // SockJS single-message frame
      var one;
      try { one = JSON.parse(data.slice(1)); } catch (e) { return; }
      handleChunk(one);
      return;
    }
    handleChunk(data);                                        // raw websocket
  }

  var lastProtoSer = '';

  function protocolTick() {
    if (!protoDirty) return;
    protoDirty = false;
    var payloads = [];
    Object.keys(proto.rooms).forEach(function (rid) {
      var r = proto.rooms[rid];
      if (!/^battle-/.test(rid)) return;

      // Which side is the opponent? Whichever isn't us. Spectating: p2.
      var foeSide = 'p2';
      if (proto.me) {
        Object.keys(r.players).forEach(function (sid) {
          if (toId(r.players[sid]) === proto.me) foeSide = (sid === 'p1') ? 'p2' : 'p1';
        });
      }
      var nearSide = foeSide === 'p2' ? 'p1' : 'p2';

      function collect(sid) {
        var out = [];
        var teraUsed = false, teraUsedBy = '';
        Object.keys(r.mons).forEach(function (k) {
          if (k.indexOf(sid + '|') !== 0) return;
          var m = r.mons[k];
          // One Terastallization per side per battle: whoever spent it spent
          // it for the whole team.
          if (!teraUsed && m.terastallized) { teraUsed = true; teraUsedBy = m.species || ''; }
          var uses = {};
          Object.keys(m.moveUses).forEach(function (mv) { uses[mv] = m.moveUses[mv]; });
          out.push({
            species: m.species, name: m.name, ident: m.ident, level: m.level,
            gender: m.gender, fainted: m.fainted, hp: m.hp, maxhp: m.maxhp,
            status: m.status, moves: m.moves.slice(), item: m.item,
            itemLost: !!m.itemLost, ability: m.ability,
            terastallized: m.terastallized, boosts: {}, active: m.active,
            baseSpe: null, types: null,
            moveUses: uses, lastMove: m.lastMove || '',
            movesSinceSwitch: m.movesSinceSwitch || 0
          });
        });
        return {
          id: sid, name: r.players[sid] || '', totalPokemon: 6, revealed: out.length,
          teraUsed: teraUsed, teraUsedBy: teraUsedBy, pokemon: out
        };
      }

      payloads.push({
        source: 'protocol',
        roomid: rid, tier: '', gen: 0, gameType: 'singles',
        turn: r.turn, ended: r.ended, isReplay: false,
        focused: rid === focusedRoomId(),
        near: collect(nearSide), far: collect(foeSide)
      });
    });
    if (!payloads.length) return;
    var ser = JSON.stringify(payloads);
    if (ser === lastProtoSer) return;
    lastProtoSer = ser;
    post('battles', payloads);
  }

  // ---- socket taps -----------------------------------------------------

  try {
    var NativeWS = window.WebSocket;
    if (NativeWS) {
      window.WebSocket = new Proxy(NativeWS, {
        construct: function (Target, args, newTarget) {
          // Reflect.construct preserves new.target, so `class X extends WebSocket`
          // still yields an X. `new Target(...)` silently dropped the subclass.
          var ws = Reflect.construct(Target, args, newTarget || Target);
          try {
            ws.addEventListener('message', function (ev) { handleFrame(ev.data); });
          } catch (e) { /* ignore */ }
          return ws;
        }
      });
    }
  } catch (e) { console.warn('[randbats-live] websocket tap unavailable', e); }

  // SockJS can fall back to xhr-streaming/polling on restrictive networks.
  try {
    var openOrig = XMLHttpRequest.prototype.open;
    var sendOrig = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { if (/\/showdown\//.test(String(url))) this.__rblWatch = true; } catch (e) { /* ignore */ }
      return openOrig.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (xhr.__rblWatch) {
        var seen = 0;
        xhr.addEventListener('progress', function () {
          try {
            var t = xhr.responseText || '';
            if (t.length <= seen) return;
            var chunk = t.slice(seen); seen = t.length;
            chunk.split('\n').forEach(function (l) { if (l) handleFrame(l); });
          } catch (e) { /* ignore */ }
        });
      }
      return sendOrig.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  // ---- run -------------------------------------------------------------

  // Only ONE reader ticks. pollClient falls through to protocolTick when the
  // client objects give it nothing; running both on their own intervals made
  // them race, and the fallback — which ships no field, no team and no base
  // stats — won every other tick.
  setInterval(pollClient, POLL_MS);
  pollClient();

  // ---- description lookups --------------------------------------------
  // The client ships the full item/ability/move dex, so the panel can explain
  // what a predicted item or ability actually does. Only the isolated world
  // knows which names are on screen, so it asks and we answer.

  function lookup(kind, name) {
    try {
      var dex = window.Dex && window.Dex[kind];
      var e = dex && dex.get(name);
      if (e && e.exists !== false && e.name) return e;
    } catch (err) { /* ignore */ }
    return null;
  }

  function describe(query) {
    var out = { items: {}, abilities: {}, moves: {} };

    (query.items || []).forEach(function (n) {
      var e = lookup('items', n);
      out.items[n] = e ? { short: e.shortDesc || e.desc || '' } : { short: '' };
    });

    (query.abilities || []).forEach(function (n) {
      var e = lookup('abilities', n);
      out.abilities[n] = e ? { short: e.shortDesc || e.desc || '' } : { short: '' };
    });

    (query.moves || []).forEach(function (n) {
      var e = lookup('moves', n);
      if (!e) { out.moves[n] = { short: '' }; return; }
      out.moves[n] = {
        short: e.shortDesc || e.desc || '',
        type: e.type || '',
        category: e.category || '',
        bp: e.basePower || 0,
        // accuracy is `true` for moves that bypass accuracy checks
        acc: e.accuracy === true ? null : (e.accuracy || null),
        prio: e.priority || 0,
        // Random Battle sets carry no PP Ups, so the base value IS the maximum.
        // The panel uses it with moveUses to say when a move is spent.
        pp: e.pp || 0
      };
    });

    return out;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__rbl !== TAG) return;
    if (ev.data.type === 'resync') { lastSerialized = ''; lastProtoSer = ''; protoDirty = true; pollClient(); }
    if (ev.data.type === 'describe') post('descs', describe(ev.data.payload || {}));
  });

  post('ready', { at: Date.now() });
})();
