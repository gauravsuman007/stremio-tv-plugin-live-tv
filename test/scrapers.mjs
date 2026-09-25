/**
 * The plugin surface: on/off survives a restart, and the merge step in
 * channels.ts refuses a scraper that breaks the two rules that keep one
 * source from corrupting another -- its own id namespace, and never a
 * second channel under an id already taken.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "stremio-tv-scrapers-"));

const { initPluginConfig, pluginConfig } = await import("../dist/plugin-config.js");
initPluginConfig(dir);

const dropDir = pluginConfig.scrapersDir;
mkdirSync(dropDir, { recursive: true });

const scrapers = await import("../dist/scrapers.js");

/* ---- nothing is built in ------------------------------------------------ */

same("no scraper is built into the image", scrapers.allScrapers(), []);
same("built-in ids is empty", scrapers.builtinScraperIds(), []);

/* ---- on by default, and toggling persists ------------------------------ */

check("a scraper is on by default even if never registered", scrapers.scraperEnabled("some-scraper"));

scrapers.setScraperEnabled("some-scraper", false);
check("switching off takes effect immediately", !scrapers.scraperEnabled("some-scraper"));

const stored = JSON.parse(readFileSync(join(dir, "scrapers.json"), "utf8"));

same("switched-off scrapers are the only thing written to disk", stored.off, ["some-scraper"]);

scrapers.setScraperEnabled("some-scraper", true);
check("switching back on takes effect immediately", scrapers.scraperEnabled("some-scraper"));

/* ---- a run is recorded and read back ------------------------------------ */

check("an unrun scraper reports no run", scrapers.lastRun("nobody-built-this-yet") === null);

scrapers.recordRun("some-scraper", { at: 1234, ok: true, channels: 9001, error: "" });
same("a recorded run reads back", scrapers.lastRun("some-scraper"), {
    at: 1234,
    ok: true,
    channels: 9001,
    error: ""
});

/* ---- the merge step in channels.ts polices namespaces and duplicates --- */

const channelsModule = await import("../dist/channels.js");
const { forgetChannels, channelIndex, PREFIX, LIVE_PREFIX } = channelsModule;

function channel(id, name) {
    return {
        id,
        name,
        country: "US",
        countryName: "United States",
        countryFlag: "\u{1F1FA}\u{1F1F8}",
        categories: [],
        languages: ["eng"],
        logo: "",
        website: "",
        network: "",
        streams: [{ url: `https://example.invalid/${name}.m3u8`, quality: "", labels: [], referrer: "", userAgent: "" }]
    };
}

const good = {
    id: "well-behaved",
    name: "Well Behaved",
    async build() {
        return {
            channels: [
                channel(`${LIVE_PREFIX}well-behaved:one`, "one"),
                channel(`${LIVE_PREFIX}well-behaved:extra`, "extra"),
                // Wrong namespace -- must be dropped, not offered.
                channel("not-my-namespace:two", "two")
            ],
            rails: [
                {
                    // A real rail, over this scraper's own two channels.
                    id: "mine",
                    heading: "Mine",
                    channelIds: [`${LIVE_PREFIX}well-behaved:one`, `${LIVE_PREFIX}well-behaved:extra`]
                },
                {
                    // Reaches for a channel this scraper never returned --
                    // that one id is dropped, the rest of the rail stands.
                    id: "reaching",
                    heading: "Reaching",
                    channelIds: [`${LIVE_PREFIX}well-behaved:one`, `${LIVE_PREFIX}collider:stolen`]
                },
                {
                    // Names only a channel that belongs to another
                    // scraper -- the whole rail is empty and dropped.
                    id: "empty-after-filtering",
                    heading: "Should not appear",
                    channelIds: [`${LIVE_PREFIX}collider:stolen`]
                },
                {
                    // An unusable slug -- the rail itself is dropped.
                    id: "Not A Slug!",
                    heading: "Should not appear either",
                    channelIds: [`${LIVE_PREFIX}well-behaved:one`]
                }
            ]
        };
    }
};

