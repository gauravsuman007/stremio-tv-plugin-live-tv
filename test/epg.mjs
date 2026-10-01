/**
 * The programme guide (`epg.ts`): matching channels without mixing up
 * look-alike names, reading schedules as absolute instants whatever zone
 * they were written in, and the cache's "until the timeline ends, or 12
 * hours" rule. No network: the fetcher is a stub.
 */

import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GuideStore, buildIndex, epgKey, isFresh, matchChannel, nowAndNext, nowLine, parseDirectory, parseSchedule, STALE_AFTER } =
    await import("../dist/epg.js");

const HOUR = 3_600_000;

/* ---- names: spelling flattened, identity kept ---- */

assert.equal(epgKey("SkyDramaHD"), epgKey("Sky Drama HD"));
assert.equal(epgKey("BBC 1"), epgKey("BBC One"));
assert.equal(epgKey("BBC1 HD"), epgKey("BBC One"));
assert.equal(epgKey("Colors TV"), epgKey("Colors"));
assert.equal(epgKey("Télé Québec"), epgKey("Tele Quebec"));
assert.equal(epgKey("Sony SAB"), epgKey("Sony Sab HD"));

for (const [a, b] of [
    ["Star Sports 1", "Star Sports 1 Hindi"],
    ["Star Sports 1", "Star Sports 2"],
    ["Sky Cinema", "Sky Cinema Action"],
    ["Quest", "Quest +1"],
    ["QUEST+1", "Quest +24"],
    ["Channel 4", "Channel 5"],
    ["TV 2", "Channel 2"],
    ["Nick", "Nick Jr"],
    ["Zee TV", "Zee TV USA"],
    ["Discovery", "Discovery Kids"]
]) {
    assert.notEqual(epgKey(a), epgKey(b), `${a} must not match ${b}`);
}

/* ---- matching: same country, exact key, stable choice ---- */

const directory = [
    { id: "100", name: "Star Sports 1 Hindi", country: "IN" },
    { id: "101", name: "Star Sports 1", country: "IN" },
    { id: "102", name: "Star Sports 1 HD", country: "IN" },
    { id: "200", name: "Sky Cinema Action", country: "GB" },
    { id: "201", name: "Sky Cinema Premiere", country: "GB" },
    { id: "300", name: "QUEST+1", country: "GB" },
    { id: "301", name: "Quest", country: "GB" },
    { id: "400", name: "Colors", country: "GB" },
    { id: "401", name: "Colors", country: "IN" },
    { id: "500", name: "Unique Planet", country: "US" }
];
const index = buildIndex(directory);
const match = (name, country) => matchChannel(index, { id: "x", name, country })?.id ?? null;

assert.equal(match("Star Sports 1", "IN"), "101", "SD listing for an SD name");
assert.equal(match("Star Sports 1 HD", "IN"), "102", "HD listing for an HD name");
assert.equal(match("Star Sports 1 Hindi", "IN"), "100");
assert.equal(match("Sky Cinema", "UK"), null, "no guide beats the wrong guide");
assert.equal(match("Quest", "UK"), "301", "UK is GB, and Quest is not Quest +1");
assert.equal(match("Quest +1", "GB"), "300");
assert.equal(match("Colors TV", "IN"), "401", "the country decides between same-named channels");
assert.equal(match("Colors TV", "GB"), "400");
assert.equal(match("Colors", ""), null, "no country, and the name exists in two: no match");
assert.equal(match("Unique Planet", ""), "500", "no country, but unique worldwide");
assert.equal(match("Star Sports 1", "PK"), null, "a different country never matches");

/* ---- the directory ---- */

const xml = `<?xml version='1.0'?><tv>
  <channel id="9122"><display-name lang="GB">Sky Premiere HD</display-name><icon src="" /></channel>
  <channel id="9149"><display-name lang="GB">QUEST+1</display-name></channel>
  <channel id="77"><display-name lang="IN">Tom &amp; Jerry</display-name></channel>
  <programme start="20261001000000 +0000" channel="9122"><title>x</title></programme>`;

assert.deepEqual(parseDirectory(xml), [
    { id: "9122", name: "Sky Premiere HD", country: "GB" },
    { id: "9149", name: "QUEST+1", country: "GB" },
    { id: "77", name: "Tom & Jerry", country: "IN" }
]);

/* ---- schedules: absolute instants, whatever the offset ---- */

const now = Date.parse("2026-10-01T12:10:00Z");
const schedule = parseSchedule(
    [
        {
            epg_list: [
                { start_date: "2026-10-01T11:00:00+00:00", title: "Morning", desc: "early" },
                /* 12:00 UTC, written in India's zone. */
                { start_date: "2026-10-01T17:30:00+05:30", title: "Noon" }
            ]
        },
        {
            epg_list: [
                /* 12:45 UTC, written in New York's zone; and a duplicate. */
                { start_date: "2026-10-01T08:45:00-04:00", title: "Afternoon" },
                { start_date: "2026-10-01T12:00:00Z", title: "Noon" },
                { start_date: "2026-10-01T14:00:00+00:00", title: "Evening" }
            ]
        }
    ],
    now
);

