# Working on stremio-tv-plugin-live-tv

## Every behavior change bumps the version -- in BOTH places, together

`plugin.json`'s `version` is what stremio-tv's importer compares to decide
whether "Check for updates" installs anything at all (a re-import only
ever replaces a numerically GREATER version, never an equal or lower one
-- see "dist/ is built by CI" below). `src/plugin.ts`'s returned
`StremioTvPlugin.version` is a second, independent copy of the same
number, read at runtime (Settings shows it, logs reference it) --
**the two must always read the same value**, or an operator sees one
number on the page and another in "Check for updates", with no way to
tell which is real. Bump both, in the same commit, for ANY change to this
repository's behavior -- not only a `dispose()`-relevant one:

- A user-visible behavior change (ranking, merging, a new page, a new
  badge) -- self-evidently.
- An internal-only change with no visible effect that a NEXT importer
  should still pick up (a bug fix in `channels.ts`, a contract-doc-only
  change) -- version exists to let "Check for updates" do anything at
  all; an unbumped version means it silently keeps running the OLD copy
  forever, indistinguishable from "nothing changed."

This was missed once already (a commit landed `plugin.json` at "1.2.0"
while `src/plugin.ts`'s own `version` field stayed at "1.1.2" -- fixed
alongside this note, both now read the same number). Check both files
are equal before every push, not just after a change you think of as
"a version-worthy one."

## dist/ is built by CI, never locally

stremio-tv's plugin importer (Settings > Plugins > Import from GitHub) reads the compiled `dist/` (`plugin.mjs` + `plugin.json`) from this repo's main branch. There is no build step on the consuming side, so `dist/` has to be committed -- but **only by CI**.

- **Do not run `npm run build` to produce a commit, and do not hand-edit or commit `dist/`.** Commit source only.
- `.github/workflows/ci.yml` typechecks, builds, and on a push to `main` commits any change in `dist/` back as `github-actions[bot]` with `[skip ci]` (`contents: write`). Pull requests only prove the build works.
- So after pushing, `git pull` before your next commit; the bot's commit will be ahead of you.
- `npm run build` locally is fine for trying something out; leave the resulting `dist/` changes uncommitted (`git checkout dist`).
- A change is not live for stremio-tv until that bot commit exists **and** someone presses "Check for updates" on stremio-tv's plugins page. Nothing pulls on its own. Bump the version in `plugin.json` -- the importer only installs a real increase.

## dispose() must stop everything the plugin started

stremio-tv reloads a plugin from a freshly imported copy on update, disable
and delete, so the old module instance is orphaned rather than replaced. Its
timers keep running unless `dispose()` (in `src/plugin.ts`) stops them. Any
new `setInterval`, recurring `setTimeout` or long-running loop needs a stop
function called from there -- today: the scraper scheduler, the nightly sweep
(and any pass in flight, via `halted`), and the pending check-store write,
which is flushed rather than dropped. Bump the version in `plugin.json` and
`src/plugin.ts` together.

## The contracts this repo sits between, and how they stay linked

This repo is the middle of a three-repo chain, and every contract in that
chain is a manually-synced copy (no npm workspace linking anything) --
each copy's own top comment names its source of truth, so "did this
change ripple out" is always one file open away rather than something to
remember:

- **Upstream, from stremio-tv core**: `src/plugin-types.ts`, `src/host.ts`
  and `src/types.ts` are this plugin's own copies of stremio-tv's
  `src/plugin-types.ts` (`StremioTvPlugin`/`PluginHost`/`PLUGIN_API_VERSION`)
  and its scattered `addons.ts`/`client.ts` data shapes. Each file's header
  says so. stremio-tv is the one repository this one cannot see at build
  time, so a contract change on that side (a new hook, a new field) has to
  be *noticed* by hand and copied down -- there is no CI check across
  repos for this direction.
- **Downstream, to stremio-tv-scrapers-live-tv**: `src/scraper-types.ts`
  is the canonical scraper contract (`Scraper`/`ScrapedChannel`/
  `ScrapedRail`/...). It is copied byte-identical to `docs/scraper-template.ts`
  in THIS repo (a self-contained file, handable to a session with no
  access to the rest of this codebase) -- `cp src/scraper-types.ts
  docs/scraper-template.ts` whenever it changes, same commit. The scrapers
  repository's own `template/scraper-template.mts` is in turn a richer,
  example-code-augmented copy of that same `docs/scraper-template.ts`,
  kept in sync by hand on ITS side (see its `AGENTS.md`) -- so a change to
  `src/scraper-types.ts` here is not finished until both downstream copies
  reflect it.

Nothing enforces any of these three links except a person or an agent
actually checking, each time.

## Deleting a scraper, and why the default one stays deleted

`deleteScraper` (`scrapers.ts`) removes the file, `<id>.config.json` and the on/off state, then the route forgets the channel index. It also writes `<id>.deleted`: the bundled iptv-org default is re-seeded whenever its file is missing, so without the marker a Delete undid itself at the next restart. The marker only stops *seeding*; importing the same id from GitHub still installs it. The old "only source configured" lock is gone -- switching off or deleting the last source is the operator's call, and a page with no channels says why. The settings link on the plugin list points at `/tv/scrapers`, not `/tv` (that is the guide, which is where it used to land).

## The live relay hook, and why a scraper's headers finally reach playback

Since core plugin API 1.2.0, stremio-tv's `/live` relay asks this plugin's
`liveFetch` (`src/relay.ts`) before fetching any live URL itself. The
plugin answers only for mirrors that need it -- a `referrer`/`userAgent`, or
a `decoder` naming one of the scraper's own `decoders` -- and returns `null`
for everything else, so an ordinary channel is relayed by core exactly as
before. Playlists answered here are read on the way through and every URI
they name is remembered under the same rule, which is how segments on an
unrelated CDN host get the right headers and decoder. Before 1.2.0 core
sent neither header, so a Referer-locked mirror passed the nightly check
and failed on the television.

A decoder mirror is dropped at merge time (`fromScraper`) unless the
scraper really exports that decoder AND `host.pluginApiVersion` is at
least 1.2.0 (`relay-support.ts`): offered anywhere else, it would hand a
player a picture instead of video. `test/relay.mjs` covers all of this.

## The programme guide (`epg.ts`)

Schedules come from epg.pw's per-channel JSON API, fetched when a channel
is opened or played and cached until its timeline ends or it is 12 hours
old; the last 50 channels opened or played are refreshed every 12 hours
(`GuideStore.startWarming`, stopped in `dispose()`). The channel directory
is the head of epg.pw's XMLTV file, re-read weekly. Matching is exact
normalized name within the same country -- loosening it is how look-alike
channels ("Star Sports 1" / "Star Sports 1 Hindi") start sharing a guide;
`<configDir>/epg-overrides.json` pins or blocks a channel instead. Every
time is an epoch instant; only relative text ("35 min left") is written
here, never a clock time. Today the guide reaches the title page as a line
in `metaFor`'s description. `programmesFor` (in `plugin-types.ts`) is a
PROPOSED core API 1.3.0 hook for the player title and a proper title-page
panel; core does not call it yet.
