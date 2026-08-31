/*
 * Where to find Chromium.
 *
 * This sandbox ships a prebuilt one at a fixed path; CI installs its own and
 * playwright already knows where that is. Prefer the explicit path when it
 * exists so local runs never re-download, and fall through to playwright's
 * own resolution when it doesn't.
 */
'use strict';
const fs = require('fs');
const p = process.env.RBL_CHROMIUM || '/opt/pw-browsers/chromium';
module.exports = fs.existsSync(p) ? { executablePath: p } : {};
