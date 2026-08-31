# Chrome Web Store readiness

Notes for publishing, and an honest assessment of the risk.

## The policy landscape as of now

Google's [2026 policy update](https://developer.chrome.com/blog/cws-policy-updates-2026)
took effect on **1 August 2026**. The two clauses that matter here:

> "Any user data collected by an extension must now be strictly necessary to the
> extension's disclosed single purpose."

> "All data collection be prominently disclosed to the user — regardless of
> whether the data is closely related to the extension's single purpose."

Plus an ongoing obligation to proactively disclose any later change in data
handling.

## Where this extension stands

Strong, because it collects nothing:

| Requirement | Status |
|---|---|
| Single purpose, clearly stated | ✅ One purpose: display Random Battle information while you play |
| Data collection strictly necessary | ✅ No user data is collected at all — nothing is sent to the developer, and there is no server |
| Prominent disclosure | ✅ [PRIVACY.md](../PRIVACY.md), to be published and linked in the listing. It discloses both request classes (set data, and the sprite fallback) and everything kept in `chrome.storage.local` |
| Minimum permissions | ✅ `storage`, plus two data-file hosts — and site access on the two Showdown hosts via content-script match patterns (see below) |
| No remote code execution | ✅ Everything ships in the package; fetched JSON is parsed as data, fetched PNGs are only ever a CSS background |
| No obfuscated code | ⚠️ Readable source, but `src/vendor/calc.js` is a 469 KB minified bundle. See "The vendored bundle is not reproducible" below |
| Licence notices for redistributed code | ✅ [LICENSE](../LICENSE) and [THIRD-PARTY-LICENSES.txt](../THIRD-PARTY-LICENSES.txt). Both must be inside the uploaded zip |
| Not circumventing an AI service's guardrails | ✅ Not applicable |

Avoiding a `tabs` permission and a broad host permission keeps the list short —
but "no host permission on pokemonshowdown.com" is not the same as "no access to
pokemonshowdown.com", and the submission must not be written as if it were.

### The host-access justification a reviewer will actually ask for

The manifest declares two `host_permissions` (`data.pkmn.cc`,
`raw.githubusercontent.com/pkmn/randbats`) and no host permission for Showdown.
Chrome nonetheless grants and displays site access for **content-script match
patterns**, so the install prompt reads:

> Read and change your data on play.pokemonshowdown.com and
> replay.pokemonshowdown.com

and both hosts appear under the extension's site-access settings. The permission
form has a field for this, and the earlier drafts of these notes did not
anticipate it. Text to paste:

> The extension's entire function is to read the Random Battle in front of the
> user and draw a panel over it, so it must run on the two pages where Random
> Battles happen. `play.pokemonshowdown.com` is where battles are played;
> `replay.pokemonshowdown.com` is where they are reviewed. Both are declared as
> static content-script matches rather than host permissions or
> `activeTab`/optional permissions, so the access is fixed at these two hosts,
> cannot be broadened at runtime, and never extends to any other tab.
>
> `src/inject.js` runs in the MAIN world because Showdown's battle state lives
> on page JavaScript (`window.app.battle`), which an isolated-world script
> cannot see. That object is the primary source. Because it is not a stable API,
> the script also installs two pass-through taps at load — `window.WebSocket` is
> wrapped in a `Proxy` whose `construct` trap attaches a `message` listener, and
> `XMLHttpRequest.prototype.open`/`.send` are wrapped to read the response text
> of Showdown's own `/showdown/` streaming requests — so the battle protocol can
> be parsed directly if the client object is unreadable. Both taps forward every
> argument and result unchanged, send nothing, and modify no frame. The script
> patches no Showdown method, never assigns to `battle.subscription`, and writes
> nothing into Showdown's own interface; the only DOM the extension adds is its
> own panel, styled by a stylesheet scoped entirely to that panel's class names.
>
> It reads the user's Showdown username from the `|updateuser|` protocol line
> solely to determine which side of the battle is theirs, and both players'
> display names to label the panel header. Neither is stored or transmitted.
> Nothing from chat or private messages is parsed or retained, and no data of
> any kind is sent to the developer.

Also declare the sprite request in the data-safety form's free text if there is
anywhere to put it: cards fetch
`https://play.pokemonshowdown.com/sprites/gen5/<species>.png` when the client's
`Dex.getPokemonIcon` is unavailable. It is a subresource load from a page the
extension already runs on, needs no permission, and goes to the origin already
serving the battle — but a reviewer running a network trace will see it, and it
is better disclosed than discovered.

### The vendored bundle is not reproducible

