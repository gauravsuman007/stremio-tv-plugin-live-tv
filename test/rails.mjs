/*
    ARRANGING THE LIVE RAILS.

    The properties that matter are not about markup, they are about what
    survives: an arrangement made today must still make sense when the
    index invents a rail tomorrow, and it must never be able to hide one
    it has never heard of. Both are asserted here.
*/
import assert from "node:assert";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { arrange, moved, visibleRails, railsPage } = await import("../dist/pages/rails.js");
const { livePage } = await import("../dist/pages/tv.js");

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

const slot = (id, count = 5) => ({ id, heading: id.toUpperCase(), count });
const SLOTS = [slot("fav"), slot("recent"), slot("country:IN"), slot("theme:news"), slot("places")];
const ids = (list) => list.map((entry) => entry.id);
const PLAIN = { order: [], off: [] };

/* ---- nothing said ------------------------------------------------- */
assert.deepStrictEqual(ids(arrange(SLOTS, PLAIN)), ids(SLOTS));
checks += 1;
assert.deepStrictEqual(ids(visibleRails(SLOTS, PLAIN)), ids(SLOTS));
checks += 1;

/* ---- moving -------------------------------------------------------- */
const up = moved(SLOTS, PLAIN, "theme:news", -1);
assert.deepStrictEqual(up, ["fav", "recent", "theme:news", "country:IN", "places"]);
checks += 1;
ok(moved(SLOTS, PLAIN, "fav", -1)[0] === "fav", "the top rail cannot go above the top");
ok(moved(SLOTS, PLAIN, "places", 1).at(-1) === "places", "nor the bottom one below the bottom");
ok(moved(SLOTS, PLAIN, "nope:1", -1).length === SLOTS.length, "a rail that is not there moves nothing");

/* ---- an arrangement outlives the index changing its mind ----------- */
const said = { order: up, off: [] };
// Where liveSlots would put it: with the computed rails, above the wall.
const later = [...SLOTS.slice(0, 4), slot("kids:hin"), slot("places")];
const withNew = ids(arrange(later, said));

ok(withNew.includes("kids:hin"), "a rail invented after the arrangement still appears");
ok(
    withNew.indexOf("kids:hin") === withNew.indexOf("theme:news") + 1,
    "and it follows the rail it naturally follows, wherever that one was moved to"
);
ok(withNew.at(-1) === "places", "rather than being appended under everything");
assert.deepStrictEqual(
    withNew.filter((id) => id !== "kids:hin"),
    up
);
checks += 1;

const gone = ids(arrange([slot("fav"), slot("places")], said));
assert.deepStrictEqual(gone, ["fav", "places"]);
checks += 1;

/* ---- hiding -------------------------------------------------------- */
const hidden = { order: up, off: ["theme:news"] };

ok(!ids(visibleRails(SLOTS, hidden)).includes("theme:news"), "a hidden rail is not drawn");
ok(ids(arrange(SLOTS, hidden)).includes("theme:news"), "but the arranging page still lists it");
ok(
    ids(visibleRails(later, hidden)).includes("kids:hin"),
    "hiding one rail never hides a rail nobody has heard of"
);

/* ---- the page itself ------------------------------------------------ */
const client = { link: (path) => `/s/abc${path}` };
const markup = railsPage(client, true, SLOTS, hidden, false);

ok(markup.includes("Hidden"), "a hidden rail says so");
ok(/href="[^"]*\/tv\/rails\?up=fav"/.test(markup) === false, "the top rail has no Up link");
ok(/href="[^"]*\/tv\/rails\?down=places"/.test(markup) === false, "the bottom rail has no Down link");
ok(/href="[^"]*\/tv\/rails\?show=theme%3Anews"/.test(markup), "a hidden rail offers Show");
ok(/href="[^"]*\/tv\/rails\?hide=fav"/.test(markup), "a shown one offers Hide");
ok(/\?reset=1/.test(markup), "and an arrangement can be dropped");
ok(!/\?reset=1/.test(railsPage(client, true, SLOTS, PLAIN, true)), "which is not offered when there is none");

/* ---- the live page obeys it ---------------------------------------- */
const CHANNEL = { id: "iptv:One.in", name: "One", logo: "", streams: [], categories: [], labels: [] };
const draw = (show) =>
    livePage(
        client,
        true,
        [
            { id: "country:IN", heading: "Top channels in India", by: "b", channels: [CHANNEL] },
            { id: "theme:news", heading: "News", by: "b", channels: [CHANNEL] }
        ],
        [{ id: "iptv:Two.in", name: "Two", logo: "", when: Date.now() }],
        [],
        [],
        null,
        [],
        false,
        { running: false, at: 0, tried: 0, found: 0 },
        "",
        show
    );

const natural = draw([]);
ok(natural.indexOf("Recently watched") < natural.indexOf("News"), "with nothing said the page is as built");

const asked = draw(["theme:news", "recent"]);
ok(asked.indexOf("News") < asked.indexOf("Recently watched"), "and as asked when something is");
ok(!asked.includes("Top channels in India"), "a rail left out of the order is not drawn");

console.log(`PASSED: ${checks} rail-arrangement checks`);
