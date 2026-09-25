/**
 * Live TV: where the channels come from, and why they do not come from an
 * addon.
 *
 * WHAT WENT WRONG WITH THE ADDON
 * ------------------------------
 * An IPTV addon hands over a list and a `url` per channel and says nothing
 * about whether that URL is alive. Most public lists are assembled from
 * whatever was reachable on the day they were written, and a third of the
 * entries in a year-old one answer 403 or nothing at all -- which is
 * precisely what was reported here: the first few channels opened and
 * offered no source to play from.
 *
 * Reconfiguring the addon does not fix that, because the addon is not the
 * part that is wrong. The list is. So this module keeps its own index, and
 * -- the part that actually matters -- **nothing is offered as playable
 * until it has been asked**. See `verify`.
 *
 * WHY iptv-org
 * ------------
 * It is the one public list that is curated rather than scraped: dead
 * entries are removed by automated checks and by people, channels are keyed
 * to a stable id rather than to whatever the playlist called them that
 * week, and the metadata this page needs -- country, category, language,
 * logo -- is published alongside as plain JSON with no key and no account.
 * A channel there frequently has SEVERAL stream URLs from different
 * mirrors, which is what makes "play the best one" a real choice rather
 * than a hopeful one.
 *
 * Addon channels are not replaced by any of this. An installed live-TV
 * addon still answers for its own ids through the ordinary path, and its
 * catalogues still appear on Browse. This is an additional source, and the
 * only one the Live TV page can rank, group by country and search, because
 * it is the only one whose whole index is here.
 *
 * WHAT "POPULAR" MEANS HERE, SAID PLAINLY
 * ---------------------------------------
 * Nobody publishes audience figures for these. What is published is how
 * many independent mirrors carry a channel, what it is about, whether it
 * has a real logo, a website and a named network -- and a channel that
 * fifteen different people went to the trouble of carrying is, in practice,
 * one people want. That is the whole of the signal, plus a weighting per
 * category and a list of names that are majors in their own market.
 *
 * It is a proxy and it is described as one everywhere it is shown. It is
 * not a ratings table and must never be dressed up as one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { pluginConfig as config } from "./plugin-config.js";
import { host } from "./host.js";
import { allScrapers, recordRun, scraperEnabled } from "./scrapers.js";
const fetchVia = (url, options) => host.fetchVia(url, options);
/** A rail's local slug, as a scraper may name it -- see `ScrapedRail.id`. */
const RAIL_SLUG = /^[a-z0-9-]{1,40}$/;
/** How long an index is used before it is fetched again. */
const INDEX_TTL_MS = 12 * 60 * 60 * 1000;
/** Our own id space, so a channel from here can never collide with an
 *  addon's. Everything below round-trips through `/detail/tv/<id>`.
 *  Historical name -- it now means "this id belongs to the live-TV
 *  surface", not literally iptv-org, see `LIVE_PREFIX`. */
export const PREFIX = "iptv:";
/** The id space every scraper OTHER than the built-in iptv-org one must
 *  use, as `live:<scraper id>:<whatever that scraper calls it>`. Two
 *  prefixes rather than one because the iptv-org scraper's ids predate the
 *  plugin system and already sit in favourites and watch-progress on a
 *  running deployment -- see `src/scrapers/iptv-org.ts`. */
export const LIVE_PREFIX = "live:";
/*
    HOW MUCH A CATEGORY IS WORTH.

    Not a judgement about what is worth watching. It is a correction for a
    bias in the source: channels that are free to redistribute are massively
    over-mirrored relative to how much anyone watches them, and mirror count
    is the main signal here. Without this the top of India's list is a
    religious broadcaster with seventeen mirrors, above every news channel
    in the country.
*/
const CATEGORY_WEIGHT = {
    general: 30,
    entertainment: 26,
    news: 24,
    sports: 24,
    movies: 22,
    kids: 18,
    series: 14,
    music: 14,
    documentary: 10,
    comedy: 8,
    animation: 8,
    family: 8,
    lifestyle: 8,
    business: 6,
    cooking: 4,
    travel: 4,
    culture: 4,
    science: 4,
    education: 2,
    weather: 0,
    auto: 0,
    classic: 0,
    public: 0,
    outdoor: -6,
    relax: -8,
    interactive: -20,
    religious: -20,
    legislative: -24,
    shop: -30,
    xxx: -1000
};
/*
    Names that are majors in their own market.

    Short, because every entry is a maintenance burden and a thing to be
    wrong about. It only has to lift the handful of channels everybody in a
    market would name, above the long tail of small ones that happen to be
    well mirrored -- the ordering below them is the composite's job.

    Matched within a country's own list, so a Nigerian "StarCross" is never
    competing with India's Star.
*/
const MAJOR = /^(bbc|itv|channel [45]|sky|cnn|cnbc|msnbc|nbc|cbs|abc|fox|pbs|cbc|bloomberg|euronews|al jazeera|france 24|dw|trt|nhk|rt |cgtn|star|colors|zee|sony|set |ndtv|aaj tak|india today|republic|times now|news18|abp|dd |doordarshan|sun |asianet|maa |gemini|udaya|discovery|national geographic|nat geo|history|cartoon network|nickelodeon|disney|mtv|axn|amc|tnt|tlc)\b/i;
/** The composite, exported so its two corrections can be tested. */
export function scoreOf(mirrors, categories, name, logo = "", website = "", network = "") {
    /*
        HOW WIDELY IT IS CARRIED -- counting only what is carried TO HERE.

        Diminishing, not linear: the step from one mirror to four says
        something, the step from twenty to twenty-four says only that a
        channel is easy to rebroadcast.

        And a geo-blocked mirror barely counts. This number is standing in
        for "how available is this channel", and a mirror that answers
        nothing outside its own country is not availability -- BBC One has
        FIFTY mirrors, forty-eight of them the BBC's own geo-fenced edges,
        and scoring it on fifty put the one channel in the UK rail that
        cannot play at the front of it. Quarter weight rather than zero,
        because a household routing live TV through a UK exit node gets
        exactly those mirrors and nothing else.
    */
    const warned = mirrors.filter((mirror) => mirror.labels.length > 0).length;
    const clear = mirrors.length - warned;
    const carried = Math.round(Math.sqrt(clear + warned * 0.25) * 34);
    const about = categories.reduce((worst, category) => Math.min(worst, CATEGORY_WEIGHT[category] ?? 0), categories.length ? 30 : 0);
    return (carried +
        about +
        (MAJOR.test(name) ? 120 : 0) +
        (logo ? 10 : 0) +
        (website ? 6 : 0) +
        (network ? 10 : 0));
}
let index = null;
let loading = null;
/** A scraper's own id, valid on its own terms -- see `LIVE_PREFIX` and the
 *  iptv-org exception to it. */
