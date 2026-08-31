# Privacy Policy — Randbats Live

_Last updated: 2026-08-30_

## The short version

**Randbats Live collects nothing.** No personal data, no browsing history, no
battle logs, no analytics, no telemetry. There is no account, no login, and no
server belonging to this extension — nothing is sent to the author of this
extension, ever, because there is nowhere for it to be sent.

Two kinds of request do leave your browser: the public Pokémon set-data files,
and the Pokémon sprite images the panel draws. Both are described below, and
neither goes anywhere you were not already talking to.

## What it stores, and where

Everything the extension remembers lives in `chrome.storage.local` **on your own
machine**. It is never uploaded, never shared, and is removed when you uninstall
the extension.

| Stored | Why |
|---|---|
| Panel position, size, theme, collapsed state, open tab | So the overlay stays where you put it |
| Which cards you expanded, keyed by side and Pokémon identifier (e.g. `p2\|p2a: Gholdengo`) | So a card you opened stays open. This list is never pruned, so it accumulates the names of Pokémon you have opened a card for |
| Whether the overlay is shown, which side it tracks, when you last forced a refresh | Your settings from the toolbar popup |
| A cached copy of the public randbats set data, under one key per format (`sets:gen9randombattle`, …) | So it doesn't refetch on every battle. The **set of keys** is therefore a durable record of which formats you have played |

That is the complete list. None of it leaves your machine, and none of it is
readable by any website — `chrome.storage.local` is private to the extension.

If you would rather not keep the format list, the toolbar popup's **Refresh now**
button deletes every `sets:` key outright, and uninstalling the extension deletes
all of it.

## What leaves your browser

### 1. The set data — public, static, identical for every user

- `https://data.pkmn.cc/randbats/stats/<format>.json`
- `https://raw.githubusercontent.com/pkmn/randbats/...` — used only if the first
  is unreachable

These are the community-maintained [pkmn/randbats](https://github.com/pkmn/randbats)
set files. The request carries no identifiers, no battle information and no query
parameters — it is the same file every user of that format downloads.

There is **one request per format you play**, not one in total: fourteen formats
are supported, the copy is cached for six hours, and a format whose CDN request
fails is retried once against the GitHub mirror. Over a long enough time you
could cause up to fourteen distinct files to be fetched, refreshed periodically.
One of them is fetched without you playing anything: on install the service
worker warms the cache for `gen9randombattle`, because almost everyone plays it.

### 2. Pokémon sprites — from Showdown's own sprite server

Each card in the panel shows a Pokémon icon. Where the page's own client exposes
`Dex.getPokemonIcon`, the panel simply applies the CSS that function hands back —
Showdown's own icon sheet, drawn by the client's own code — and asks for no
per-species file itself. Where it does not, which includes the whole
protocol-reader fallback path, the panel falls back to a per-species image:

- `https://play.pokemonshowdown.com/sprites/gen5/<species>.png`

Being honest about what that means: **this request names a Pokémon that is in
your battle**, and like any image request it discloses your IP address and
user-agent to the server that serves it. That server is
`play.pokemonshowdown.com` — the site you are already on and already connected
to, which already knows your IP, your account and your whole battle. So it tells
Showdown nothing it did not already have, and it tells nobody else anything at
all. It is still a network request that mentions your battle, so it is
documented here rather than glossed over.

On a replay page the sprite still comes from `play.pokemonshowdown.com` rather
than the `replay.` host you are on. Same operator, same battle they already have
a copy of.

### And nothing else

The predictions, the damage numbers and the switch advice are all computed
locally, in the page. **No battle log, no chat, no username, no move, no result
and no identifier is ever transmitted to anywhere.** The only fact about your
battle that crosses the network is a species name in a sprite URL, sent to the
server already running the battle.

## What it reads, and what it does not

On `play.pokemonshowdown.com` and `replay.pokemonshowdown.com` the extension
reads the state of the battle you are watching — the Pokémon on the field, their
revealed moves, items and abilities — in order to display it back to you. That
reading is passive and what it reads stays in the page. (It is not *purely*
passive; see "What it writes to the page" below.)

**It does read two pieces of account information, and here is exactly what and
why.** To know which side of the battle is yours, it reads your own Showdown
username from the `|updateuser|` line the server sends your client, and it reads
both players' display names so it can label the panel — the header reads
`RandomLadderer · 6/6 seen · turn 14`. Neither is stored in
`chrome.storage.local`, neither is transmitted anywhere, and both are already on
your screen. It reads no other account information: not your password, not your
email, not your ladder rating, not your friends list, not your settings.

It does not read any other site, and it stores nothing from chat. The
protocol-reader fallback taps the battle socket, so every frame the server sends
that client passes through it — chat and private messages included — but only
battle commands (`|switch|`, `|move|`, `|-item|`, …) are parsed; everything else
is discarded on the spot and nothing from it is kept, rendered or sent.

## What it writes to the page

The extension is not purely passive, and the honest description is narrower than
"read-only":

- It adds **its own panel** to the page, and a stylesheet whose every rule is
  scoped to that panel's own `rbl-` class names. It does not modify Showdown's
  own interface.
- To read the battle stream, `inject.js` replaces two **browser globals** in the
  page: `window.WebSocket` (with a pass-through `Proxy` that adds a `message`
  listener) and `XMLHttpRequest.prototype.open` / `.send` (which record the
  response text of Showdown's own streaming requests). Both taps pass every
  argument and every result through unchanged and observe only; they alter no
  data and send nothing. They are, however, permanent for the lifetime of the
  page.
- It does **not** patch any of Showdown's own methods, does not assign to
  `battle.subscription`, and never sends anything over the socket. It cannot
  make a move, send a message, or change the outcome of a battle.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Remember your panel layout and settings, and cache the set data |
| `https://data.pkmn.cc/*` | Download the public set data |
| `https://raw.githubusercontent.com/pkmn/randbats/*` | Fallback source for the same file |
| Site access on `play.pokemonshowdown.com` and `replay.pokemonshowdown.com`, from the content-script match patterns rather than a `host_permissions` entry | Read the battle and draw the panel over it. This is what the install prompt is describing — see below |

There is deliberately **no** `tabs` permission. The toolbar popup talks to open
tabs through `chrome.storage` instead, precisely so that permission isn't needed.

**About site access on pokemonshowdown.com.** The manifest declares no
`host_permissions` entry for pokemonshowdown.com; instead its content scripts
are declared statically, matching `https://play.pokemonshowdown.com/*` and
`https://replay.pokemonshowdown.com/*`. Chrome treats a content-script match
pattern as site access all the same, so the install prompt will say **"Read and
change your data on play.pokemonshowdown.com and replay.pokemonshowdown.com"**
and those hosts will appear under the extension's site-access settings. That
prompt is accurate: the extension does read those two sites, and it does add its
panel to them. What the declarative form buys is not less access to Showdown —
it is that the extension holds no *broad* or optional host permissions, cannot
be granted access to any other site, and cannot reach across to your other tabs.

## Single purpose

Randbats Live has one purpose: **to display information about Pokémon Showdown
Random Battles while you play them.** Every permission above serves that purpose
and nothing else.

## Remote code

The extension executes no remote code. All logic ships in the package and is
reviewable in the source. The network requests it makes fetch JSON data files,
which are parsed as data and never evaluated, and PNG images, which are only
ever set as a CSS background.

## Changes

If data handling ever changes, this policy will be updated and the change
described in the extension's release notes before the new version ships.

## Contact

Issues and questions: open an issue on the project's repository.
