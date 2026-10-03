/*
    THE PICTURE OF A MERGED CARD (`channels.ts`, `ScrapedChannel.logo`/`logos`).

    Two sources list the same live event. The merged card keeps the first
    source's id and place, but its picture comes from whichever source has
    one -- in either order -- and a pair of flags (`logos`) beats a single
    picture. A card where no source has a picture stays without one.
*/
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { initPluginConfig } = await import("../dist/plugin-config.js");
const { useScrapersForTest } = await import("../dist/scrapers.js");
const { channelIndex, resetChannelResultsForTest, forgetChannels } = await import("../dist/channels.js");

initPluginConfig(mkdtempSync(`${tmpdir()}/live-tv-event-logos-`));

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

/* Scraper results are cached per scraper id and version, so every case gets ids of its own. */
let round = 0;
const nextRound = () => {
    round += 1;
    return round;
};
const event = (scraper, name, extra = {}) => ({
    id: `live:${scraper}:${name.replace(/\W+/g, "-").toLowerCase()}`,
    name,
    country: "",
    countryName: "",
    categories: ["sports"],
    languages: [],
    logo: "",
    website: "",
    network: "",
    streams: [{ url: `https://${scraper}.example/${name.length}.m3u8`, quality: "", labels: [], referrer: "", userAgent: "" }],
    ...extra
});

const scraper = (id, channels) => ({ id, name: id, version: "1", build: async () => ({ channels }) });
const pair = (label, make) => {
    const n = nextRound();
    return [scraper(`aaa${n}`, [make(`aaa${n}`, 0)]), scraper(`bbb${n}`, [make(`bbb${n}`, 1)])];
};

const load = async (scrapers) => {
    resetChannelResultsForTest();
    forgetChannels();
    useScrapersForTest(scrapers);
    let index = null;
    for (let tries = 0; tries < 50 && !(index && index.byId.size); tries += 1) {
        index = await channelIndex();
        if (!(index && index.byId.size)) await new Promise((r) => setTimeout(r, 100));
    }
    return index;
};

const A = "https://img.test/india.png";
const B = "https://img.test/windies.png";
const NAME = "India vs West Indies";

/* `extras` is what the first and the second source put on their event. */
const two = (first, second) => pair("", (id, at) => event(id, NAME, at === 0 ? first : second));
const only = async (scrapers) => [...(await load(scrapers)).byId.values()];

/* The first source has no picture, the second does. */
let cards = await only(two({}, { logo: A }));
ok(cards.length === 1 && cards[0].streams.length === 2, "the two sources' events are one card");
ok(cards[0].logo === A, "the merged card takes the picture from the source that has one");

/* The other way round: the first has it and keeps it. */
cards = await only(two({ logo: A }, { logo: "https://img.test/other.png" }));
ok(cards[0].logo === A, "a picture already there is not replaced by a later source's");

/* A pair beats a single picture, whichever source brings it. */
cards = await only(two({ logo: A }, { logo: A, logos: [A, B] }));
ok(cards[0].logo === A && cards[0].logos && cards[0].logos[0] === A && cards[0].logos[1] === B, "a pair of flags from a later source is adopted");

cards = await only(two({ logo: A, logos: [A, B] }, { logo: A }));
ok(cards[0].logos && cards[0].logos.length === 2, "and one already there is kept");

/* Neither has anything. */
cards = await only(two({}, {}));
ok(cards[0].logo === "" && !cards[0].logos, "no source, no picture");

/* A single entry in `logos` is not a pair. */
const solo = `solo${nextRound()}`;
cards = await only([scraper(solo, [event(solo, "Solo Event", { logo: A, logos: [A] })])]);
ok(!cards[0].logos, "one picture in logos is just a logo");

console.log(`event-logos: ${checks} checks ok`);
process.exit(0);