function ownId(scraperId, id) {
    return scraperId === "iptv-org" ? id.startsWith(PREFIX) : id.startsWith(`${LIVE_PREFIX}${scraperId}:`);
}
/*
    A dropped-in or GitHub-imported scraper is somebody else's code, doing
    its own network fetching entirely outside this repo -- if its `build()`
    never resolves (an upstream host that accepts a connection and then says
    nothing, a fetch with no timeout of its own), `await`ing it here would
    hang this whole rebuild forever, and every page that waits on the
    channel index (chiefly `/tv`) with it. One scraper's bug must not be
    able to spin the Live TV page's loading circle for good.
*/
const SCRAPER_BUILD_TIMEOUT_MS = 45_000;
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (cause) => {
            clearTimeout(timer);
            reject(cause);
        });
    });
}
async function fromScraper(byId, flagOf, rails) {
    let added = 0;
    for (const scraper of allScrapers()) {
        if (!scraperEnabled(scraper.id))
            continue;
        let raw;
        try {
            raw = await withTimeout(scraper.build(), SCRAPER_BUILD_TIMEOUT_MS, `scraper "${scraper.id}"`);
        }
        catch (cause) {
            console.error(`stremio-tv: scraper "${scraper.id}" failed`, cause);
            recordRun(scraper.id, { at: Date.now(), ok: false, channels: 0, error: String(cause) });
            continue;
        }
        let kept = 0;
        const mine = new Set();
        for (const channel of raw.channels) {
            // A scraper that returns a stray id or an empty channel is a
            // bug in that scraper, not something the whole index should
            // fail over -- the bad entry is dropped and the rest kept.
            if (!channel.streams.length)
                continue;
            if (!ownId(scraper.id, channel.id)) {
                console.error(`stremio-tv: scraper "${scraper.id}" produced an id outside its namespace, dropped: ${channel.id}`);
                continue;
            }
            if (byId.has(channel.id)) {
                console.error(`stremio-tv: duplicate live channel id, kept the first: ${channel.id}`);
                continue;
            }
            const built = {
                id: channel.id,
                name: channel.name,
                country: channel.country,
                countryName: channel.countryName || channel.country,
                categories: channel.categories,
                languages: channel.languages,
                logo: channel.logo,
                website: channel.website,
                network: channel.network,
                streams: channel.streams,
                score: 0
            };
            built.score = scoreOf(built.streams, built.categories, built.name, built.logo, built.website, built.network);
            byId.set(built.id, built);
            mine.add(built.id);
            if (channel.countryFlag)
                flagOf.set(built.id, channel.countryFlag);
            kept += 1;
        }
        /*
            A RAIL IS AN OPINION ABOUT THIS SCRAPER'S OWN CHANNELS, NEVER A
            WAY TO REACH INTO SOMEBODY ELSE'S.

            `channelIds` is filtered against `mine` -- the ids this exact
            call just contributed, after streams-empty and namespace and
            duplicate filtering -- not against the final index, which is
            still being assembled and could still change from a later
            scraper. An id that did not survive is dropped silently; an id
            that was never this scraper's is dropped with a log line, the
            same posture as a stray channel id.
        */
        for (const rail of raw.rails || []) {
            if (!RAIL_SLUG.test(rail.id)) {
                console.error(`stremio-tv: scraper "${scraper.id}" gave a rail an unusable id, dropped: ${rail.id}`);
                continue;
            }
            const channelIds = rail.channelIds.filter((id) => {
                if (mine.has(id))
                    return true;
                console.error(`stremio-tv: scraper "${scraper.id}"'s rail "${rail.id}" named a channel it did not itself return, dropped: ${id}`);
                return false;
            });
            if (!channelIds.length)
                continue;
            rails.push({
                id: `rail:${scraper.id}-${rail.id}`,
                heading: rail.heading,
                by: `From ${scraper.name}`,
                channelIds
            });
        }
        added += kept;
        recordRun(scraper.id, { at: Date.now(), ok: true, channels: kept, error: "" });
    }
    return added;
}
async function build() {
    try {
        const byId = new Map();
        const flagOf = new Map();
        const rails = [];
        await fromScraper(byId, flagOf, rails);
        if (!byId.size)
            return null;
        const byCountry = new Map();
        for (const channel of byId.values()) {
            const bucket = byCountry.get(channel.country) || [];
            bucket.push(channel);
            byCountry.set(channel.country, bucket);
        }
        for (const bucket of byCountry.values())
            bucket.sort(better);
        const countries = [...byCountry.entries()]
            .filter(([code]) => code)
            .map(([code, bucket]) => ({
            code,
            name: bucket[0]?.countryName || code,
            flag: bucket.map((channel) => flagOf.get(channel.id) || "").find(Boolean) || "",
            channels: bucket.length
        }))
            .sort((a, b) => b.channels - a.channels || a.name.localeCompare(b.name));
        const all = [...byId.values()].sort(better);
        console.log(`stremio-tv: live index -- ${all.length} channels across ${countries.length} countries`);
        return { at: Date.now(), byId, byCountry, countries, all, rails };
    }
    catch (cause) {
        console.error("stremio-tv: could not build the live index", cause);
        return null;
    }
}
/**
 * Best first, and TOTAL, for the same reason the stream list is: a rail
 * whose order is not stable repoints every card on it between one page and
 * the next.
 */