const collider = {
    id: "collider",
    name: "Collider",
    async build() {
        return {
            channels: [
                {
                    // Same id as `good`'s first channel -- the second
                    // scraper to run must not overwrite the first.
                    ...channel(`${LIVE_PREFIX}well-behaved:one`, "impostor")
                },
                channel(`${LIVE_PREFIX}collider:stolen`, "stolen")
            ],
            rails: [
                {
                    // Names a channel `good` returned, not its own -- the
                    // whole rail is empty after filtering and dropped.
                    id: "reaching-back",
                    heading: "Should not appear",
                    channelIds: [`${LIVE_PREFIX}well-behaved:one`]
                }
            ]
        };
    }
};

scrapers.useScrapersForTest([good, collider]);

forgetChannels();

const built = await channelIndex();

check("the well-behaved channel is offered", built?.byId.has(`${LIVE_PREFIX}well-behaved:one`));
same("its name is the first scraper's, not the second's", built?.byId.get(`${LIVE_PREFIX}well-behaved:one`)?.name, "one");
check("the wrong-namespace channel never made it in", !built?.byId.has("not-my-namespace:two"));
same("nothing from iptv-org's own namespace collided", built?.byId.has(PREFIX + "two"), false);
same("exactly three channels survived the merge", built?.all.length, 3);

const { liveRails } = channelsModule;
const { rails } = await liveRails([], [], (code) => `/tv/country/${code}`);

// "empty-after-filtering", the unusable-slug rail, and collider's
// "reaching-back" all end up with nothing behind them and never appear --
// only "mine" and the legitimate half of "reaching" do.
same(
    "exactly the two rails with real channels behind them survived",
    rails.map((rail) => rail.heading).sort(),
    ["Mine", "Reaching"]
);

const mine = rails.find((rail) => rail.heading === "Mine");

same("its id is namespaced to the scraper and the slug", mine?.id, "rail:well-behaved-mine");
same("its \"by\" line names the scraper", mine?.by, "From Well Behaved");
same("only that scraper's two channels are on it", mine?.channels.map((c) => c.id).sort(), [
    `${LIVE_PREFIX}well-behaved:extra`,
    `${LIVE_PREFIX}well-behaved:one`
]);

const reaching = rails.find((rail) => rail.heading === "Reaching");

same(
    "a rail reaching for another scraper's channel keeps only what was really its own",
    reaching?.channels.map((c) => c.id),
    [`${LIVE_PREFIX}well-behaved:one`]
);

scrapers.useScrapersForTest(null);
forgetChannels();

/* ---- dropped-in scrapers, read from config.scrapersDir --------------- */

check("nothing dropped in yet", !scrapers.allScrapers().some((s) => s.id === "dropped-in"));

writeFileSync(
    join(dropDir, "good.mjs"),
    `export const scraper = {
        id: "dropped-in",
        name: "Dropped In",
        async build() {
            return { channels: [] };
        }
    };`
);
writeFileSync(join(dropDir, "not-a-scraper.mjs"), `export const nope = { hello: "world" };`);
writeFileSync(
    join(dropDir, "zz-collides.mjs"),
    `export const scraper = {
        id: "dropped-in",
        name: "Impostor",
        async build() {
            return { channels: [] };
        }
    };`
);

await scrapers.loadDynamicScrapers();

check(
    "a file exporting a well-shaped scraper is picked up",
    scrapers.allScrapers().some((s) => s.id === "dropped-in")
);
check(
    "a file exporting something that isn't a scraper is skipped, not thrown",
    !scrapers.allScrapers().some((s) => s.id === "nope")
);
same(
    "a second dropped-in file claiming an id already in use is refused",
    scrapers.allScrapers().filter((s) => s.id === "dropped-in").length,
    1
);

// zz-collides.mjs still claims "dropped-in" too, so breaking good.mjs alone
// would just hand the id to it on reload -- remove both to test a clean
// drop.
writeFileSync(join(dropDir, "good.mjs"), `export const scraper = null;`);
writeFileSync(join(dropDir, "zz-collides.mjs"), `export const scraper = null;`);

// A reload with the file removed drops it again -- this is a live re-read
// of the directory, not a one-time scan.
await scrapers.loadDynamicScrapers();
check(
    "reloading re-reads the directory, so a since-broken file is dropped",
    !scrapers.allScrapers().some((s) => s.id === "dropped-in")
);

console.log(`PASSED: ${checks} scraper-plugin checks`);
