# Architecture

A tour of the code, in the order data actually flows. Read this before the source.

```
  Showdown page                    extension (isolated world)              network
  ─────────────                    ──────────────────────────              ───────
  window.app.battle
        │
        │  inject.js  (MAIN world)
        │  polls every 500ms, reads the battle
        ▼
   postMessage ──────────────────► content.js
                                      │  resolves the format ─────────────► background.js
                                      │                                       │
                                      │  ◄──── set data ──────────────────────┘  data.pkmn.cc
                                      │
                                      ├──► engine.js   what are their sets?
                                      ├──► damage.js   how hard does it hit?
                                      │       └─► vendor/calc.js  (@smogon/calc)
                                      ▼
                                    ui.js  ──► the overlay panel
                                      │
                                      └── card icon: Dex.getPokemonIcon if the client
                                          exposes it, else a per-species PNG ────────►
                                                              play.pokemonshowdown.com
```

Two arrows cross the network, not one: the set data via `background.js`, and the sprite
fallback straight from the panel. See [PRIVACY.md](PRIVACY.md).

## The five pieces

| File | Runs in | Job |
|---|---|---|
| `inject.js` | page (MAIN world) | Read the live battle. The only file that touches Showdown |
| `background.js` | service worker | Fetch and cache set data. The only file that makes a cross-origin request (see "The data path") |
| `formats.js` | both | Room id → which data file |
| `engine.js` | isolated | The marginal model — reconstructs a set distribution from published frequencies |
| `joint.js` | isolated | The joint model — empirical set distribution + shrinkage toward `engine.js` |
| `damage.js` | isolated | Adapter over the vendored `@smogon/calc` |
| `advice.js` | isolated | Speed comparison and switch advisor — derived tactics, pure |
| `ui.js` | isolated | Build the panel's DOM |
| `content.js` | isolated | Wire the above together |

The split that matters: **`engine.js` and `damage.js` are pure.** They take plain
objects and return plain objects. That's why the tests can run them against the real
published data instead of against mocks, and it's why the tricky maths is verifiable.

## Why `inject.js` is separate

Chrome content scripts run in an *isolated world* — they share the DOM with the page
but not its JavaScript variables. `window.app` is therefore invisible to them. So
`inject.js` is declared with `"world": "MAIN"` in the manifest, runs inside the page,
and relays what it reads via `window.postMessage`.

### What it writes

It observes rather than participates — but it is not literally read-only, and the precise
statement is worth making because a reader who opens `inject.js` will find the assignments:

- It never patches a method belonging to **Showdown** — not a `Battle` method, not a client
  method, and it never assigns to `battle.subscription`.
- It never sends anything over the socket, and adds no DOM to the page (the panel is built
  by `ui.js` in the isolated world).
- It **does** permanently replace two **browser globals** in the page, both to see the battle
  stream: `window.WebSocket` becomes a `Proxy` whose `construct` trap builds the real socket
  and attaches a `message` listener, and `XMLHttpRequest.prototype.open` / `.send` are
  overwritten to flag requests whose URL matches `/showdown/` and read their `responseText`
  as it streams in. Both taps `apply` the original with the original arguments and return its
  result untouched; neither alters, blocks or injects a frame.

So: if the bridge broke entirely, Showdown would carry on as normal — but the two globals
stay replaced for the lifetime of the page, which is a fact about the page, not just about
the extension.

It has two readers:

1. **Client-object poll (primary).** Reads `battle.sides` directly. Preferred because
   the client has already done the hard parsing — `moveTrack` excludes Struggle, tags
   Transform copies, and attributes called moves to the caller; `prevItem` remembers a
   consumed item; `baseAbility` survives an ability swap.
2. **Protocol reader (fallback).** Taps the WebSocket and parses the Showdown protocol
   (`|switch|`, `|move|`, `|-terastallize|`…). Cruder, but it doesn't depend on client
   internals, so it survives a client rewrite. Also handles SockJS's xhr-streaming
   transport.

`content.js` prefers whichever produced state, client first.

## The data path

`background.js` holds the only host permissions and is the only component that `fetch`es
across origins. It fetches `data.pkmn.cc/randbats/stats/<format>.json`, falls back to the
GitHub mirror, caches in `chrome.storage.local` for 6 hours, and serves a stale copy rather
than failing if both are unreachable. Content scripts ask it over
`chrome.runtime.sendMessage`. It also warms `gen9randombattle` on install.

Two other things in the extension cause the browser to load a URL, and neither goes through
the service worker:

- `content.js` fetches `chrome.runtime.getURL('src/data/joint-<format>.json')` — a
  `chrome-extension://` URL for a file inside the package. It is a `fetch`, but it never
  leaves the machine.