function better(a, b) {
    return b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
/**
 * The index, fetched if it is missing or stale.
 *
 * A failed fetch keeps the OLD index rather than emptying the page: a list
 * that is twelve hours out of date is a working Live TV page, and no list
 * is a blank one.
 */
export async function channelIndex() {
    if (index && Date.now() - index.at < INDEX_TTL_MS)
        return index;
    if (!loading) {
        loading = build().then((built) => {
            if (built)
                index = built;
            loading = null;
            return index;
        });
    }
    return index || loading;
}
/** Drop the index, so the next page rebuilds it. For the tests. */
export function forgetChannels() {
    index = null;
}
export function isChannelId(id) {
    return id.startsWith(PREFIX) || id.startsWith(LIVE_PREFIX);
}
export async function findChannel(id) {
    const built = await channelIndex();
    return built?.byId.get(id) || null;
}
/*
    ===================================================================
    WHAT ANSWERED, AND WHEN
    ===================================================================

    One store, two readers, and they want different things from it.

    PLAYBACK wants freshness. Live URLs come and go through the day, so an
    answer from last night is a hint and not a fact: anything older than a
    few minutes is asked again before a channel is started on it.

    THE RANKING wants coverage. It is deciding which of ten thousand
    channels to put on a rail, it cannot ask anything, and last night's
    answer is overwhelmingly better than no answer -- a channel that was
    serving at three in the morning is a channel worth offering, and one
    whose fifty mirrors were all silent is not, whatever its logo looks
    like.

    So entries are kept with their timestamp and never expired. `fresh`
    answers the first reader, `known` the second.
*/
const GOOD_MS = 10 * 60 * 1000;
const BAD_MS = 4 * 60 * 1000;
const checks = new Map();
/*
    AND THE ANSWERS THAT WENT ALL THE WAY TO VIDEO.

    A separate store because it answers a different question. `checks` says
    "this URL served a playlist", which is what can be asked of seventeen
    thousand sources in one night and is enough to order a rail. It is not
    enough to promise a channel will play: a playlist is a text file, and
    an edge that serves a stale one whose segments 404 answers `verify`
    with a confident yes and the television with nothing at all. That is
    exactly the failure that gets reported as "it said it worked".

    Proving the rest costs a real segment. Measured, that is 2.92 requests
    and about 18KB per source, which is why it IS done to the whole index
    every night rather than only to favourites. See `deepVerify`.
*/
const deep = new Map();
/** The last deep answer for this URL whenever it was given, or null. */
export function deeplyKnown(url) {
    const held = deep.get(url);
    return held ? held.ok : null;
}
const codecs = new Map();
/** What this URL was last seen carrying, or null if nobody has looked. */
export function codecFor(url) {
    return codecs.get(url) || null;
}
/** How many sources have been looked at, for the page to say. */
export function codecCount() {
    return codecs.size;
}
/** Rebuilt from the deep store rather than maintained alongside it, so a
 *  restart cannot leave the two disagreeing. */
let records = null;
let recordsAt = 0;
/** How long a derived view of the stores is reused before rebuilding. */
const DERIVED_MS = 60 * 1000;
/** Sources a host must carry before its record says anything. Below this
 *  a single unlucky channel would condemn every mirror on the host. */
const RECORD_MIN = 5;
function hostRecords() {
    if (records && Date.now() - recordsAt < DERIVED_MS)
        return records;
    const built = new Map();
    for (const [url, held] of deep) {
        const host = hostOf(url);
        if (!host)
            continue;
        const seen = built.get(host) || { n: 0, ok: 0 };
        seen.n += 1;
        if (held.ok)
            seen.ok += 1;
        built.set(host, seen);
    }
    records = built;
    recordsAt = Date.now();
    return built;
}
/**
 * What this host's record is worth as a tiebreak: 2 dependable, 1 nothing
 * known either way, 0 a host that mostly disappoints.
 *
 * THREE BUCKETS AND NOT A RATIO, deliberately. A ratio would order mirrors
 * on the difference between 0.91 and 0.88, which is noise, and would make
 * the order of a channel's sources -- and therefore every link on its page
 * -- shift from one night to the next for no reason a viewer could see.
 */
export function reputationOf(url) {
    const seen = hostRecords().get(hostOf(url));
    if (!seen || seen.n < RECORD_MIN)
        return 1;
    const rate = seen.ok / seen.n;
    if (rate >= 0.8)
        return 2;
    return rate <= 0.4 ? 0 : 1;
}
let trusted = null;
/**
 * Whether the deep store has seen enough of the index to be allowed to
 * HIDE anything.
 *
 * THE GUARD MATTERS MORE THAN THE FILTER IT GUARDS. "No source of this
 * channel played video" and "nobody has got round to this channel yet" are
 * identical when read off an empty store, and on a cold install -- or in
 * the minutes after a deploy, before the store is restored -- that is every
 * channel in the index. Without this, the rails come up empty and the
 * surface looks broken in the one way it never was.
 *
 * Half of the sources that answered, because the deep pass only ever
 * follows those: it is never going to reach the ones that did not.
 */
export function deepEnough() {
    if (trusted && Date.now() - trusted.at < DERIVED_MS)
        return trusted.ok;
    let live = 0;
    for (const held of checks.values())
        if (held.ok)
            live += 1;
    const ok = live > 0 && deep.size * 2 >= live;
    trusted = { at: Date.now(), ok };
    return ok;
}
/**
 * What the store as a whole amounts to: how many answers are in it, how
 * many were yes, and when the newest was given.
 *
 * Derived rather than recorded, so it survives a restart without a second
 * thing to keep in step. The sweep's own in-process counters are gone
 * after a deploy, and a page that then said "no sources have been checked
 * yet" while ranking every rail on fifteen thousand answers would be
 * lying about the one thing that explains the ordering.
 */
export function checkSummary() {
    let at = 0;
    let found = 0;
    for (const held of checks.values()) {
        if (held.at > at)
            at = held.at;
        if (held.ok)
            found += 1;
    }
    return { at, tried: checks.size, found };
}
/** The last answer for this URL whenever it was given, or null. */
export function known(url) {
    const held = checks.get(url);
    return held ? held.ok : null;
}
function fresh(url) {
    const held = checks.get(url);
    if (!held)
        return null;
    return Date.now() - held.at < (held.ok ? GOOD_MS : BAD_MS) ? held.ok : null;
}
function remember(url, ok) {
    checks.set(url, { at: Date.now(), ok });
}
/*
    KEPT ON DISK, because the sweep is the expensive thing here and a
    restart must not throw it away: half an hour of somebody else's
    bandwidth, and a Live TV page that goes back to guessing until the next
    three in the morning.

    Written coalesced and renamed over, for the same reason the session
    store is: a half-written file here is not a lost answer, it is a file
    that fails to parse, which loses ALL of them.
*/
let pendingWrite = null;
export function saveChecks() {
    if (!config.liveChecks)
        return;
    try {
        mkdirSync(dirname(config.liveChecks), { recursive: true });
        const temporary = `${config.liveChecks}.tmp`;
        writeFileSync(temporary, JSON.stringify({
            v: 2,
            at: Date.now(),
            checks: [...checks],
            deep: [...deep],
            codecs: [...codecs]
        }), { mode: 0o600 });
        renameSync(temporary, config.liveChecks);
    }
    catch (cause) {
        console.error("stremio-tv: could not write the live-check store", cause);
    }
}
function scheduleSave() {
    if (!config.liveChecks || pendingWrite)
        return;
    pendingWrite = setTimeout(() => {
        pendingWrite = null;
        saveChecks();
    }, 30_000);
    pendingWrite.unref();
}
export function loadChecks() {
    if (!config.liveChecks)
        return;
    try {
        const parsed = JSON.parse(readFileSync(config.liveChecks, "utf8"));
        for (const [url, held] of parsed.checks || []) {
            // Validated rather than trusted: this file outlives the code
            // that wrote it, and a malformed entry would decide a ranking.
            if (typeof url === "string" && held && typeof held.ok === "boolean") {
                checks.set(url, { at: Number(held.at) || 0, ok: held.ok });
            }
        }
        for (const [url, held] of parsed.deep || []) {
            if (typeof url === "string" && held && typeof held.ok === "boolean") {
                deep.set(url, { at: Number(held.at) || 0, ok: held.ok });
            }
        }
        for (const [url, held] of parsed.codecs || []) {
            // A v1 store has none of these, which is not an error: the
            // sweep fills them in over the following nights.
            /*
                A fact written before `audioFirst` existed is not read
                back. It cannot be defaulted either way honestly -- false
                sends a channel through ffmpeg that does not need it, true
                hands over a silent one -- so the URL is simply left
                unprobed and the next play asks again.
            */
            if (typeof url === "string" && held && typeof held.video === "string" && typeof held.audioFirst === "boolean") {
                codecs.set(url, {
                    at: Number(held.at) || 0,
                    video: held.video,
                    audio: typeof held.audio === "string" ? held.audio : "",
                    width: Number(held.width) || 0,
                    height: Number(held.height) || 0,
                    /* Absent in a store written before these were recorded.
                       "" is honest -- nobody looked -- and reads as "not
                       proven progressive", which is the safe side. */
                    fields: typeof held.fields === "string" ? held.fields : "",
                    audioIndex: Number.isInteger(held.audioIndex) ? Number(held.audioIndex) : -1,
                    audioFirst: held.audioFirst
                });
            }
        }
        /*
            COUNTED, not sized. This said `deep.size`, which is every
            source that has been FOLLOWED -- failures included -- under a
            label that claimed they had all played. It read 9,883 proven
            on a night when 8,532 played, which is precisely the kind of
            confident overstatement this whole mechanism exists to stop.
        */
        let played = 0;
        for (const held of deep.values())
            if (held.ok)
                played += 1;
        console.log(`stremio-tv: ${checks.size} live-source answers restored` +
            (deep.size ? `, ${played} of ${deep.size} followed through to video` : "") +
            (codecs.size ? `, ${codecs.size} with the codec known` : ""));
    }
    catch {
        // No file yet is the ordinary first-run case, not a fault.
    }
}
/**
 * Whether this URL is actually serving a playlist right now.
 *
 * THE POINT OF THE WHOLE MODULE. A public IPTV list is a list of URLs that
 * worked once; asking is the only way to know which of them work now.
 *
 * FETCHED THE WAY PLAYBACK WILL FETCH IT. If live TV is routed through the
 * tunnel then that is the path the video takes, and a mirror checked
 * directly answers a different question from the one being asked -- which
 * is not a small difference: geo-fenced mirrors are exactly the ones that
 * fail one way and work the other, and they are most of what the switch is
 * for. So the proxy is passed in by the caller, which knows the state of
 * the tunnel, and is used here.
 */
export async function verify(stream, proxy = "") {
    const already = fresh(stream.url);
    if (already !== null)
        return already;
    let ok = false;
    try {
        const upstream = await fetchVia(stream.url, {
            proxy,
            headers: {
                "user-agent": stream.userAgent || "VLC/3.0.20 LibVLC/3.0.20",
                ...(stream.referrer ? { referer: stream.referrer } : {})
            },
            timeoutMs: CHECK_MS
        });
        if (upstream.status < 400) {
            const body = await head(upstream.body);
            /*
                A 200 is not enough and never was. A dead IPTV host answers
                200 with an HTML holding page, and an addon that trusted the
                status handed the television a web page to decode. The
                format's own first line is the test.
            */
            ok = body.trimStart().startsWith("#EXTM3U");
        }
        else {
            upstream.body.resume();
        }
    }
    catch {
        ok = false;
    }
    remember(stream.url, ok);
    scheduleSave();
    return ok;
}
/** How long one check may take. A dead host's answer is silence. */
const CHECK_MS = 6000;
/** The first few kilobytes, then hang up. A playlist declares itself on
 *  its first line and a segment stream would never end. */
function head(body) {
    return new Promise((resolve) => {
        let text = "";
        body.on("data", (chunk) => {
            text += chunk.toString("utf8");
            if (text.length > 4096) {
                body.destroy();
                resolve(text);
            }
        });
        body.on("end", () => resolve(text));
        body.on("error", () => resolve(text));
    });
}
/*
    ===================================================================
    PROVING A SOURCE ALL THE WAY TO VIDEO
    ===================================================================

    WHY A SECOND, DEEPER CHECK EXISTS AT ALL

    `verify` asks one question -- "does this URL serve a playlist" -- and
    it is the right question to ask seventeen thousand times, because the
    answer costs a few kilobytes and arrives in six seconds.

    But a playlist is a TEXT FILE, and the ways a channel can be dead
    behind a perfectly good one are ordinary rather than exotic:

      * the segments 404 while the playlist that lists them is cached at
        the edge and served for weeks;
      * the playlist is a master listing variants that are all gone;
      * the segment server geo-fences and the playlist server does not,
        so the table of contents arrives and the book does not;
      * the key URI is dead, which plays exactly zero encrypted seconds.

    All four answer `verify` with a confident yes. All four are what
    somebody means when they say the nightly job called it playable and it
    did not play.

    WHAT IT ACTUALLY COSTS, MEASURED

    This was first built for a curated list on the assumption that a
    segment is hundreds of kilobytes and the whole index would be tens of
    gigabytes a night. That was wrong by two orders of magnitude, and
    wrong in the direction that mattered: the read aborts at 16 KB, so a
    deep check costs 2.92 requests and 18 KB.

    Sampled across the whole index rather than its head: 60 sources, 18 KB
    each, 0.33 s each at a concurrency of six. Over the 10,782 sources the
    shallow sweep finds alive that is about 194 MB and roughly a quarter
    of an hour -- which is affordable every night, so it is done every
    night, for everything.

    The sample also settled why it is worth doing: 38 of those 60 played.
    Nearly two in five sources that pass the shallow check do not actually
    deliver video, which is far too many to leave unmeasured on a page
    that orders itself by what works.
*/
/** How long the deep check may take in total. Three hops, so three times. */
const DEEP_MS = 9000;
/** Enough bytes to be a piece of video and not an error page. */
const SEGMENT_BYTES = 16 * 1024;
/** How many of a master's renditions are tried before giving up on it. */
const VARIANTS = 4;
/**
 * The URIs in a playlist, split by what they are.
 *
 * A master playlist lists VARIANTS (each another playlist); a media
 * playlist lists SEGMENTS (actual video). The tag on the line before
 * decides which, and one file only ever holds one kind.
 */
function urisIn(text, base) {
    const variants = [];
    const segments = [];
    let next = false;
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line)
            continue;
        if (line.startsWith("#")) {
            if (line.startsWith("#EXT-X-STREAM-INF"))
                next = true;
            continue;
        }
        try {
            (next ? variants : segments).push(new URL(line, base).href);
        }
        catch {
            /* Not a URL. Skipped rather than failing the whole playlist. */
        }
        next = false;
    }
    return { variants, segments };
}
/** GET a few bytes and say how many arrived, and what they looked like. */
async function taste(url, stream, proxy, want, keep = false) {
    const upstream = await fetchVia(url, {
        proxy,
        headers: {
            "user-agent": stream.userAgent || "VLC/3.0.20 LibVLC/3.0.20",
            ...(stream.referrer ? { referer: stream.referrer } : {})
        },
        timeoutMs: DEEP_MS
    });
    if (upstream.status >= 400) {
        upstream.body.resume();
        return { status: upstream.status, text: "", bytes: 0, data: Buffer.alloc(0) };
    }
    return new Promise((resolve) => {
        let bytes = 0;
        let text = "";
        /*
            The bytes themselves are kept only when somebody asked for
            enough of them to be worth keeping -- the codec probe wants a
            couple of hundred kilobytes, and the ordinary deep check wants
            sixteen and would rather not hold them.
        */
        const chunks = [];
        const done = () => resolve({ status: upstream.status, text, bytes, data: Buffer.concat(chunks) });
        upstream.body.on("data", (chunk) => {
            bytes += chunk.length;
            if (keep)
                chunks.push(chunk);
            // Only the head is kept as text: a playlist declares itself in
            // its first line, and a segment is not text at all.
            if (text.length < 8192)
                text += chunk.toString("utf8");
            if (bytes >= want) {
                upstream.body.destroy();
                done();
            }
        });
        upstream.body.on("end", done);
        upstream.body.on("error", done);
    });
}
/*
    HOW MUCH OF A SEGMENT IT TAKES TO NAME THE CODEC.

    Measured, not guessed, on the sources that caused this: at 16KB --
    what the deep check already reads -- ffprobe called NBC "mp3", having
    found an audio packet and no video one yet, which as a basis for
    demoting a mirror is worse than knowing nothing. At 64KB it said
    "unknown". At 192KB it said h264 1920x1080, and MPEG-2 sources were
    named correctly at every size. So 192KB, and the probe is budgeted
    (see `sweep.ts`) rather than run over the whole index.
*/
const PROBE_BYTES = 192 * 1024;
/** Long enough for ffprobe to parse a fifth of a megabyte, no longer. */
const PROBE_MS = 20_000;
/**
 * Ask ffprobe what a buffer of transport stream actually contains.
 *
 * Down a pipe rather than through a temporary file: this runs thousands
 * of times a night, and a nightly sweep that leaves files behind when it
 * is killed mid-write is a disk that fills up in a month.
 */
