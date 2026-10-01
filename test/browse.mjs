/*
    BROWSE, WORLD TV AND THE TAXONOMY UNDER THEM.

    The promises: every scraper's own category words land in one of a
    dozen genres (unknown -> General, shopping/adult -> not browsable);
    an untagged Indian channel is filed under the language its name gives
    away; the language chips only offer languages that lead somewhere;
    a home market that speaks several languages gets a rail per language;
    and nothing on these pages uses CSS the television's Chromium 53 drops.
*/
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { initPluginConfig } = await import("../dist/plugin-config.js");
const { useScrapersForTest } = await import("../dist/scrapers.js");
const { channelIndex, channelsIn, countries, liveRails, resetChannelResultsForTest, forgetChannels } = await import("../dist/channels.js");
const { genreOf, languagesOf, continentOf } = await import("../dist/taxonomy.js");
const { browsePage, worldPage } = await import("../dist/pages/browse.js");

initPluginConfig(mkdtempSync(`${tmpdir()}/live-tv-browse-`));

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

const client = { link: (path) => `/s/x${path}`, session: {}, request: {}, authKey: "" };

let n = 0;
const chan = (name, country, categories, languages = []) => ({
    id: `live:t:${++n}`,
    name,
    country,
    countryName: { IN: "India", US: "United States", KE: "Kenya" }[country] || country,
    countryFlag: { IN: "🇮🇳", US: "🇺🇸", KE: "🇰🇪" }[country] || "",
    categories,
    languages,
    logo: "",
    website: "",
    network: "",
    streams: [{ url: `http://x/${n}.m3u8`, quality: "", labels: [], referrer: "", userAgent: "" }]
});

const list = [
    chan("Aaj Tak", "IN", ["news"], ["hin"]),
    chan("ABP News", "IN", ["news"], ["hin"]),
    chan("India TV", "IN", [], ["hin"]),
    chan("Zee News", "IN", ["news"], ["hin"]),
    chan("NDTV 24x7", "IN", ["news"], ["eng"]),
    chan("WION", "IN", ["news"], ["eng"]),
    chan("Sun TV", "IN", ["entertainment"]),
    chan("Sun News", "IN", []),
    chan("Polimer News", "IN", []),
    chan("Puthiya Thalaimurai", "IN", ["news"]),
    chan("Asianet News", "IN", ["news"]),
    chan("Aastha", "IN", ["religious"], ["hin"]),
    chan("Shop CJ", "IN", ["shop"], ["hin"]),
    chan("Star Sports 1", "IN", ["Sport"], ["eng"]),
    chan("Mystery Box", "IN", ["telenovela"], ["hin"]),
    chan("CBS News", "US", ["news"], ["eng"]),
    chan("KTN", "KE", ["general"], ["swa"])
];

useScrapersForTest([{ id: "t", name: "T", version: "1", build: async () => ({ channels: list }) }]);
resetChannelResultsForTest();
forgetChannels();

let index = null;
for (let tries = 0; tries < 60 && !(index && index.byId.size); tries += 1) {
    index = await channelIndex();
    if (!(index && index.byId.size)) await new Promise((r) => setTimeout(r, 100));
}
ok(index && index.byId.size === list.length, "the test catalogue is indexed");

const byName = (name) => [...index.byId.values()].find((channel) => channel.name === name);

/* ---- taxonomy ------------------------------------------------------------ */

ok(genreOf(byName("Aaj Tak")) === "news", "a plain category maps to its genre");
ok(genreOf(byName("Star Sports 1")) === "sports", "a differently cased, singular category still maps");
ok(genreOf(byName("India TV")) === "general", "no category and nothing in the name: General");
ok(genreOf(byName("Sun News")) === "news", "no category, but the name says news");
ok(genreOf(byName("Aastha")) === "devotional", "religious is Devotional");
ok(genreOf(byName("Shop CJ")) === null, "a shopping channel is not browsable");
ok(genreOf(byName("Mystery Box")) === "general", "an unknown category word falls to General");
ok(languagesOf(byName("Sun TV"))[0] === "tam", "an untagged Indian channel is filed by its name: Sun TV is Tamil");
ok(languagesOf(byName("Asianet News"))[0] === "mal", "and Asianet is Malayalam");
ok(languagesOf(byName("CBS News"))[0] === "eng", "a tagged channel keeps its own languages");
ok(continentOf("UK") === "europe" && continentOf("GB") === "europe", "both spellings of the UK are in Europe");
ok(continentOf("KE") === "africa" && continentOf("ZZ") === "elsewhere", "an unknown code is Elsewhere, not dropped");

/* ---- the Browse page ------------------------------------------------------- */

const india = await channelsIn("IN");
const html = browsePage(client, false, {
    scope: { country: "IN", title: "India", flag: "🇮🇳", path: "/tv/browse", regionChips: true },
    regions: [{ code: "IN", name: "India", flag: "🇮🇳" }, { code: "US", name: "United States", flag: "🇺🇸" }],
    channels: india,
    genre: "news",
    language: "",
    skip: 0,
    perPage: 60,
    status: null,
    languageName: (code) => code
});

ok(html.includes(">News<span class=\"n\">9</span>"), "the side list counts News for the region");
ok(html.includes("Language") && html.includes("Hindi") && html.includes("Tamil"), "India's News offers a language choice, by name");
ok(!html.includes("Malayalam"), "but not a language with a single channel in this genre");
ok(html.includes("/s/x/tv/browse?c=IN&amp;g=news&amp;l=tam"), "language chips keep the region and the genre");
ok(html.includes("/s/x/tv/world"), "and the region row leads on to World TV");
ok(!html.includes("Shop CJ"), "shopping is never on the wall");
ok(!/display:\s*(grid|flex)|\bgap:|clamp\(|:focus-visible|aspect-ratio|var\(--/.test(html), "no CSS the television's Chromium 53 drops");

const tamil = browsePage(client, false, {
    scope: { country: "IN", title: "India", flag: "", path: "/tv/country/IN", regionChips: false },
    regions: [],
    channels: india,
    genre: "news",
    language: "tam",
    skip: 0,
    perPage: 60,
    status: null,
    languageName: (code) => code
});
ok(tamil.includes("Puthiya Thalaimurai") && tamil.includes("Polimer News") && !tamil.includes("Aaj Tak"), "picking Tamil shows Tamil news only");
ok(!tamil.includes("Region"), "a country's own page has no region row");

/* ---- World TV ------------------------------------------------------------- */

const world = worldPage(client, false, await countries(), ["IN", "US"], null);
ok(world.includes("Your countries") && world.includes("Asia") && world.includes("Africa"), "World TV groups countries by continent, household first");
ok(world.includes("/s/x/tv/country/KE"), "every country links to its own page");

/* ---- language rails on the home page --------------------------------------- */

const { rails } = await liveRails(["IN"], [{ code: "hin", name: "Hindi" }], (code) => `/tv/country/${code}`);
const tamilRail = rails.find((rail) => rail.id === "lang:IN:tam");
ok(tamilRail && tamilRail.heading === "Tamil channels", "India gets a Tamil rail, named in words");
ok(tamilRail.more === "/tv/country/IN?l=tam", "whose See all opens India filtered to Tamil");
ok(!rails.some((rail) => rail.id === "lang:IN:hin"), "but not a rail for its biggest language, which the country rail already is");

console.log(`browse: ${checks} checks ok`);
process.exit(0);