- `ui.js` sets a card icon's `background-image`. Normally that is the style string the page's
  own `Dex.getPokemonIcon` returns, reusing Showdown's spritesheet. When `Dex` is
  unavailable — which is the case for the entire protocol-reader path, since that path never
  touches the client object — `content.js`'s `spriteUrl()` supplies
  `https://play.pokemonshowdown.com/sprites/gen5/<species>.png`, and the browser fetches it.
  That is a real cross-origin image request naming a Pokémon in the battle; it needs no host
  permission because it is a subresource load from a page the content script already runs on,
  and it goes to the server already running the battle. `PRIVACY.md` documents it explicitly.

## The two computations

**The set prediction runs two models.** `joint.js` is primary: it holds the empirical joint
distribution over (moves, item, ability, Tera, role) sampled from Showdown's own generator,
so it captures couplings the published marginals cannot express (Terapagos with Rest always
holds a Chesto Berry). `engine.js` is the prior it shrinks toward on thin slices, and the
fallback for species the table doesn't cover or whose published sets have changed since the
table was built.

**`engine.js` — what set do they have?** The published data gives *marginal* move
frequencies. Answering "given Glare, how likely is Knock Off?" needs a joint
distribution, so the engine reconstructs one: a conditional Bernoulli sample calibrated
by iterative proportional fitting, then exact conditional queries via elementary
symmetric polynomials. See the README for the maths.

**`damage.js` — how hard does it hit?** A thin adapter over `vendor/calc.js`, which is
a committed bundle of `@smogon/calc`. We do not reimplement the damage formula; that
library is the reference implementation. The adapter's only real job is constructing
the two Pokémon correctly.

That construction rests on one verified fact: Random Battle sets use **85 EVs, 31 IVs
and a neutral nature**, with per-stat overrides in the set data. Confirmed in
Showdown's own generator (`data/random-battles/gen9/teams.ts` — it sets
`evs = {hp: 85, …}` and returns no `nature` field, so the server defaults it to
Serious). `@smogon/calc` also defaults to Serious, so the two agree.

Because the server tells us our *own* exact stats, the adapter cross-checks its
reconstruction against them and surfaces a warning in the panel if they disagree —
if that assumption ever stops holding, you find out rather than silently reading
wrong numbers.

## Tactical derivations

`advice.js` answers the two questions the raw numbers don't:

- **`speed()`** — who moves first, folding in boosts, paralysis (halved from gen 7, quartered
  before), Tailwind, Trick Room's reversal, and Choice Scarf. Scarf is the interesting one:
  we only have a probability, so when you win the race *unless* they're scarfed, the panel
  says exactly that rather than picking a side.
- **`switches()`** — runs their active's predicted moves against every bench slot and ranks by
  the worst realistic hit. Boosts are dropped for benched slots, since they reset on switch.

Damage is marginalised over the item distribution rather than computed for the single most
likely item. The spread reported is the variation *between items*, not the ±15% damage roll —
conflating those two would put a "varies" marker on every row and mean nothing.

## Rendering

`content.js`'s `rerender()` is a short pipeline of named steps: pick a room, resolve
the format, get the set data, pick the sides, build a card per Pokémon, add the damage
matchup, hand it to the UI. Any step that can't continue returns a `notice()` view
explaining why, so the panel always says something useful.

The bridge polls twice a second, and most ticks are identical. `rerender()` serialises
the view model and skips the DOM work when nothing observable changed.

`ui.js` builds everything with `document.createElement` and `textContent`. There is no
`innerHTML` anywhere in the project — a username or chat message can never become
markup in the panel.

### Battle evidence

Three facts the battle states outright, which no set model can supply. `inject.js` captures
them in *both* readers (`teraUsed`/`teraUsedBy` per side; `lastMove`, `movesSinceSwitch` and
`moveUses` per Pokemon); `content.js` turns them into view-model state; `ui.js` renders them.

The boundary matters: the bridge reports only what it observed, and never infers. It does not
decide whether a Pokemon is Choice-locked — it says how many moves it has used since it
switched in, and `content.js` combines that with the item posterior. `movesSinceSwitch` is
counted by the bridge itself against a baseline taken the first poll a Pokemon is active,
rather than trusting the client's `lastMove` reset semantics, which cannot be verified from
inside the extension. A Pokemon first seen mid-stint therefore reads 0 and the lock stays
quiet until it moves again — the right way round when the answer drives a recommendation.

### Density is a function of uncertainty

`monCard()` decides how much room each distribution gets from how uncertain it is, not from
what kind of thing it is. One helper, `attr(label, arr, limit)`, handles item, ability, Tera
and role:

- top option revealed or ≥ 95% → push onto `facts`, rendered as one muted word on a single
  line at the bottom of the card, keeping its hover description;
- otherwise → a `.rs-line`: `ITEM  Assault Vest 80% · Leftovers 20%`, one row tall.

Only moves get bar rows, and only those revealed or ≥ 15%; the rest go into a `hidden`
`.rs-extra` behind a `.rs-more` toggle. A distribution with a single possible value is
dropped entirely (`rolesTotal` exists so the engine can distinguish "one role" from "one role
survived the evidence"). Anything that is already a header chip — a revealed Tera type — is
not repeated as a fact.

The tests assert the behaviour, not the layout: busiest card under 8 rows, no bar section for
an item or ability, a 29% move still visible up front, the toggle revealing more, and
collapsed facts still carrying tooltips.

## Testing

The suites mirror the boundaries above:

| Suite | Covers |
|---|---|
| `engine.test.js` | The model, against the **real** published data for all 7 data shapes |
| `ui.test.js` | Bridge → engine → overlay, in real Chromium, singles |
| `doubles.test.js` | Doubles, Champions doubles, four-side FFA, format resolution |
| `damage.test.js` | The vendored calc, the adapter, immunities, field effects, tabs |
| `load.test.js` | The packaged extension actually loads; permissions stay minimal |
| `calibration.test.js` | Grades the marginal model against real teams from Showdown's own generator |
| `joint.test.js` | Grades the joint model on held-out teams; tunes the shrinkage pseudo-count |
| `rivals.test.js` | Scores our model against the other extensions' algorithm on the same held-out sets |
| `protocol.test.js` | A whole 28-turn battle log replayed through the real bridge, turn by turn |
| `a11y.test.js` | Keyboard operation, accessible names, measured contrast, non-colour cues |

`rivals.test.js` reimplements the boolean role-filter both maintained extensions use, from
their published source, and scores all three models over a **shared candidate support** — an
earlier version scored each model on its own output, which excused the marginal model for
omitting the options it had ruled out and reversed the apparent result.

`calibration.test.js` is the one that checks the model is *right* rather than merely
self-consistent: it generates real sets with `Teams.generate()`, hides part of each, and
compares predicted probabilities to observed frequencies.

`protocol.test.js` is the only suite that does not use a mock page. It stubs `window.WebSocket`
before `inject.js` loads — so inject's own construct trap wraps it — then dispatches real
SockJS frames and reads state back through the bridge's own `postMessage` output, with
`window.app` left undefined so only the protocol reader is under test. It is what caught the
Sleep Talk fullname bug and the Illusion migration bug, both of which were live.

`test/harness.html` and `test/harness-doubles.html` are mock Showdown pages. They stub
`window.app`, `window.Dex` and the `chrome.*` APIs, then load the **real** `inject.js`
and the real content scripts into one page — so the tests exercise the actual message
plumbing, not a reimplementation of it.

## Adding things

- **A new format** → `formats.js`, plus a fixture and a case in `doubles.test.js`.
- **Something new read from the battle** → `inject.js` only; everything downstream
  takes plain objects.
- **A new prediction** → `engine.js`, with an assertion against real data.
- **A new panel section** → `ui.js`, fed from the view model `content.js` builds.

## Regenerating the joint tables

`src/data/joint-*.json` are sampled from Showdown's generator and committed. Rebuild after a
balance patch changes the sets:

```bash
npm run build-joint            # 60,000 teams per format, ~80s each
```

Species whose published move pool has changed since the last build fall back automatically,
so a stale table degrades rather than misleads.

**Battle-only formes.** The generator reports the *team* forme (`Zacian`) for sets that are
really the battle forme (`Zacian-Crowned`), while the published stats — and the battle itself —
keep them as separate species with different move pools. Left merged, the entry's move pool
matches neither, the freshness fingerprint rejects it, and those Pokemon silently lose the
joint model. `build-joint.js` splits the rows on the item that triggers the forme change
(`requiredItem`) and then **re-compacts both halves**, so each entry's index arrays hold only
the values its own rows use. Compacting only the split-off half leaves the base forme
fingerprinting over moves it can no longer roll — the same silent fallback, one level down.

## Regenerating the vendor bundle

`src/vendor/calc.js` is committed so the extension loads unpacked with no build step.
Rebuild it only when bumping the library:

```bash
./scripts/build-vendor.sh
```

The script pins nothing — it runs `npm install @smogon/calc esbuild` in a temp directory, so
re-running it later gets whatever is current. The committed bundle's banner records which
version it actually came from. Both `@smogon/calc` and the `pokemon-showdown` generator behind
`src/data/` are MIT; their notices are reproduced in
[THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt), which must ship with any copy of the
extension.