function askFfprobe(data) {
    return new Promise((resolve) => {
        let out = "";
        let settled = false;
        const child = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=index,codec_name,codec_type,width,height,field_order",
            "-of", "json",
            "-i", "pipe:0"
        ]);
        const finish = (fact) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* Already gone, which is the outcome either way. */
            }
            resolve(fact);
        };
        const timer = setTimeout(() => finish(null), PROBE_MS);
        timer.unref();
        child.stdout.on("data", (chunk) => {
            if (out.length < 64 * 1024)
                out += chunk.toString("utf8");
        });
        child.stderr.resume();
        /*
            ffprobe hangs up as soon as it has enough, and a write to a
            closed pipe is an EPIPE that would take the process down.
        */
        child.stdin.on("error", () => undefined);
        child.on("error", () => finish(null));
        child.on("close", () => {
            try {
                const parsed = JSON.parse(out);
                const found = parsed.streams || [];
                const video = found.find((entry) => entry.codec_type === "video");
                const sound = found.filter((entry) => entry.codec_type === "audio");
                /* AAC wherever there is one: see `audioIndex`. */
                const audio = sound.find((entry) => entry.codec_name === "aac") || sound[0];
                const audioFirst = !audio || !sound[0] || audio.index === sound[0].index;
                if (!video && !audio)
                    return finish(null);
                finish({
                    at: Date.now(),
                    video: String(video?.codec_name || ""),
                    audio: String(audio?.codec_name || ""),
                    width: Number(video?.width) || 0,
                    height: Number(video?.height) || 0,
                    fields: String(video?.field_order || ""),
                    audioIndex: Number.isInteger(audio?.index) ? Number(audio?.index) : -1,
                    audioFirst
                });
            }
            catch {
                finish(null);
            }
        });
        child.stdin.end(data);
    });
}
/**
 * Follow one source to a segment and name what is inside it.
 *
 * Only ever called on a source the deep check already proved, because
 * there is no point spending a fifth of a megabyte on a URL that does not
 * answer -- and because that keeps this an addition to the evidence
 * rather than a second, slower way of asking the same first question.
 */
