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
    ["Discovery", "Discovery Kids"],
    /* A name's non-Latin part is part of its identity, never dropped. */
    ["CGTN", "CGTN纪录"],
    ["BRIDGE", "Bridge TV Шлягер"],
    ["RT", "RT Д Русский"],
    ["MOMO TV", "MOMO親子台"],
    /* A 4K/8K channel is often a channel of its own. */
    ["CCTV-4K", "CCTV"],
    ["BBC One 4K", "BBC One"]
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
assert.equal(match("Unique Planet", ""), null, "no country: never matched, even when the name is unique");
assert.equal(match("Unique Planet", "CA"), null, "and never across countries");
assert.equal(match("Star Sports 1", "PK"), null, "a different country never matches");

/* ---- the rules that keep a wrong guide out ---- */

{
    const rules = buildIndex([
        { id: "1", name: "CGTN纪录", country: "CN" },
        { id: "2", name: "CCTV-1 综合", country: "CN" },
        { id: "3", name: "CCTV怀旧剧场", country: "CN" },
        { id: "4", name: "CCTV-5+ 体育赛事", country: "CN" },
        { id: "5", name: "Universal Channel", country: "BR" },
        { id: "6", name: "HIT TV", country: "RU" },
        { id: "7", name: "Hit", country: "RU" },
        { id: "8", name: "SAAM", country: "IN" },
        { id: "9", name: "NATIONAL GEOGRAPHIC", country: "IN" },
        { id: "10", name: "STAR SPORTS 1 HINDI", country: "IN" },
        { id: "11", name: "Roar TV", country: "US" },
        { id: "12", name: "Bridge TV Шлягер", country: "RU" }
    ]);
    const rule = (name, country, languages) => matchChannel(rules, { id: "x", name, country, languages })?.id ?? null;

    assert.equal(rule("CGTN", "CN"), null, "a different channel's listing (CGTN Documentary) is not CGTN");
    assert.equal(rule("BRIDGE", "RU"), null, "nor is a Cyrillic-named sibling");
    assert.equal(rule("CCTV-1", "CN"), "2", "a NUMBERED channel with a CJK descriptor is that channel");
    assert.equal(rule("CCTV-5+", "CN"), "4");
    assert.equal(rule("CCTV-8K", "CN"), null, "and a descriptor-only listing is not a number match");
    assert.equal(rule("TV Universal", "BR"), null, "a leading TV is part of the name: not 'Universal Channel'");
    assert.equal(rule("Hit", "RU"), "7", "an exact listing is taken");
    assert.equal(rule("Hit TV", "RU"), "6", "an exact listing is taken");
    assert.equal(rule("Saam TV", "IN"), "8", "a trailing TV is ignored, in the second pass");
    assert.equal(rule("Roar", "US"), "11");
    assert.equal(rule("Hit Network", "RU"), null);
    assert.equal(rule("National Geographic", "IN", ["eng"]), "9");
    assert.equal(rule("National Geographic", "IN", ["eng", "hin", "kan", "tam"]), null, "a pan-regional feed has no single schedule");
    assert.equal(rule("Star Sports 1 Hindi", "IN", ["hin", "eng", "tam"]), "10", "unless its own name says which language");

    /* Two listings that differ by more than "TV" are two channels: no pick. */
    const clash = buildIndex([
        { id: "20", name: "Zing", country: "IN" },
        { id: "21", name: "Zing TV", country: "IN" }
    ]);
    assert.equal(matchChannel(clash, { id: "x", name: "Zing Channel", country: "IN" }), null);
    assert.equal(matchChannel(clash, { id: "x", name: "Zing", country: "IN" })?.id, "20");
}

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

/* ---- the whole-guide fetch ---- */

const { BulkGuide, mapChannels, parseProgramme, parseXmltvTime } = await import("../dist/epg-bulk.js");

assert.equal(parseXmltvTime("20261001083000 +0530"), Date.parse("2026-10-01T03:00:00Z"), "an offset is honoured");
assert.equal(parseXmltvTime("20261001030000 +0000"), Date.parse("2026-10-01T03:00:00Z"));
assert.equal(parseXmltvTime("20260930230000 -0400"), Date.parse("2026-10-01T03:00:00Z"));

