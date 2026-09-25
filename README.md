# stremio-tv-plugin-live-tv

Live TV -- channels, scrapers, VPN routing selection, HLS relay -- as a
[stremio-tv](https://github.com/gauravsuman007/stremio-tv) plugin, loaded
in-process from a dropped-in `dist/plugin.mjs`.

## Build before you commit

stremio-tv's own plugin importer (`src/plugin-import.ts`) does not run a
TypeScript compiler -- it pulls the already-COMPILED `dist/plugin.mjs` +
`dist/plugin.json` (and everything else under `dist/`) straight from this
repository's `main` branch on GitHub, the same convention the older
`stremio-tv-scrapers` repo uses for a dropped-in scraper. That means:

- **`dist/` is committed, not gitignored.** Whatever is on `main` under
  `dist/` is exactly what a running stremio-tv container will load.
- **You must run `npm run build` and commit the result** before pushing
  a source change. There is no build step on the receiving end.
- **CI enforces this as a gate**, not a courtesy: `.github/workflows/ci.yml`
  runs `npm run check && npm run build && npm test`, then diffs the
  freshly-built `dist/` against what you committed
  (`git diff --exit-code -- dist/`). If they differ -- because a source
  change was pushed without rebuilding -- the workflow fails. CI never
  auto-commits `dist/` back for you (that would create a push loop); if
  the check fails, run `npm run build` locally, commit the updated
  `dist/`, and push again.

## Scripts

- `npm run build` -- compiles `src/` to `dist/` (and copies `plugin.json`
  alongside `dist/plugin.mjs`).
- `npm run check` -- typecheck only, no emit.
- `npm test` -- the unit/integration suites under `test/`.