export async function probeCodec(stream, proxy = "") {
    try {
        const top = await taste(stream.url, stream, proxy, 64 * 1024);
        if (top.status >= 400 || !top.text.trimStart().startsWith("#EXTM3U"))
            return null;
        const first = urisIn(top.text, stream.url);
        let list = null;
        if (first.variants.length === 0) {
            list = { url: stream.url, text: top.text };
        }
        else {
            for (const variant of first.variants.slice(0, VARIANTS)) {
                const inner = await taste(variant, stream, proxy, 64 * 1024);
                if (inner.status < 400 && inner.text.trimStart().startsWith("#EXTM3U")) {
                    list = { url: variant, text: inner.text };
                    break;
                }
            }
        }
        if (!list)
            return null;
        const segment = urisIn(list.text, list.url).segments[0];
        if (!segment)
            return null;
        const got = await taste(segment, stream, proxy, PROBE_BYTES, true);
        if (got.status >= 400 || got.bytes < 32 * 1024)
            return null;
        const fact = await askFfprobe(got.data);
        /*
            A probe that found nothing is not written down. ffprobe failing
            on a truncated read is a fact about the read, and recording it
            as "this source has no video" would demote a working mirror on
            the strength of this service's own impatience.
        */
        if (!fact || (!fact.video && !fact.audio))
            return null;
        codecs.set(stream.url, fact);
        scheduleSave();
        return fact;
    }
    catch {
        return null;
    }
}
/**
 * Follow one source from its playlist to a real segment of video.
 *
 * Returns true only when bytes of video actually arrived. Master playlists
 * are followed one level, which is as deep as live HLS goes.
 */
export async function deepVerify(stream, proxy = "") {
    let ok = false;
    try {
        const top = await taste(stream.url, stream, proxy, 64 * 1024);
        if (top.status < 400 && top.text.trimStart().startsWith("#EXTM3U")) {
            const first = urisIn(top.text, stream.url);
            const lists = [];
            if (first.variants.length === 0) {
                lists.push({ url: stream.url, text: top.text });
            }
            else {
                /*
                    MORE THAN ONE RENDITION IS TRIED, and that is not
                    thoroughness for its own sake. Measured on ABC News
                    Live 1: the master serves 200 with a dozen renditions
                    and the FIRST of them 404s. A player would simply move
                    to the next one, so failing the channel on that one
                    answer would be this check inventing a fault the
                    television does not have.
                */
                for (const variant of first.variants.slice(0, VARIANTS)) {
                    const inner = await taste(variant, stream, proxy, 64 * 1024);
                    if (inner.status < 400 && inner.text.trimStart().startsWith("#EXTM3U")) {
                        lists.push({ url: variant, text: inner.text });
                        break;
                    }
                }
            }
            for (const list of lists) {
                const segment = urisIn(list.text, list.url).segments[0];
                if (!segment)
                    continue;
                const got = await taste(segment, stream, proxy, SEGMENT_BYTES);
                /*
                    Bytes, and not an error page wearing a 200. An HLS
                    segment is MPEG-TS or fragmented MP4; neither begins
                    with a "<".
                */
                ok = got.status < 400 && got.bytes >= 1024 && !got.text.trimStart().startsWith("<");
                if (ok)
                    break;
            }
        }
    }
    catch {
        ok = false;
    }
    deep.set(stream.url, { at: Date.now(), ok });
    /*
        POSITIVE EVIDENCE ONLY, and this asymmetry is deliberate.

        A yes here is also a shallow yes, and a better-informed one: a
        source that served real video certainly served a playlist.

        A NO is not written back. This check now runs over every live
        source in the index rather than a curated few, and any systematic
        blind spot in it -- a host that refuses a truncated read, an
        unusual key arrangement, a referrer this does not send -- would
        become a wave of false negatives, sinking working channels
        wholesale through `proofOf`. That failure looks exactly like the
        one this whole mechanism exists to prevent.

        So a deep failure reorders a channel's own mirrors (see
        `rankStreams`) and never removes the channel from a rail. The
        shallow sweep, which is the conservative measurement, stays the
        thing that can say no.
    */
    if (ok)
        remember(stream.url, true);
    scheduleSave();
    return ok;
}
/** How many of a channel's sources have been proven right through to video. */
export function provenFor(channel) {
    return channel.streams.filter((stream) => deeplyKnown(stream.url) === true).length;
}
/**
 * The channel's mirrors, best first.
 *
 * LAST NIGHT'S ANSWER LEADS. Everything below it -- labels, stated quality
 * -- is what the list CLAIMS about a mirror, and a mirror that was actually
 * serving at three this morning beats every claim. A mirror that was
 * actually silent then goes last, behind even the ones nobody has asked
 * about, because "no answer" at least might work.
 *
 * Then: a mirror that says it is not on all day, or that it is blocked
 * outside its own country, before stated resolution. Total, and falling
 * through to the URL, because an unstable order repoints every link on the
 * page between one load and the next.
 */
/*
    CODECS NO BROWSER HAS EVER DECODED, whatever a panel claims.

    MPEG-2 is not in the capability probes because there is no MIME string
    a browser answers honestly for it, and it is not a codec anybody ships
    over HLS on purpose -- it is what a re-streamed satellite feed looks
    like when nobody re-encoded it. The LG's own decoder may well take it;
    hls.js, which is what every desktop browser here uses, will not.
*/
const AWKWARD = ["mpeg2video", "mpeg1video", "vc1"];
/**
 * How well a mirror's video suits the panel in front of it.
 *
 *   2  known, and this set decodes it
 *   1  nobody has looked -- which must not rank below a known bad, or
 *      the first night's probing would bury every unprobed mirror
 *   0  known, and this set does not decode it
 *
 * DEMOTION, NEVER REMOVAL. An HEVC mirror on a browser that cannot take
 * HEVC still appears, still plays if it is pressed, and still gets its
 * turn when nothing better answers. The explicit instruction behind this
 * is worth keeping in view: more options that might work beats fewer that
 * are certain to, because the codec record is evidence about the last
 * time somebody looked and the set in the room is the last word.
 */
export function codecRank(url, cannot) {
    const fact = codecFor(url);
    if (!fact || !fact.video)
        return 1;
    return cannot.includes(fact.video) || AWKWARD.includes(fact.video) ? 0 : 2;
}
/**
 * The codec, said the way somebody choosing a mirror needs to hear it:
 * with the warning attached when this panel cannot take it. Empty when
 * nobody has looked, which is not worth a word on the row.
 */