assert.deepEqual(
    parseProgramme(`<programme channel="7" start="20261001100000 +0000" stop="20261001110000 +0000"><title lang="en">Tom &amp; Jerry</title><desc>Chase.</desc></programme>`),
    { channel: "7", programme: { start: Date.parse("2026-10-01T10:00:00Z"), stop: Date.parse("2026-10-01T11:00:00Z"), title: "Tom & Jerry", description: "Chase." } }
);

const mapped = mapChannels(
    [
        { id: "1", name: "Colors", country: "GB" },
        { id: "2", name: "Colors", country: "IN" }
    ],
    [
        { id: "uk", name: "Colors TV", country: "UK" },
        { id: "in", name: "Colors", country: "IN" },
        { id: "pk", name: "Colors", country: "PK" },
        { id: "none", name: "Colors", country: "" }
    ]
);
assert.deepEqual([...mapped.feeds.entries()], [["1", ["uk"]], ["2", ["in"]]], "each country its own guide; none across countries");
assert.equal(mapped.status.matched, 2);
assert.equal(mapped.status.unmatched, 2);
assert.equal(mapped.status.noCountry, 1);
assert.deepEqual(mapped.status.countries.find((c) => c.code === "PK"), { code: "PK", channels: 1, matched: 0 });
assert.equal(mapped.status.uncovered, 1, "PK: the guide has no channels for that country at all");

{
    const at = Date.parse("2026-10-01T12:00:00Z");
    const guideXml = `<?xml version="1.0"?><tv>
<channel id="1"><display-name lang="GB">Colors</display-name></channel>
<channel id="2"><display-name lang="IN">Colors</display-name></channel>
<programme channel="1" start="20261001113000 +0000" stop="20261001123000 +0000"><title>UK Show</title></programme>
<programme channel="2" start="20261001170000 +0530" stop="20261001183000 +0530"><title>India Show</title></programme>
<programme channel="2" start="20261005000000 +0000" stop="20261005010000 +0000"><title>Too far ahead</title></programme>
</tv>`;
    const bulkDir = mkdtempSync(join(tmpdir(), "epg-bulk-"));
    const bulk = new BulkGuide({
        file: join(bulkDir, "epg-guide.json"),
        now: () => at,
        fetcher: async () => ({
            ok: true,
            status: 200,
            /* Small chunks, so a programme is split across reads. */
            body: Readable.from(gzipChunks(guideXml)),
            text: async () => ""
        }),
        channels: async () => [
            { id: "uk", name: "Colors", country: "UK" },
            { id: "in", name: "Colors", country: "IN" }
        ]
    });

    await bulk.refresh();
    assert.deepEqual(bulk.programmesFor("uk").map((p) => p.title), ["UK Show"]);
    assert.deepEqual(bulk.programmesFor("in").map((p) => p.title), ["India Show"], "kept: only the window around now");
    assert.equal(bulk.status().matched, 2);
    assert.ok(bulk.status().ok);

    const reread = new BulkGuide({ file: join(bulkDir, "epg-guide.json"), now: () => at, fetcher: async () => ({ ok: false, status: 500, body: null, text: async () => "" }), channels: async () => [] });
    assert.deepEqual(reread.programmesFor("uk").map((p) => p.title), ["UK Show"], "schedules survive a restart");
    await reread.refresh();
    assert.equal(reread.status().ok, false, "a failed fetch is reported");
    assert.deepEqual(reread.programmesFor("uk").map((p) => p.title), ["UK Show"], "and keeps the schedules already held");
}

/* ---- tier 1: by iptv-org's own id, tier 2: by name ---- */

