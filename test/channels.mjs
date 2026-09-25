/**
 * The live-TV index: the ordering, and the promise that a source answered.
 *
 * WHY THESE AND NOT THE FETCH. The fetch is six files from somebody else's
 * CDN and is not worth a test; what is worth a test is everything that
 * happens to them afterwards, because every one of those is a decision that
 * looks fine when it is wrong.
 *
 * A channel list sorted badly still renders. A channel that has closed down
 * still has a name and a logo. A source list that offers dead URLs still
 * looks like a source list -- which is the exact complaint this whole page
 * was written to answer, and the only way to fail it is silently.
 */

import { strict as assert } from "node:assert";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { select, rankStreams, searchChannels, channelStreamList, describeChannel, isChannelId, anyChecked, scoreOf, evidenceFor, known, proofOf, PREFIX } =
    await import("../dist/channels.js");

let checks = 0;

function check(what, value) {
    assert.ok(value, what);
    checks += 1;
}

function same(what, value, expected) {
    assert.equal(value, expected, what);
    checks += 1;
}

/* ---- ids -------------------------------------------------------------- */

check("our own channels are recognisable", isChannelId(`${PREFIX}BBCOne.uk`));
check("an addon's channel id is not ours", !isChannelId("iptv_channels_12345"));
check("nor is a film", !isChannelId("tt0111161"));

/* ---- the ordering ----------------------------------------------------- */

function channel(name, over = {}) {
    return {
        id: PREFIX + name,
        name,
        country: "IN",
        countryName: "India",
        categories: ["general"],
        languages: ["hin"],
        logo: "",
        website: "",
        network: "",
        streams: [{ url: `http://x/${name}`, quality: "1080p", labels: [], referrer: "", userAgent: "" }],
        score: 0,
        ...over
    };
}

const built = {
    all: [
        channel("Small", { score: 10 }),
        channel("Large", { score: 90 }),
        /*
            Scored above everything in the house's own market, which is the
            ordinary case: the globe's most mirrored channels are Brazilian
            and Turkish, and the real scores top out around 370 -- which is
            why the home bonus is 400 and not 40.
        */
        channel("Foreign", { score: 300, country: "BR", countryName: "Brazil", languages: ["por"] }),
        channel("Sporty", { score: 40, categories: ["sports"] }),
        channel("Cartoons", { score: 20, categories: ["animation"] })
    ]
};

const top = select(built, { limit: 10 });

same("the highest score leads when nothing is preferred", top[0].name, "Foreign");

/*
    THE ONE THAT MATTERS. Sorted purely by score the sports rail leads with
    whichever country mirrors the most, which on a television in a
    particular house is the wrong list -- so a channel from one of the
    household's markets outranks a better-scored one that is not.
*/
const home = select(built, { limit: 10 }, ["IN"]);

same("the household's own market comes first", home[0].name, "Large");
check("and the foreign one is still there", home.some((entry) => entry.name === "Foreign"));

same(
    "a country filter is a filter, not a preference",
    select(built, { countries: ["BR"] }).length,
    1
);
same(
    "kids reads animation as well as kids",
    select(built, { categories: ["kids", "animation", "family"] })[0].name,
    "Cartoons"
);
same(
    "a language filter uses the feed's own code",
    select(built, { languages: ["por"] })[0].name,
    "Foreign"
);
/* ---- which mirror is offered first ------------------------------------ */

const many = channel("Many", {
    streams: [
        { url: "http://a", quality: "480p", labels: [], referrer: "", userAgent: "" },
        { url: "http://b", quality: "1080p", labels: ["Not 24/7"], referrer: "", userAgent: "" },
        { url: "http://c", quality: "1080p", labels: [], referrer: "", userAgent: "" }
    ]
});

const ranked = rankStreams(many);

same("an unwarned mirror leads", ranked[0].url, "http://c");
same("and the warned one goes last however good it claims to be", ranked[2].url, "http://b");

/* ---- the source list --------------------------------------------------- */

/*
    Nothing here can reach the internet, so every check fails -- which is
    the case worth testing anyway. The list must still be OFFERED: a viewer
    whose sources this service could not reach may still be able to reach
    them, and a page that hides them is the page that says a channel has no
    sources at all.
*/
const list = await channelStreamList(many);

same("every mirror is still listed", list.items.length, 3);
check("with the failure said out loud", list.failures.length === 1);
check(
    "and said in terms of what was tried",
    /answered just now|did not answer just now/.test(list.failures[0].reason)
);
check("attributed to where they came from", list.items[0].from.manifest.name === "iptv-org");
check("and each one is a direct URL", list.items.every((entry) => entry.value.url));
check(
    "none of them claims to have been checked",
    list.items.every((entry) => entry.value.name === "Live")
);

check("and nothing on it claims to be serving", !anyChecked(list.items));

/*
    THE ONE THAT PRODUCED ALL OF THIS. "Tried playing BBC One, nothing
    played" -- fifty mirrors, forty-eight of them the BBC's own geo-fenced
    edges, none of which answer from this house. Five were checked, none
    worked, and Play was handed the first dead one anyway: a black screen
    and no explanation.

    Two things have to hold. The reason must name geo-blocking, because
    that is the only version of it somebody can act on -- the switch is at
    the top of the page. And it must survive a couple of unlabelled strays
    among the fenced ones, which is exactly BBC One's shape.
*/
const fenced = channel("Fenced", {
    streams: [
        ...Array.from({ length: 8 }, (_, at) => ({
            url: `http://fence/${at}`,
            quality: "720p",
            labels: ["Geo-blocked"],
            referrer: "",
            userAgent: ""
        })),
        { url: "http://stray", quality: "720p", labels: [], referrer: "", userAgent: "" }
    ]
});

