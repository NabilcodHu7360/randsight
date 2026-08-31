# Chrome Web Store listing — paste-ready copy

Everything below is written to be pasted into the developer dashboard as-is.
Where a field has a hard character limit, the count is given and the text is
inside it.

---

## Name (45 char limit)

```
Randsight
```

`13/45`. Leaving it short on purpose — the store appends nothing, and a name
padded out with keywords ("Randsight — Pokémon Showdown Random Battle Set
Predictor") reads as SEO rather than as a product.

---

## Short description (132 char limit)

```
Live set prediction for Pokémon Showdown Random Battles: what the opponent is probably running, and what it does to you.
```

`119/132`.

Alternatives if you want a different emphasis:

```
Predicts the opposing Pokémon's moves, item and Tera in Random Battles — and updates every time they reveal something.
```
`117/132`

```
A Random Battle overlay that keeps a running estimate of the opposing team, with damage numbers and switch advice.
```
`113/132`

---

## Detailed description

```
Randsight watches your Pokémon Showdown Random Battle and keeps a running
estimate of what the opposing team is holding. Every time they reveal a move, an
item or a Tera type, the whole picture tightens.

It is not a lookup table. Random Battles draw a Pokémon's moves from a role, and
the generator picks the item from the moves it chose — so what you have already
seen genuinely changes what is still possible. Randsight models that
relationship instead of showing you the same static percentages every game.

WHAT YOU GET

Sets — one card per opposing Pokémon. Per-move probabilities for the slots you
haven't seen, the role posterior, item, ability, Tera type, and their speed at
their actual level. Anything that has stopped being a question shrinks to one
line, so what's on screen is what's still undecided. Hover anything for what it
actually does.

Damage — the current matchup, both directions, opening with a plain-English
verdict: "You survive — worst is Headlong Rush at 64%, about 2 hits." Incoming
moves are ranked by threat, meaning damage discounted by how likely they
actually have it — a plain calculator can't rank a move it doesn't know about.
Damage is computed across their whole item and ability distribution, not one
guess. Immunities are shown, not hidden.

Switch — your six ranked by how much HP is left standing after the worst hit
they can realistically land. It leads with the answer, and if nothing on your
bench survives, it says so rather than recommending a Pokémon that dies.

It also reads three things off the battle that set data cannot tell you:
Terastallization is once per side, so after they use it the panel stops showing
Tera types for everyone else. A Choice item locks them into the move they just
used. A move used to its PP limit cannot happen again.

FORMATS

All fourteen supported Random Battle formats ship their own prediction data —
gen 1 through gen 9 singles, gen 9 doubles, Champions doubles, Baby, BDSP, and
Let's Go. Blitz and unrated lobbies work too. Multi and Free-For-All resolve to
the closest format and are labelled as approximate.

PRIVACY

It collects nothing. No account, no analytics, no telemetry, no server. Two
kinds of request leave your browser: the public set-data files from
pkmn/randbats, and Pokémon sprites from Showdown's own sprite server. The only
permission it asks for is storage, used to remember where you left the panel.
The full policy is linked below and ships inside the extension.

Open source, MIT licensed. Not affiliated with Smogon, Pokémon Showdown, or
Nintendo/Game Freak.
```

---

## Category

**Primary:** Entertainment

Not "Productivity" — a reviewer who opens it sees a game overlay, and a
mismatched category invites a closer look for the wrong reason.

## Language

English (United States)

---

## Single purpose (required field)

Reviewers reject vague answers here. This one is narrow and matches what the
code actually does:

```
Randsight has a single purpose: to display predicted set information for the
opposing team during a Pokémon Showdown Random Battle. It reads the battle state
already present on play.pokemonshowdown.com and renders an overlay panel on that
page. It has no other function and operates on no other site.
```

---

## Permission justifications

### `storage`

```
Used only to remember the overlay's position, size, theme, which cards the user
expanded, and a cached copy of the public set-data files so they are not
re-downloaded on every battle. All of it stays in chrome.storage.local on the
user's own machine. Nothing is transmitted.
```

### Host access — `play.pokemonshowdown.com` and `replay.pokemonshowdown.com`

The extension declares no `host_permissions`, but content-script match patterns
still cause Chrome to show and request site access, and reviewers ask about it:

```
The extension's entire function is to display an overlay on a Pokémon Showdown
battle page, so it must run on the page where the battle happens. The content
scripts are declared statically in the manifest for exactly two hosts and cannot
be extended to any other site at runtime. No host_permissions are requested, no
tabs permission is requested, and the extension cannot see any other tab. It
reads the battle state the page already holds and writes only its own overlay
element into the page.
```

### Remote code

```
None. All code is contained in the package. The extension fetches two kinds of
remote resource, both of which are data and neither of which is executed: JSON
set-data files from data.pkmn.cc (parsed with JSON.parse) and PNG sprite images
from play.pokemonshowdown.com (used only as a CSS background). The damage
calculator is a vendored, unminified copy of @smogon/calc included in the
package.
```

---

## Data usage disclosures

Every checkbox: **not collected**. There is no analytics, no telemetry, no
account, and no server belonging to this extension.

Certifications to tick:

- [x] I do not sell or transfer user data to third parties, outside of approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## Screenshots

`docs/store/` — three at 1280×800, from a real ladder game, with both account
names replaced. `1-sets.png`, `2-damage.png`, `3-switch.png`.

Suggested captions, if you use them:

1. *Every opposing Pokémon, with what's still uncertain about it*
2. *Both directions of the matchup, and who moves first*
3. *Who to bring in, ranked by what survives*

---

## URLs

| Field | Value |
|---|---|
| Homepage | the public repo, once it exists |
| Privacy policy | wherever `docs/privacy.html` ends up hosted — **required**, the listing cannot be submitted without it |
| Support | the repo's issues page |

---

## Before you hit submit

- [ ] Retake `2-damage.png` — the current one predates v1.7.0 and shows a
      warning that no longer fires, and the old pairing-button wording
- [ ] Privacy policy actually reachable at the URL you entered
- [ ] The zip is the one from `npm run package`, not a hand-made one
- [ ] `LICENSE` and `THIRD-PARTY-LICENSES.txt` are inside the zip (they are,
      and `load.test.js` asserts it)