{
    const { buildLinks, guideLink } = await import("../dist/epg-ids.js");

    assert.deepEqual(guideLink("epg.iptvx.one", "1-2"), { url: "https://epg.iptvx.one/epg.xml.gz", channel: "1-2" });
    assert.deepEqual(guideLink("i.mjh.nz", "Plex/gb#abc-def"), { url: "https://i.mjh.nz/Plex/gb.xml.gz", channel: "abc-def" });
    assert.equal(guideLink("i.mjh.nz", "../etc#x"), null, "a path cannot climb out of the host");
    assert.equal(guideLink("i.mjh.nz", "no-hash"), null);
    assert.equal(guideLink("tataplay.com", "137"), null, "a per-channel scraper has no bulk file");

    const table = buildLinks([
        { channel: "Quest.uk", feed: "SD", site: "i.mjh.nz", site_id: "Plex/us#q-us" },
        { channel: "Quest.uk", feed: "SD", site: "i.mjh.nz", site_id: "Plex/gb#q-gb" },
        { channel: "Quest.uk", feed: "SD", site: "tataplay.com", site_id: "5" },
        { channel: null, site: "i.mjh.nz", site_id: "Plex/gb#orphan" }
    ]);
    assert.deepEqual(Object.keys(table.links), ["Quest.uk"]);
    assert.equal(table.links["Quest.uk"].length, 2);

    const at = Date.parse("2026-10-01T12:00:00Z");
    const prog = (channel, start, stop, title) =>
        `<programme channel="${channel}" start="${start} +0000" stop="${stop} +0000"><title>${title}</title></programme>`;
    const files = {
        "https://iptv-org.github.io/api/guides.json": JSON.stringify([
            { channel: "Quest.uk", site: "i.mjh.nz", site_id: "Plex/us#q-us" },
            { channel: "Quest.uk", site: "i.mjh.nz", site_id: "Plex/gb#q-gb" },
            { channel: "Solo.us", site: "epg.iptvx.one", site_id: "solo" },
            { channel: "Pinned.us", site: "epg.iptvx.one", site_id: "pinned" }
        ]),
        "https://i.mjh.nz/Plex/us.xml.gz": `<tv><channel id="q-us"><display-name>Quest</display-name></channel>${prog("q-us", "20261001110000", "20261001150000", "US Quest A")}${prog("q-us", "20261001150000", "20261001190000", "US Quest B")}${prog("q-us", "20261001190000", "20261001230000", "US Quest C")}</tv>`,
        "https://i.mjh.nz/Plex/gb.xml.gz": `<tv><channel id="q-gb"><display-name>Quest</display-name></channel>${prog("q-gb", "20261001110000", "20261001150000", "UK Quest")}</tv>`,
        "https://epg.iptvx.one/epg.xml.gz": `<tv><channel id="solo"><display-name>Solo</display-name></channel><channel id="pinned"><display-name>P</display-name></channel>${prog("solo", "20261001110000", "20261001150000", "Solo Show")}${prog("pinned", "20261001110000", "20261001150000", "Wrong")}</tv>`,
        "https://epg.pw/xmltv/epg.xml.gz": `<tv><channel id="1"><display-name lang="US">Fallback</display-name></channel><channel id="2"><display-name lang="US">Solo</display-name></channel>${prog("1", "20261001110000", "20261001150000", "Name Match")}${prog("2", "20261001110000", "20261001150000", "Name Solo")}</tv>`
    };
    const seen = [];
    const dirIds = mkdtempSync(join(tmpdir(), "epg-ids-"));
    writeFileSync(join(dirIds, "overrides.json"), JSON.stringify({ "iptv:Pinned.us": null }));

    const bulkIds = new BulkGuide({
        file: join(dirIds, "guide.json"),
        linksFile: join(dirIds, "links.json"),
        overridesFile: join(dirIds, "overrides.json"),
        now: () => at,
        fetcher: async (url) => {
            seen.push(url);
            const body = files[url];

            if (body === undefined) return { ok: false, status: 404, body: null, text: async () => "" };

            return url.endsWith(".gz")
                ? { ok: true, status: 200, body: Readable.from(gzipChunks(body)), text: async () => "" }
                : { ok: true, status: 200, body: null, text: async () => body };
        },
        channels: async () => [
            { id: "iptv:Quest.uk", name: "Quest", country: "UK" },
            { id: "iptv:Solo.us", name: "Solo", country: "US" },
            { id: "iptv:Pinned.us", name: "Pinned", country: "US" },
            { id: "iptv:Fallback.us", name: "Fallback", country: "US" },
            { id: "live:other:1", name: "No Country", country: "" }
        ]
    });

    await bulkIds.refresh();
    const titles = (id) => bulkIds.programmesFor(id)?.map((p) => p.title) ?? null;

    assert.ok(bulkIds.status().ok, bulkIds.status().error);
    assert.deepEqual(titles("iptv:Quest.uk"), ["UK Quest"], "the file of the channel's own country wins over a fuller foreign one");
    assert.deepEqual(titles("iptv:Solo.us"), ["Solo Show"], "an id match beats a name match");
    assert.equal(titles("iptv:Pinned.us"), null, "a hand-made block outranks the id mapping");
    assert.deepEqual(titles("iptv:Fallback.us"), ["Name Match"], "no id mapping: the guarded name match");
    assert.equal(titles("live:other:1"), null, "no country and no id: nothing");
    assert.equal(bulkIds.status().byId, 2);
    assert.equal(bulkIds.status().matched, 3);
    assert.deepEqual(bulkIds.status().sources, { ok: 3, failed: 0 });

    /* The mapping is kept for a week: a second run does not fetch it. */
    seen.length = 0;
    await bulkIds.refresh();
    assert.ok(!seen.includes("https://iptv-org.github.io/api/guides.json"), "guides.json is read at most weekly");
    assert.ok(JSON.parse(readFileSync(join(dirIds, "links.json"), "utf8")).links["Solo.us"], "and it is persisted");
}

