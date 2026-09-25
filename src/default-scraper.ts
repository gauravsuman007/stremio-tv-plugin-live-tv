/**
 * The default scraper this plugin ships with -- iptv-org, bundled straight
 * into `dist/` (`scrapers/iptv-org.mts` -> `dist/scrapers/iptv-org.mjs`,
 * see `tsconfig.scrapers.json`) rather than pulled from any external
 * repository. There is no network fetch involved: the compiled file
 * already sits on disk, right beside `dist/plugin.mjs`, the moment this
 * plugin's `dist/` is deployed, so seeding it is a plain file copy.
 *
 * SEED ONCE, UPDATE LIKE ANY OTHER DROPPED-IN SCRAPER
 * -----------------------------------------------------
 * On load, `seedOrUpdateDefaultScraper()`:
 *
 *   - If `<configDir>/scrapers/iptv-org.mjs` does not exist yet, copies the
 *     bundled file in. This only ever happens once per deployment -- from
 *     then on the file exists, so this branch never runs again.
 *   - If it already exists (whether from a previous seed or because
 *     someone dropped in their own customised `iptv-org.mjs`), it is left
 *     alone UNLESS the bundled copy's `version` is a real increase over
 *     the one already on disk -- the exact same `versionSupersedes`
 *     comparison `github-import.ts` uses for a GitHub-imported source, so
 *     "the plugin ships a newer default" behaves identically to "an
 *     operator re-checked a GitHub source for updates". A customised file
 *     an operator wrote by hand, with no `version` bump, is therefore
 *     never silently clobbered; and one they never touched keeps tracking
 *     the plugin's own updates automatically.
 *
 * A missing `dist/scrapers/iptv-org.mjs` (a dev checkout that only ran
 * `tsc -p tsconfig.json`, or a test harness) is a harmless no-op, not an
 * error -- this plugin still works with zero scrapers, same as any other
 * boot with an empty `scrapersDir`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pluginConfig } from "./plugin-config.js";
import { looksLikeScraper, type Scraper } from "./scrapers.js";
import { versionSupersedes } from "./github-import.js";

/** Never renamed -- see `scrapers/iptv-org.mts`'s own note on why its id
 *  must never change. */
export const DEFAULT_SCRAPER_ID = "iptv-org";

/** `dist/scrapers/<id>.mjs`, sibling of this compiled module (itself
 *  `dist/default-scraper.js`) -- resolved from `import.meta.url` so it
 *  works the same whether this runs from a dev checkout or a deployment
 *  that copied `dist/` somewhere else entirely. */
function bundledScraperPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));

    return join(here, "scrapers", `${DEFAULT_SCRAPER_ID}.mjs`);
}

async function loadScraperFrom(path: string, cacheBust: string): Promise<Scraper | null> {
    const loaded = await import(`${pathToFileURL(path).href}?${cacheBust}`);
    const candidate: unknown = looksLikeScraper(loaded.default) ? loaded.default : Object.values(loaded).find(looksLikeScraper);

    return looksLikeScraper(candidate) ? candidate : null;
}

export async function seedOrUpdateDefaultScraper(): Promise<void> {
    const bundledPath = bundledScraperPath();

    if (!existsSync(bundledPath)) return; // not built with the scrapers tsconfig -- nothing to seed from.
    if (!pluginConfig.scrapersDir) return;

    mkdirSync(pluginConfig.scrapersDir, { recursive: true });

    const targetPath = join(pluginConfig.scrapersDir, `${DEFAULT_SCRAPER_ID}.mjs`);
    // Cache-busted with more than a millisecond clock, same reason
    // `scrapers.ts#loadDynamicScrapers` uses a counter instead -- two
    // calls in the same event-loop tick (as a test suite does) can share a
    // `Date.now()` value, which would silently hand back a stale cached
    // module instead of re-reading the file from disk.
    const bundled = await loadScraperFrom(bundledPath, `bundled=${Date.now()}-${Math.random().toString(36).slice(2)}`);

    if (!bundled) {
        console.error("live-tv: the bundled default scraper does not export a valid Scraper, skipped");
        return;
    }

    if (!existsSync(targetPath)) {
        writeFileSync(targetPath, readFileSync(bundledPath));
        console.log(`live-tv: seeded the default scraper (${DEFAULT_SCRAPER_ID}) v${bundled.version || "?"}`);
        return;
    }

    let existing: Scraper | null = null;

    try {
        existing = await loadScraperFrom(targetPath, `existing=${Date.now()}-${Math.random().toString(36).slice(2)}`);
    } catch (cause) {
        console.error(`live-tv: could not read the existing ${DEFAULT_SCRAPER_ID} scraper to check for an update`, cause);
        return;
    }

    if (existing && versionSupersedes(bundled.version, existing.version)) {
        writeFileSync(targetPath, readFileSync(bundledPath));
        console.log(`live-tv: updated the default scraper (${DEFAULT_SCRAPER_ID}) to v${bundled.version}`);
    }
}
