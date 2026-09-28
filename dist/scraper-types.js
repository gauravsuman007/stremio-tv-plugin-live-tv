/**
 * The shape a live-TV scraper hands back. Nothing here is repo-specific on
 * purpose: this file is also handed out, BYTE-IDENTICAL, as
 * `docs/scraper-template.ts` in this same repository, to a session that
 * cannot see the rest of this codebase -- so it must stand on its own and
 * stay small enough to read once. Whenever this file changes, copy it over
 * `docs/scraper-template.ts` in the same commit (`cp src/scraper-types.ts
 * docs/scraper-template.ts`) -- nothing enforces the two staying identical.
 *
 * This is also, in turn, the canonical upstream copy that
 * `stremio-tv-scrapers-live-tv`'s own `template/scraper-template.mts`
 * (a richer, example-augmented version of the same contract) is manually
 * kept in sync against -- see that repository's `AGENTS.md`.
 */
export {};
