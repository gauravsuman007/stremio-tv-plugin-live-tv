# Working on stremio-tv-plugin-live-tv

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
