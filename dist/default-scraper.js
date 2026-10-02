/**
 * The default scraper -- iptv-org -- is NOT part of this repository. It
 * lives in github.com/gauravsuman007/stremio-tv-scrapers-live-tv
 * (`scrapers/iptv-org.mts`, compiled by that repo's CI to `dist/iptv-org.mjs`)
 * like every other source, and a fresh data volume fetches it from there.
 *
 * `seedDefaultScraper()` does that once: when `<scrapersDir>/iptv-org.mjs`
 * does not exist and the operator has not deleted it (`iptv-org.deleted`),
 * it imports that one file through the ordinary GitHub importer and
 * remembers the repository as a source, so Sources > "Check for updates"
 * keeps it current like any imported scraper. Nothing is ever overwritten
 * here: an existing file, customised or not, is left alone.
 *
 * It needs the network once. The caller retries until it succeeds (see
 * `plugin.ts`); in between, the channel page says it has no channels.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pluginConfig } from "./plugin-config.js";
import { importFromGithub, rememberGithubSource } from "./github-import.js";
/** Never renamed: channel ids, checks and logos are all keyed under it. */
export const DEFAULT_SCRAPER_ID = "iptv-org";
export const DEFAULT_SOURCE = { owner: "gauravsuman007", repo: "stremio-tv-scrapers-live-tv" };
export async function seedDefaultScraper(importer = importFromGithub) {
    if (!pluginConfig.scrapersDir)
        return "failed";
    if (existsSync(join(pluginConfig.scrapersDir, `${DEFAULT_SCRAPER_ID}.mjs`)))
        return "present";
    if (existsSync(join(pluginConfig.scrapersDir, `${DEFAULT_SCRAPER_ID}.deleted`)))
        return "deleted";
    try {
        const result = await importer(DEFAULT_SOURCE.owner, DEFAULT_SOURCE.repo, "", [`${DEFAULT_SCRAPER_ID}.mjs`]);
        if (!result.imported.includes(DEFAULT_SCRAPER_ID)) {
            console.error(`live-tv: could not fetch the default scraper: ${JSON.stringify(result.errors.concat(result.skipped))}`);
            return "failed";
        }
        rememberGithubSource(DEFAULT_SOURCE.owner, DEFAULT_SOURCE.repo, "");
        console.log(`live-tv: fetched the default scraper (${DEFAULT_SCRAPER_ID}) from ${DEFAULT_SOURCE.owner}/${DEFAULT_SOURCE.repo}`);
        return "seeded";
    }
    catch (cause) {
        console.error("live-tv: could not fetch the default scraper", cause);
        return "failed";
    }
}
