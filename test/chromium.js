/*
 * Where to find Chromium.
 *
 * This sandbox ships a prebuilt one at a fixed path; CI installs its own via
 * `npx playwright install chromium`. Prefer the explicit path when it exists so
 * local runs never re-download.
 *
 * When there is no explicit path we ask for the 'chromium' CHANNEL rather than
 * letting the default resolve. That channel is the new-headless build, and
 * loading an unpacked extension — which load.test.js does — does not work under
 * the old headless mode. This is the one thing that differs between a local run
 * and CI, so it is the one thing worth being explicit about.
 */
'use strict';
const fs = require('fs');
const p = process.env.RS_CHROMIUM || process.env.RBL_CHROMIUM || '/opt/pw-browsers/chromium';
module.exports = fs.existsSync(p) ? { executablePath: p } : { channel: 'chromium' };
