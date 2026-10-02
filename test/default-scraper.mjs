/**
 * The default scraper is fetched from the scrapers repository, once, when
 * nothing is on disk and the operator has not deleted it. It is never
 * overwritten by the seeding. The importer is injected: no network here.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;

function check(what, value) {
    assert.ok(value, what);
    checks += 1;
}

const dir = mkdtempSync(join(tmpdir(), "stremio-tv-default-scraper-"));

const { initPluginConfig, pluginConfig } = await import("../dist/plugin-config.js");
initPluginConfig(dir);
mkdirSync(pluginConfig.scrapersDir, { recursive: true });

const { seedDefaultScraper, DEFAULT_SCRAPER_ID, DEFAULT_SOURCE } = await import("../dist/default-scraper.js");
const calls = [];
const ok = async (...args) => {
    calls.push(args);
    writeFileSync(join(pluginConfig.scrapersDir, `${DEFAULT_SCRAPER_ID}.mjs`), "// fetched");
    return { imported: [DEFAULT_SCRAPER_ID], updated: [], skipped: [], errors: [] };
};

check("the default comes from the scrapers repository", DEFAULT_SOURCE.repo === "stremio-tv-scrapers-live-tv");

const failed = await seedDefaultScraper(async () => { throw new Error("offline"); });
check("an unreachable repository is a failure to retry, not a crash", failed === "failed");

check("an empty import counts as a failure", (await seedDefaultScraper(async () => ({ imported: [], updated: [], skipped: [], errors: [{ file: "x", error: "boom" }] }))) === "failed");

check("a fresh volume fetches it", (await seedDefaultScraper(ok)) === "seeded");
check("and asks for that one file only, with no token", calls[0][3][0] === "iptv-org.mjs" && calls[0][2] === "");
check("a second start leaves the file alone", (await seedDefaultScraper(ok)) === "present" && calls.length === 1);

const dir2 = mkdtempSync(join(tmpdir(), "stremio-tv-default-scraper-"));
initPluginConfig(dir2);
mkdirSync(pluginConfig.scrapersDir, { recursive: true });
writeFileSync(join(pluginConfig.scrapersDir, `${DEFAULT_SCRAPER_ID}.deleted`), "");
check("a deliberate delete stays deleted", (await seedDefaultScraper(ok)) === "deleted" && calls.length === 1);

console.log(`PASSED: ${checks} default-scraper checks`);
