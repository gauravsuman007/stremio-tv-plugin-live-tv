/**
 * The bundled default scraper: seeded once when nothing exists yet, never
 * clobbered when something customised is already there, and updated only
 * when the bundled copy's version is a real increase.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;

function check(what, value) {
    assert.ok(value, what);
    checks += 1;
}

function same(what, value, expected) {
    assert.deepEqual(value, expected, what);
    checks += 1;
}

const dir = mkdtempSync(join(tmpdir(), "stremio-tv-default-scraper-"));

const { initPluginConfig, pluginConfig } = await import("../dist/plugin-config.js");
initPluginConfig(dir);

const dropDir = pluginConfig.scrapersDir;
mkdirSync(dropDir, { recursive: true });

const { seedOrUpdateDefaultScraper, DEFAULT_SCRAPER_ID } = await import("../dist/default-scraper.js");
const targetPath = join(dropDir, `${DEFAULT_SCRAPER_ID}.mjs`);

/* ---- nothing on disk yet: seeded from the bundled dist/scrapers/ copy -- */

check("nothing seeded yet", !existsSync(targetPath));

await seedOrUpdateDefaultScraper();

check("the bundled default scraper is copied in on first load", existsSync(targetPath));

const seeded = readFileSync(targetPath, "utf8");

check("the seeded file looks like the real iptv-org scraper", seeded.includes('id: "iptv-org"'));

/* ---- already present, no version at all: versioned beats unversioned --- *
 * same convention as github-import.ts's versionSupersedes -- an
 * unversioned file on disk can never be known to be newer than a versioned
 * bundled copy, so it is treated as an update, not left alone. */

writeFileSync(targetPath, `export const scraper = {
    id: "iptv-org",
    name: "customised by an operator, no version",
    async build() { return { channels: [] }; }
};`);

await seedOrUpdateDefaultScraper();

same(
    "an unversioned existing file is superseded by the versioned bundled copy",
    readFileSync(targetPath, "utf8").includes("customised by an operator"),
    false
);

/* ---- already present, SAME version as the bundled copy: never clobbered */

writeFileSync(targetPath, `export const scraper = {
    id: "iptv-org",
    name: "customised by an operator, same version",
    version: "1.0.0",
    async build() { return { channels: [] }; }
};`);

await seedOrUpdateDefaultScraper();

same(
    "an existing file at the same version as the bundled copy is left alone, not overwritten every boot",
    readFileSync(targetPath, "utf8").includes("customised by an operator, same version"),
    true
);

/* ---- an existing file with a version the bundled copy does not beat ---- */

writeFileSync(targetPath, `export const scraper = {
    id: "iptv-org",
    name: "still customised",
    version: "999.0.0",
    async build() { return { channels: [] }; }
};`);

await seedOrUpdateDefaultScraper();

check(
    "a version the bundled copy cannot beat is kept as-is",
    readFileSync(targetPath, "utf8").includes("still customised")
);

/* ---- an existing file with an older version is updated to the bundled -- */

writeFileSync(targetPath, `export const scraper = {
    id: "iptv-org",
    name: "old copy",
    version: "0.0.1",
    async build() { return { channels: [] }; }
};`);

await seedOrUpdateDefaultScraper();

check(
    "an existing file with an older version is replaced by the bundled copy",
    readFileSync(targetPath, "utf8").includes('id: "iptv-org"') &&
        !readFileSync(targetPath, "utf8").includes("old copy")
);

console.log(`PASSED: ${checks} default-scraper checks`);
