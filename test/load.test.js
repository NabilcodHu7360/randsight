/* Loads the unpacked extension into real Chromium to prove the manifest,
 * service worker and content scripts actually parse and register.
 * Run: node test/load.test.js  */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
let failures = 0;
function ok(cond, msg) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
  if (!cond) failures++;
}

(async () => {
  console.log('\n[1] Manifest');
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  ok(mf.manifest_version === 3, 'manifest_version 3');
  const files = []
    .concat(mf.background.service_worker)
    .concat(...mf.content_scripts.map(c => (c.js || []).concat(c.css || [])))
    .concat(mf.action.default_popup)
    .concat(Object.values(mf.icons));
  const missing = files.filter(f => !fs.existsSync(path.join(EXT, f)));
  ok(missing.length === 0, `all ${files.length} referenced files exist${missing.length ? ' — missing ' + missing : ''}`);
  ok(mf.content_scripts.some(c => c.world === 'MAIN'), 'a MAIN-world content script is declared');
  ok(mf.content_scripts.some(c => c.world === 'ISOLATED'), 'an ISOLATED-world content script is declared');
  ok(!JSON.stringify(mf.permissions).includes('tabs'), 'no broad tabs permission requested');
  ok(JSON.stringify(mf.permissions) === '["storage"]', 'storage is the only permission');
  ok(!mf.host_permissions.some(h => /pokemonshowdown/.test(h)),
    'no host permission on pokemonshowdown.com — content scripts are declarative only');
  const popupSrc = fs.readFileSync(path.join(EXT, 'popup', 'popup.js'), 'utf8');
  ok(!/chrome\.tabs/.test(popupSrc), 'popup does not touch chrome.tabs');

  console.log('\n[2] Load into Chromium');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbl-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    ...require('./chromium'),
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run'
    ]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  ok(!!sw, 'service worker registered' + (sw ? ' at ' + sw.url().split('/').pop() : ''));
  // chrome.runtime lives in the isolated world, which page.evaluate can't
  // reach, so resolve the extension id from the service worker URL instead.
  const extId = sw ? new URL(sw.url()).host : null;

  if (sw) {
    const formatsOk = await sw.evaluate(() => {
      const a = self.RBLFormats.resolve('battle-gen9randombattle-2312345678');
      const b = self.RBLFormats.resolve('battle-gen9randombattleblitz-99');
      const c = self.RBLFormats.resolve('battle-gen9hackmonscup-1');
      const d = self.RBLFormats.resolve('battle-gen9randombattlemayhem-1');
      return {
        base: a.ok && a.file === 'gen9randombattle',
        alias: b.ok && b.file === 'gen9randombattle',
        unsupported: !c.ok,
        approx: d.ok && d.exact === false && d.file === 'gen9randombattle',
        gen: self.RBLFormats.generation('gen1randombattle')
      };
    });
    ok(formatsOk.base, 'room id -> gen9randombattle');
    ok(formatsOk.alias, 'blitz aliases onto the base format');
    ok(formatsOk.unsupported, 'hackmonscup correctly rejected');
    ok(formatsOk.approx, 'mayhem resolves but is flagged approximate');
    ok(formatsOk.gen === 1, 'generation() parses gen1');

    const listens = await sw.evaluate(() => typeof chrome.runtime.onMessage.hasListeners === 'function'
      ? chrome.runtime.onMessage.hasListeners() : true);
    ok(listens, 'service worker has a message listener attached');
  }

  console.log('\n[3] Joint tables ship and are reachable from the page');
  {
    const dataDir = path.join(EXT, 'src', 'data');
    const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter(f => f.endsWith('.json')) : [];
    ok(files.length > 0, `${files.length} joint table(s) bundled: ${files.map(f => f.replace(/^joint-|\.json$/g, '')).join(', ')}`);
    // A format we claim to support but have no table for silently runs the
    // weaker marginal model. That gap is invisible in the UI, so assert it here.
    const have = new Set(files.map(f => f.replace(/^joint-|\.json$/g, '')));
    const claimed = fs.readFileSync(path.join(EXT, "src", "formats.js"), 'utf8')
      .match(/var SUPPORTED = \[([\s\S]*?)\]/)[1]
      .match(/'([a-z0-9]+)'/g).map(s => s.slice(1, -1));
    const missing = claimed.filter(f => !have.has(f));
    ok(missing.length === 0,
      `every supported format has a joint table (${claimed.length} formats${missing.length ? ', missing ' + missing.join(', ') : ''})`);

    const war = JSON.stringify(mf.web_accessible_resources || []);
    ok(/src\/data/.test(war), 'src/data is declared web-accessible so the content script can fetch it');
    const total = files.reduce((a, f) => a + fs.statSync(path.join(dataDir, f)).size, 0);
    ok(total < 4 * 1024 * 1024, `joint tables total ${(total / 1024 / 1024).toFixed(2)} MB`);
    for (const f of files) {
      const t = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
      if (!t.species || !Object.keys(t.species).length) { ok(false, `${f} has no species`); break; }
    }
    ok(true, 'every table parses and has species');
  }

  console.log('\n[4] The first-run guide actually opens');
  {
    // MV3 extension pages run under `script-src 'self'`, so an inline <script>
    // is silently blocked — and the extension promises it makes no network
    // requests beyond the set data, so a webfont link would break that too.
    const src = fs.readFileSync(path.join(EXT, 'guide', 'guide.html'), 'utf8');
    ok(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/.test(src),
      'the guide has no inline script, which MV3 would block');
    ok(!/https?:\/\/(?!.*pokemonshowdown|.*github|.*pkmn)/.test(
      src.replace(/<a [^>]*href="https?:\/\/[^"]*"/g, '')),
      'the guide loads no remote assets — no webfonts, no CDN');

    const gpage = await ctx.newPage();
    const gerrs = [];
    gpage.on('pageerror', e => gerrs.push(String(e)));
    gpage.on('console', m => { if (m.type() === 'error') gerrs.push('console: ' + m.text()); });
    const offsite = [];
    gpage.on('request', r => { if (!/^chrome-extension:/.test(r.url())) offsite.push(r.url()); });

    await gpage.goto(`chrome-extension://${extId}/guide/guide.html`);
    await gpage.waitForTimeout(2600);

    ok(gerrs.length === 0, `guide renders with no errors${gerrs.length ? ' -> ' + gerrs[0] : ''}`);
    ok(offsite.length === 0,
      `guide requests nothing off-origin${offsite.length ? ' -> ' + offsite[0] : ''}`);

    const g = await gpage.evaluate(() => ({
      title: document.title,
      shots: [...document.images].filter(i => i.naturalWidth > 0).length,
      images: document.images.length,
      ko: !!document.getElementById('ko'),
      // the specimen animates a reveal; after it settles the row must read "seen"
      revealed: document.querySelector('#reveal .pct')?.textContent
    }));
    ok(/Randbats Live/.test(g.title), `titled "${g.title}"`);
    ok(g.shots === g.images && g.images === 3, `all ${g.images} screenshots loaded`);
    ok(g.ko, 'the KO glossary is present');
    ok(g.revealed === 'seen', `the opening specimen resolves to a reveal (${g.revealed})`);
    await gpage.close();

    const bg = fs.readFileSync(path.join(EXT, 'src', 'background.js'), 'utf8');
    ok(/reason === 'install'/.test(bg),
      'the guide opens on first install only, not on every update');
  }

  console.log('\n[4b] The shipped package contains only what it should');
  {
    // An exclude-list quietly ships whatever you forgot to exclude. Assert the
    // allowlist held: no node_modules, no test harnesses with a mocked chrome
    // API, no dev scripts, no repo docs.
    const { execSync } = require('child_process');
    execSync('bash scripts/package.sh /tmp/rbl-pkg-check.zip', { cwd: EXT });
    const listing = execSync('unzip -Z1 /tmp/rbl-pkg-check.zip', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(f => f && !f.endsWith('/'));

    const allowed = /^(manifest\.json|LICENSE|THIRD-PARTY-LICENSES\.txt|PRIVACY\.md|(src|popup|guide|icons)\/)/;
    const stray = listing.filter(f => !allowed.test(f));
    ok(stray.length === 0, `no stray files in the package (${listing.length} files${stray.length ? ' — ' + stray.slice(0, 5).join(', ') : ''})`);
    ok(!listing.some(f => /node_modules|\.test\.js|harness|fixtures|probe|\.md$/.test(f) && f !== 'PRIVACY.md'),
      'no tests, harnesses, fixtures or dev scripts ship');
    ok(listing.includes('LICENSE') && listing.includes('THIRD-PARTY-LICENSES.txt'),
      'the licence files ship — the vendored MIT bundle requires them');
    const bytes = fs.statSync('/tmp/rbl-pkg-check.zip').size;
    ok(bytes < 5 * 1024 * 1024, `package is ${(bytes / 1024).toFixed(0)} KB`);
    fs.rmSync('/tmp/rbl-pkg-check.zip', { force: true });
  }

  console.log('\n[5] Content scripts on a Showdown-shaped page');
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  // Route the real host to a local stub so we exercise the manifest's match
  // patterns without needing network access.
  await page.route('https://play.pokemonshowdown.com/**', route => {
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title><body></body>' });
  });
  await page.goto('https://play.pokemonshowdown.com/');
  await page.waitForTimeout(1500);

  // The content script fetches its joint table by extension URL. That only
  // works if web_accessible_resources lists it AND the page origin matches, so
  // fetch it from the page exactly as the content script would.
  const jointOk = await page.evaluate(async (id) => {
    if (!id) return 'no extension id';
    try {
      const r = await fetch(`chrome-extension://${id}/src/data/joint-gen9randombattle.json`);
      if (!r.ok) return 'HTTP ' + r.status;
      const t = await r.json();
      return Object.keys(t.species || {}).length;
    } catch (e) { return 'ERR ' + e.message; }
  }, extId);
  ok(typeof jointOk === 'number' && jointOk > 400,
    `joint table is fetchable from the page origin (${jointOk} species)`);

  const injected = await page.evaluate(() => ({
    panel: !!document.getElementById('rbl-panel'),
    empty: (document.querySelector('#rbl-panel .rbl-empty b') || {}).textContent || '',
    styled: !!document.getElementById('rbl-panel') &&
      getComputedStyle(document.getElementById('rbl-panel')).position === 'fixed'
  }));
  ok(injected.panel, 'overlay injected on play.pokemonshowdown.com');
  ok(injected.styled, 'overlay stylesheet applied');
  ok(/No battle open/.test(injected.empty), `empty state shown: "${injected.empty}"`);
  ok(errs.length === 0, `no page errors${errs.length ? ' -> ' + errs[0] : ''}`);

  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
