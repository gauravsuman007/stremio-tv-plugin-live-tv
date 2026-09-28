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
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginConfig as config } from "./plugin-config.js";
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
const BUILTIN = [];
/** Every scraper found in `config.scrapersDir` on the last (re)load. */
let dynamic = [];
/** Which file each dropped-in scraper came from, so Delete knows what to remove. */
const fileOf = new Map();
let override = null;
export function allScrapers() {
    return override || [...BUILTIN, ...dynamic];
}
/** Ids no dropped-in or GitHub-imported scraper may claim, because they
 *  are already spoken for by an image-built one. */
export function builtinScraperIds() {
    return BUILTIN.map((s) => s.id);
}
export function looksLikeScraper(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.id === "string" &&
        value.id.length > 0 &&
        typeof value.name === "string" &&
        typeof value.build === "function");
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
/*
    THIS MUST BE UNIQUE ACROSS THE WHOLE PROCESS, NOT JUST THIS MODULE
    INSTANCE. stremio-tv reloads this plugin from a freshly imported copy
    on every update (see `dispose()`'s own note on this) -- a fresh copy
    means `reloadCounter` below starts back at 0 every time, but Node's own
    ES module cache is keyed by the resolved URL and lives for the whole
    process, not per plugin instance. A later boot's FIRST reload can reuse
    the exact `?reload=1` a PREVIOUS boot's first reload already used --
    same URL, so `import()` hands back that old, cached module instead of
    re-reading the file, even though the file on disk has since changed.
    Seeding the counter from this module's own load time (necessarily
    different across two separate plugin instances, since loading this
    file fresh is what a plugin reload IS) makes every reload's cache key
    unique for real, not just within one instance's own lifetime -- this
    was previously mis-diagnosed as some other kind of staleness, only
    "fixed" by restarting the whole container to clear Node's module cache
    outright.
*/
const bootEpoch = Date.now();
let reloadCounter = 0;
export async function loadDynamicScrapers() {
    const found = [];
    const foundFiles = new Map();
    const cacheBust = `${bootEpoch}-${++reloadCounter}`;
    if (config.scrapersDir) {
        let files = [];
        try {
            files = readdirSync(config.scrapersDir).filter((name) => /\.m?js$/.test(name));
        }
        catch {
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
                foundFiles.set(candidate.id, file);
            }
            catch (cause) {
                console.error(`stremio-tv: could not load scraper from ${file}`, cause);
            }
        }
    }
    dynamic = found;
    fileOf.clear();
    for (const [id, file] of foundFiles)
        fileOf.set(id, file);
}
/** Swap the registry for a fake one, so the merge logic in channels.ts can
 *  be exercised without a network call. For the tests. */
export function useScrapersForTest(list) {
    override = list;
}
/*
    ON OR OFF, KEPT ACROSS A RESTART.

    On by default -- a scraper that was just wired in and never visited in
    settings should still contribute channels, the same way a new rail
    shows up rather than starting hidden. See `railPrefs` in session.ts for
    the sibling of this idea on rail ordering.
*/
const enabled = new Map();
let loaded = false;
function ensureLoaded() {
    if (loaded)
        return;
    loaded = true;
    if (!config.scraperStore)
        return;
    try {
        const parsed = JSON.parse(readFileSync(config.scraperStore, "utf8"));
        for (const id of parsed.off || []) {
            if (typeof id === "string")
                enabled.set(id, false);
        }
    }
    catch {
        // No store yet, or it is unreadable -- every scraper stays on,
        // which is the same posture as a first boot.
    }
}
function persist() {
    if (!config.scraperStore)
        return;
    try {
        mkdirSync(dirname(config.scraperStore), { recursive: true });
        const off = [...enabled.entries()].filter(([, on]) => !on).map(([id]) => id);
        const temporary = `${config.scraperStore}.tmp`;
        writeFileSync(temporary, JSON.stringify({ off }), { mode: 0o600 });
        renameSync(temporary, config.scraperStore);
    }
    catch (cause) {
        console.error("stremio-tv: could not write the scraper store", cause);
    }
}
export function scraperEnabled(id) {
    ensureLoaded();
    return enabled.get(id) ?? true;
}
export function setScraperEnabled(id, on) {
    ensureLoaded();
    enabled.set(id, on);
    persist();
}
/**
 * Remove a dropped-in or GitHub-imported scraper: its file, its stored
 * settings (`<id>.config.json`) and its on/off state. An image-built one
 * cannot be removed and answers false. The caller forgets the channel index
 * afterwards -- this module does not know about it.
 */
export function deleteScraper(id) {
    const file = fileOf.get(id);
    if (!file || !config.scrapersDir)
        return false;
    rmSync(`${config.scrapersDir}/${file}`, { force: true });
    rmSync(`${config.scrapersDir}/${id}.config.json`, { force: true });
    // Tells the boot-time seeding of a bundled default that this was removed
    // on purpose, or the next restart would put it straight back.
    writeFileSync(`${config.scrapersDir}/${id}.deleted`, "");
    fileOf.delete(id);
    dynamic = dynamic.filter((scraper) => scraper.id !== id);
    ensureLoaded();
    enabled.delete(id);
    persist();
    runs.delete(id);
    return true;
}
const runs = new Map();
export function recordRun(id, run) {
    runs.set(id, run);
}
export function lastRun(id) {
    return runs.get(id) || null;
}
/**
 * Whether a manual "Run now" (Settings > Live TV > Sources) is currently in
 * flight for a scraper, and the cooperative stop flag its "Stop" button
 * sets. In-memory only, same as `runs` above -- a reloaded plugin gets a
 * fresh, empty map, which is fine: an orphaned run belongs to the old
 * module instance and this one has nothing to show for it either way.
 */
const running = new Map();
export function scraperRunning(id) {
    return running.has(id);
}
/** Claims the run slot for `id`, or refuses if one is already in flight. */
export function beginScraperRun(id) {
    if (running.has(id))
        return false;
    running.set(id, { stopRequested: false });
    return true;
}
export function endScraperRun(id) {
    running.delete(id);
}
export function requestScraperStop(id) {
    const state = running.get(id);
    if (!state)
        return false;
    state.stopRequested = true;
    return true;
}
export function scraperStopRequested(id) {
    return running.get(id)?.stopRequested ?? false;
}
