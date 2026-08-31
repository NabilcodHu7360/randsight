/*
 * Store screenshots, made reproducible.
 *
 * The three PNGs in docs/store were hand-taken off the ladder, which meant a
 * rename or a UI change silently left them stale — and it did: they still said
 * "Randbats Live". This drives the same harness the UI suite uses, so the shots
 * always match the code that is actually shipping.
 *
 *   node scripts/shots.js
 *
 * Chrome Web Store wants 1280x800 (or 640x400), so that is the viewport.
 *
 * One caveat worth knowing: the Pokemon icons are background-images served from
 * play.pokemonshowdown.com. Run this somewhere that host is reachable or every
 * card gets a blank icon square. The script checks and refuses rather than
 * writing shots with holes in them; pass --allow-blank-icons to override.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'store');
const PORT = 8744;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const ALLOW_BLANK = process.argv.includes('--allow-blank-icons');

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

/* A plain backdrop. The harness's debug log is not part of the product, and a
 * store shot of the panel over a screenshot of Showdown would need Showdown's
 * own copyrighted art in it. Neutral it is.
 *
 * The panel is ~265px wide by design — it has to sit beside a battle without
 * covering it. At 1:1 in a 1280x800 frame that reads as a stamp on an empty
 * page, so the shot scales it up and gives the space left over to a caption
 * rather than to more background. */
const SCALE = 1.45;
const BACKDROP = `
  #log { display: none !important; }
  body {
    background: radial-gradient(1100px 800px at 18% -12%, #1c2532 0%, #0e1116 60%) !important;
    overflow: hidden !important;
  }
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image:
      linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px);
    background-size: 46px 46px;
  }
  #rs-panel {
    left: 64px !important; top: var(--panel-top, 34px) !important;
    right: auto !important; bottom: auto !important;
    transform: scale(${SCALE}) !important;
    transform-origin: top left !important;
    max-height: ${Math.round(732 / SCALE)}px !important;
    box-shadow: 0 26px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.055) !important;
    z-index: 2 !important;
  }
  /* --cap-left is measured off the rendered panel, because the panel sizes
     itself to its content and a hardcoded column would overlap the wide ones. */
  #rs-cap {
    position: fixed; z-index: 5;
    left: var(--cap-left, 620px); right: 64px; top: 50%; transform: translateY(-50%);
    font: 400 17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color: #9aa4b4; letter-spacing: .1px;
  }
  #rs-cap h2 {
    margin: 0 0 14px; font-size: 34px; line-height: 1.18; font-weight: 650;
    letter-spacing: -.5px; color: #eef1f6;
  }
  #rs-cap h2 em { font-style: normal; color: #8fbcff; }
  #rs-cap p { margin: 0 0 12px; max-width: 30ch; }
  #rs-cap p:last-child { margin-bottom: 0; }
  #rs-cap .rs-cap-k {
    display: inline-block; margin-top: 20px; padding: 5px 11px;
    border: 1px solid #3d4453; border-radius: 999px;
    font-size: 13px; color: #adb6c5; letter-spacing: .3px;
  }
`;

const SHOTS = [
  { file: '1-sets.png', tab: 'Sets', open: 'all',
    h: 'Every set they <em>could</em> still have',
    p: ['Randsight reads the battle log and narrows the opponent down to what the '
      + 'random-battle generator can actually produce.',
       'Seen moves are locked in. The rest carry the odds they deserve.'],
    k: 'Sets' },
  { file: '2-damage.png', tab: 'Damage', open: 'none',
    h: 'The roll, and what it <em>means</em>',
    p: ['Real damage numbers from Smogon’s own calculator, weighted across every '
      + 'item and ability they might be holding.',
       'It answers the question you were going to ask anyway: do I survive, and do I kill?'],
    k: 'Damage' },
  { file: '3-switch.png', tab: 'Switch', open: 'none',
    h: 'Who comes in and <em>lives</em>',
    p: ['Every bench Pokemon scored against what is in front of you — what it '
      + 'takes, what is left, and whether it outspeeds.'],
    k: 'Switch' }
];

function captionHTML(s) {
  return '<h2>' + s.h + '</h2>' + s.p.map(t => '<p>' + t + '</p>').join('') +
         '<span class="rs-cap-k">' + s.k + ' tab</span>';
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise(r => server.listen(PORT, r));

  const browser = await chromium.launch({ ...require('../test/chromium') });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2                       // the store downscales; 2x stays sharp
  });

  const blockedIcons = [];
  page.on('requestfailed', r => { if (/pokemonshowdown\.com/.test(r.url())) blockedIcons.push(r.url()); });
  page.on('response', r => { if (r.status() >= 400 && /pokemonshowdown\.com/.test(r.url())) blockedIcons.push(r.url()); });

  await page.goto(`http://127.0.0.1:${PORT}/test/harness.html`);
  await page.waitForFunction(() => window.__harness && window.__harness.ready(), { timeout: 15000 });
  await page.addStyleTag({ content: BACKDROP });

  await page.evaluate(() => {
    const cap = document.createElement('div');
    cap.id = 'rs-cap';
    document.body.appendChild(cap);
  });

  for (const shot of SHOTS) {
    await page.evaluate(t => window.__harness.showTab(t), shot.tab);
    if (shot.open === 'all') await page.evaluate(() => window.__harness.openAll());
    await page.evaluate(html => {
      const root = document.documentElement;
      const panel = document.getElementById('rs-panel');
      document.getElementById('rs-cap').innerHTML = html;

      // Centre the panel vertically. The Switch tab is half the height of the
      // Sets tab, and pinning both to the top left one of them floating in an
      // empty lower half. Measured with the offset reset so the reading is the
      // panel's own height, not its height plus wherever it currently sits.
      root.style.setProperty('--panel-top', '0px');
      const h = panel.getBoundingClientRect().height;
      root.style.setProperty('--panel-top', Math.max(30, Math.round((800 - h) / 2)) + 'px');
      root.style.setProperty('--cap-left',
        Math.round(panel.getBoundingClientRect().right + 54) + 'px');
    }, captionHTML(shot));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, shot.file) });
    console.log(`  ${shot.file}  ${shot.tab}`);
  }

  await browser.close();
  server.close();

  if (blockedIcons.length) {
    const msg = `\n${blockedIcons.length} icon request(s) to play.pokemonshowdown.com were blocked, ` +
                `so the cards in these shots have empty icon squares.\n  e.g. ${blockedIcons[0]}\n`;
    if (!ALLOW_BLANK) {
      console.error(msg + 'Re-run somewhere that host is reachable, or pass --allow-blank-icons.');
      process.exit(1);
    }
    console.warn(msg + '(--allow-blank-icons given, keeping them anyway)');
  }
  console.log(`\nWrote ${SHOTS.length} shots to docs/store/ at 1280x800.`);
})().catch(e => { console.error(e); process.exit(1); });