export function codecSaid(url, cannot) {
    const fact = codecFor(url);
    if (!fact || !fact.video)
        return "";
    const NAMES = {
        h264: "H.264",
        hevc: "H.265",
        mpeg2video: "MPEG-2",
        vp9: "VP9",
        av1: "AV1"
    };
    const name = NAMES[fact.video] || fact.video;
    const size = fact.height ? `${fact.height}p` : "";
    return `${[name, size].filter(Boolean).join(" ")}${codecRank(url, cannot) === 0 ? ", which this device may not decode" : ""}`;
}
export function rankStreams(channel, 
/**
 * The video codecs this panel does not decode, from `undecodable`.
 * Empty means rank on everything else, which is what a set that has
 * never reported its capabilities gets.
 */
cannot = []) {
    const lines = (quality) => {
        const found = /(\d{3,4})/.exec(quality);
        return found ? Number(found[1]) : 0;
    };
    /*
        FIVE RUNGS, because there are five genuinely different things that
        can be known about a mirror, and collapsing any two of them loses
        the distinction that decides what plays:

          4  played real video last night
          3  served a playlist, and has not been followed further
          2  nobody has asked
          1  served a playlist whose video would not come -- a stale
             master, segments that 404, a fenced segment server. Below
             everything unproven, because it is known to disappoint, and
             above an outright silence, because the edge may recover.
          0  did not answer at all

        Note that rung 1 exists ONLY here, in the ordering of one
        channel's own mirrors. It never reaches `proofOf`, so it can
        reorder a channel and never remove it.
    */
    const evidence = (stream) => {
        const followed = deeplyKnown(stream.url);
        if (followed === true)
            return 4;
        const answer = known(stream.url);
        if (answer === true)
            return followed === false ? 1 : 3;
        return answer === null ? 2 : 0;
    };
    /*
        THEN THE HOST'S RECORD, above the labels, because the labels are
        the list's claims and the record is measurement -- the same reason
        last night's answer leads in the first place.

        This is what decides between two mirrors NOBODY HAS ASKED ABOUT,
        which on a channel added since the last sweep is all of them. That
        tie used to be broken by the alphabet.
    */
    /*
        THE CODEC SITS BELOW THE EVIDENCE AND ABOVE THE HOST'S RECORD.

        Below the evidence, because a mirror that played real video last
        night in a codec this panel dislikes is still a better bet than one
        that answered nothing at all -- and because the conversion, the
        native decoder on the television, and the viewer's own press all
        remain available underneath. Above the reputation, because a codec
        this set cannot decode is a certainty about this mirror, while a
        host's record is a tendency across many.
    */
    return [...channel.streams].sort((a, b) => evidence(b) - evidence(a) ||
        codecRank(b.url, cannot) - codecRank(a.url, cannot) ||
        reputationOf(b.url) - reputationOf(a.url) ||
        a.labels.length - b.labels.length ||
        lines(b.quality) - lines(a.quality) ||
        a.url.localeCompare(b.url));
}
/**
 * A channel every one of whose leads has been followed and come to
 * nothing: it serves playlists, and not one of them yields video.
 *
 * THE TWO CONDITIONS ARE BOTH LOAD-BEARING. `good > 0` means there was
 * something to follow at all -- a channel whose mirrors are simply silent
 * is already sunk by `proofOf` and is not this. `followed === good` means
 * every one of those was actually followed: a channel with four live
 * mirrors of which the sweep reached one is not evidence of anything, and
 * hiding it would turn "the deep pass ran out of time" into "this channel
 * does not exist".
 */
export function disappointing(channel) {
    let good = 0;
    let followed = 0;
    for (const stream of channel.streams) {
        if (known(stream.url) !== true)
            continue;
        good += 1;
        const answer = deeplyKnown(stream.url);
        if (answer === null)
            continue;
        followed += 1;
        // One mirror that played is enough. The channel works.
        if (answer === true)
            return false;
    }
    return good > 0 && followed === good;
}
/**
 * How many of this channel's mirrors are known to have served, and how many
 * are known not to have.
 *
 * Both halves matter to the ranking and they are not opposites: a channel
 * nobody has asked about is in neither count, and must not be treated as
 * broken.
 */
/**
 * What last night's answers are worth in a ranking: ±1000, which dominates
 * both the composite (tops out near 400) and the home-market bonus.
 *
 * Shared by every list a viewer can see -- the rails, a country page, a
 * channel search -- because a channel that sinks on one and leads another
 * is worse than one that sinks on neither: it reads as a bug in whichever
 * page the viewer happens to be looking at.
 */
export function proofOf(channel) {
    const seen = evidenceFor(channel);
    if (seen.good > 0)
        return 1000;
    return seen.bad > 0 && seen.bad === channel.streams.length ? -1000 : 0;
}
export function evidenceFor(channel) {
    let good = 0;
    let bad = 0;
    for (const stream of channel.streams) {
        const answer = known(stream.url);
        if (answer === true)
            good += 1;
        else if (answer === false)
            bad += 1;
    }
    return { good, bad };
}
/**
 * The first mirror that answers, or null when none of them do.
 *
 * Tried in order and in SEQUENCE rather than all at once: the first one
 * usually answers, and firing six requests at six strangers' servers to
 * discard five of them is rude in a way that gets an address blocked.
 */
export async function firstWorking(channel) {
    for (const stream of rankStreams(channel)) {
        if (await verify(stream))
            return stream;
    }
    return null;
}
/*
    ===================================================================
    THE ADAPTER: a channel, said in the protocol's own words.
    ===================================================================

    Everything downstream of here -- the title page, the source list, the
    player, the resume bookmark -- speaks `MetaDetail` and `Stream`, and
    none of it should have to learn that live TV exists. So a channel is
    dressed as a meta and its mirrors as streams, and the ordinary pages
    answer for it unchanged.
*/
/**
 * The "addon" a channel is attributed to.
 *
 * It is real in the sense that matters: the source list prints where a
 * stream came from, and "iptv-org" is the honest answer. It is never
 * fetched from -- there is no such service -- so it carries the project's
 * page as its base, which is what anyone following the attribution wants.
 */
const SOURCE = {
    base: "https://iptv-org.github.io",
    manifest: { id: "org.iptv.index", name: "iptv-org", types: ["tv"] }
};
export function channelPreview(channel) {
    return {
        id: channel.id,
        type: "tv",
        name: channel.name,
        poster: channel.logo,
        posterShape: "square",
        background: channel.logo,
        description: describeChannel(channel),
        genres: channel.categories
    };
}
/** The one line under a channel's name. Category, country, mirrors. */
export function describeChannel(channel) {
    const carried = channel.streams.length === 1 ? "1 source" : `${channel.streams.length} sources`;
    return [channel.network, channel.categories.join(", "), carried].filter(Boolean).join(" · ");
}
export function channelMeta(channel) {
    return {
        ...channelPreview(channel),
        logo: channel.logo,
        country: channel.countryName || channel.country,
        /*
            Live TV has no runtime, no year and no rating, and the title
            page renders each of those only when it has one -- so they are
            left off rather than filled in with a dash.
        */
        description: describeChannel(channel)
    };
}
/**
 * A channel's mirrors as a source list, working ones first.
 *
 * The verification is the reason this is not simply `rankStreams`. Mirrors
 * are asked whether they are alive, and the ones that answered are moved to
 * the top -- so "Play" on a channel page starts a stream that is serving
 * right now rather than the first URL somebody wrote down.
 *
 * HOW DEEP, AND WHY IT IS NOT FIVE. BBC One has FIFTY mirrors and the first
 * several are geo-blocked edges of the BBC's own CDN, which answer nothing
 * from outside the UK. Checking five of those found nothing, reported
 * nothing to the caller it could act on, and left Play pointing at a corpse
 * -- a black player and no explanation, which is the exact failure this
 * whole module was written to end.
 *
 * So it goes deeper, in batches, stopping the moment it has enough to offer
 * and abandoning the pass on a whole-pass budget rather than a per-URL one.
 * A cached answer costs nothing and does not count against either, so the
 * warm case -- which is every press, because the title page arms it -- is
 * instant.
 *
 * Nothing is HIDDEN, however deep it went. A mirror this service could not
 * reach may still be one the viewer wants to try, and a source list that
 * silently drops entries is what made the addon look broken to begin with.
 */
