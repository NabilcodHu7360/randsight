# Security

## Reporting something

Open an issue at https://github.com/NabilcodHu7360/randsight/issues. If it is
something you would rather not post in public, say so in the issue without the
details and I will find another way to hear it.

Randsight has no server, no account and no data to steal — the interesting
attack surface is the extension reading a page it should not, or a page
reaching into the extension. Those are the reports worth writing up.

## What `npm audit` reports, and why it is not what it looks like

`npm audit` currently reports around a dozen advisories, one of them critical.
Every one of them is in the dependency tree of `pokemon-showdown`, and none of
them is in the extension.

```
$ node -e "console.log(require('./package.json').dependencies)"
{}
```

There are no runtime dependencies. Not "few" — none. The extension is the
JavaScript in `src/`, plus one vendored file:

- **`src/vendor/calc.js`** is @smogon/calc 0.11.0, bundled ahead of time by
  `scripts/build-vendor.sh` and committed. It is checked in unminified so it can
  be read and diffed rather than trusted.

`pokemon-showdown` is a devDependency. It exists so `test/joint.test.js` and
`test/rivals.test.js` can call the real `Teams.generate()` to produce held-out
teams to score the model against — which is the whole reason those numbers mean
anything. It pulls in `sqlite3`, `nodemailer` and `node-gyp` because it is a
whole game server; Randsight uses one function from it, on a developer's
machine, in CI.

What ships is the zip that `npm run package` builds: 46 files, from an
allowlist, and `test/load.test.js` asserts that nothing else got in.

So:

- **Do not run `npm audit fix --force`.** It will move `pokemon-showdown` to a
  version whose generator output no longer matches the published set data, and
  the model's benchmark numbers will quietly stop meaning what they say.
- A genuine advisory against `playwright` or against the vendored calc *is*
  worth acting on. Those are the two that can reach something real — the first
  because it runs in CI, the second because it ships.

## What the extension can actually touch

- Permissions: `storage`, and nothing else. No `tabs`, no `activeTab`, no
  `scripting`.
- Host permissions: `data.pkmn.cc` and `raw.githubusercontent.com/pkmn/randbats`
  — the two places the published random-battle set data lives. That is the
  extension's only privileged fetch.
- Content scripts run on `play.pokemonshowdown.com` and
  `replay.pokemonshowdown.com`, and nowhere else.
- The panel also loads Pokemon icons from `play.pokemonshowdown.com`. Those are
  plain `background-image` URLs from the page's own origin, not a privileged
  fetch, and a blocked one costs you an icon and nothing else.
- The page bridge takes exactly one string from the page and uses it as CSS
  rather than as text — the sprite style from Showdown's own `Dex` function —
  and it is pattern-matched before it is used (`src/ui.js`). Everything else
  crossing that boundary is text.

`PRIVACY.md` covers what is and is not read, in more detail and in plainer
words.
