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
(and any pass in flight, via `halted`), the logo store (`logos.ts`: its start-up and
nightly timers and any pass in flight), and the pending check-store write,
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

## The programme guide (`epg-bulk.ts`, `epg.ts`)

The WHOLE guide (epg.pw's XMLTV, ~50 MB gzipped) is streamed every 12
hours by `BulkGuide` and matched to every channel in the index; each
matched channel keeps 12 hours back to 36 ahead in
`<configDir>/epg-guide.json`. Matching is exact normalized name within the
SAME country only -- never across countries, and a channel with no
country is never matched; loosening this is how look-alike channels
("Star Sports 1" / "Star Sports 1 Hindi", "Colors" UK / India) start
sharing a guide. `<configDir>/epg-overrides.json` pins or blocks a channel
by hand. The run's status and per-country match counts are on the Sources
page.

Per-channel fetching (`GuideStore` in `epg.ts`: fetch on open/play, cache
until the timeline ends or 12 hours, last 50 kept warm) is still there for
channels the bulk run missed, but OFF by default -- a switch on the Sources
page, saved in `<configDir>/epg-settings.json`.

Every time is an epoch instant; this repo writes only relative text ("35
min left"), never a clock time. Core (plugin API 1.4.0) draws the rest:
`metaFor`'s `schedule` becomes the title page's timetable (row height
proportional to duration; the TV's time and the channel's zone from
`timezones.ts`), and `playerExtras` gives the player its region chips and
a Programs button that opens a sidebar headed by the channel's logo and
name, listing the next 12 hours. `metaFor` never waits on the network --
core calls it on Play too. `dispose()` stops both timers.

## Channel logos (`logos.ts`, `logo-image.ts`)

Every logo URL in the index is downloaded once and kept under
`<configDir>/logos/` (original as `<sha1(url)>.orig`, display copy beside it);
decisions are in `<configDir>/logos.json`. A pass runs ~30 s after load, nightly
(`LIVE_LOGO_HOUR`, default 4, -1 = off) and from the Sources page; it skips
anything settled. Decoding is ffmpeg's (the binary core ships) -- no image
library. `render.ts#chanCard` swaps the card's picture for this plugin's
`/tv/logo/:file` route by rewriting core's `/img/<b64>?w=480&h=1` link in the
returned HTML.

Why SVG: core's image route bakes a WHITE halo under every raster logo but
relays an SVG as it is, so the tile (option C) and name pill (option E) are SVG.
Changing the look means bumping `LOGO_DESIGN` in `logo-image.ts`: every logo is
remade from its saved original, no download. Only cards are swapped; the title
page and the player sidebar still use core's own logo URL.


## A stream can be a handle: resolving at the moment of use

`ScrapedStream.resolver` names an entry in the scraper's `resolvers`; the
stream's `url` is then a stable HANDLE that is never fetched, and
`src/resolve.ts` turns it into a real address whenever `verify`,
`deepVerify`, `probeCodec` or the relay (`liveFetch`) is about to fetch it
(answers reused five minutes, failures twenty seconds). Everything keyed by
URL -- evidence, ranking, the relay's rule table -- stays keyed by the
handle. A resolver that has nothing is a dead mirror (`verify` false, the
relay answers 502), never a fetch of the handle.

It exists for sources whose address is signed and expires, or whose
handshake changes: zlive.st's lasts 2.5 hours, and an out-of-date handshake
is answered with a looping decoy video instead of an error, which every
"is it a playlist" check calls a working channel.

**Needs stremio-tv plugin API 1.5.0** (`resolverAvailable()` in
`relay-support.ts`): the core must never give a handle to a device to fetch
directly (`direct:` in its `index.ts`). On an older core resolver mirrors are
dropped, not offered. This mirrors the standalone live-tv app's
`src/livetv/resolve.ts`; keep the two in step, and `docs/scraper-template.ts`
with `src/scraper-types.ts`.


## A stream can be encrypted: ClearKey DASH served as HLS

`ScrapedStream.clearKey` (plugin 1.17.0) marks a mirror whose `url` is a DASH
manifest encrypted with Common Encryption and carries the ClearKey that opens
it. A television cannot be handed a key through a URL, so the plugin's relay
does the decryption: `src/clearkey.ts` runs ONE ffmpeg per distinct stream
(`-cenc_decryption_key KEY -i MANIFEST -c copy -f hls`, never a re-encode),
shared by every viewer, and `liveFetch` answers the manifest URL with its
playlist and its segments (`https://clearkey.invalid/<session>/s<N>.ts`,
recognised by shape) from the session's directory. To core and the television
it is an ordinary HLS channel.

Offered only when it can play (`clearKeyUsable` in `channels.ts`): the relay
exists, **core is at plugin API 1.6.0** (it must never hand the MPD to a
device directly -- `direct:` in its `index.ts`, the same rule as a resolver
mirror), `ffmpeg` can read DASH and decrypt CENC (`FFMPEG_PATH` overrides),
the key is exactly 32 hex characters, and the stream names no `decoder`.
Otherwise it is dropped, not shown broken. `verify`/`deepVerify` check the
manifest only (`<MPD`); `probeCodec` skips it. Sessions die after 45 s idle,
at most 6 run at once, a source that will not start is a 502 and is not
relaunched for 30 s, and `dispose()` calls `stopClearKey()`.

This is a copy of the standalone live-tv app's `src/livetv/clearkey.ts` (and
`relay.ts`, `relay-support.ts`, `resolve.ts`, which are byte-identical to
theirs). `test/clearkey.mjs` runs against a stub ffmpeg; the real thing was
checked by hand against a live encrypted stream. See that repo's AGENTS.md,
"A stream can be encrypted", for the reasoning and the limits (one key pair
only; no Widevine/PlayReady/FairPlay).

**A contract change like this one is three repos, not one**: this repo's
`src/scraper-types.ts` (+ `docs/scraper-template.ts`), the live-tv app's
`src/livetv/scraper-types.ts` (+ `docs/scraper-template.ts`), and
stremio-tv-scrapers-live-tv's `template/scraper-template.mts` -- plus core's
`PLUGIN_API_VERSION` when the host side needs core to cooperate.


## A card can have two pictures (`ScrapedChannel.logos`), and merged events keep any picture

`logos` is an optional pair of image URLs for one card -- a fixture's two
flags -- drawn side by side by `logos.ts`/`logo-image.ts#pairSvg` when BOTH are
settled (route `/tv/logo/p<keyA><keyB>.svg`), else the card keeps its one
`logo`. When two sources' events merge, `channels.ts` now adopts the incoming
`logo` (and a pair) if the existing card has none. Byte-for-byte the same as the
standalone app's `src/livetv/` (`logo-image.ts`, `render.ts`; `logos.ts` differs
by its User-Agent line only); see that repo's AGENTS.md for the reasoning.
Tests: `test/logos.mjs`, `test/event-logos.mjs`.
