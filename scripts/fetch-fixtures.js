#!/usr/bin/env node
/* Download the randbats stats files the test suite runs against.
 * Writes to test/fixtures/ (used by ui.test.js) and to the directory
 * engine.test.js reads, which defaults to /tmp/rb and can be overridden
 * with RBL_DATA. */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const FORMATS = [
  'gen9randombattle', 'gen8randombattle', 'gen1randombattle',
  'gen9randomdoublesbattle', 'gen9championsrandomdoublesbattle',
  'gen9babyrandombattle', 'gen7letsgorandombattle', 'gen8bdsprandombattle'
];

// Formats the browser tests load directly out of test/fixtures/
const FIXTURE_FORMATS = [
  'gen9randombattle', 'gen9randomdoublesbattle', 'gen9championsrandomdoublesbattle'
];

const SOURCES = [
  f => `https://data.pkmn.cc/randbats/stats/${f}.json`,
  f => `https://raw.githubusercontent.com/pkmn/randbats/main/data/stats/${f}.json`
];

const FIXTURES = path.resolve(__dirname, '..', 'test', 'fixtures');
const DATA = process.env.RBL_DATA || '/tmp/rb';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> ${res.statusCode}`)); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve(buf));
    }).on('error', reject);
  });
}

async function fetchOne(f) {
  let lastErr;
  for (const src of SOURCES) {
    try { return await get(src(f)); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

(async () => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of FORMATS) {
    const body = await fetchOne(f);
    JSON.parse(body);                        // fail loudly on a bad download
    // engine.test.js reads these names
    const engineName = f === 'gen9randombattle' ? 'g9stats.json' : `${f}.stats.json`;
    fs.writeFileSync(path.join(DATA, engineName), body);
    if (FIXTURE_FORMATS.indexOf(f) !== -1) {
      fs.writeFileSync(path.join(FIXTURES, f + '.json'), body);
    }
    console.log(`  ${f}  ${(body.length / 1024).toFixed(0)} KB`);
  }
  console.log(`\nfixtures -> ${FIXTURES}\ndata     -> ${DATA}`);
})().catch(e => { console.error('fetch failed:', e.message); process.exit(1); });
