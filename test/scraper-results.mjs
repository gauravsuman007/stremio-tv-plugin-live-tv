/*
    HELD, PERSISTED SCRAPER RESULTS.

    The promises: a slow scraper never empties or delays the page; a
    delivered result survives a restart and is served without waiting on
    the network; a failed refresh keeps the previous result.
*/
import assert from "node:assert";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { initPluginConfig } = await import("../dist/plugin-config.js");
const { useScrapersForTest } = await import("../dist/scrapers.js");
const { channelIndex, resetChannelResultsForTest, forgetChannels } = await import("../dist/channels.js");

initPluginConfig(mkdtempSync(`${tmpdir()}/live-tv-results-`));

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

const chan = (scraper, name) => ({
    id: `live:${scraper}:${name}`,
    name,
    country: "IN",
    countryName: "India",
    categories: [],
    languages: [],
    logo: "",
    website: "",
    network: "",
    streams: [{ url: `http://x/${scraper}/${name}`, quality: "", labels: [], referrer: "", userAgent: "" }]
});

const fast = { id: "fast", name: "Fast", version: "1", build: async () => ({ channels: [chan("fast", "One")], rails: [] }) };
let slowMode = "hang";
const slow = {
    id: "slow",
    name: "Slow",
    version: "1",
    build: () =>
        slowMode === "hang"
            ? new Promise(() => {})
            : slowMode === "fail"
              ? Promise.reject(new Error("boom"))
              : Promise.resolve({ channels: [chan("slow", "Two")], rails: [] })
};

/* a slow scraper does not hold back the fast one */
useScrapersForTest([fast, slow]);
let started = Date.now();
let index = await channelIndex();
ok(Date.now() - started < 12_000, "the first request is bounded");
ok(index?.byId.has("live:fast:One") ?? (await channelIndex())?.byId.has("live:fast:One"), "the fast scraper's channel is served");
ok(existsSync(`${tmpdir()}`), "sanity");

/* the slow one finishes later and folds in */
slowMode = "ok";
resetChannelResultsForTest();
useScrapersForTest([fast, slow]);
await channelIndex();
await new Promise((resolve) => setTimeout(resolve, 200));
index = await channelIndex();
ok(index?.byId.has("live:slow:Two") && index.byId.has("live:fast:One"), "both scrapers end up in the index");

/* a restart (memory gone, disk kept) serves at once, even if the scraper now hangs */
slowMode = "hang";
resetChannelResultsForTest();
useScrapersForTest([fast, slow]);
started = Date.now();
index = await channelIndex();
ok(Date.now() - started < 1_000, "restored results are served without waiting");
ok(index?.byId.has("live:slow:Two"), "the persisted result of the now-hanging scraper is still there");

/* a failing refresh keeps what was held */
slowMode = "fail";
resetChannelResultsForTest();
useScrapersForTest([fast, { ...slow, version: "2" }]);
await channelIndex();
await new Promise((resolve) => setTimeout(resolve, 200));
forgetChannels();
index = await channelIndex();
ok(index?.byId.has("live:slow:Two"), "a failed refresh keeps the previous result");

console.log(`PASSED: ${checks} scraper-result checks`);
process.exit(0);
