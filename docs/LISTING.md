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
You are nine turns into a Random Battle, looking at a Gholdengo, and the game comes down to one question: does it have Focus Blast?

You can't know. But you can know the odds — and they are not the odds they were on turn one.

Randsight watches your battle and keeps a running estimate of what the opposing team is holding. Every move they use, every item that gives itself away, every Tera type spent narrows it. By the time the decision matters, you are usually not guessing.

WHY IT ISN'T A LOOKUP TABLE

Random Battles don't roll moves independently. The generator picks a role first, draws moves to fit that role, and then chooses an item based on the moves it landed on. So what you have already seen genuinely changes what is still possible. A Great Tusk that has shown Rapid Spin is a different Pokémon from one that has shown Bulk Up — different remaining moves, and different item odds too.

Tools that show the same static percentages every game can't tell those two apart. Randsight models the relationship, so the numbers answer your battle instead of describing the average one.

THREE TABS, THREE QUESTIONS

SETS — what can they still be carrying?

One card per opposing Pokémon: the odds on each move slot you haven't seen, the role, the item, the ability, the Tera type, and their speed at their actual level. Anything that has stopped being a question collapses to a single line, so what's on screen is only what's still undecided. Hover anything to find out what it does.

DAMAGE — do I survive, and do I kill?

The current matchup in both directions, opening with the answer in plain words: "You survive — worst is Headlong Rush at 64%, about 2 hits." Their moves are ranked by threat, not raw damage: how hard it hits, discounted by how likely they are to actually have it. A normal calculator can't rank a move it doesn't know about yet. And the numbers are computed across their whole item and ability distribution rather than one hopeful guess. Immunities are shown, not quietly skipped.

SWITCH — who can come in?

Your six, ranked by how much HP is left standing after the worst hit they can realistically land, with a mark for who outspeeds. It leads with the answer. If nothing on your bench survives, it says so instead of recommending a Pokémon that dies.

IT READS THE BATTLE, NOT JUST THE DATA

Three things no set file can tell you, taken straight from what happened:

Terastallization is once per side. After they use it, Randsight stops offering Tera types for the rest of their team.

A Choice item locks them into the move they just used — so the panel stops pretending the others are live this turn.

A move used to its last PP cannot happen again.

WHAT IT WON'T DO

It won't tell you it knows. Uncertainty stays visible: a 34% is drawn as a 34%, not rounded up into a recommendation. Where a number depends on something unrevealed, it says which assumption it made.

It doesn't play for you. There is no auto-anything — it reads the page, it never sends a move, and it never touches the socket.

Doubles damage doesn't yet model spread-move targeting or redirection, and the panel tells you so rather than quietly being wrong.

FORMATS

All fourteen Random Battle formats with published prediction data: gen 1 through gen 9 singles, gen 9 doubles, Champions doubles, Baby, BDSP, and Let's Go. Blitz and unrated lobbies work too. Multi and Free-For-All fall back to the closest format and are labelled as approximate rather than presented as exact.

PRIVACY

No user data is sent to the developer. There is no account, analytics, telemetry, advertising, or developer-operated server. Battle information is processed locally to provide the features shown in the panel.

Two kinds of request leave your browser: the public set-data files from pkmn/randbats, and Pokémon sprites from Showdown's own sprite server. The storage permission remembers panel settings, caches public set data, and keeps the local counter and preferences for an occasional, dismissible feedback request. The full policy is linked below and also ships inside the extension.

Open source under the MIT licence, and the damage calculator is Smogon's own, included unmodified so you can read it. Not affiliated with Smogon, Pokémon Showdown, or Nintendo/Game Freak.
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
Randsight has one purpose: to provide live decision-support information for
Pokémon Showdown Random Battles. On play.pokemonshowdown.com, it reads the
current battle state and displays an overlay containing predicted opposing
sets, damage estimates, Speed comparisons, and switch guidance. It does not
automate gameplay, send battle commands, or operate on unrelated websites.
```

---

## Permission justifications

### `storage`

```
Used to remember the overlay's position, size, theme, selected tab, expanded
cards, enabled state, and selected team side. It also caches public set-data
files and stores the completed-battle counter and preferences used by the
occasional feedback prompt, including whether the user selected “Don't ask
again.” A limited list of recently counted battle room identifiers prevents a
completed battle from being counted twice. All of it stays in
chrome.storage.local on the user's own machine and is never sent to the
developer.
```

### Host access

Two separate things a reviewer will ask about, and they must not be conflated —
the manifest declares `host_permissions` for the two data hosts, and separately
declares content-script matches for the two Showdown hosts.

```
The extension does two distinct things with hosts, and asks for the narrowest
access that allows each.

Content scripts are declared statically in the manifest for exactly two hosts,
play.pokemonshowdown.com and replay.pokemonshowdown.com, because the extension's
entire function is to draw an overlay on the page where the battle happens. They
cannot be extended to any other site at runtime. No tabs permission is requested
and the extension cannot see any other tab. On those two pages it reads the
battle state the page already holds and writes only its own overlay element.

host_permissions are declared for two hosts and nothing else: data.pkmn.cc and
raw.githubusercontent.com/pkmn/randbats. These are the two locations of the
public random-battle set-data files the prediction is built from. They are
fetched as JSON, parsed with JSON.parse, and never executed. No user data is
sent with those requests; they are plain GETs for static public files.
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

No selected data category is transmitted to or accessible by the developer.
The extension processes battle-page content and player display names locally,
and stores only the local settings and counters described in the privacy policy.
Complete the dashboard's data-category questions consistently with Google's
current guidance for locally processed data.

Certifications to tick:

- [x] I do not sell or transfer user data to third parties, outside of approved use cases
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## Screenshots

`docs/store/` — `1-sets.png`, `2-damage.png`, `3-switch.png`, three at 1280×800.
Generated by `npm run shots`, so they track the shipping build rather than
drifting away from it the way the old hand-taken ones did.

Each already carries its own headline in the image, so the store's caption field
can be left empty. The uncaptioned crops in `docs/site/` are for the landing
page, which writes its own captions — don't upload those here.

---

## URLs

| Field | Value |
|---|---|
| Homepage | `https://nabilcodhu7360.github.io/randsight/` |
| Privacy policy | `https://nabilcodhu7360.github.io/randsight/privacy.html` |
| Support | `https://github.com/NabilcodHu7360/randsight/issues` |

Both github.io URLs need GitHub Pages switched on (Settings → Pages → `main`,
folder `/docs`). The privacy field is required and the form will not submit
without a URL that actually resolves.

---

## Before you hit submit

- [ ] Privacy policy actually reachable at the URL you entered — open it
- [ ] The zip is the one from `npm run package` (~0.74 MB, 46 files), not a
      hand-made one and not `randsight-repo.zip`
- [ ] `LICENSE` and `THIRD-PARTY-LICENSES.txt` are inside the zip (they are,
      and `load.test.js` asserts it)