const fencedList = await channelStreamList(fenced);

check("a geo-fenced channel says so", /geo-blocked/i.test(fencedList.failures[0].reason));
check("and says what to do about it", /VPN/.test(fencedList.failures[0].reason));
check("a stray unlabelled mirror does not hide that", fencedList.items.length === 9);
check("and Play has nothing it is willing to start", !anyChecked(fencedList.items));

/*
    HOW DEEP IT LOOKS. Five was not enough for a channel with fifty
    mirrors whose first dozen are fenced -- so the pass goes on past the
    first batch rather than reporting nothing and pointing Play at a
    corpse.
*/
const deep = channel("Deep", {
    streams: Array.from({ length: 12 }, (_, at) => ({
        url: `http://deep/${at}`,
        quality: "720p",
        labels: [],
        referrer: "",
        userAgent: ""
    }))
});

const deepList = await channelStreamList(deep);

check("more than one batch is tried", /the first 12 of 12|none of this channel/.test(deepList.failures[0].reason));

/* ---- what "widely carried" counts -------------------------------------- */

/*
    A geo-fenced mirror barely counts toward it. The number is standing in
    for how available a channel is, and forty-eight fenced edges are not
    availability -- scoring them made BBC One the front of the UK rail and
    the one channel in it that cannot play.
*/
const mirror = (labels) => ({ url: `http://m/${Math.random()}`, quality: "720p", labels, referrer: "", userAgent: "" });

check(
    "four reachable mirrors beat twelve fenced ones",
    scoreOf(Array.from({ length: 4 }, () => mirror([])), ["general"], "Clear") >
        scoreOf(Array.from({ length: 12 }, () => mirror(["Geo-blocked"])), ["general"], "Fenced")
);
check(
    "but a fenced mirror is not worth nothing -- a UK exit node gets exactly those",
    scoreOf(Array.from({ length: 12 }, () => mirror(["Geo-blocked"])), ["general"], "Fenced") >
        scoreOf([mirror([])], ["general"], "Lonely")
);
check(
    "a shopping channel does not outrank the news for being well mirrored",
    scoreOf(Array.from({ length: 9 }, () => mirror([])), ["shop"], "Buy Now") <
        scoreOf(Array.from({ length: 4 }, () => mirror([])), ["news"], "Some News")
);

/* ---- the line under a name --------------------------------------------- */

check("a single source is not '1 sources'", /\b1 source\b/.test(describeChannel(channel("One"))));
check("and several are counted", /3 sources/.test(describeChannel(many)));

/* ---- what the night found ---------------------------------------------- */

/*
    THE SWEEP IS THE POINT OF THE SECOND HALF OF THIS FILE. Everything the
    list says about a mirror is a claim; an answer from three this morning
    is evidence, and it has to beat every claim -- including the stated
    resolution, which is the one that reads as most authoritative and is
    worth exactly nothing if the host is gone.

    `channelStreamList` above has already asked about `many`'s three
    mirrors and been refused by all of them, so they are known-bad here
    without anything being mocked.
*/
same("a mirror that was asked and failed is remembered as such", known("http://a"), false);
same("a mirror nobody asked about is not remembered as anything", known("http://never"), null);

const seen = evidenceFor(many);

same("and the channel knows how many of each it has", seen.bad, 3);
same("with nothing counted as working", seen.good, 0);

/*
    Ordering. All three of `many`'s mirrors are known-bad, so the claims
    decide between them again -- but a fourth that nobody has asked about
    must come FIRST, because "no answer" might still work and "no" does
    not.
*/
const mixed = channel("Mixed", {
    streams: [
        ...many.streams,
        { url: "http://unknown", quality: "240p", labels: ["Not 24/7"], referrer: "", userAgent: "" }
    ]
});

same(
    "an unasked mirror outranks a known-dead one, whatever either claims",
    rankStreams(mixed)[0].url,
    "http://unknown"
);

/*
    And in `select`: a channel proven dead sinks below one nobody has
    asked about, however good its composite looks. This is the whole
    answer to "ensure channels from India and the USA play" -- the ones
    that do not simply stop leading their rails.
*/
const rails = select(
    { all: [{ ...many, name: "Proven dead", score: 900 }, channel("Unasked", { score: 10 })] },
    { limit: 5 }
);

same("a channel whose every source failed sinks", rails[0].name, "Unasked");
check("but is still offered rather than hidden", rails.length === 2);

/*
    AND IT SINKS ON EVERY LIST, not only the rails.

    The country page took the index's own order, which is fixed at build
    time and therefore predates the sweep -- so BBC One sat second in the
    United Kingdom while the rails had already sunk it. A channel that
    sinks on one page and leads another reads as a bug in whichever page
    you are looking at.
*/
same(
    "search puts the working one first when the term does not decide",
    proofOf({ ...many, name: "Dead" }) < proofOf(channel("Alive")),
    true
);

/* ---- search ------------------------------------------------------------ */

same("one letter is not a search", (await searchChannels("b")).length, 0);

console.log(`PASSED: ${checks} live-channel checks`);
