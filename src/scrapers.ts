/**
 * The plugin surface for live TV: what scrapers exist, which of them are
 * switched on, and what happened the last time each ran.
 *
 * TWO WAYS IN, BOTH STILL FULL TRUST
 * -----------------------------------
 * A scraper is code that runs on this server with the same reach as the
 * rest of it -- it can be asked to fetch anything, from anywhere. That is
 * never accepted through a form from whoever can reach a settings page, so
 * there is no upload or paste-in-a-textarea route either way. What differs
 * is how the file gets here:
 *
 *   * BUILT IN -- a `.ts` module under `src/scrapers/`, imported below and
 *     added to `BUILTIN`. Part of the image; changing it needs a rebuild
 *     and a redeploy. This is where the one source this deployment cannot
 *     do without belongs.
 *   * DROPPED IN -- a plain `.mjs`/`.js` file (this container runs no
 *     TypeScript compiler) in `config.scrapersDir`, a directory on the
 *     already-mounted data volume. `loadDynamicScrapers()` below reads
 *     every file there, no image rebuild involved -- copy a new file in,
 *     or replace one, and reload (see `/tv/scrapers`'s "Reload sources").
 *     This is the route `docs/scraper-template.ts` and a session with no
 *     access to this repository actually produce for.
 *
 * Either way, once a scraper is loaded it is toggled and reported on
 * identically -- `allScrapers()` does not say which route a given one came
 * in by, and nothing downstream needs to know.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { pluginConfig as config } from "./plugin-config.js";

export type { Scraper, ScrapedChannel, ScrapedStream } from "./scraper-types.js";
import type { Scraper } from "./scraper-types.js";

/**
 * Every scraper built into the image -- currently none. iptv-org and
 * ntv.st, which used to live here, are now ordinary GitHub-imported
 * scrapers (see `github-import.ts`) pulled from
 * github.com/gauravsuman007/stremio-tv-scrapers, same as any third-party
 * source: nothing here treats them specially, and a fresh deployment with
 * an empty `config.scrapersDir` has no live-TV channels until something is
 * imported or dropped in. `BUILTIN` stays as a mechanism -- add an entry
 * here, the normal way, for a future source this deployment should never
 * run without even with a wiped data volume.
 */
const BUILTIN: Scraper[] = [];

/** Every scraper found in `config.scrapersDir` on the last (re)load. */
let dynamic: Scraper[] = [];

let override: Scraper[] | null = null;

export function allScrapers(): Scraper[] {
    return override || [...BUILTIN, ...dynamic];
}

/** Ids no dropped-in or GitHub-imported scraper may claim, because they
 *  are already spoken for by an image-built one. */
export function builtinScraperIds(): string[] {
    return BUILTIN.map((s) => s.id);
}

export function looksLikeScraper(value: unknown): value is Scraper {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Scraper).id === "string" &&
        (value as Scraper).id.length > 0 &&
        typeof (value as Scraper).name === "string" &&
        typeof (value as Scraper).build === "function"
    );
}

/**
 * (Re)reads `config.scrapersDir` and replaces the dropped-in scraper list.
 *
 * Called once at boot, and again whenever someone asks `/tv/scrapers` to
 * reload -- there is no file-watcher, because a half-copied file mid-write
 * would otherwise be picked up as a broken scraper. Every file is loaded
 * independently: one that fails to import, doesn't export a `Scraper`, or
 * claims an id already in use is skipped with a logged reason rather than
 * aborting the others.
 */
let reloadCounter = 0;

export async function loadDynamicScrapers(): Promise<void> {
    const found: Scraper[] = [];
    const cacheBust = ++reloadCounter;

    if (config.scrapersDir) {
        let files: string[] = [];

        try {
            files = readdirSync(config.scrapersDir).filter((name) => /\.m?js$/.test(name));
        } catch {
            // No directory mounted, or nothing in it yet -- not an error,
            // the deployment may simply have no dropped-in scrapers.
        }

        for (const file of files) {
            const path = `${config.scrapersDir}/${file}`;

            try {
                // Cache-busted: a plain `import()` of the same path would
                // hand back the FIRST load forever, defeating reload.
                const loaded = await import(`${pathToFileURL(path).href}?reload=${cacheBust}`);
                const candidate = looksLikeScraper(loaded.default)
                    ? loaded.default
                    : Object.values(loaded).find(looksLikeScraper);

                if (!looksLikeScraper(candidate)) {
                    console.error(`stremio-tv: ${file} does not export a scraper (needs id, name, build()), skipped`);
                    continue;
                }

                if (BUILTIN.some((s) => s.id === candidate.id) || found.some((s) => s.id === candidate.id)) {
                    console.error(`stremio-tv: ${file}'s scraper id "${candidate.id}" is already in use, skipped`);
                    continue;
                }

                found.push(candidate);
            } catch (cause) {
                console.error(`stremio-tv: could not load scraper from ${file}`, cause);
            }
        }
    }

    dynamic = found;
}

/** Swap the registry for a fake one, so the merge logic in channels.ts can
 *  be exercised without a network call. For the tests. */
export function useScrapersForTest(list: Scraper[] | null): void {
    override = list;
}

/*
    ON OR OFF, KEPT ACROSS A RESTART.

    On by default -- a scraper that was just wired in and never visited in
    settings should still contribute channels, the same way a new rail
    shows up rather than starting hidden. See `railPrefs` in session.ts for
    the sibling of this idea on rail ordering.
*/
const enabled = new Map<string, boolean>();
let loaded = false;

function ensureLoaded(): void {
    if (loaded) return;

    loaded = true;

    if (!config.scraperStore) return;

    try {
        const parsed = JSON.parse(readFileSync(config.scraperStore, "utf8")) as {
            off?: string[];
        };

        for (const id of parsed.off || []) {
            if (typeof id === "string") enabled.set(id, false);
        }
    } catch {
        // No store yet, or it is unreadable -- every scraper stays on,
        // which is the same posture as a first boot.
    }
}

function persist(): void {
    if (!config.scraperStore) return;

    try {
        mkdirSync(dirname(config.scraperStore), { recursive: true });

        const off = [...enabled.entries()].filter(([, on]) => !on).map(([id]) => id);
        const temporary = `${config.scraperStore}.tmp`;

        writeFileSync(temporary, JSON.stringify({ off }), { mode: 0o600 });
        renameSync(temporary, config.scraperStore);
    } catch (cause) {
        console.error("stremio-tv: could not write the scraper store", cause);
    }
}

export function scraperEnabled(id: string): boolean {
    ensureLoaded();

    return enabled.get(id) ?? true;
}

export function setScraperEnabled(id: string, on: boolean): void {
    ensureLoaded();
    enabled.set(id, on);
    persist();
}

/** What happened the last time a scraper ran, for the settings page. */
export interface ScraperRun {
    at: number;
    ok: boolean;
    channels: number;
    error: string;
}

const runs = new Map<string, ScraperRun>();

export function recordRun(id: string, run: ScraperRun): void {
    runs.set(id, run);
}

export function lastRun(id: string): ScraperRun | null {
    return runs.get(id) || null;
}