const DEPTH = 18;
const BATCH = 6;
const WANT = 3;
const BUDGET_MS = 7000;
/** What a source row is called once something answered on it. */
export const CHECKED = "Live \u00b7 checked";
export async function channelStreamList(channel, 
/** The tunnel's proxy when live TV is routed, "" for a direct fetch. */
proxy = "", 
/**
 * True when live TV is routed and the tunnel is NOT up.
 *
 * Nothing is checked in that state and nothing is offered. Checking
 * directly would answer a question about a path the video will not
 * take, and every one of those answers would be wrong in the direction
 * that matters -- a geo-fenced mirror reported as working for a
 * household whose traffic cannot reach it.
 */
routedDown = false, 
/** The video codecs this panel does not decode. See `rankStreams`. */
cannot = []) {
    const ranked = rankStreams(channel, cannot);
    if (routedDown) {
        return {
            items: ranked.map((stream) => ({
                from: SOURCE,
                value: {
                    url: stream.url,
                    name: "Live",
                    title: [stream.quality || "unknown quality", ...stream.labels, hostOf(stream.url)]
                        .filter(Boolean)
                        .join("\n")
                }
            })),
            failures: [
                {
                    addon: "iptv-org",
                    reason: "live TV is set to go through the VPN and the tunnel is not connected, so nothing was checked"
                }
            ]
        };
    }
    const deadline = Date.now() + BUDGET_MS;
    const good = [];
    const bad = [];
    let tried = 0;
    for (let at = 0; at < Math.min(DEPTH, ranked.length); at += BATCH) {
        if (good.length >= WANT)
            break;
        /*
            The budget is checked between batches and not inside one: a
            batch already in flight is nearly free to finish, and cutting
            it off would throw away answers that have been paid for.
        */
        if (Date.now() > deadline)
            break;
        const batch = ranked.slice(at, at + BATCH);
        const alive = await Promise.all(batch.map((stream) => verify(stream, proxy)));
        tried += batch.length;
        batch.forEach((stream, index) => (alive[index] ? good : bad).push(stream));
    }
    const ordered = [...good, ...bad, ...ranked.slice(tried)];
    /*
        SAID IN TERMS OF WHY, not just that.

        "Nothing answered" is true and useless. When every mirror that was
        tried carries iptv-org's own Geo-blocked label, the channel is not
        broken -- it is working exactly as its broadcaster intends, and the
        thing that fixes it is the switch at the top of the page.
    */
    /*
        MOST of them, not all. BBC One's fifty mirrors are forty-eight
        geo-fenced edges and two strays, and requiring unanimity there
        would trade the one message somebody can act on for "nothing
        answered".
    */
    const fenced = bad.filter((stream) => stream.labels.some((label) => /geo/i.test(label))).length;
    const blocked = bad.length > 0 && fenced >= bad.length * 0.6;
    const failures = good.length === 0 && tried > 0
        ? [
            {
                addon: "iptv-org",
                reason: blocked
                    ? `all ${tried} sources tried are geo-blocked from here -- this channel needs the VPN, on an exit node in its own country`
                    : tried >= ranked.length
                        ? "none of this channel's sources answered just now"
                        : `the first ${tried} of ${ranked.length} sources did not answer just now`
            }
        ]
        : [];
    return {
        items: ordered.map((stream, at) => ({
            from: SOURCE,
            value: {
                url: stream.url,
                name: at < good.length ? CHECKED : "Live",
                title: [
                    /*
                        THE CODEC IS SAID OUT LOUD when it is known, because
                        this list exists for the viewer who wants to choose
                        for themselves -- and "H.265, which this browser
                        cannot decode" is the single most useful thing that
                        can be said about a mirror that looks fine and will
                        not play.
                    */
                    codecSaid(stream.url, cannot) || stream.quality || "unknown quality",
                    ...stream.labels,
                    hostOf(stream.url)
                ]
                    .filter(Boolean)
                    .join("\n")
            }
        })),
        failures
    };
}
/** Whether anything on this list is known to be serving right now. */
export function anyChecked(items) {
    return items.some((entry) => entry.value.name === CHECKED);
}
function hostOf(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return "";
    }
}
/**
 * Ask this channel's mirrors whether they are alive, and throw the answer
 * away.
 *
 * Called after the title page has been sent, for the same reason films arm
 * their torrent there: the viewer is looking at the page for the thing they
 * are about to press, the check takes a round trip to somebody else's
 * server, and doing it now means Play does not.
 */
export function warmChannel(channel, proxy = "") {
    /*
        The same list the press will ask for, so the press finds it cached.
        No budget and no early stop: nobody is waiting on this, and a
        channel whose first dozen mirrors are geo-blocked is exactly the one
        worth having already looked past by the time Play is pressed.
    */
    void channelStreamList(channel, proxy).catch(() => null);
}
/**
 * Channels for one rail, best first.
 *
 * WHY A RAIL IS NOT SIMPLY "THE TOP OF A CATEGORY". Sorted globally, Sports
 * is a line of Latin American and Turkish channels, because that is where
 * the free mirrors are -- correct by the score and useless on a television
 * in a particular house. So a channel from one of the household's own
 * markets is lifted above one that is not, and the composite only decides
 * the order WITHIN each of those groups.
 *
 * The lift is a bonus rather than a filter, so a rail still fills up when
 * the household's own market has nothing of that kind -- which is the case
 * for Kids in most countries.
 */
export function select(built, want, home = []) {
    const categories = want.categories || [];
    const languages = want.languages || [];
    const countries = want.countries || [];
    const kept = built.all.filter((channel) => {
        if (countries.length && !countries.includes(channel.country))
            return false;
        if (categories.length && !categories.some((c) => channel.categories.includes(c)))
            return false;
        if (languages.length && !languages.some((l) => channel.languages.includes(l)))
            return false;
        return true;
    });
    /*
        WHAT THE NIGHT FOUND OUTRANKS EVERYTHING THE LIST CLAIMS.

        The composite below is a guess assembled from mirror counts and
        category labels. The sweep is evidence. A channel that was serving
        at three this morning goes above one that was silent, whatever
        either of them scores -- which is the whole point of running the
        sweep, and the answer to "ensure channels from India and the USA
        play": the ones that do not simply stop leading their rails.

        1,000 either way, so it dominates both the composite (which tops
        out near 400) and the home-market bonus. A channel nobody has asked
        about sits between them, untouched: unknown is not broken, and on a
        cold install that is every channel, which must still produce the
        same page it produced before any of this existed.
    */
    const rank = (channel) => {
        const at = home.indexOf(channel.country);
        return channel.score + proofOf(channel) + (at < 0 ? 0 : 400 - at * 40);
    };
    /*
        AND THE ONES THAT WILL ONLY DISAPPOINT COME OFF THE RAIL ENTIRELY.

        This is the one place evidence is allowed to REMOVE rather than
        reorder, and it is allowed here because a rail is a recommendation.
        Everywhere else -- a country page, a search -- the viewer asked for
        a specific thing by name and gets it, with the channel's own page
        explaining what the night found. A rail nobody asked for should not
        be offering a channel that has been followed to the end of every
        one of its mirrors and yields nothing.

        Guarded twice. `deepEnough` refuses the whole idea until the store
        has seen half the live index, so a cold start cannot empty the
        rails. And a rail that would come up EMPTY keeps its unfiltered
        contents: a narrow pick -- Kids in a small country -- is better
        served by something imperfect than by a blank row, and a blank row
        reads as a bug in the page rather than a fact about the channels.
    */
    const sorted = kept.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
    const worth = deepEnough() ? sorted.filter((channel) => !disappointing(channel)) : sorted;
    return (worth.length ? worth : sorted).slice(0, want.limit || 20);
}
/**
 * Channels whose name matches, best first.
 *
 * Deliberately not fuzzy. Somebody typing "bbc" on a remote wants the BBC
 * channels and a fuzzy match buries them under everything containing a b,
 * a c and a c -- so it is a substring, with a name that STARTS with the
 * term ranked above one that merely contains it, and the composite
 * breaking the tie after that.
 */
export async function searchChannels(term, limit = 60) {
    const wanted = term.trim().toLowerCase();
    /*
        The length is checked BEFORE the index is asked for. One letter is
        not a search -- it is the first press of a word -- and a keyboard
        whose first letter built a 25MB index would be a keyboard with a
        thirty-second first press.
    */
    if (wanted.length < 2)
        return [];
    const built = await channelIndex();
    if (!built)
        return [];
    const hits = built.all.filter((channel) => channel.name.toLowerCase().includes(wanted));
    return hits
        .sort((a, b) => {
        const ahead = a.name.toLowerCase().startsWith(wanted) ? 1 : 0;
        const bhead = b.name.toLowerCase().startsWith(wanted) ? 1 : 0;
        /*
            The term still decides first -- somebody typing "bbc one"
            wants BBC One at the top even when it is the one that does
            not play from here, and the page will say why the moment
            they open it.
        */
        return (bhead - ahead ||
            proofOf(b) - proofOf(a) ||
            b.score - a.score ||
            a.name.localeCompare(b.name));
    })
        .slice(0, limit);
}
/**
 * One country's channels, best first. ALL of them -- the page that shows
 * them is what decides how many fit, and a cap here would silently make
 * its "of 745" a lie.
 */
