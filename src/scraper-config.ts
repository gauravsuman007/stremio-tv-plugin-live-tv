/**
 * Stored values for each scraper's own `configSchema` -- an interval, a
 * pacing delay, whatever a scraper chose to expose in Settings > Live TV >
 * Sources next to its name.
 *
 * KEPT BESIDE THE SCRAPER ITSELF, NOT IN A SEPARATE DATABASE
 * -------------------------------------------------------------
 * Each scraper's config lives at `<id>.config.json` in `config.scrapersDir`
 * -- the SAME directory, and the same mounted volume, as `<id>.mjs` itself.
 * Deliberately not a single shared JSON file the way `scraperStore` and
 * `githubSourcesStore` are: a scraper and its settings are one unit, so
 * removing the `.mjs` (or copying it to another deployment) can carry its
 * settings along, or leave them behind, by the same ordinary file
 * operation -- nothing else needs to know that pairing exists.
 *
 * MIGRATION, ON EVERY READ
 * -------------------------
 * A scraper update can add a field, remove one, or change a field's type --
 * the same id's `.config.json` from before that update may now hold values
 * that no longer make sense. `getScraperConfig` reconciles the stored
 * object against the scraper's CURRENT `configSchema` every time it is
 * read: a stored key that still names a field of the same type is kept, a
 * field the schema no longer declares is dropped, and a field newly
 * declared (or whose stored value no longer matches its type) gets that
 * field's `default`. Nothing here ever hands back a value for a field that
 * does not currently exist, or leaves a field with no value at all.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { pluginConfig as config } from "./plugin-config.js";

import type { Scraper, ScraperConfigValue } from "./scraper-types.js";

function pathFor(scraperId: string): string | null {
    return config.scrapersDir ? `${config.scrapersDir}/${scraperId}.config.json` : null;
}

function readStored(scraperId: string): Record<string, ScraperConfigValue> {
    const path = pathFor(scraperId);

    if (!path) return {};

    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, ScraperConfigValue>;

        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        // No file yet, or unreadable -- this scraper starts at its own
        // defaults, same posture as a first boot.
        return {};
    }
}

/** This scraper's config values right now, one per field in its OWN
 *  `configSchema`, migrated against whatever is on disk beside it -- see
 *  the module doc comment. A scraper with no `configSchema` always gets
 *  `{}`. */
export function getScraperConfig(scraper: Scraper): Record<string, ScraperConfigValue> {
    const stored = readStored(scraper.id);
    const result: Record<string, ScraperConfigValue> = {};

    for (const field of scraper.configSchema || []) {
        const existing = stored[field.key];

        result[field.key] = existing !== undefined && typeof existing === field.type ? existing : field.default;
    }

    return result;
}

/** Saves `values` to `<id>.config.json` beside `<id>.mjs`, reconciled the
 *  same way `getScraperConfig` reads them -- anything not a field in this
 *  scraper's current `configSchema`, or of the wrong type, never reaches
 *  disk. A no-op when `config.scrapersDir` is not configured. */
export function setScraperConfig(scraper: Scraper, values: Record<string, ScraperConfigValue>): void {
    const path = pathFor(scraper.id);

    if (!path) return;

    const reconciled: Record<string, ScraperConfigValue> = {};

    for (const field of scraper.configSchema || []) {
        const incoming = values[field.key];

        reconciled[field.key] = incoming !== undefined && typeof incoming === field.type ? incoming : field.default;
    }

    try {
        mkdirSync(config.scrapersDir, { recursive: true });

        const temporary = `${path}.tmp`;

        writeFileSync(temporary, JSON.stringify(reconciled), { mode: 0o600 });
        renameSync(temporary, path);
    } catch (cause) {
        console.error(`stremio-tv: could not write config for scraper "${scraper.id}"`, cause);
    }
}