`docs/STORE.md` previously called `src/vendor/calc.js` a *reproducible* build.
It is not. `scripts/build-vendor.sh` runs `npm install @smogon/calc esbuild` in a
temp directory with **no pinned versions** for either, so re-running it after
upstream publishes anything produces a different file. What can honestly be
claimed is:

- the bundle's banner records the exact `@smogon/calc` version it came from
  (currently v0.11.0);
- the build script that produced it is in the repository;
- the library it bundles is public, MIT, and unmodified.

Pinning both dependencies (and committing a lockfile for the vendor build) would
make the "reproducible build" claim true, and is worth doing before the claim is
made to a reviewer. Until then, do not use the word.

## Things to prepare before submitting

1. **A developer account** — one-off US$5 registration fee.
2. **Host the privacy policy at a public URL** and link it in the listing.
   `PRIVACY.md` is written to be published as-is.
3. **Screenshots — none of the existing ones can be used.** The store accepts
   1280×800 or 640×400 only, and every image in `docs/` and `guide/` is neither:

   | File | Size |
   |---|---|
   | `docs/overlay-dark.png`, `docs/overlay-light.png` | 684×1812 |
   | `docs/doubles-tab.png` | 684×1138 |
   | `docs/switch-tab.png` | 684×692 |
   | `docs/tooltip.png` | 342×851 |
   | `docs/damage-tab.png` | 342×521 |
   | `guide/sets.png` | 700×1149 |
   | `guide/damage.png` | 620×945 |
   | `guide/switch.png` | 620×627 |

   They are also panel-only crops, where the store wants full-window shots. The
   widest is 684 px, so none can be scaled up to a 1280-wide frame without
   blurring — these have to be retaken, not resized.

   **On account names in screenshots.** The names visible in the current
   images — `RandomLadderer`, `DoublesFoe`, `AlphaTester` — are *not* real
   accounts; they come from the mock battles in `test/harness.html`,
   `test/harness-doubles.html` and
   `test/fixtures/battle-gen9randombattle-log.txt`. Nothing currently committed
   needs blurring. The hazard is the *replacement* shots: the panel header
   renders both players' display names, so a full-window capture of a real
   ladder game will publish a real opponent's account name (and the client's
   chat pane may show more). Either retake against the test harness at store
   dimensions, or blur every name in the client and the panel header before
   uploading.
4. **Fill in the data-safety form** truthfully: no data is collected — nothing is
   transmitted to the developer, and there is no server. Where the form allows
   free text, note the sprite request described above.
5. **Justify each permission** in the submission form — including the
   content-script host access, which the form does ask about. The block above is
   the text to paste.
6. **Decide on the vendored bundle.** Reviewers sometimes flag minified files as
   obfuscation. Either ship it unminified (≈1.4 MB instead of 469 KB, still
   fine), or include `scripts/build-vendor.sh` and describe it in the notes as a
   plain esbuild bundle of a published MIT library — *not* as a reproducible
   build, which it isn't. Shipping unminified is the lower-friction option and
   sidesteps the argument entirely.
7. **Ship the licence files.** `LICENSE` and `THIRD-PARTY-LICENSES.txt` must be
   inside the uploaded zip. `src/vendor/calc.js` is a redistributed copy of
   @smogon/calc, and MIT requires the copyright notice and permission notice to
   travel with it; the one-line `(MIT)` banner in the bundle is not sufficient
   on its own. The joint tables in `src/data/` are generated with Pokémon
   Showdown's own team generator, so Showdown is credited there and in
   `README.md` too.

## The delisted competitor

"Pokemon Showdown Random Battle Tooltip" (~1,000 users, last updated 2018) was
removed from the store in 2025. **The specific violation is not public**, and I
could not determine it — so treat the following as hypotheses, not findings:

- **Abandonment.** It had not been updated in roughly seven years. Manifest V2
  extensions were force-migrated, and MV2 items that were never updated were
  removed en masse. This is the most likely explanation by a distance, and it
  says nothing about the concept being disallowed.
- **Missing privacy disclosure.** Listings that never completed the data-safety
  declaration were removed in an earlier sweep.

What it is *probably not*: the category itself. Showdex (~80k users) and the pkmn
Randbats Tooltip (~10k) both do the same class of thing and remain listed and
actively updated. There is no evidence Showdown assistance tools are prohibited.

**Before publishing, check with Smogon.** The bigger practical risk is not
Google's policy but Pokémon Showdown's own stance on assistance tools in ladder
play. Showdex and the Randbats Tooltip both have long-running Smogon forum
threads, which suggests the community accepts them — but that is worth
confirming directly rather than assuming, especially for a tool that adds a
damage calculator and switch advice on top of set display.