export async function channelsIn(code) {
    const built = await channelIndex();
    /*
        Sorted HERE and not at index-build time, because the evidence
        changes under it: the index is built once and the sweep runs after,
        and a country page ordered by the build's own sort put BBC One --
        which cannot play from this house -- second in the United Kingdom
        while the rails had already sunk it. A copy, so the index's own
        order is left alone.
    */
    return [...(built?.byCountry.get(code.toUpperCase()) || [])].sort((a, b) => proofOf(b) - proofOf(a) || better(a, b));
}
/** Every country that has channels, most first. */
export async function countries() {
    return (await channelIndex())?.countries || [];
}
export async function countryNamed(code) {
    const built = await channelIndex();
    return built?.countries.find((entry) => entry.code === code.toUpperCase()) || null;
}
/** Kids is three categories, not one: iptv-org files cartoons under
 *  "animation" and family channels under "family", and a Kids rail that
 *  reads only "kids" misses most of what a child would watch. */
const KIDS = ["kids", "animation", "family"];
/** Below this a rail is not worth a heading. */
const MIN_RAIL = 4;
/*
    And above this a rail costs more than it is worth. Nobody arrows past
    the fourteenth tile of a rail on a remote -- what they do instead is
    open the country, which is one press away -- and every tile is a card
    and an image for a 2016 panel to lay out on a page that already has ten
    rails on it.
*/
const RAIL = 14;
/**
 * Every rail on the Live TV page, in the order they appear.
 *
 * @param home       the household's markets, best first
 * @param languages  the house's languages, code and name, for the kids rails
 * @param countryHref  where a country's "see all" points
 */
export async function liveRails(home, languages, countryHref) {
    const built = await channelIndex();
    if (!built)
        return { rails: [], countries: [], down: true };
    const named = new Map(built.countries.map((country) => [country.code, country.name]));
    const rails = [];
    /*
        THE HOUSEHOLD'S OWN MARKETS FIRST, one rail each.

        Before the themed rails rather than after them, because a live TV
        page that opens on a global Sports rail is a page about somebody
        else's television.
    */
    for (const code of home) {
        const channels = select(built, { countries: [code], limit: RAIL });
        if (!channels.length)
            continue;
        rails.push({
            id: `country:${code}`,
            heading: `Top channels in ${named.get(code) || code}`,
            by: "Most widely carried",
            channels,
            more: countryHref(code)
        });
    }
    const themed = [
        { id: "sports", heading: "Sports", categories: ["sports"] },
        { id: "news", heading: "News", categories: ["news"] },
        { id: "films", heading: "Films and series", categories: ["movies", "series"] },
        { id: "music", heading: "Music", categories: ["music"] },
        { id: "docs", heading: "Documentaries", categories: ["documentary", "science"] }
    ];
    for (const rail of themed) {
        rails.push({
            id: `theme:${rail.id}`,
            heading: rail.heading,
            by: "Your countries first",
            channels: select(built, { categories: rail.categories, limit: RAIL }, home)
        });
    }
    /*
        A KIDS RAIL PER LANGUAGE THE HOUSE WATCHES.

        Split by language rather than shown as one rail, because this is
        the one category where the language is the whole decision: a
        six-year-old cannot use a Spanish cartoon channel, and a rail
        sorted by how widely a channel is carried puts several in front of
        the one they can watch.
    */
    for (const language of languages) {
        const channels = select(built, { categories: KIDS, languages: [language.code], limit: RAIL }, home);
        /*
            A rail with two cards on it reads as a broken rail. A house
            that watches eight languages would otherwise get eight Kids
            headings, six of them nearly empty.
        */
        if (channels.length < MIN_RAIL)
            continue;
        rails.push({
            id: `kids:${language.code}`,
            heading: `Kids in ${language.name}`,
            by: "Your countries first",
            channels
        });
    }
    /*
        WHATEVER A SCRAPER ASKED FOR, LAST.

        Resolved here, against the finished index, rather than at merge
        time -- a channel another scraper's duplicate id shadowed, or one
        that has since aged out, disappears from the rail the same way it
        disappears from the country and theme rails above, instead of
        leaving a gap where a card should be.
    */
    for (const decl of built.rails) {
        const channels = decl.channelIds
            .map((id) => built.byId.get(id))
            .filter((channel) => Boolean(channel))
            .sort(better)
            .slice(0, RAIL);
        if (!channels.length)
            continue;
        rails.push({ id: decl.id, heading: decl.heading, by: decl.by, channels });
    }
    return { rails: rails.filter((rail) => rail.channels.length > 0), countries: built.countries, down: false };
}
/**
 * THE FINAL RANKING, AT PLAY TIME.
 *
 * Ported from stremio-tv `src/index.ts`'s own (now removed) `rankChannel`,
 * unchanged in substance -- this is Live-TV-domain ranking (mirror
 * reachability through the household's own VPN routing, then codec cost
 * for THIS television), so it belongs here with the rest of that domain
 * now that Live TV is a plugin, not split across a core `index.ts` and a
 * plugin. See that history for the full reasoning behind every step;
 * summarized in the comments below.
 */
export async function rankReachability(found, skipped, session) {
    const available = found.items.map((_, at) => at).filter((at) => !skipped.includes(at));
    let liveProxyNow = null;
    try {
        const capability = await host.requestVpnCapability("live-tv", session);
        liveProxyNow = capability.liveProxy ? await capability.liveProxy(session) : "";
    }
    catch {
        liveProxyNow = null;
    }
    const cost = (at) => {
        const item = found.items[at];
        if (!item)
            return 9;
        const fact = codecFor(item.value.url || "");
        if (!fact)
            return 4;
        const picture = host.canCopyVideo(session, fact.video);
        const sound = host.canCopyLiveAudio(session, fact.audio);
        if (picture && sound && fact.fields === "progressive" && fact.audioFirst)
            return 0;
        if (picture && sound)
            return 1;
        if (picture)
            return 2;
        return 5;
    };
    const reachOf = (at) => {
        const item = found.items[at];
        if (!item)
            return 90;
        const said = known(item.value.url || "");
        return item.value.name === CHECKED || said === true ? 0 : said === null ? 10 : 20;
    };
    const grade = (at) => reachOf(at) + cost(at);
    const sorted = available.slice().sort((a, b) => grade(a) - grade(b));
    const alive = liveProxyNow === null
        ? sorted.map(() => false)
        : await Promise.all(sorted.map(async (at) => {
            const stream = found.items[at]?.value;
            if (!stream?.url)
                return false;
            return verify({ url: stream.url, quality: "", labels: [], referrer: "", userAgent: "" }, liveProxyNow).catch(() => false);
        }));
    const answered = sorted.filter((_, at) => alive[at]);
    const reachable = answered.length > 0 ? answered : sorted;
    const LOOK_AT = 4;
    await Promise.all(reachable.slice(0, LOOK_AT).map(async (at) => {
        const stream = found.items[at]?.value;
        if (!stream?.url || codecFor(stream.url) || liveProxyNow === null)
            return;
        await probeCodec({ url: stream.url, quality: "", labels: [], referrer: "", userAgent: "" }, liveProxyNow).catch(() => null);
    }));
    const ranked = reachable.slice().sort((a, b) => grade(a) - grade(b));
    return [...ranked, ...sorted.filter((at) => !ranked.includes(at))];
}
