/* Accessibility pass over the overlay panel, driven through the mock Showdown
 * page in real Chromium. Everything here asserts rendered behaviour: focus is
 * moved with real Tab / arrow presses, contrast is computed from
 * getComputedStyle on what actually painted, and a non-colour cue only counts
 * if the browser drew a glyph for it.
 * Run: node test/a11y.test.js  */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8737;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// WCAG 2.1: 4.5:1 for body text, 3:1 for large text and for the boundaries of
// user interface components.
const AA_TEXT = 4.5;
const AA_UI = 3;

/* Injected into the page: colour maths plus the two things that are genuinely
   hard to get right from outside — what is actually painted behind a piece of
   text, and which elements a screen reader would treat as controls. */
const HELPERS = `
window.__a11y = (function () {
  function parse(s) {
    var m = String(s).match(/[-\\d.]+/g);
    if (!m) return [0, 0, 0, 0];
    return [+m[0], +m[1], +m[2], m.length > 3 ? +m[3] : 1];
  }
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  // src over dst
  function over(src, dst) {
    var a = src[3];
    return [src[0] * a + dst[0] * (1 - a), src[1] * a + dst[1] * (1 - a), src[2] * a + dst[2] * (1 - a), 1];
  }

  /* The layers painted behind a piece of text, innermost first. A probability
     row's bar is a sibling <i> painted over the row and under the text, so it
     has to be spliced in at the row — checking against the card colour alone
     would flatter every number in the panel. */
  function layers(el) {
    var out = [], n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (n.classList && n.classList.contains('rbl-row')) {
        var f = n.querySelector(':scope > .rbl-fill');
        if (f) {
          var fs2 = getComputedStyle(f);
          var fc = parse(fs2.backgroundColor);
          fc[3] *= parseFloat(fs2.opacity || '1');
          if (fc[3] > 0.001) out.push(fc);
        }
      }
      var bc = parse(cs.backgroundColor);
      if (bc[3] > 0.001) out.push(bc);
      if (n.id === 'rbl-panel') break;
      n = n.parentElement;
    }
    return out;
  }
  function bgOf(el) {
    var l = layers(el), base = [255, 255, 255, 1];
    for (var i = l.length - 1; i >= 0; i--) base = over(l[i], base);
    return base;
  }
  function opacityChain(el) {
    var o = 1, n = el;
    while (n && n.nodeType === 1) {
      o *= parseFloat(getComputedStyle(n).opacity || '1');
      if (n.id === 'rbl-panel') break;
      n = n.parentElement;
    }
    return o;
  }
  function visible(el) {
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return el.getClientRects().length > 0;
  }
  function ownText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    }
    return t.trim();
  }
  function desc(el) {
    var c = el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + String(c).trim().split(/\\s+/).join('.') : '');
  }

  /* Every visible run of text in the panel, with the ratio it actually
     achieves against what is painted behind it. Pseudo-element cue glyphs
     inherit their colour from the element they hang off, so the element's own
     measurement covers them. */
  function textContrast() {
    var out = [];
    var all = document.querySelectorAll('#rbl-panel, #rbl-panel *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var text = ownText(el);
      if (!text || !visible(el)) continue;
      var cs = getComputedStyle(el);
      var fg = parse(cs.color);
      var bg = bgOf(el);
      var op = opacityChain(el);
      fg[3] *= op;
      var eff = over(fg, bg);
      var size = parseFloat(cs.fontSize);
      var weight = parseInt(cs.fontWeight, 10) || 400;
      var large = size >= 24 || (size >= 18.66 && weight >= 700);
      out.push({
        sel: desc(el), text: text.slice(0, 40), size: size, large: large,
        opacity: op, color: cs.color, ratio: ratio(eff, bg)
      });
    }
    return out;
  }

  function focusInfo() {
    var el = document.activeElement;
    if (!el || el === document.body) return null;
    var cs = getComputedStyle(el);
    var w = parseFloat(cs.outlineWidth) || 0;
    var oc = parse(cs.outlineColor);
    var bg = bgOf(el);
    return {
      sel: desc(el),
      inPanel: !!document.getElementById('rbl-panel') &&
        document.getElementById('rbl-panel').contains(el),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 48),
      outlineStyle: cs.outlineStyle,
      outlineWidth: w,
      outlineRatio: oc[3] > 0 ? ratio(over(oc, bg), bg) : 0
    };
  }

  return {
    ratio: ratio, bgOf: bgOf, textContrast: textContrast, focusInfo: focusInfo,
    parse: parse, over: over, desc: desc, visible: visible
  };
})();
`;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ ...require('./chromium') });
  const page = await browser.newPage({ viewport: { width: 1180, height: 950 } });
  await page.addInitScript(HELPERS);

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  // ?evidence=1 is the richer fixture: it renders PP-exhausted rows, a Choice
  // lock, a KO on the switch tab and an immune row on the damage tab, so every
  // colour-coded state the panel can paint is on screen at once.
  await page.goto(`http://127.0.0.1:${PORT}/test/harness.html?evidence=1`);
  await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
  await page.evaluate(() => window.__harness.openAll());
  await page.waitForTimeout(2400);   // let the Choice lock land

  // -----------------------------------------------------------------
  console.log('\n[1] Landmark, tablist and panel structure');
  {
    const s = await page.evaluate(() => {
      const p = document.getElementById('rbl-panel');
      const bar = document.getElementById('rbl-tabs');
      const body = document.getElementById('rbl-body');
      const tabs = [...bar.querySelectorAll('.rbl-tab')];
      return {
        panelRole: p.getAttribute('role'),
        panelName: p.getAttribute('aria-label'),
        barRole: bar.getAttribute('role'),
        tabs: tabs.map(t => ({
          role: t.getAttribute('role'), text: t.textContent,
          selected: t.getAttribute('aria-selected'), tabindex: t.tabIndex,
          controls: t.getAttribute('aria-controls')
        })),
        bodyRole: body.getAttribute('role'),
        labelledBy: body.getAttribute('aria-labelledby'),
        labelText: (document.getElementById(body.getAttribute('aria-labelledby')) || {}).textContent,
        themePressed: document.querySelectorAll('#rbl-head .rbl-btn')[0].getAttribute('aria-pressed'),
        collapseExpanded: document.querySelectorAll('#rbl-head .rbl-btn')[1].getAttribute('aria-expanded'),
        headsAreButtons: [...document.querySelectorAll('.rbl-mon-head')].every(h => h.tagName === 'BUTTON'),
        headsExpanded: [...document.querySelectorAll('.rbl-mon-head')]
          .every(h => h.getAttribute('aria-expanded') ===
            String(h.closest('.rbl-mon').classList.contains('rbl-open')))
      };
    });
    ok(s.panelRole === 'complementary' && /Randbats Live/.test(s.panelName || ''),
      `panel is a landmark named "${s.panelName}"`);
    ok(s.barRole === 'tablist' && s.tabs.length === 3 && s.tabs.every(t => t.role === 'tab'),
      `three role=tab buttons in a tablist (${s.tabs.map(t => t.text).join(', ')})`);
    ok(s.tabs.filter(t => t.selected === 'true').length === 1,
      'exactly one tab is aria-selected');
    ok(s.tabs.filter(t => t.tabindex === 0).length === 1 &&
      s.tabs.find(t => t.selected === 'true').tabindex === 0,
      'roving tabindex: the tablist is one Tab stop, and it is the selected tab');
    ok(s.bodyRole === 'tabpanel' && s.labelText === 'Sets',
      `the body is a tabpanel labelled by its tab ("${s.labelText}")`);
    ok(s.tabs.every(t => t.controls === 'rbl-body'), 'every tab points at the panel it controls');
    ok(s.themePressed === 'false' && s.collapseExpanded === 'true',
      'theme button is a toggle (aria-pressed) and collapse reports aria-expanded');
    ok(s.headsAreButtons, 'Pokemon card headers are real buttons, not divs with click handlers');
    ok(s.headsExpanded, 'each card header reports aria-expanded matching whether it is open');
  }

  // -----------------------------------------------------------------
  console.log('\n[2] Everything interactive is reachable by Tab, with a visible ring');
  {
    const stops = [];
    await page.evaluate(() => { document.body.focus(); window.getSelection().removeAllRanges(); });
    // Walk the whole document; stop once focus has left the panel again.
    let seenPanel = false;
    for (let i = 0; i < 240; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => window.__a11y.focusInfo());
      if (!f) break;
      if (f.inPanel) { seenPanel = true; stops.push(f); }
      else if (seenPanel) break;
    }

    const sels = stops.map(s => s.sel);
    const has = re => sels.some(s => re.test(s));
    ok(stops.length > 0, `${stops.length} Tab stops inside the panel`);
    ok(has(/rbl-btn/) && sels.filter(s => /rbl-btn/.test(s)).length === 2,
      'both header buttons (theme, collapse) are Tab stops');
    ok(sels.filter(s => /rbl-tab\b/.test(s)).length === 1,
      'the tablist takes exactly one Tab stop (arrows move within it)');
    ok(has(/#rbl-body/), 'the scrollable panel body is focusable, so it can be scrolled by keyboard');
    ok(sels.filter(s => /rbl-mon-head/.test(s)).length >= 6,
      `every Pokemon card header is reachable (${sels.filter(s => /rbl-mon-head/.test(s)).length})`);
    ok(has(/rbl-row.*rbl-has-tip/) || has(/rbl-has-tip/),
      'rows and facts that carry a description are reachable, so their tooltip is too');
    ok(has(/rbl-more/), 'the "+ N less likely" disclosure is a Tab stop');

    const noRing = stops.filter(s =>
      s.outlineStyle === 'none' || s.outlineWidth < 2 || s.outlineRatio < AA_UI);
    ok(noRing.length === 0,
      `every Tab stop paints a >=2px focus ring at >=3:1 against its own background` +
      (noRing.length ? ` -> ${noRing[0].sel} (${noRing[0].outlineStyle} ${noRing[0].outlineWidth}px, ${noRing[0].outlineRatio.toFixed(2)}:1)` : ''));

    const unnamed = stops.filter(s => !s.name || s.name.length < 2);
    ok(unnamed.length === 0,
      `every Tab stop has an accessible name` + (unnamed.length ? ` -> ${unnamed[0].sel}` : ''));
  }

  // -----------------------------------------------------------------
  console.log('\n[3] Arrow keys move between tabs and change the panel');
  {
    const read = () => page.evaluate(() => ({
      selected: (document.querySelector('#rbl-tabs .rbl-tab[aria-selected="true"]') || {}).textContent,
      focused: (document.activeElement || {}).textContent,
      labelledBy: document.getElementById('rbl-body').getAttribute('aria-labelledby'),
      // something only the damage/switch views render
      matchup: !!document.querySelector('#rbl-body .rbl-matchup'),
      cards: document.querySelectorAll('#rbl-body .rbl-mon').length
    }));

    await page.evaluate(() => document.querySelector('#rbl-tabs .rbl-tab[aria-selected="true"]').focus());
    const before = await read();
    ok(before.selected === 'Sets' && before.cards > 0, `starts on Sets with ${before.cards} cards`);

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    const right = await read();
    ok(right.selected === 'Damage' && right.focused === 'Damage',
      `ArrowRight selects and focuses Damage (got "${right.selected}")`);
    ok(right.cards === 0 && right.matchup,
      'and the panel actually re-renders: the cards are gone, a matchup line is there');
    ok(right.labelledBy === 'rbl-tab-damage', 'the tabpanel renames itself after its new tab');

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    ok((await read()).selected === 'Switch', 'ArrowRight again reaches Switch');

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    ok((await read()).selected === 'Sets', 'and wraps round to Sets');

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(350);
    ok((await read()).selected === 'Switch', 'ArrowLeft wraps the other way');

    await page.keyboard.press('Home');
    await page.waitForTimeout(350);
    ok((await read()).selected === 'Sets', 'Home jumps to the first tab');

    await page.keyboard.press('End');
    await page.waitForTimeout(350);
    ok((await read()).selected === 'Switch', 'End jumps to the last tab');

    await page.keyboard.press('Home');
    await page.waitForTimeout(350);
    await page.evaluate(() => window.__harness.openAll());
    await page.waitForTimeout(200);
  }

  // -----------------------------------------------------------------
  console.log('\n[4] Card headers and the disclosure work from the keyboard');
  {
    const r = await page.evaluate(async () => {
      const head = document.querySelector('.rbl-mon-head');
      head.focus();
      const openBefore = head.closest('.rbl-mon').classList.contains('rbl-open');
      return { focused: document.activeElement === head, openBefore };
    });
    ok(r.focused, 'a card header takes focus');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    const afterEnter = await page.evaluate(() => {
      const head = document.querySelector('.rbl-mon-head');
      return {
        open: head.closest('.rbl-mon').classList.contains('rbl-open'),
        expanded: head.getAttribute('aria-expanded')
      };
    });
    ok(afterEnter.open !== r.openBefore, 'Enter toggles it open/closed');
    ok(afterEnter.expanded === String(afterEnter.open),
      `and aria-expanded follows (${afterEnter.expanded})`);
    await page.keyboard.press('Space');
    await page.waitForTimeout(120);
    ok(await page.evaluate(() =>
      document.querySelector('.rbl-mon-head').closest('.rbl-mon').classList.contains('rbl-open')) === r.openBefore,
      'Space toggles it back');

    const more = await page.evaluate(() => {
      // only a button inside an open card can actually take focus
      const b = [...document.querySelectorAll('.rbl-mon.rbl-open .rbl-more')][0];
      if (!b) return null;
      b.focus();
      if (document.activeElement !== b) return null;
      return { expanded: b.getAttribute('aria-expanded'), controls: b.getAttribute('aria-controls'),
        targetHidden: document.getElementById(b.getAttribute('aria-controls')).hidden };
    });
    if (!more) {
      ok(false, 'no "+ N less likely" toggle rendered on this fixture');
    } else {
      ok(more.expanded === 'false' && more.targetHidden,
        'the disclosure starts collapsed and says so with aria-expanded');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => {
        const b = document.querySelector('.rbl-more');
        return { expanded: b.getAttribute('aria-expanded'),
          hidden: document.getElementById(b.getAttribute('aria-controls')).hidden };
      });
      ok(after.expanded === 'true' && !after.hidden,
        'Enter opens it and flips aria-expanded');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
    }
  }

  // -----------------------------------------------------------------
  console.log('\n[4b] Keyboard focus survives a re-render');
  {
    // The bridge polls twice a second and rebuilds the body whenever anything
    // visible changes. If that drops focus, keyboard use of the panel is over.
    await page.evaluate(() => window.__harness.openAll());
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.rbl-mon-head')];
      const h = heads[2] || heads[0];
      h.focus();
      return { sel: window.__a11y.desc(document.activeElement),
        name: document.activeElement.getAttribute('aria-label') };
    });
    // Force the panel to re-render by advancing the mock battle a turn.
    await page.evaluate(() => { window.app.curRoom.battle.turn += 1; });
    await page.waitForFunction(
      t => (document.getElementById('rbl-sub').textContent || '').indexOf('turn ' + t) >= 0,
      await page.evaluate(() => window.app.curRoom.battle.turn), { timeout: 5000 });
    const after = await page.evaluate(() => ({
      sel: window.__a11y.desc(document.activeElement),
      name: document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label'),
      inPanel: document.getElementById('rbl-panel').contains(document.activeElement)
    }));
    ok(after.inPanel && after.name === before.name,
      `focus stays on the same control across a re-render ("${before.name}" -> "${after.name}")`);
  }

  // -----------------------------------------------------------------
  console.log('\n[5] Tooltips are reachable without a mouse');
  {
    await page.evaluate(() => window.__harness.openAll());
    await page.waitForTimeout(150);
    const focused = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#rbl-panel .rbl-row.rbl-has-tip')][0];
      if (!row) return null;
      row.focus();
      const t = document.getElementById('rbl-tip');
      return {
        name: row.querySelector('.rbl-row-name').textContent,
        shown: !!t && t.style.display === 'block',
        describedby: row.getAttribute('aria-describedby'),
        tipRole: t && t.getAttribute('role'),
        title: t && t.querySelector('.rbl-tip-t') && t.querySelector('.rbl-tip-t').textContent,
        desc: t && t.querySelector('.rbl-tip-d') && t.querySelector('.rbl-tip-d').textContent
      };
    });
    ok(focused && focused.shown,
      `focusing a described row opens its tooltip ("${focused && focused.name}")`);
    ok(focused && focused.describedby === 'rbl-tip' && focused.tipRole === 'tooltip',
      'the row points at it with aria-describedby while it is on screen');
    ok(focused && focused.desc && focused.desc.length > 5,
      `so a keyboard user can read the description: "${focused && focused.desc}"`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
    const dismissed = await page.evaluate(() => ({
      shown: document.getElementById('rbl-tip').style.display === 'block',
      describedby: document.querySelector('#rbl-panel .rbl-row.rbl-has-tip').getAttribute('aria-describedby')
    }));
    ok(!dismissed.shown && !dismissed.describedby,
      'Escape dismisses it and drops the description reference (WCAG 1.4.13)');
  }

  // -----------------------------------------------------------------
  console.log('\n[6] Every colour-coded state carries a non-colour cue');
  {
    // A cue only counts if the browser actually painted a glyph for it.
    const census = async () => page.evaluate(() => {
      function glyph(el) {
        const c = getComputedStyle(el, '::before').content;
        return (c && c !== 'none' && c !== 'normal') ? c.replace(/^"|"$/g, '') : '';
      }
      function cueIn(el) {
        if (glyph(el)) return glyph(el);
        const kid = [...el.querySelectorAll('[data-cue]')].map(glyph).filter(Boolean);
        return kid[0] || '';
      }
      const out = {};
      document.querySelectorAll('#rbl-panel [data-state]').forEach(el => {
        const k = el.getAttribute('data-state');
        (out[k] = out[k] || []).push({
          sel: window.__a11y.desc(el), cue: cueIn(el),
          text: (el.textContent || '').trim().slice(0, 34)
        });
      });
      return out;
    });

    const seenStates = {};
    for (const tab of ['Sets', 'Damage', 'Switch']) {
      await page.evaluate(l => window.__harness.showTab(l), tab);
      await page.waitForTimeout(400);
      if (tab === 'Sets') { await page.evaluate(() => window.__harness.openAll()); await page.waitForTimeout(200); }
      const c = await census();
      Object.keys(c).forEach(k => { seenStates[k] = (seenStates[k] || []).concat(c[k]); });
    }

    const want = {
      seen: 'a move / item the battle actually revealed (drawn in green)',
      spent: 'a move whose PP is gone (green name, struck through)',
      immune: 'a move that cannot touch you (faded, italic)',
      ko: 'a bench slot that gets knocked out (red bar, red word)',
      safe: 'a bench slot that survives (green word)',
      dead: 'a fainted slot (demoted)',
      good: 'a verdict in your favour (green)',
      bad: 'a verdict against you (red)'
    };
    Object.keys(want).forEach(k => {
      const got = seenStates[k] || [];
      ok(got.length > 0 && got.every(g => g.cue),
        got.length
          ? `${k}: ${got.length} element(s), all cued "${got[0].cue}" — ${want[k]}`
          : `${k} never rendered, so its cue could not be checked — ${want[k]}`);
    });

    // The states carried by words as well as a glyph must still say them.
    await page.evaluate(() => window.__harness.showTab('Switch'));
    await page.waitForTimeout(350);
    const koWords = await page.evaluate(() =>
      [...document.querySelectorAll('#rbl-body .rbl-ko-yes, #rbl-body .rbl-ko-no')]
        .map(x => x.className.replace(/rbl-dmg-prob /, '') + '=' + x.textContent));
    ok(koWords.length > 0 && koWords.every(w => /=(yes|KO)$/.test(w)),
      `the survives column is words as well as colour: ${koWords.join(', ')}`);

    // Bars: the decorative ones are hidden, the one with no number is named.
    await page.evaluate(() => window.__harness.showTab('Sets'));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__harness.openAll());
    const bars = await page.evaluate(() => ({
      fills: [...document.querySelectorAll('#rbl-panel .rbl-fill')]
        .filter(f => f.getAttribute('aria-hidden') !== 'true').length,
      totalFills: document.querySelectorAll('#rbl-panel .rbl-fill').length,
      hp: [...document.querySelectorAll('#rbl-panel .rbl-hp')]
        .map(b => ({ role: b.getAttribute('role'), name: b.getAttribute('aria-label') }))
    }));
    ok(bars.totalFills > 0 && bars.fills === 0,
      `all ${bars.totalFills} probability/damage bars are aria-hidden — the number beside them is the label`);
    ok(bars.hp.length > 0 && bars.hp.every(b => b.role === 'img' && /percent HP left/.test(b.name || '')),
      `the HP bar, the one with no number beside it, names itself: "${(bars.hp[0] || {}).name}"`);
  }

  // -----------------------------------------------------------------
  console.log('\n[7] Rows read as sentences');
  {
    await page.evaluate(() => window.__harness.openAll());
    await page.waitForTimeout(200);
    const rows = await page.evaluate(() => {
      const inList = el => !!el.closest('[role="list"]');
      return [...document.querySelectorAll('#rbl-panel .rbl-row')].map(r => ({
        role: r.getAttribute('role'), inList: inList(r),
        label: r.getAttribute('aria-label'),
        pct: (r.querySelector('.rbl-row-pct') || {}).textContent
      }));
    });
    ok(rows.length > 0 && rows.every(r => r.role === 'listitem' && r.inList),
      `all ${rows.length} rows are list items inside a named list`);
    ok(rows.every(r => r.label && /,/.test(r.label)),
      'every row has an accessible label with more than one clause');
    const pctRow = rows.find(r => /\d+ percent$/.test(r.label || ''));
    ok(!!pctRow, `a predicted move reads as a sentence: "${pctRow && pctRow.label}"`);
    const seenRow = rows.find(r => / seen$/.test(r.label || ''));
    ok(!!seenRow, `a revealed move says why it is certain: "${seenRow && seenRow.label}"`);
    const ppRow = rows.find(r => /no PP left$/.test(r.label || ''));
    ok(!!ppRow, `a PP-exhausted move says so: "${ppRow && ppRow.label}"`);
    const sure = rows.find(r => /, certain$/.test(r.label || ''));
    ok(!!sure, `a settled move reads "certain", not "100 %": "${sure && sure.label}"`);

    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('.rbl-mon-head')].map(h => ({
        label: h.getAttribute('aria-label'),
        species: h.querySelector('.rbl-name').firstChild.textContent.trim()
      })));
    ok(heads.every(h => h.label && /move slots known$/.test(h.label)),
      `card headers spell out the slot chip: "${heads[0].label}"`);
    ok(heads.every(h => h.label.indexOf(h.species) === 0),
      'and each begins with the species name shown on it, so the spoken name still matches the visible one');

    await page.evaluate(() => window.__harness.showTab('Switch'));
    await page.waitForTimeout(350);
    const swRows = await page.evaluate(() =>
      [...document.querySelectorAll('#rbl-body .rbl-row')].map(r => r.getAttribute('aria-label')));
    ok(swRows.every(l => l && /(survives|knocked out|fainted)/.test(l)),
      `switch rows say the outcome in words: "${swRows[0]}"`);
    await page.evaluate(() => window.__harness.showTab('Sets'));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__harness.openAll());
    await page.waitForTimeout(200);
  }

  // -----------------------------------------------------------------
  console.log('\n[8] Contrast of the rendered text, both themes, every tab');
  {
    const worstPerTheme = {};
    for (const light of [false, true]) {
      await page.evaluate(on => {
        const p = document.getElementById('rbl-panel');
        if (p.classList.contains('rbl-light') !== on) {
          // the ◐ button, exactly as a user would flip it
          document.querySelectorAll('#rbl-head .rbl-btn')[0].click();
        }
      }, light);
      await page.waitForTimeout(150);
      const themeOn = await page.evaluate(() =>
        document.getElementById('rbl-panel').classList.contains('rbl-light'));
      ok(themeOn === light, `${light ? 'light' : 'dark'} theme applied via the ◐ button`);

      let bad = [], worst = { ratio: 99 }, counted = 0, faded = [];
      for (const tab of ['Sets', 'Damage', 'Switch']) {
        await page.evaluate(l => window.__harness.showTab(l), tab);
        await page.waitForTimeout(400);
        if (tab === 'Sets') {
          await page.evaluate(() => window.__harness.openAll());
          await page.waitForTimeout(200);
          // open the long tail too, so its rows get measured
          await page.evaluate(() => document.querySelectorAll('.rbl-more').forEach(b => b.click()));
          await page.waitForTimeout(150);
        }
        const rows = await page.evaluate(() => window.__a11y.textContrast());
        counted += rows.length;
        rows.forEach(r => {
          const need = r.large ? 3 : 4.5;
          if (r.ratio + 0.005 < need) bad.push(Object.assign({ tab, need }, r));
          if (r.ratio < worst.ratio) worst = Object.assign({ tab }, r);
          if (r.opacity < 0.999) faded.push(Object.assign({ tab }, r));
        });
      }
      const theme = light ? 'light' : 'dark';
      worstPerTheme[theme] = worst;
      ok(bad.length === 0,
        `${theme}: all ${counted} runs of visible text meet AA` +
        (bad.length ? ` -> ${bad.length} fail, e.g. ${bad[0].sel} "${bad[0].text}" ` +
          `${bad[0].ratio.toFixed(2)}:1 (needs ${bad[0].need})` : ''));
      ok(faded.length === 0,
        `${theme}: no text is faded by an ancestor opacity` +
        (faded.length ? ` -> ${faded[0].sel} at ${faded[0].opacity}` : ''));
      console.log(`        ${theme} worst: ${worst.sel} "${worst.text}" ` +
        `${worst.ratio.toFixed(2)}:1 at ${worst.size}px (${worst.tab})`);
    }
    ok(worstPerTheme.dark.ratio >= AA_TEXT && worstPerTheme.light.ratio >= AA_TEXT,
      `worst case anywhere: dark ${worstPerTheme.dark.ratio.toFixed(2)}:1, ` +
      `light ${worstPerTheme.light.ratio.toFixed(2)}:1 (AA needs ${AA_TEXT})`);

    // Non-text contrast (WCAG 1.4.11): the marks that identify state without
    // any text next to them have their own 3:1 floor.
    for (const light of [false, true]) {
      await page.evaluate(on => {
        const p = document.getElementById('rbl-panel');
        if (p.classList.contains('rbl-light') !== on) {
          document.querySelectorAll('#rbl-head .rbl-btn')[0].click();
        }
      }, light);
      await page.evaluate(() => window.__harness.showTab('Sets'));
      await page.waitForTimeout(350);
      await page.evaluate(() => window.__harness.openAll());
      await page.waitForTimeout(200);

      const edges = await page.evaluate(() => {
        const A = window.__a11y, out = [];
        const p = document.getElementById('rbl-panel');
        const cs = getComputedStyle(p);
        const edge = A.parse(cs.getPropertyValue('--rbl-edge').trim());
        // the token that all real control boundaries are drawn from
        ['--rbl-bg', '--rbl-bg-2', '--rbl-bg-3'].forEach(v => {
          const bg = A.parse(cs.getPropertyValue(v).trim());
          out.push({ sel: '--rbl-edge on ' + v, ratio: A.ratio(edge, bg) });
        });
        // the underline that says which tab you are on
        const on = document.querySelector('#rbl-tabs .rbl-tab.rbl-tab-on');
        out.push({
          sel: 'selected tab underline',
          ratio: A.ratio(A.over(A.parse(getComputedStyle(on).borderBottomColor), A.bgOf(on)), A.bgOf(on))
        });
        // the "fainted" badge, which is a dashed outline and nothing else
        const out2 = document.querySelector('.rbl-chip-out');
        if (out2) {
          const b = A.bgOf(out2.parentElement);
          out.push({
            sel: 'fainted badge outline',
            ratio: A.ratio(A.over(A.parse(getComputedStyle(out2).borderTopColor), b), b)
          });
        }
        // the HP bar, whose fill has to be distinguishable from its track
        const hp = document.querySelector('.rbl-hp');
        if (hp) {
          const track = A.parse(getComputedStyle(hp).backgroundColor);
          const fill = A.parse(getComputedStyle(hp.firstElementChild).backgroundColor);
          out.push({ sel: 'HP fill vs track', ratio: A.ratio(fill, track) });
        }
        return out;
      });
      const weak = edges.filter(e => e.ratio + 0.005 < AA_UI);
      ok(edges.length >= 6 && weak.length === 0,
        `${light ? 'light' : 'dark'}: ${edges.length} non-text boundaries meet the 3:1 minimum` +
        (weak.length ? ` -> ${weak[0].sel} at ${weak[0].ratio.toFixed(2)}:1` : ''));
    }
  }

  // -----------------------------------------------------------------
  console.log('\n[9] Reduced motion and forced contrast are honoured');
  {
    const rm = await browser.newPage({ viewport: { width: 1180, height: 900 }, reducedMotion: 'reduce' });
    await rm.addInitScript(HELPERS);
    await rm.goto(`http://127.0.0.1:${PORT}/test/harness.html`);
    await rm.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
    await rm.evaluate(() => window.__harness.openAll());
    await rm.waitForTimeout(250);
    const durations = await rm.evaluate(() =>
      [...document.querySelectorAll('#rbl-panel, #rbl-panel *')]
        .map(e => getComputedStyle(e).transitionDuration)
        .filter(d => d && !/^0s(,\s*0s)*$/.test(d)));
    ok(durations.length === 0,
      `prefers-reduced-motion: no element keeps a transition (${durations[0] || 'none'})`);

    const hc = await browser.newPage({ viewport: { width: 1180, height: 900 }, contrast: 'more' });
    await hc.addInitScript(HELPERS);
    await hc.goto(`http://127.0.0.1:${PORT}/test/harness.html`);
    await hc.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
    await hc.waitForTimeout(250);
    const hcEdges = await hc.evaluate(() => {
      const A = window.__a11y, p = document.getElementById('rbl-panel');
      const card = document.querySelector('.rbl-mon');
      const cs = getComputedStyle(card);
      const bg = A.bgOf(card.parentElement);
      return {
        line: getComputedStyle(p).getPropertyValue('--rbl-line').trim(),
        edge: getComputedStyle(p).getPropertyValue('--rbl-edge').trim(),
        cardBorder: A.ratio(A.over(A.parse(cs.borderTopColor), bg), bg)
      };
    });
    ok(hcEdges.cardBorder >= AA_UI,
      `prefers-contrast: more promotes the hairlines to a real edge (${hcEdges.cardBorder.toFixed(2)}:1)`);
    await rm.close(); await hc.close();
  }

  console.log('\n[10] No script errors');
  ok(pageErrors.filter(e => !/Failed to load resource/.test(e)).length === 0,
    `clean${pageErrors.length ? ' -> ' + pageErrors[0] : ''}`);

  await browser.close();
  server.close();
  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