Two things to put in front of them in the same conversation:

- **Sprite hotlinking.** When the page's `Dex.getPokemonIcon` isn't available —
  which is the entire protocol-fallback reader path — the panel loads each
  card's icon from `https://play.pokemonshowdown.com/sprites/gen5/<species>.png`
  directly. That is Showdown's bandwidth, requested by a third-party extension,
  on every card of every battle the fallback path serves. It is a small number
  of small images, browser-cached, and only on pages already loading assets from
  the same origin — but it is still their server, and asking is cheaper than
  being asked. Worth raising alongside: is hotlinking acceptable to them; would
  they prefer the extension bundle its own icon sheet; and would they rather it
  always used `Dex.getPokemonIcon` and simply showed no icon when the client
  object is unavailable.
- **The joint tables.** `src/data/joint-*.json` is 1.99 MB of set data sampled
  from Showdown's own `Teams.generate()`. It is MIT and attributed, so there is
  no licence question, but shipping a derivative of their generator's output is
  the kind of thing worth mentioning rather than letting them find.

## Not blocking, but worth doing first

- Full-window screenshots at 1280×800 or 640×400, with every account name either
  a test-harness fixture or blurred.
- A short listing description that leads with the differentiator (conditional
  probabilities, not just set lists) rather than a feature list.
- Decide whether to ship the calc bundle unminified.
- Pin `@smogon/calc` and `esbuild` in `scripts/build-vendor.sh` so the
  "reproducible build" claim can be made honestly.

## Publisher

Copyright holder and Web Store developer account: **Mohammad Nabil Islam**
([@NabilcodHu7360](https://github.com/NabilcodHu7360)). `LICENSE` and
`THIRD-PARTY-LICENSES.txt` both ship inside the package.

### Screenshots — ready

`docs/store/` holds three 1280×800 shots, taken from a real Gen 9 Random
Doubles ladder game:

| file | shows |
|---|---|
| `1-sets.png` | Turn 1. Two full opposing cards — role split, move probabilities summing to 4, item and Tera lines, speed. |
| `2-damage.png` | Turn 5. The doubles pairing picker, the speed verdict, both damage directions with KO summaries. |
| `3-switch.png` | Turn 6. Both actives marked, worst hit per slot, survives yes/KO, four fainted slots. |

**Both account names are gone from all three.** Every occurrence of either
handle — including the one the panel itself renders in its header — is painted
out and replaced with `PlayerA` / `PlayerB`, same length so nothing reflows.
`scripts/anonymise-shots.py` does this with OCR rather than pinned coordinates,
so it works on future screenshots too:

```bash
python3 scripts/anonymise-shots.py docs/store shot1.png shot2.png
```

Verified by re-running OCR over the finished images: no fragment of either
handle survives. The players' chat is blurred in `3-switch.png` — a third
party's conversation, not ours to publish — and the site's ad rail is blurred
where the panel sits over it. Nothing the extension itself renders is altered
beyond the handle.

**`2-damage.png` needs retaking after v1.7.0.** It shows two things that build
changed: a "Stat reconstruction differs on atk" warning that was a false
positive from their Intimidate, and pairing buttons reading "Dipplin → Glaceon"
where the header beneath said "Glaceon vs Dipplin". Both fixed; the shot now
shows an older build.

---

## Paste-ready material now exists

| File | What it is |
|---|---|
| `docs/LISTING.md` | Every listing field written out and within its character limit — name, short and long description, category, the single-purpose statement, permission justifications, data-usage answers |
| `docs/SMOGON-POST.md` | A draft forum post, plus what to do if the answer is no or if nobody replies |
| `docs/privacy.html` | `PRIVACY.md` rendered as a standalone page for hosting. No webfonts, no CDN, no script — an analytics tag on a privacy policy would be its own answer |
| `docs/store/*.png` | Three 1280×800 screenshots from a real game, both handles replaced |
| `scripts/package.sh` | The allowlist packager. Use this, never a hand-made zip |
| `scripts/anonymise-shots.py` | Redoes the handle replacement on future screenshots |
| `scripts/build-privacy-page.py` | Rebuilds `privacy.html` when `PRIVACY.md` changes |

### The vendored bundle now ships unminified

`src/vendor/calc.js` was a 480 KB single line. It is now 854 KB across 24,046
readable lines (138 KB gzipped over the wire, and it is read from disk anyway —
first render measured at 199 ms either way). A reviewer can audit it, which is
worth more than the bytes.

`scripts/build-vendor.sh` now pins both `@smogon/calc` and `esbuild`, so
"regenerate it yourself and compare" is a true claim rather than a hopeful one.