function gzipChunks(text) {
    const zipped = gzipSync(Buffer.from(text));
    const out = [];

    for (let at = 0; at < zipped.length; at += 37) out.push(zipped.subarray(at, at + 37));

    return out;
}


/* ---- per-channel sites: Airtel Xstream, Dish TV ---- */

{
    const { dishTime, siteSchedule, isSiteProvider } = await import("../dist/epg-sites.js");
    const { buildLinks } = await import("../dist/epg-ids.js");
    const at = Date.parse("2026-10-02T09:30:00Z");

    /* Dish writes India wall-clock with a "Z": 14:31 there is 09:01 UTC. */
    assert.equal(new Date(dishTime("2026-10-02T14:31:00Z")).toISOString(), "2026-10-02T09:01:00.000Z");
    assert.ok(Number.isNaN(dishTime("nonsense")));
    assert.equal(isSiteProvider("airtelxstream.in"), true);
    assert.equal(isSiteProvider("tataplay.com"), false, "a site that refuses ordinary clients is not here");

    const table = buildLinks([
        { channel: "Nat.in", site: "airtelxstream.in", site_id: "AIRTEL_NAT" },
        { channel: "Nat.in", site: "dishtv.in", site_id: "143573" },
        { channel: "Nat.in", site: "tataplay.com", site_id: "137" },
        { channel: "Nat.in", site: "airtelxstream.in", site_id: "AIRTEL_NAT" }
    ]);
    assert.deepEqual(table.dynamic["Nat.in"], [
        { site: "airtelxstream.in", siteId: "AIRTEL_NAT" },
        { site: "dishtv.in", siteId: "143573" }
    ]);

    const calls = [];
    const airtelBody = JSON.stringify({
        programGuide: {
            AIRTEL_NAT: [
                { title: "Later", desc: "d", startTime: at + 3_600_000, endTime: at + 7_200_000 },
                { title: "Now", startTime: at - 1_800_000, endTime: at + 3_600_000 },
                { title: "", startTime: at, endTime: at + 1 },
                { title: "Long gone", startTime: at - 40 * 3_600_000, endTime: at - 39 * 3_600_000 }
            ]
        }
    });
    const dishList = (title, start, stop) => JSON.stringify([{ title, start, stop }]);
    const get = async (url, _timeout, init) => {
        calls.push([url, init?.method || "GET"]);

        if (url.includes("epg.airtel.tv")) return { ok: true, status: 200, body: null, text: async () => airtelBody };
        if (url.includes("/signin")) return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ token: "T" }) };

        const date = JSON.parse(init.body).date;

        assert.equal(init.headers.Authorization, "T");

        return { ok: true, status: 200, body: null, text: async () => (date === "02/10/2026" ? dishList("Dish Now", "2026-10-02T14:31:00Z", "2026-10-02T15:31:00Z") : "[]") };
    };

    const a = await siteSchedule({ site: "airtelxstream.in", siteId: "AIRTEL_NAT" }, at, get);
    assert.deepEqual(a.map((p) => p.title), ["Now", "Later"], "ordered; nameless and long-ended dropped");
    assert.equal(a[0].stop, a[1].start);
    assert.ok(calls[0][0].includes("channelId=AIRTEL_NAT"));

    const d = await siteSchedule({ site: "dishtv.in", siteId: "143573" }, at, get);
    assert.deepEqual(d.map((p) => [p.title, new Date(p.start).toISOString()]), [["Dish Now", "2026-10-02T09:01:00.000Z"]]);
    assert.equal(calls.filter((c) => c[0].includes("/signin")).length, 1);

    /* The store: a site's own API before the name match; an override beats both. */
    const store = new GuideStore({
        file: "",
        now: () => at,
        overridesFile: (() => {
            const f = join(mkdtempSync(join(tmpdir(), "epg-site-")), "o.json");
            writeFileSync(f, JSON.stringify({ "iptv:Blocked.in": null }));

            return f;
        })(),
        siteLinks: () => [{ site: "airtelxstream.in", siteId: "AIRTEL_NAT" }],
        lookup: async () => null,
        fetcher: get
    });

    assert.deepEqual((await store.programmesFor("iptv:Nat.in"))?.map((p) => p.title), ["Now", "Later"], "by the site's id: no directory, no name");
    assert.equal(await store.programmesFor("iptv:Blocked.in"), null, "a hand-made block outranks the site link");

    const failing = new GuideStore({
        file: "",
        now: () => at,
        siteLinks: () => [{ site: "airtelxstream.in", siteId: "X" }],
        lookup: async () => null,
        fetcher: async () => ({ ok: false, status: 500, body: null, text: async () => "" })
    });
    assert.equal(await failing.programmesFor("iptv:Nat.in"), null, "a site that is down is no guide, not an error");
}

