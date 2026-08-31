/*
 * Randsight — overlay rendering.
 * Pure DOM construction (no innerHTML anywhere, so nothing from the battle log
 * can be interpreted as markup). Owns the panel element and its chrome;
 * content.js feeds it a view model.
 */
(function (root) {
  'use strict';

  var el, headSub, body, foot, tabBar, themeBtn, collapseBtn, state = {
    collapsed: false, light: false, expanded: {}, pos: null, size: null, tab: 'sets'
  };
  var lastView = null;
  var onPersist = function () {};
  var uid = 0;
  function nextId(p) { uid += 1; return p + '-' + uid; }

  var TABS = [['sets', 'Sets'], ['damage', 'Damage'], ['switch', 'Switch']];

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function pct(p) {
    if (p >= 0.9995) return '100%';
    if (p < 0.001) return '<0.1%';
    if (p < 0.0995) return (p * 100).toFixed(1) + '%';
    return Math.round(p * 100) + '%';
  }

  /* Percentages read aloud as "71 percent", not "71 %" or "71". A screen
     reader gets a sentence; the eye keeps the compact glyph. */
  function pctWords(p) {
    if (p >= 0.9995) return 'certain';
    if (p < 0.001) return 'under 0.1 percent';
    if (p < 0.0995) return (p * 100).toFixed(1) + ' percent';
    return Math.round(p * 100) + ' percent';
  }

  // Glyphs for the redundant non-colour cues. One vocabulary across the panel:
  // ✓ confirmed / safe, ✕ ruled out / lethal, ⊘ cannot happen, ⚠ bad news.
  var CUE = { yes: '✓', no: '✕', none: '⊘', warn: '⚠' };

  /* Redundant, non-colour cue. The glyph is painted from the attribute by CSS
     (`[data-cue]::before { content: attr(data-cue) }`) so it never lands in
     textContent — the panel's other suites read textContent directly, and a
     colour-blind user still gets a mark they can see. */
  function cue(node, glyph, stateName) {
    if (glyph) node.setAttribute('data-cue', glyph);
    if (stateName) node.setAttribute('data-state', stateName);
    return node;
  }

  function label(node, text) {
    if (text) node.setAttribute('aria-label', text);
    return node;
  }

  /** A middot between items. Punctuation, not content — and at the old
      --rs-line colour it was 1.4:1 text, so it now uses a real text token. */
  function sep() {
    var s = h('span', 'rs-sep', '·');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  // -------------------------------------------------------------------
  // panel chrome
  // -------------------------------------------------------------------

  function build() {
    if (el) return el;
    el = h('div'); el.id = 'rs-panel';
    // A landmark with a name: the panel is findable, and everything below it is
    // announced as belonging to something rather than floating in the page.
    el.setAttribute('role', 'complementary');
    el.setAttribute('aria-label', 'Randsight — opponent set predictions');

    var head = h('div'); head.id = 'rs-head';
    var title = h('span', null, 'Randsight'); title.id = 'rs-title';
    headSub = h('span', null, ''); headSub.id = 'rs-sub';

    themeBtn = h('button', 'rs-btn', '◐');
    themeBtn.type = 'button';
    themeBtn.title = 'Toggle light / dark';
    themeBtn.setAttribute('aria-label', 'Light theme');
    themeBtn.setAttribute('aria-pressed', 'false');
    themeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      state.light = !state.light;
      el.classList.toggle('rs-light', state.light);
      themeBtn.setAttribute('aria-pressed', state.light ? 'true' : 'false');
      onPersist(state);
    });

    collapseBtn = h('button', 'rs-btn', '—');
    collapseBtn.type = 'button';
    collapseBtn.title = 'Collapse';
    collapseBtn.setAttribute('aria-label', 'Collapse panel');
    collapseBtn.setAttribute('aria-expanded', 'true');
    collapseBtn.setAttribute('aria-controls', 'rs-body');
    collapseBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      state.collapsed = !state.collapsed;
      el.classList.toggle('rs-collapsed', state.collapsed);
      collapseBtn.textContent = state.collapsed ? '+' : '—';
      syncCollapseBtn();
      onPersist(state);
    });

    head.appendChild(title);
    head.appendChild(headSub);
    head.appendChild(themeBtn);
    head.appendChild(collapseBtn);

    tabBar = h('div'); tabBar.id = 'rs-tabs';
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'Panel views');
    TABS.forEach(function (t) {
      var b = h('button', 'rs-tab', t[1]);
      b.type = 'button';
      b.id = 'rs-tab-' + t[0];
      b.dataset.tab = t[0];
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'rs-body');
      b.setAttribute('aria-selected', 'false');
      b.tabIndex = -1;
      b.addEventListener('click', function () { selectTab(t[0], false); });
      tabBar.appendChild(b);
    });
    // Standard tablist keyboard model: arrows move (and activate), Home/End jump.
    tabBar.addEventListener('keydown', function (e) {
      var keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
      var i = TABS.map(function (t) { return t[0]; }).indexOf(state.tab);
      var next = -1;
      if (e.key in keys) next = (i + keys[e.key] + TABS.length) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      if (next < 0) return;
      e.preventDefault();
      selectTab(TABS[next][0], true);
    });

    body = h('div'); body.id = 'rs-body';
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', 'rs-tab-sets');
    // The panel is a scroll container, so it needs to be reachable by keyboard
    // for anyone who scrolls with the arrow keys rather than a wheel.
    body.tabIndex = 0;
    foot = h('div'); foot.id = 'rs-foot';

    el.appendChild(head);
    el.appendChild(tabBar);
    el.appendChild(body);
    el.appendChild(foot);
    document.body.appendChild(el);

    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && tip && tip.style.display !== 'none') hideTip(true);
    });

    makeDraggable(head);
    window.addEventListener('resize', function () {
      if (!state.pos || !state.pos.left) return;
      el.style.left = clampLeft(parseFloat(el.style.left)) + 'px';
      el.style.top = clampTop(parseFloat(el.style.top)) + 'px';
    });
    trackResize();
    syncTabs();
    return el;
  }

  function syncCollapseBtn() {
    if (!collapseBtn) return;
    collapseBtn.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
    collapseBtn.setAttribute('aria-label', state.collapsed ? 'Expand panel' : 'Collapse panel');
    collapseBtn.title = state.collapsed ? 'Expand' : 'Collapse';
  }

  function selectTab(key, moveFocus) {
    state.tab = key;
    syncTabs();
    if (moveFocus) {
      var b = tabBar.querySelector('#rs-tab-' + key);
      if (b) b.focus();
    }
    // Render BEFORE persisting: the persist handler triggers a recompute, and
    // if that throws, the tab bar must not be left pointing at a tab whose body
    // never drew — that state was permanent.
    if (lastView) render(lastView);
    onPersist(state);
  }

  function syncTabs() {
    if (!tabBar) return;
    [].forEach.call(tabBar.children, function (b) {
      var on = b.dataset.tab === state.tab;
      b.classList.toggle('rs-tab-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      // Roving tabindex: the tablist is one Tab stop, arrows move within it.
      b.tabIndex = on ? 0 : -1;
    });
    if (body) body.setAttribute('aria-labelledby', 'rs-tab-' + state.tab);
  }

  // A saved position from a bigger screen must not put the panel — and its drag
  // handle — somewhere the user can never reach it again.
  function clampLeft(x) {
    if (!isFinite(x)) return 16;
    var w = el.offsetWidth || 340;
    return Math.min(Math.max(x, 0), Math.max(window.innerWidth - Math.min(w, 120), 0));
  }
  function clampTop(y) {
    if (!isFinite(y)) return 64;
    return Math.min(Math.max(y, 0), Math.max(window.innerHeight - 30, 0));
  }

  /** Put the panel back where it started. The popup offers this as an escape. */
  function resetLayout() {
    build();
    state.pos = null; state.size = null; state.collapsed = false;
    el.style.left = ''; el.style.top = ''; el.style.right = '';
    el.style.width = ''; el.style.height = '';
    el.classList.remove('rs-collapsed');
    onPersist(state);
  }

  function makeDraggable(handle) {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      // Dragging from a button swallowed its focus (mousedown preventDefault),
      // so the theme and collapse controls never showed a focus ring on click.
      if (e.target.closest && e.target.closest('button')) return;
      dragging = true;
      var r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      el.style.right = 'auto';
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var w = el.offsetWidth, hgt = el.offsetHeight;
      var x = Math.min(Math.max(ox + e.clientX - sx, 0), window.innerWidth - Math.min(w, 120));
      var y = Math.min(Math.max(oy + e.clientY - sy, 0), window.innerHeight - 30);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      state.pos = { left: el.style.left, top: el.style.top };
      onPersist(state);
    });
  }

  function trackResize() {
    if (typeof ResizeObserver !== 'function') return;
    var t = null;
    new ResizeObserver(function () {
      if (state.collapsed) return;
      clearTimeout(t);
      t = setTimeout(function () {
        state.size = { width: el.style.width, height: el.style.height };
        onPersist(state);
      }, 400);
    }).observe(el);
  }

  function applyState(saved) {
    build();
    if (!saved) return;
    state = Object.assign(state, saved);
    el.classList.toggle('rs-light', !!state.light);
    el.classList.toggle('rs-collapsed', !!state.collapsed);
    themeBtn.setAttribute('aria-pressed', state.light ? 'true' : 'false');
    syncCollapseBtn();
    if (state.pos && state.pos.left) {
      el.style.right = 'auto';
      el.style.left = clampLeft(parseFloat(state.pos.left)) + 'px';
      el.style.top = clampTop(parseFloat(state.pos.top)) + 'px';
    } else {
      // Cleared — go back to the stylesheet's corner. Without this the panel
      // keeps whatever inline offsets it already had, so a reset does nothing.
      el.style.left = ''; el.style.top = ''; el.style.right = '';
    }
    if (state.size && state.size.width) {
      el.style.width = state.size.width;
      if (state.size.height) el.style.height = state.size.height;
    } else {
      el.style.width = ''; el.style.height = '';
    }
    if (['damage', 'switch'].indexOf(state.tab) < 0) state.tab = 'sets';
    syncTabs();
    var cb = el.querySelectorAll('#rs-head .rs-btn');
    if (cb.length) cb[cb.length - 1].textContent = state.collapsed ? '+' : '—';
  }

  // -------------------------------------------------------------------
  // rows
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // tooltip — explains what a predicted move / item / ability actually does
  // -------------------------------------------------------------------

  var tip = null, tipHideTimer = null;

  function ensureTip() {
    if (tip) return tip;
    tip = h('div'); tip.id = 'rs-tip';
    tip.setAttribute('role', 'tooltip');
    el.appendChild(tip);
    return tip;
  }

  function moveMeta(info) {
    var bits = [];
    if (info.type) bits.push(info.type);
    if (info.category && info.category !== 'Status') bits.push(info.category);
    if (info.bp) bits.push(info.bp + ' BP');
    if (info.acc) bits.push(info.acc + '%');
    if (info.prio) bits.push((info.prio > 0 ? '+' : '') + info.prio + ' prio');
    return bits.join(' · ');
  }

  function showTip(row, name, info) {
    if (!info || !info.short) return;
    var t = ensureTip();
    t.textContent = '';
    t.appendChild(h('div', 'rs-tip-t', name));
    var meta = moveMeta(info);
    if (meta) t.appendChild(h('div', 'rs-tip-m', meta));
    t.appendChild(h('div', 'rs-tip-d', info.short));

    // Anchor to the row, flipping above when there isn't room below.
    var pr = el.getBoundingClientRect();
    var rr = row.getBoundingClientRect();
    t.style.visibility = 'hidden';
    t.style.display = 'block';
    var th = t.offsetHeight;
    var below = rr.bottom - pr.top + 6;
    var above = rr.top - pr.top - th - 6;
    var top = (rr.bottom + th + 10 < window.innerHeight || above < 0) ? below : above;
    t.style.top = top + 'px';
    t.style.visibility = '';
    clearTimeout(tipHideTimer);
    // The description only counts as an accessible description while it is
    // actually on screen, so the reference is attached and removed with it.
    if (tipOwner && tipOwner !== row) tipOwner.removeAttribute('aria-describedby');
    tipOwner = row;
    row.setAttribute('aria-describedby', 'rs-tip');
  }

  var tipOwner = null;

  function hideTip(now) {
    if (!tip) return;
    if (tipOwner) { tipOwner.removeAttribute('aria-describedby'); tipOwner = null; }
    clearTimeout(tipHideTimer);
    if (now) { tip.style.display = 'none'; return; }
    tipHideTimer = setTimeout(function () { tip.style.display = 'none'; }, 80);
  }

  /* A tooltip that only answers to the mouse is a tooltip a keyboard user can
     never read. Every hoverable thing is also a Tab stop that opens on focus,
     and Escape dismisses it (WCAG 1.4.13). */
  function attachTip(node, name, info) {
    if (!info || !info.short) return node;
    node.classList.add('rs-has-tip');
    if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
    node.addEventListener('mouseenter', function () { showTip(node, name, info); });
    node.addEventListener('mouseleave', function () { hideTip(); });
    node.addEventListener('focus', function () { showTip(node, name, info); });
    node.addEventListener('blur', function () { hideTip(true); });
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && tip && tip.style.display !== 'none') {
        e.stopPropagation();
        hideTip(true);
      }
    });
    return node;
  }

  /** The decorative bar behind a row. Its value is always spelled out in the
      text beside it, so the bar is hidden from assistive tech rather than read
      as a second, unlabelled copy of the same number. */
  function bar(cls, widthPct) {
    var fill = h('i', cls);
    fill.style.width = widthPct;
    fill.setAttribute('aria-hidden', 'true');
    return fill;
  }

  function probRow(name, prob, revealed, dead, info, pp) {
    var spent = pp && pp.spent;
    var row = h('div', 'rs-row' + (revealed ? ' rs-rev' : '') +
      (!revealed && prob >= 0.9995 ? ' rs-sure' : '') +
      (dead || spent ? ' rs-dead' : '') + (spent ? ' rs-spent' : ''));
    row.setAttribute('role', 'listitem');
    row.appendChild(bar('rs-fill', Math.max(prob * 100, 0).toFixed(1) + '%'));
    var nameEl = h('span', 'rs-row-name');
    nameEl.appendChild(h('span', 'rs-mv', name));
    // PP is a hard fact, so it outranks the probability in the right-hand slot.
    if (pp && (spent || pp.ppLeft !== undefined)) {
      nameEl.appendChild(h('span', 'rs-lv',
        spent ? ' \u00b7 no PP' : ' \u00b7 ' + pp.ppLeft + ' PP left'));
    }
    row.appendChild(nameEl);
    row.appendChild(h('span', 'rs-row-pct', revealed ? 'seen' : pct(prob)));

    // Colour says revealed / impossible / predicted; so now do a glyph, a
    // strike-through and the word in the right-hand column.
    if (spent) cue(row, CUE.no, 'spent');
    else if (revealed) cue(row, CUE.yes, 'seen');
    else if (dead) cue(row, CUE.no, 'dead');

    label(row, name + ', ' + (spent ? 'no PP left'
      : revealed ? 'seen'
        : pctWords(prob) +
          (pp && pp.ppLeft !== undefined ? ', ' + pp.ppLeft + ' PP left' : '')));

    attachTip(row, name, info);
    return row;
  }

  /** Small column labels under a section title — every number gets a name. */
  function colHeads(labels) {
    var row = h('div', 'rs-cols');
    // Hidden from assistive tech: every row repeats these words in its own
    // label, so read aloud they would be three orphan fragments per section.
    row.setAttribute('aria-hidden', 'true');
    labels.forEach(function (l) {
      var c = h('span', 'rs-col-' + l.k, l.t);
      row.appendChild(c);
    });
    return row;
  }

  var VERDICT_CUE = { good: CUE.yes, bad: CUE.warn, ok: '' };

  function verdictLine(text, tone) {
    var v = h('div', 'rs-verdict rs-v-' + (tone || 'ok'), text);
    cue(v, VERDICT_CUE[tone || 'ok'], tone || 'ok');
    return v;
  }

  function section(titleText, rightText) {
    var sec = h('div', 'rs-sec');
    sec.setAttribute('role', 'group');
    sec.setAttribute('aria-label', titleText + (rightText ? ', ' + rightText : ''));
    var t = h('div', 'rs-sec-t');
    t.appendChild(h('span', null, titleText));
    if (rightText) t.appendChild(h('span', null, rightText));
    sec.appendChild(t);
    return sec;
  }

  /** Rows carry role="listitem", so they need a list to sit in. A plain
      wrapper: every suite selects rows as descendants, not children. */
  function rowList(name) {
    var l = h('div', 'rs-rows');
    l.setAttribute('role', 'list');
    if (name) l.setAttribute('aria-label', name);
    return l;
  }

  // -------------------------------------------------------------------
  // pokemon card
  // -------------------------------------------------------------------

  function monCard(vm) {
    var key = vm.key;
    var open = state.expanded[key];
    if (open === undefined) open = vm.active;

    var card = h('div', 'rs-mon' + (vm.active ? ' rs-active' : '') +
      (vm.fainted ? ' rs-fainted' : '') + (open ? ' rs-open' : ''));

    var bodyId = nextId('rs-mon-body');
    // A real button, not a div with a click handler: Tab reaches it, Enter and
    // Space work, and the expanded/collapsed state is announced.
    var head = h('button', 'rs-mon-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.setAttribute('aria-controls', bodyId);
    var icon = h('span', 'rs-icon');
    icon.setAttribute('aria-hidden', 'true');
    // The icon style comes from the page's own Dex function. It is the one
    // string the panel takes from the page and uses as CSS rather than text, so
    // allow only the shape Showdown actually returns and drop anything else.
    if (vm.icon && /^[-a-zA-Z0-9_:;.,#()%\/?&=+'"\s]*$/.test(vm.icon) && vm.icon.length < 400) {
      icon.setAttribute('style', vm.icon);
    }
    else if (vm.spriteUrl) {
      icon.style.backgroundImage = 'url(' + vm.spriteUrl + ')';
      icon.style.backgroundSize = 'contain';
      icon.style.backgroundPosition = 'center';
    }
    head.appendChild(icon);

    var nameWrap = h('span', 'rs-name', vm.species);
    if (vm.level) nameWrap.appendChild(h('span', 'rs-lv', ' L' + vm.level));
    head.appendChild(nameWrap);

    // In Multi / Free-For-All there is more than one opposing player, so each
    // card has to say whose Pokemon it is.
    if (vm.owner) head.appendChild(h('span', 'rs-chip rs-chip-owner', vm.owner));

    // "Fainted" used to be carried by a 45% opacity wash and an "FNT" chip.
    // One chip, in words: no extra row, and it survives any colour deficiency.
    if (vm.status && String(vm.status).toLowerCase() !== 'fnt') {
      head.appendChild(h('span', 'rs-chip rs-chip-status', vm.status));
    }
    if (vm.tera) head.appendChild(h('span', 'rs-chip rs-chip-tera', 'Tera ' + vm.tera));
    if (vm.fainted) head.appendChild(h('span', 'rs-chip rs-chip-out', 'fainted'));
    var slotChip = h('span', 'rs-chip' + (vm.slotsKnown >= vm.slotsTotal ? ' rs-chip-known' : ''),
      vm.slotsKnown + '/' + vm.slotsTotal);
    if (vm.slotsKnown >= vm.slotsTotal) cue(slotChip, CUE.yes);
    head.appendChild(slotChip);

    label(head, [
      vm.species,
      vm.level ? 'level ' + vm.level : '',
      vm.active ? 'on the field' : '',
      vm.fainted ? 'fainted' : '',
      vm.owner ? "on " + vm.owner + "'s team" : '',
      vm.status ? 'status ' + vm.status : '',
      vm.tera ? 'Terastallized to ' + vm.tera : '',
      vm.slotsKnown + ' of ' + vm.slotsTotal + ' move slots known'
    ].filter(Boolean).join(', '));

    head.addEventListener('click', function () {
      var nowOpen = !card.classList.contains('rs-open');
      card.classList.toggle('rs-open', nowOpen);
      head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      state.expanded[key] = nowOpen;
      onPersist(state);
    });
    card.appendChild(head);

    if (typeof vm.hpPct === 'number' && vm.hpPct < 100) {
      // The one bar with no number beside it, so it carries its own name.
      var hpBar = h('div', 'rs-hp' + (vm.hpPct <= 20 ? ' rs-hp-low' : vm.hpPct <= 50 ? ' rs-hp-mid' : ''));
      hpBar.setAttribute('role', 'img');
      label(hpBar, Math.max(Math.round(vm.hpPct), 0) + ' percent HP left' +
        (vm.hpPct <= 20 ? ', critical' : vm.hpPct <= 50 ? ', low' : ''));
      var hpFill = h('i'); hpFill.style.width = Math.max(vm.hpPct, 0) + '%';
      hpBar.appendChild(hpFill);
      card.appendChild(hpBar);
    }

    var b = h('div', 'rs-mon-body');
    b.id = bodyId;

    if (vm.unsupported) {
      b.appendChild(h('div', 'rs-note', vm.unsupported));
      card.appendChild(b);
      return card;
    }

    // Anything effectively settled becomes one muted line of plain text at the
    // bottom of the card. Only genuine uncertainty earns a section with bars.
    var facts = [];

    // Item, ability, Tera and role are one answer each, not a ranking to study.
    // Settled -> a word on the facts line. Unsettled -> one compact line of
    // "name pct" instead of a whole section of bars, which is what made a card
    // look like a spreadsheet.
    function attr(heading, arr, limit) {
      if (!arr || !arr.length) return null;
      var top = arr[0];
      // Collapsing to text must not cost the description — the fact keeps its
      // tooltip, so hovering "Choice Scarf" still explains what it does.
      if (top.revealed || top.prob >= 0.95) {
        facts.push({ text: top.name, info: top.info, revealed: top.revealed });
        return null;
      }
      var line = h('div', 'rs-line');
      line.setAttribute('role', 'group');
      line.setAttribute('aria-label', heading);
      line.appendChild(h('b', null, heading));
      arr.slice(0, limit).forEach(function (x, i) {
        if (x.prob < 0.01 && !x.revealed) return;
        if (i) line.appendChild(sep());
        var span = h('span', 'rs-opt' + (x.revealed ? ' rs-fact-seen' : ''),
          x.name + ' ' + pct(x.prob));
        if (x.revealed) cue(span, CUE.yes, 'seen');
        label(span, x.name + ', ' + (x.revealed ? 'seen' : pctWords(x.prob)));
        attachTip(span, x.name, x.info);
        line.appendChild(span);
      });
      return line;
    }
    function factOrSection(heading, arr, limit) {
      var line = attr(heading, arr, limit);
      if (line) b.appendChild(line);
    }

    // A species with only one possible role isn't telling you anything.
    if (vm.roles && vm.roles.length && (vm.rolesTotal || vm.roles.length) > 1) {
      factOrSection('Role', vm.roles, 3);
    }

    // ---- moves --------------------------------------------------------
    // A card used to print every option down to a fraction of a percent —
    // 8+ rows where 4 mattered. Show what's actually live; put the long tail
    // behind one click.
    var MINOR = 0.15;
    var primary = [], minor = [];
    vm.moves.forEach(function (m) {
      if (m.revealed || m.prob >= MINOR) primary.push(m);
      else if (m.prob >= 0.0005) minor.push(m);
    });

    var certain = vm.moves.filter(function (m) { return m.revealed || m.prob >= 0.9995; }).length;
    var unknown = vm.slotsTotal - vm.slotsKnown;
    var moveLabel = unknown <= 0 ? 'complete'
      : certain >= vm.slotsTotal ? 'set is fixed'
        : unknown + ' unknown';

    // Stated as the conditional it is: we never see their item directly.
    if (vm.lock) {
      var lockText = vm.lock.prob >= 0.995
        ? 'Locked into ' + vm.lock.move
        : 'Locked into ' + vm.lock.move + ' if Choice (' + pct(vm.lock.prob) + ')';
      var lockEl = h('div', 'rs-lock', lockText);
      lockEl.setAttribute('role', 'note');
      b.appendChild(lockEl);
    }

    var ms = section('Moves', moveLabel);
    var msList = rowList('Moves, ' + moveLabel);
    primary.forEach(function (m) {
      msList.appendChild(probRow(m.name, m.prob, m.revealed, false, m.info, m));
    });
    ms.appendChild(msList);

    if (minor.length) {
      var extraId = nextId('rs-extra');
      var more = h('button', 'rs-more', '+ ' + minor.length + ' less likely');
      more.type = 'button';
      more.setAttribute('aria-expanded', 'false');
      more.setAttribute('aria-controls', extraId);
      var extra = rowList('Less likely moves');
      extra.classList.add('rs-extra');
      extra.id = extraId;
      minor.forEach(function (m) {
        extra.appendChild(probRow(m.name, m.prob, false, false, m.info));
      });
      extra.hidden = true;
      more.addEventListener('click', function (ev) {
        ev.stopPropagation();
        extra.hidden = !extra.hidden;
        more.setAttribute('aria-expanded', extra.hidden ? 'false' : 'true');
        more.textContent = extra.hidden
          ? '+ ' + minor.length + ' less likely'
          : '\u2212 hide less likely';
      });
      ms.appendChild(extra);
      ms.appendChild(more);
    }
    b.appendChild(ms);

    // ---- everything else ----------------------------------------------
    factOrSection('Item', vm.items, 3);
    factOrSection('Ability', vm.abilities, 3);
    // A revealed Tera type is already a chip in the header \u2014 repeating it as a
    // fact says the same thing twice.
    if (!(vm.teraTypes && vm.teraTypes[0] && vm.teraTypes[0].revealed)) {
      factOrSection('Tera', vm.teraTypes, 3);
    }

    if (vm.speed) {
      var spd = 'Speed ' + vm.speed.base;
      if (vm.speed.scarf && vm.speed.scarfProb >= 0.995) {
        spd = 'Speed ' + vm.speed.scarf + ' (Scarf)';   // no "100%" on a fact
      } else if (vm.speed.scarf && vm.speed.scarfProb > 0.005) {
        spd += ' \u00b7 Scarf ' + vm.speed.scarf + ' (' + pct(vm.speed.scarfProb) + ')';
      }
      facts.push({ text: spd });
    }
    if (vm.evNote) facts.push({ text: vm.evNote });
    // Their side has already Terastallized, so this one never will. That kills
    // a whole distribution — say so rather than showing percentages for it.
    if (vm.teraSpent !== undefined) {
      facts.push({ text: 'no Tera left' + (vm.teraSpent ? ' (' + vm.teraSpent + ' used it)' : '') });
    }

    if (facts.length) {
      var meta = h('div', 'rs-meta');
      meta.setAttribute('role', 'group');
      meta.setAttribute('aria-label', 'What is already settled');
      facts.forEach(function (f) {
        var span = h('span', 'rs-fact' + (f.revealed ? ' rs-fact-seen' : ''), f.text);
        // A settled fact is green when it was actually observed; the tick is
        // what carries that when the green does not.
        if (f.revealed) { cue(span, CUE.yes, 'seen'); label(span, f.text + ', seen'); }
        attachTip(span, f.text, f.info);
        meta.appendChild(span);
      });
      b.appendChild(meta);
    }

    (vm.notes || []).forEach(function (n) {
      var note = h('div', 'rs-note', n);
      note.setAttribute('role', 'note');
      b.appendChild(note);
    });

    card.appendChild(b);
    return card;
  }

  // -------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // damage tab
  // -------------------------------------------------------------------

  function dmgRow(r, showChance) {
    var row = h('div', 'rs-row rs-dmg' +
      (r.revealed ? ' rs-rev' : '') + (r.immune ? ' rs-immune' : ''));
    row.setAttribute('role', 'listitem');
    row.appendChild(bar('rs-fill', r.immune ? '0%' : Math.min(r.hiPct, 100).toFixed(1) + '%'));

    row.appendChild(h('span', 'rs-row-name', r.move));

    var pctText = r.immune ? 'immune'
      : (r.hiPct >= 100 ? r.loPct.toFixed(0) + '–' + r.hiPct.toFixed(0) + '%'
        : r.loPct.toFixed(0) + '–' + r.hiPct.toFixed(0) + '%');
    row.appendChild(h('span', 'rs-dmg-pct', pctText));

    var spoken = r.move + ', ';
    spoken += r.immune ? 'no effect, immune'
      : r.loPct.toFixed(0) + ' to ' + r.hiPct.toFixed(0) + ' percent';

    if (showChance) {
      // "seen" beats "100%" here: it says WHY we're certain.
      if (r.revealed) {
        row.appendChild(cue(h('span', 'rs-dmg-prob rs-dmg-seen', 'seen'), CUE.yes));
        spoken += ', move already seen';
      } else {
        row.appendChild(h('span', 'rs-dmg-prob', Math.round(r.prob * 100) + '%'));
        spoken += ', ' + Math.round(r.prob * 100) + ' percent likely they have it';
      }
    } else {
      var koShort = /OHKO/.test(r.ko || '') ? 'OHKO'
        : (/(\d)HKO/.exec(r.ko || '') || [])[0] || '';
      row.appendChild(h('span', 'rs-dmg-prob rs-dmg-ko', koShort));
      if (koShort) spoken += ', ' + koShort;
    }

    // Immunity was a 50%-opacity wash plus italics; now it carries a mark too.
    if (r.immune) cue(row, CUE.none, 'immune');
    // "seen" only means something for THEIR moves. On our own side every move
    // is known, so a tick on every row is a column of no information.
    else if (r.revealed && showChance) cue(row, CUE.yes, 'seen');

    if (r.swing) {
      var mark = h('span', 'rs-swing', '\u00b1');
      mark.title = 'Varies by up to ' + r.swing.pct.toFixed(0) +
        ' points with their item' + (r.swing.item ? ' (worst: ' + r.swing.item + ')' : '');
      mark.setAttribute('aria-hidden', 'true');
      spoken += ', varies with their item';
      row.appendChild(mark);
    }
    if (r.ko) row.title = r.desc || r.ko;
    label(row, spoken);
    return row;
  }

  function speedBlock(sp) {
    if (!sp) return null;
    var box = h('div', 'rs-speed');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Speed');

    var verdictText, cls;
    if (sp.verdict === 'you') { verdictText = 'You move first'; cls = ' rs-good'; }
    else if (sp.verdict === 'them') { verdictText = 'They move first'; cls = ' rs-bad'; }
    else if (sp.verdict === 'tie') { verdictText = 'Speed tie'; cls = ' rs-warn'; }
    else { verdictText = 'You move first \u2014 unless Choice Scarf'; cls = ' rs-warn'; }

    var head = h('div', 'rs-speed-v' + cls, verdictText);
    cue(head, cls === ' rs-good' ? CUE.yes : cls === ' rs-bad' ? CUE.no : CUE.warn,
      cls.trim().replace('rs-', ''));
    if (sp.trickRoom) head.appendChild(h('span', 'rs-chip rs-chip-tera', 'Trick Room'));
    box.appendChild(head);

    var line = h('div', 'rs-speed-n');
    line.appendChild(h('b', null, String(sp.you.value)));
    line.appendChild(h('span', null, sp.you.parts.length ? ' (' + sp.you.parts.join(', ') + ')' : ''));
    line.appendChild(h('span', null, '  vs  '));
    line.appendChild(h('b', null, String(sp.them.value)));
    line.appendChild(h('span', null, sp.them.parts.length ? ' (' + sp.them.parts.join(', ') + ')' : ''));
    box.appendChild(line);

    if (!sp.them.scarfKnown && sp.them.scarfProb > 0.005) {
      box.appendChild(h('div', 'rs-speed-s',
        'Choice Scarf would make them ' + sp.them.scarfValue +
        ' \u2014 ' + Math.round(sp.them.scarfProb * 100) + '% likely'));
    }
    return box;
  }

  function renderSwitch(view) {
    var sw = view.switches;
    if (!sw || !sw.rows || !sw.rows.length) {
      var e = h('div', 'rs-empty');
      e.appendChild(h('b', null, 'No team data yet'));
      e.appendChild(document.createTextNode(
        (view.damage && view.damage.reason) || 'Your team appears once the battle starts.'));
      body.appendChild(e);
      return;
    }

    var multiFoe = sw.foes && sw.foes.length > 1;
    body.appendChild(h('div', 'rs-matchup', multiFoe
      ? 'Worst hit on each, from ' + sw.foes.join(' or ')
      : 'If ' + sw.foe + ' attacks, worst hit on each'));

    var bench = sw.rows.filter(function (r) {
      return !r.fainted && !r.active && !r.unknown;
    });
    var safest = bench[0];
    if (safest && safest.survives) {
      body.appendChild(verdictLine(
        'Safest switch: ' + safest.species +
        (safest.worstPct > 0
          ? ' — takes about ' + Math.round(safest.worstPct) + '%, leaving ' +
            Math.round(safest.left) + '%'
          : ' — takes nothing'),
        'good'));
    } else if (safest) {
      // Saying "safest" about something that dies is worse than saying nothing.
      body.appendChild(verdictLine(
        'Nothing on your bench survives ' + sw.foe + '’s best hit.', 'bad'));
    }

    var sec = section('Your team');
    sec.appendChild(colHeads([
      { k: 'name', t: 'pokemon' },
      { k: 'dmg', t: 'worst hit' },
      { k: 'prob', t: 'survives?' }
    ]));

    var list = rowList('Your team, worst hit on each');
    sw.rows.forEach(function (r) {
      var row = h('div', 'rs-row rs-dmg' + (r.fainted ? ' rs-dead' : '') +
        (r.active ? ' rs-rev' : ''));
      row.setAttribute('role', 'listitem');
      var fill = bar('rs-fill', Math.min(r.worstPct, 100).toFixed(1) + '%');
      if (!r.fainted && !r.survives) fill.classList.add('rs-fill-ko');
      row.appendChild(fill);

      var name = h('span', 'rs-row-name', r.species);
      if (r.active) name.appendChild(h('span', 'rs-lv', ' \u00b7 in now'));
      // Without this, "68% \u2014 KO" reads as a mistake. It isn't: the slot is
      // already chipped, and the damage figure is a share of full HP.
      else if (!r.fainted && r.hpPct < 100) {
        name.appendChild(h('span', 'rs-lv', ' \u00b7 at ' + r.hpPct + '%'));
      }
      row.appendChild(name);

      if (r.speed) {
        var m = h('span', 'rs-spd-mark', r.speed.faster ? '\u25b2' : '\u25bc');
        m.title = r.speed.faster
          ? 'Outspeeds their active (' + r.speed.value + ')'
          : 'Slower than their active (' + r.speed.value + ')';
        m.setAttribute('aria-hidden', 'true');   // folded into the row label
        row.appendChild(m);
      }

      row.appendChild(h('span', 'rs-dmg-pct',
        r.fainted ? '\u2014' : (r.worstPct > 0 ? Math.round(r.worstPct) + '%' : 'nothing')));

      // "KO" red vs "yes" green was the only difference on the busiest column.
      // Now the glyph, the row's inset edge and the words all say it.
      var verdict;
      if (r.fainted) { verdict = h('span', 'rs-dmg-prob', 'fainted'); cue(row, CUE.no, 'dead'); }
      else if (r.unknown) {
        // The calc could not build this Pokemon — a species newer than the
        // pinned library. Say we don't know; never imply it dies.
        verdict = h('span', 'rs-dmg-prob', 'unknown');
      } else if (!r.survives) {
        verdict = cue(h('span', 'rs-dmg-prob rs-ko-yes', 'KO'), CUE.no);
        cue(row, null, 'ko');
      } else {
        verdict = cue(h('span', 'rs-dmg-prob rs-ko-no', 'yes'), CUE.yes);
        cue(row, null, 'safe');
      }
      row.appendChild(verdict);

      label(row, r.species +
        (r.active ? ', in now' : r.fainted ? '' : r.hpPct < 100 ? ', at ' + r.hpPct + ' percent' : '') +
        (r.fainted ? ', fainted'
          : r.unknown ? ', cannot be calculated'
            : ', worst hit ' + (r.worstPct > 0 ? Math.round(r.worstPct) + ' percent' : 'nothing') +
              (r.survives ? ', survives' : ', gets knocked out')) +
        (r.speed ? (r.speed.faster ? ', outspeeds their active' : ', slower than their active') : ''));

      if (r.worstMove) {
        row.title = (multiFoe && r.worstFrom ? r.worstFrom + '\u2019s ' : '') +
          r.worstMove + ': ' + Math.round(r.worstLo || 0) + '-' + Math.round(r.worstPct) + '%' +
          ' of its HP' + (r.ko ? ' \u2014 ' + r.ko : '') +
          (r.worstProb < 1 ? '  (' + Math.round(r.worstProb * 100) + '% likely they have it)' : '');
      }
      list.appendChild(row);
    });
    sec.appendChild(list);
    body.appendChild(sec);

    var legend = h('div', 'rs-assumes');
    legend.appendChild(h('div', null,
      '\u25b2 outspeeds their active \u00b7 \u25bc slower. "Worst hit" is the biggest ' +
      'damage they can realistically do to that Pokemon.'));
    if (sw.assumes) legend.appendChild(h('div', null, 'Assumes ' + sw.assumes));
    body.appendChild(legend);
  }

  function renderDamage(view) {
    var d = view.damage;
    if (!d || !d.available) {
      var e = h('div', 'rs-empty');
      e.appendChild(h('b', null, 'No matchup yet'));
      e.appendChild(document.createTextNode((d && d.reason) || 'Waiting for both active Pokemon.'));
      body.appendChild(e);
      return;
    }

    // Doubles has up to four pairings. Analysing one of them silently — which
    // is what this did — is worse than analysing none.
    if (d.multi && d.pairs && d.pairs.length > 1) {
      var picker = h('div', 'rs-pairs');
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-label', 'Which matchup to analyse');
      d.pairs.forEach(function (pr) {
        var key = pr.mineIdx + ':' + pr.foeIdx;
        var on = key === d.pairKey;
        // Same order as the matchup header directly beneath it. These used to
        // disagree \u2014 the button said "Dipplin \u2192 Glaceon" over a header reading
        // "Glaceon vs Dipplin", which is the same matchup written backwards.
        var b = h('button', 'rs-pair' + (on ? ' rs-pair-on' : ''),
          pr.foe + ' vs ' + pr.mine);
        b.type = 'button';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        // Selected is otherwise only an accent border and accent text.
        if (on) cue(b, CUE.yes, 'on');
        b.addEventListener('click', function () {
          state.pair = key;
          onPersist(state);   // content.js recomputes the matchup and re-renders
        });
        picker.appendChild(b);
      });
      body.appendChild(picker);
    }

    var head2 = h('div', 'rs-matchup');
    head2.appendChild(h('b', null, d.foe.species));
    head2.appendChild(h('span', null, ' vs '));
    head2.appendChild(h('b', null, d.mine.species));
    body.appendChild(head2);

    var sb = speedBlock(view.speed);
    if (sb) body.appendChild(sb);

    if (d.warning) {
      var warn = h('div', 'rs-note', d.warning);
      warn.setAttribute('role', 'note');
      body.appendChild(warn);
    }

    // ---- what they do to us -----------------------------------------
    var inc = section('They hit you');
    inc.appendChild(verdictLine(d.incomingVerdict || '',
      /KOs you|can KO you/.test(d.incomingVerdict || '') ? 'bad' : 'ok'));
    inc.appendChild(colHeads([
      { k: 'name', t: 'move' },
      { k: 'dmg', t: 'of your HP' },
      { k: 'prob', t: 'they have it' }
    ]));
    if (!d.incoming.length) inc.appendChild(h('div', 'rs-quiet', 'No damaging moves found.'));
    var incList = rowList('Their moves, damage to you');
    d.incoming.forEach(function (r) { incList.appendChild(dmgRow(r, true)); });
    inc.appendChild(incList);
    body.appendChild(inc);

    // ---- what we do to them -----------------------------------------
    var out = section('You hit them');
    out.appendChild(verdictLine(d.outgoingVerdict || '',
      /KOs them|can KO them/.test(d.outgoingVerdict || '') ? 'good' : 'ok'));
    out.appendChild(colHeads([
      { k: 'name', t: 'your move' },
      { k: 'dmg', t: 'of their HP' },
      { k: 'prob', t: '' }
    ]));
    if (!d.outgoing.length) out.appendChild(h('div', 'rs-quiet', 'No damaging moves found.'));
    var outList = rowList('Your moves, damage to them');
    d.outgoing.forEach(function (r) { outList.appendChild(dmgRow(r, false)); });
    out.appendChild(outList);
    body.appendChild(out);

    var legend = h('div', 'rs-assumes');
    legend.appendChild(h('div', null,
      'Bars show damage. Hover or Tab to a row for the KO chance.'));
    if (d.itemNote) legend.appendChild(h('div', null, d.itemNote));
    else if (d.assumes) legend.appendChild(h('div', null, 'Assumes ' + d.assumes));
    body.appendChild(legend);
  }

  /* The bridge polls twice a second and re-renders whenever anything visible
     changes, which used to wipe out whatever the keyboard was on — Tab into a
     card, wait for the next turn, and focus was back at the top of the page.
     The body is rebuilt from scratch, so the only stable address a focused
     node has is its position; re-focus the node at the same position when it
     is still recognisably the same thing. */
  function focusMark() {
    var a = document.activeElement;
    if (!a || a === body || !body.contains(a)) return null;
    var path = [], n = a;
    while (n && n !== body && n.parentNode) {
      path.push([].indexOf.call(n.parentNode.children, n));
      n = n.parentNode;
    }
    if (n !== body) return null;
    return { path: path.reverse(), tag: a.tagName, cls: a.className };
  }

  function restoreFocus(mark) {
    if (!mark) return;
    var n = body;
    for (var i = 0; i < mark.path.length; i++) {
      n = n.children[mark.path[i]];
      if (!n) return;
    }
    if (n.tagName !== mark.tag || n.className !== mark.cls) return;
    if (typeof n.focus === 'function') n.focus({ preventScroll: true });
  }

  function render(view) {
    build();
    lastView = view;
    headSub.textContent = view.subtitle || '';
    headSub.title = view.subtitleFull || view.subtitle || '';
    syncTabs();

    var mark = focusMark();
    if (tip) hideTip(true);
    body.textContent = '';

    if (view.emptyTitle && (!view.mons || !view.mons.length)) {
      // A notice outranks the tab. Whatever it says — no battle, unsupported
      // format, lost the thread, something went wrong — it is the reason there
      // is nothing else to show, so it must be what the user reads.
      var n = h('div', 'rs-empty');
      n.appendChild(h('b', null, view.emptyTitle));
      n.appendChild(document.createTextNode(view.emptyBody || ''));
      body.appendChild(n);
    }
    else if (state.tab === 'damage') { renderDamage(view); }
    else if (state.tab === 'switch') { renderSwitch(view); }
    else if (!view.mons || !view.mons.length) {
      var e = h('div', 'rs-empty');
      e.appendChild(h('b', null, view.emptyTitle || 'Waiting for a battle'));
      e.appendChild(document.createTextNode(view.emptyBody || 'Start or spectate a Random Battle.'));
      body.appendChild(e);
    } else {
      view.mons.forEach(function (vm) { body.appendChild(monCard(vm)); });
    }

    foot.textContent = '';
    foot.appendChild(h('span', null, view.footLeft || ''));
    var right = h('span', null, view.footRight || '');
    foot.appendChild(right);

    restoreFocus(mark);
  }

  function setVisible(v) { build(); el.style.display = v ? 'flex' : 'none'; }

  root.RSUI = {
    render: render,
    applyState: applyState,
    setVisible: setVisible,
    onPersist: function (fn) { onPersist = fn; },
    getState: function () { return state; },
    resetLayout: resetLayout
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
