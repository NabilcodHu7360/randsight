# Publishing

Everything in the repo is ready. What's left is account creation, one push, and
one conversation — all of which need you rather than the code.

---

## 1. Push it

The repo is initialised with one commit on `main`. Create an empty repo named
`randsight` on GitHub (no README, no licence, no `.gitignore` — they're all
here already), then:

```bash
git remote add origin git@github.com:NabilcodHu7360/randsight.git
git push -u origin main
```

CI runs on that push. `.github/workflows/test.yml` installs Chromium, fetches
the set-data fixtures, and runs all ten suites; it takes about fifteen minutes
and uploads the packaged zip as an artifact. If it's green, the extension builds
and passes on a machine that isn't yours, which is the only real proof.

## 2. Turn on Pages

**Settings → Pages → Source: `main` / `/docs`.**

That publishes:

| URL | What |
|---|---|
| `…github.io/randsight/` | The landing page |
| `…github.io/randsight/privacy.html` | **The privacy-policy URL the Web Store requires** |

Both are self-contained. The privacy page loads nothing at all — no fonts, no
CDN, no script. An analytics tag on a privacy policy answers its own question.

## 3. Ask Smogon

`docs/SMOGON-POST.md` is a draft ready to post, with four specific questions
including the sprite hotlinking.

**Do this before submitting to the store, not alongside it.** Showdex and the
pkmn Randbats Tooltip both exist and are tolerated, but both stop at showing set
data. This gives damage numbers and a switch recommendation, which is a
different conversation. If the answer is "not the advice parts", that's a small
change now and an awkward retraction later. The draft includes what to do if
they say no, and what to do if nobody replies.

## 4. Submit

1. Chrome Web Store developer account — one-off $5, on whichever Google account
   should own the listing.
2. Upload the zip from `npm run package`. Never a hand-made one: the packager is
   an allowlist and `load.test.js` asserts nothing else got in.
3. Paste the fields from `docs/LISTING.md`. Every one is written out and inside
   its character limit, including the single-purpose statement and the
   permission justifications reviewers ask for.
4. Screenshots from `docs/store/`. They are generated, not hand-taken:
   ```bash
   npm run shots
   ```
   That drives the same harness the UI suite uses, at 1280x800, so the shots
   always match the code that is shipping — which the old hand-taken ones did
   not, having survived both v1.7.0 and the rename. **Run it somewhere
   `play.pokemonshowdown.com` is reachable**, or every card gets a blank icon
   square; the script refuses rather than writing shots with holes in them.

   A real ladder screenshot is still the more convincing asset if you want to
   swap one in. Run it through the redactor first — it OCRs the frame and
   covers the usernames:
   ```bash
   python3 scripts/anonymise-shots.py docs/store new-shot.png
   ```
5. Data usage: every box **not collected**, and tick all three certifications.

Expect a few days of review. First submissions get looked at harder.

---

## Keeping it alive

- **Set data changes with every balance patch.** `refresh-joint-tables.yml` runs
  weekly, rebuilds all fourteen tables, validates them against freshly generated
  teams, and opens a PR only if the sets actually changed. Nothing to do unless
  it fails.
- **The extension degrades rather than lies** when data goes stale: a per-species
  fingerprint of the published move pool means a Pokémon whose sets changed
  falls back to the marginal model instead of serving a wrong answer.
- **`src/vendor/calc.js` is pinned** to @smogon/calc 0.11.0. When a new
  generation lands, bump the pin in `scripts/build-vendor.sh` and re-run it —
  until then the calc won't know new species, and the Switch tab shows those
  slots as `unknown` rather than guessing.

## The one real product gap left

**Damage taken as evidence.** Randbats spreads are fixed, so "my Close Combat
did 41%" is a strong signal about whether they're holding an Assault Vest or
Leftovers. The calculator currently only runs forwards. Inverting it — observing
the HP drop and updating the item posterior — is the biggest remaining
improvement to the model, and nothing else on the list comes close.

Smaller ones, in rough order of value:

- Doubles-aware *damage*: spread-move targeting, redirection, ally interactions.
  The pairing picker fixed the honesty problem, not the modelling one.
- Replay support. `replay.pokemonshowdown.com` is matched in the manifest but
  the page structure is untested, so it probably shows "No battle open".
- Keyboard move/resize for the panel. Dragging is mouse-only; the popup's reset
  is currently the only keyboard-reachable escape.
- A real screen-reader run. The accessibility work is asserted through the DOM
  and computed styles only — no NVDA or VoiceOver has actually seen it.