/* ---- latency: a page never waits longer than its budget ---- */

{
    const slowDir = mkdtempSync(join(tmpdir(), "epg-slow-"));
    let t = Date.parse("2026-10-01T12:10:00Z");
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const list = (title) => JSON.stringify({ epg_list: [{ start_date: "2026-10-01T12:00:00+00:00", title }, { start_date: "2026-10-01T18:00:00+00:00", title: title + " 2" }, { start_date: "2026-10-02T02:00:00+00:00", title: "End" }] });
    let slow = true;
    const store = new GuideStore({
        file: "",
        now: () => t,
        lookup: async () => ({ id: "c", name: "Unique Planet", country: "US" }),
        fetcher: async (url) => {
            if (url.endsWith(".xml.gz")) {
                return { ok: true, status: 200, body: Readable.from([gzipSync(Buffer.from(`<tv><channel id="5"><display-name lang="US">Unique Planet</display-name></channel><programme x="1">`))]), text: async () => "" };
            }

            const title = slow ? "Slow" : "Fresh";

            if (slow) await gate;

            return { ok: true, status: 200, body: null, text: async () => list(title) };
        }
    });

    const began = Date.now();
    const first = await store.programmesWithin("c", 80);

    assert.equal(first, null, "a slow guide: the page gets nothing, rather than waiting");
    assert.ok(Date.now() - began < 400, `answered within the budget (took ${Date.now() - began} ms)`);

    release();
    slow = false;
    assert.ok((await store.programmesFor("c"))?.length, "the lookup carried on and finished in the background");
    assert.equal((await store.programmesWithin("c", 0))?.[0]?.title, "Slow", "and the next page has it at once");

    /* Stale but with programmes ahead: answered at once, refreshed behind. */
    t += 13 * HOUR;
    const stale = await store.programmesWithin("c", 0);

    assert.ok(stale?.length, "a stale schedule with programmes left is still answered");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await store.programmesWithin("c", 0))?.[0]?.title, "Fresh 2", "the refresh landed");
    void slowDir;
}

console.log("epg: ok");
