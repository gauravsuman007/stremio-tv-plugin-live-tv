/**
 * A host's record, and the one place evidence is allowed to remove a
 * channel rather than reorder it.
 *
 * WHY A REAL SERVER AND NOT A STUB. Both things under test are read off
 * the check stores, and the stores are only ever written by `verify` and
 * `deepVerify` actually asking. A stub that wrote them directly would test
 * the sort and leave the interesting half -- which answers land in which
 * store -- unexercised, and that half is where the bugs are: a host that
 * serves a perfectly good master playlist whose segments 404 is the exact
 * failure this whole mechanism exists to catch, and it cannot be
 * expressed at all without a server willing to lie.
 *
 * Two hostnames for one address, because the record is keyed by hostname
 * and the point is that two mirrors on the same machine are judged apart
 * when they behave apart.
 */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { verify, deepVerify, reputationOf, disappointing, deepEnough, select, rankStreams, known, deeplyKnown } =
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

/* ---- an origin that is dependable on one path and hollow on another ----- */

const SEGMENT = Buffer.alloc(32 * 1024, 7);

const origin = createServer((request, response) => {
    const path = request.url;

    /*
        One path on the hollow host DOES deliver, so that "this host mostly
        disappoints" and "this mirror disappoints" stay separable below.
    */
    const hollow = path.startsWith("/bad") && !path.startsWith("/bad5");

    if (path.endsWith(".ts")) {
        // THE HOLLOW HOST. Its playlists are flawless; its video is gone.
        if (hollow) {
            response.writeHead(404, { "content-type": "text/plain" });
            response.end("gone");
            return;
        }

        response.writeHead(200, { "content-type": "video/mp2t" });
        response.end(SEGMENT);
        return;
    }

    const body = path.endsWith("/r.m3u8")
        ? `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\ns.ts\n`
        : `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n${path.replace(/\.m3u8$/, "")}/r.m3u8\n`;

    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    response.end(body);
});

origin.listen(0, "127.0.0.1");
await new Promise((done) => origin.once("listening", done));

const port = origin.address().port;

/** A mirror, dressed as the index dresses one. */
function mirror(url) {
    return { url, quality: "1080p", labels: [], referrer: "", userAgent: "" };
}

const dependable = [];
const hollow = [];

for (let n = 0; n < 6; n += 1) {
    dependable.push(mirror(`http://127.0.0.1:${port}/good${n}.m3u8`));
    hollow.push(mirror(`http://localhost:${port}/bad${n}.m3u8`));
}

/*
    And one mirror that is asked the cheap question and never the expensive
    one -- a source the deep pass has not got to yet, which on any real
    night is a great many of them.
*/
const unreached = mirror(`http://127.0.0.1:${port}/good9.m3u8`);

await verify(unreached);

/* ---- ask, for real ----------------------------------------------------- */

for (const stream of [...dependable, ...hollow]) {
    await verify(stream);
    await deepVerify(stream);
}

origin.close();

/*
    BOTH HOSTS PASS THE SHALLOW CHECK. That is the entire problem: the
    cheap test that can be run against fifteen thousand sources in a night
    cannot tell these two apart, and it is the one the rails were ordered
    on.
*/
same("the dependable host serves a playlist", known(dependable[0].url), true);
same("and so does the hollow one", known(hollow[0].url), true);

same("but only one of them yields video", deeplyKnown(dependable[0].url), true);
same("the other's segments are gone", deeplyKnown(hollow[0].url), false);

/* ---- what the record is worth ------------------------------------------ */

same("a host that delivers is worth leading with", reputationOf(dependable[0].url), 2);
same("a host that never does is worth avoiding", reputationOf(hollow[0].url), 0);
same("and a host nobody has a record for sits between them", reputationOf("http://nowhere.example/x.m3u8"), 1);

/*
    THE TIEBREAK THIS EXISTS FOR. Neither of these two has been asked
    about, so the per-URL store says nothing about either and the sort used
    to fall through to the alphabet -- which put the hollow host first,
    since "localhost" precedes "127" nowhere but happens to here by the
    quality claim. What decides now is the company each keeps.
*/
const fresh = {
    streams: [
        { ...mirror(`http://localhost:${port}/fresh.m3u8`), quality: "1080p" },
        { ...mirror(`http://127.0.0.1:${port}/fresh.m3u8`), quality: "1080p" }
    ]
};

check(
    "an unasked mirror on a host that delivers leads one on a host that does not",
    rankStreams(fresh)[0].url.includes("127.0.0.1")
);

/*
    AND IT IS ONLY A TIEBREAK. `/bad5` sits on the host with the worst
    record on the server and was itself followed all the way to video;
    `/fresh` sits on the spotless host and has never been asked about.
    The one we know about wins, because measurement of the thing beats
    measurement of its neighbours -- and getting this the wrong way round
    would let one bad night on a CDN bury the mirror that actually plays.
*/
same("the proven mirror is on the host with the poor record", reputationOf(hollow[5].url), 0);

const proven = { streams: [mirror(`http://127.0.0.1:${port}/fresh.m3u8`), hollow[5]] };

check(
    "a host's record never outranks an answer about the mirror itself",
    rankStreams(proven)[0].url.includes("/bad5")
);

/* ---- the channel that will only disappoint ----------------------------- */

const works = { name: "Works", country: "IN", categories: [], languages: [], score: 10, streams: dependable };
const empty = { name: "Empty", country: "IN", categories: [], languages: [], score: 900, streams: hollow.slice(0, 5) };
const unasked = {
    name: "Unasked",
    country: "IN",
    categories: [],
    languages: [],
    score: 500,
    streams: [mirror("http://nobody.example/x.m3u8")]
};

same("a channel with a mirror that played is not disappointing", disappointing(works), false);
same("a channel every one of whose live mirrors was followed and gave nothing is", disappointing(empty), true);
same("and a channel nobody has asked about never is", disappointing(unasked), false);

/*
    A channel with FOUR live mirrors of which the sweep reached one is not
    evidence of anything. Hiding it would turn "the deep pass ran out of
    time" into "this channel does not exist" -- which is the same class of
    silent wrong answer as the stale playlist, told about a whole channel.
*/
const partly = { ...empty, name: "Partly", streams: [...hollow.slice(0, 5), unreached] };

same("that mirror answered the cheap question", known(unreached.url), true);
same("and was never asked the expensive one", deeplyKnown(unreached.url), null);
same("so the channel carrying it is left alone", disappointing(partly), false);

/* ---- and the rail ------------------------------------------------------ */

same("the store has seen enough of the index to be allowed to hide", deepEnough(), true);

const rail = select({ all: [empty, works] }, { limit: 5 });

same("the hollow channel comes off the rail, despite the better score", rail.length, 1);
same("and the one that plays is what is left", rail[0].name, "Works");

/*
    A RAIL THAT WOULD COME UP EMPTY KEEPS WHAT IT HAD. A blank row reads as
    a bug in the page; an imperfect row reads as the state of live TV.
*/
const bare = select({ all: [empty] }, { limit: 5 });

same("a rail with nothing left over is not emptied", bare.length, 1);
same("it keeps what it had", bare[0].name, "Empty");

console.log(`PASSED: ${checks} host-record and rail checks`);