assert.deepEqual(
    schedule.map((p) => [p.title, new Date(p.start).toISOString(), new Date(p.stop).toISOString()]),
    [
        ["Morning", "2026-10-01T11:00:00.000Z", "2026-10-01T12:00:00.000Z"],
        ["Noon", "2026-10-01T12:00:00.000Z", "2026-10-01T12:45:00.000Z"],
        ["Afternoon", "2026-10-01T12:45:00.000Z", "2026-10-01T14:00:00.000Z"]
    ],
    "each ends where the next begins; the last, with no known end, is dropped"
);
assert.equal(nowAndNext(schedule, now).now?.title, "Noon");
assert.equal(nowAndNext(schedule, now).next?.title, "Afternoon");
assert.equal(nowLine(schedule, now), "Now: Noon · 35 min left · Next: Afternoon");
assert.equal(nowLine(schedule, Date.parse("2026-10-01T10:00:00Z")), "Next: Morning in 1 h");

/* ---- freshness: until the timeline ends, or 12 hours ---- */

const entry = { epgId: "1", fetchedAt: now, programmes: schedule };
assert.equal(isFresh(entry, now + HOUR), true);
assert.equal(isFresh(entry, Date.parse("2026-10-01T14:00:00Z")), false, "timeline ran out");
assert.equal(isFresh({ ...entry, programmes: [{ start: now, stop: now + 20 * HOUR, title: "Long" }] }, now + STALE_AFTER), false, "12 hours old");
assert.equal(isFresh({ epgId: null, fetchedAt: now, programmes: [] }, now + HOUR), true, "a no-match is remembered too");

/* ---- the store, end to end, with a stub network ---- */

const dir = mkdtempSync(join(tmpdir(), "epg-"));
let clock = now;
const calls = [];
const fetcher = async (url) => {
    calls.push(url);

    if (url.endsWith(".xml.gz")) {
        const body = Readable.from([gzipSync(Buffer.from(xml + "<programme>".repeat(10)))]);

        return { ok: true, status: 200, body, text: async () => "" };
    }

    const json = JSON.stringify({
        epg_list: [
            { start_date: new Date(clock - HOUR).toISOString(), title: "Running" },
            { start_date: new Date(clock + HOUR).toISOString(), title: "Later" },
            { start_date: new Date(clock + 2 * HOUR).toISOString(), title: "End" }
        ]
    });

    return { ok: true, status: 200, body: null, text: async () => json };
};
const channels = {
    "iptv:SkyPremiere.uk": { id: "iptv:SkyPremiere.uk", name: "Sky Premiere", country: "UK" },
    "iptv:Quest.uk": { id: "iptv:Quest.uk", name: "Quest", country: "UK" }
};
const store = new GuideStore({
    file: join(dir, "epg-cache.json"),
    overridesFile: join(dir, "epg-overrides.json"),
    fetcher,
    lookup: async (id) => channels[id] || null,
    now: () => clock
});

const first = await store.programmesFor("iptv:SkyPremiere.uk");
assert.equal(first?.[0]?.title, "Running");
assert.ok(calls.some((url) => url.includes("channel_id=9122") && url.includes("timezone=UTC")), "fetched by the matched guide id");
assert.ok(calls.some((url) => /date=20260930/.test(url)), "and yesterday (UTC), for what is already running");

const before = calls.length;
await store.programmesFor("iptv:SkyPremiere.uk");
assert.equal(calls.length, before, "a fresh schedule is answered from the cache");

assert.equal(await store.programmesFor("iptv:Quest.uk"), null, "Quest is not QUEST+1: no guide");

clock += STALE_AFTER;
await store.programmesFor("iptv:SkyPremiere.uk");
assert.ok(calls.length > before, "12 hours later it is fetched again");

/* An override pins a channel by hand. */
writeFileSync(join(dir, "epg-overrides.json"), JSON.stringify({ "iptv:Quest.uk": "9149" }));
clock += STALE_AFTER;
assert.equal((await store.programmesFor("iptv:Quest.uk"))?.[0]?.title, "Running");

/* The warm set: most recent first, at most fifty. */
for (let at = 0; at < 60; at++) store.remember(`iptv:C${at}.uk`);
assert.equal(store.recentChannels().length, 50);
assert.equal(store.recentChannels()[0], "iptv:C59.uk");

store.stop();
const saved = JSON.parse(readFileSync(join(dir, "epg-cache.json"), "utf8"));
assert.equal(saved.recent.length, 50, "the warm set survives a restart");
assert.ok(saved.directory.channels.length === 3, "and so does the directory");

console.log("epg: ok");
