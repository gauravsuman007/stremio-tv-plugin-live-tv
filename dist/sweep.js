/**
 * The nightly sweep: ask every live source whether it is alive, once a
 * night, so that by morning the page is built out of evidence rather than
 * out of what a list claims.
 *
 * WHY THIS AND NOT A BETTER LIST
 * ------------------------------
 * There is no better list. Every public IPTV index -- iptv-org included --
 * is a list of URLs that worked on the day somebody wrote them down, and
 * the useful question is not "which list" but "which of these answers
 * TODAY, from HERE". That question can only be answered by asking, and
 * asking seventeen thousand times is not something to do while somebody is
 * waiting for a page. So it is done at three in the morning.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a crawler and it does not download anything. One short GET per
 * source, read until the first line is known and then hung up -- the same
 * request `verify` makes when a channel is opened, at the same deadline,
 * with the answers landing in the same store. The only difference is that
 * nobody is waiting.
 *
 * BEING POLITE IS PART OF THE DESIGN
 * ----------------------------------
 * These are a few hundred strangers' servers, and several of them carry
 * dozens of channels each. Firing everything at once would be a burst that
 * looks exactly like an attack from the other end, and the address that
 * gets blocked is this house's. So the work is grouped BY HOST: many hosts
 * are in flight at once, one request at a time within each, with a pause
 * between.
 */
import { pluginConfig as config } from "./plugin-config.js";
import { channelIndex, checkSummary, codecFor, deepVerify, deeplyKnown, known, probeCodec, rankStreams, saveChecks, verify } from "./channels.js";
import { host } from "./host.js";
const allFavourites = () => host.session.allFavourites();
const routeLive = () => host.session.routeLive();
/*
    How many different hosts are asked at the same moment.

    Measured rather than guessed: 690 sources across the top of the Indian
    and American lists took 98 seconds at 24, which puts the full 17,500 at
    about forty minutes. 32 brings that under half an hour and is still
    only 32 connections from one house.
*/
const HOSTS = 32;
/** And how long to leave one host alone between its own requests. */
const BREATH_MS = 250;
/** How often the sweep says where it has got to. */
const PROGRESS_MS = 3 * 60 * 1000;
/**
 * A hard stop, so a sweep can never still be running at breakfast.
 *
 * Sized against the measured worst case rather than the best one. Direct
 * from the house the shallow pass takes 24 minutes; THROUGH THE TUNNEL it
 * is far slower -- every request carries the proxy's round trip, and the
 * dead hosts that dominate the time still burn the full deadline each.
 * Routed is the household's normal state, so that is the case to size for.
 *
 * At 80 minutes the shallow pass alone could reach the cap and leave the
 * deep pass -- which runs second, on purpose -- with nothing. Starting at
 * 03:00 this still finishes long before anyone is watching.
 */
const WHOLE_SWEEP_MS = 150 * 60 * 1000;
let running = false;
let lastRun = 0;
let lastFound = 0;
let lastTried = 0;
let lastDeep = 0;
export function sweepState() {
    if (lastRun)
        return { running, at: lastRun, tried: lastTried, found: lastFound, deep: lastDeep };
    /*
        No sweep has run IN THIS PROCESS, which after a deploy is the
        ordinary case and says nothing about whether one has run. The store
        knows, so it is asked -- otherwise the page reports "nothing has
        been checked" while every rail on it is ordered by fifteen thousand
        answers.
    */
    return { running, ...checkSummary() };
}
function hostOf(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
}
function pause(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}
/**
 * Check everything once.
 *
 * Answers are not returned: they go into the check store, which the
 * ranking and every page read from. This function's only product is a log
 * line and a state for the Live TV page to print.
 */
export async function sweep() {
    if (running)
        return;
    const built = await channelIndex();
    if (!built) {
        console.error("stremio-tv: live sweep skipped -- no index");
        return;
    }
    /*
        THROUGH THE TUNNEL IF THAT IS WHERE PLAYBACK GOES.

        Asked once, here, rather than per request: it is a call to Riven and
        the answer does not change during a sweep. And if routing is on and
        the tunnel is DOWN, the sweep is abandoned rather than run directly
        -- a night's answers collected from the wrong address would rank
        geo-fenced mirrors as working for a household that cannot reach
        them, which is worse than no answers at all.
    */
    let proxy = "";
    try {
        const capability = await host.requestVpnCapability("live-tv");
        proxy = capability.liveProxy ? await capability.liveProxy() : "";
    }
    catch {
        console.error("stremio-tv: live sweep skipped -- live TV is routed and the tunnel is down");
        return;
    }
    running = true;
    const started = Date.now();
    const deadline = started + WHOLE_SWEEP_MS;
    /* Grouped by host, and each host's queue is worked through in order. */
    const queues = new Map();
    for (const channel of built.all) {
        for (const stream of channel.streams) {
            const host = hostOf(stream.url);
            const queue = queues.get(host) || [];
            queue.push(stream);
            queues.set(host, queue);
        }
    }
    /*
        LONGEST QUEUES FIRST.

        Each host is worked through in sequence by one worker, so a host
        carrying fifty dead sources is fifty six-second timeouts -- five
        solid minutes -- and if it is picked up last it is five minutes
        during which thirty-one workers have nothing to do. Measured: the
        final five hundred sources of a sweep took twenty-five minutes,
        which is a scheduling artefact and not the network.

        Starting the big queues first is the standard fix and costs one
        sort. The polite pacing inside each host is untouched.
    */
    const hosts = [...queues.values()].sort((a, b) => b.length - a.length);
    let at = 0;
    let tried = 0;
    let found = 0;
    console.log(`stremio-tv: live sweep starting -- ${built.all.length} channels, ` +
        `${hosts.reduce((all, queue) => all + queue.length, 0)} sources, ` +
        `${hosts.length} hosts${proxy ? ", through the tunnel" : ""}`);
    /*
        A LINE EVERY FEW MINUTES, because an hour of silence is not
        something anyone can reason about. This ran for thirty-one minutes
        with nothing between "starting" and "done", so the only way to
        know whether it was progressing or wedged was to watch the file
        size of the store.
    */
    const total = hosts.reduce((all, queue) => all + queue.length, 0);
    const ticker = setInterval(() => {
        console.log(`stremio-tv: live sweep ${tried}/${total} sources, ${found} answered, ` +
            `${Math.round((Date.now() - started) / 60_000)} min in`);
    }, PROGRESS_MS);
    ticker.unref();
    async function worker() {
        for (;;) {
            if (halted || Date.now() > deadline)
                return;
            const queue = hosts[at++];
            if (!queue)
                return;
            for (const stream of queue) {
                if (halted || Date.now() > deadline)
                    return;
                try {
                    if (await verify(stream, proxy))
                        found += 1;
                }
                catch {
                    /* `verify` swallows its own failures; this is belt and braces. */
                }
                tried += 1;
                await pause(BREATH_MS);
            }
        }
    }
    await Promise.all(Array.from({ length: HOSTS }, () => worker()));
    clearInterval(ticker);
    if (halted || Date.now() > deadline) {
        console.error(`stremio-tv: live sweep hit its ${Math.round(WHOLE_SWEEP_MS / 60_000)} min deadline ` +
            `with ${tried} of ${total} sources asked -- the deep pass will be short`);
    }
    /*
        AND THEN THE DEEPER QUESTION, FOR EVERYTHING THAT ANSWERED.

        Everything above establishes that a URL serves a playlist, which is
        not what somebody means when they ask whether a channel works: a
        cached playlist whose segments are gone passes it cleanly, and
        nearly two in five live sources turn out to be exactly that.

        Second rather than first, and on a shared deadline, so a deep pass
        that overruns can never eat the shallow sweep that orders every
        rail on the page.
    */
    const deepened = await deepen(built, proxy, deadline);
    /*
        AND FINALLY, WHAT THE PICTURES ARE.

        Last, on the same deadline, and on a budget -- see `nameCodecs`.
    */
    const named = await nameCodecs(built, proxy, deadline);
    running = false;
    lastDeep = deepened.proven;
    lastRun = Date.now();
    lastTried = tried;
    lastFound = found;
    saveChecks();
    const minutes = Math.round((Date.now() - started) / 60_000);
    console.log(`stremio-tv: live sweep done -- ${found} of ${tried} sources answered, in ${minutes} min` +
        (deepened.tried
            ? `; ${deepened.proven} of ${deepened.tried} played real video`
            : "") +
        (named ? `; ${named} more sources had their codec named` : ""));
}
/*
    HOW MANY SOURCES GET THEIR CODEC NAMED IN ONE NIGHT.

    This is the one pass that costs real bandwidth: naming a codec takes
    192KB of segment (measured -- see `PROBE_BYTES`) against the deep
    check's 18KB. Over ten thousand proven sources that would be two
    gigabytes a night through somebody's tunnel, every night, to learn
    something that changes about as often as a satellite receiver gets
    replaced.

    So it is a BUDGET, and the coverage builds up over successive nights:
    the leading mirror of each channel first, oldest answer first within
    that, favourites ahead of everything. At 1,500 a night the sources that
    actually get played are named within a week and the bill is under
    300MB a night.
*/
const CODEC_BUDGET = 1500;
/** And how long a naming stays good. A re-encode is a rare event. */
const CODEC_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Name the video in the mirrors most likely to be played.
 *
 * WHY THE LEADING MIRROR AND NOT ALL OF THEM. The ranking only ever hands
 * the television the top of the list, so knowing that a channel's
 * fourteenth mirror is MPEG-2 buys nothing -- and spending the budget on
 * it means the mirror that IS played stays unknown for another night.
 */
export async function nameCodecs(built, proxy, deadline) {
    const wanted = new Set(allFavourites());
    const first = [];
    const rest = [];
    for (const channel of built.all) {
        /*
            The leading PROVEN mirror. A source that never yielded video is
            not worth 192KB: whatever codec it carries, it is not the one
            the room will see.
        */
        const lead = rankStreams(channel).find((stream) => deeplyKnown(stream.url) === true);
        if (!lead)
            continue;
        const held = codecFor(lead.url);
        if (held && Date.now() - held.at < CODEC_FRESH_MS)
            continue;
        (wanted.has(channel.id) ? first : rest).push(lead);
    }
    /*
        Oldest first, and never-looked-at before ever-looked-at, so a long
        tail of channels cannot be starved by the same few being re-probed.
    */
    const age = (stream) => (codecFor(stream.url) || { at: 0 }).at;
    const picked = [...first, ...rest.sort((a, b) => age(a) - age(b))].slice(0, CODEC_BUDGET);
    /*
        DEALT OUT BY HOST, one at a time round the table.

        The other two passes queue per host and give each host its own
        worker; this one is short enough not to need that, but it must not
        pull eight 192KB segments off one host at once -- which is what the
        raw order would do, since a channel's mirrors and its neighbours'
        cluster on the same few operators. Round-robin puts the maximum
        distance between two reads of the same server.
    */
    const byHost = new Map();
    for (const stream of picked) {
        const host = hostOf(stream.url);
        byHost.set(host, [...(byHost.get(host) || []), stream]);
    }
    const decks = [...byHost.values()];
    const queue = [];
    for (let round = 0; queue.length < picked.length; round += 1) {
        for (const deck of decks) {
            const stream = deck[round];
            if (stream)
                queue.push(stream);
        }
    }
    if (queue.length === 0)
        return 0;
    console.log(`stremio-tv: naming codecs for ${queue.length} leading sources` +
        `${first.length ? `, ${first.length} of them favourites` : ""}`);
    let named = 0;
    let at = 0;
    async function worker() {
        for (;;) {
            if (halted || Date.now() > deadline)
                return;
            const stream = queue[at++];
            if (!stream)
                return;
            if (await probeCodec(stream, proxy))
                named += 1;
            await pause(BREATH_MS);
        }
    }
    /*
        Fewer workers than either other pass. These are the largest reads
        this service ever makes of a stranger's server, and each one also
        runs an ffprobe on a four-core box that is serving television at
        the same time.
    */
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    return named;
}
/*
    How many hosts are asked for VIDEO at the same time.

    Lower than the shallow sweep's 32, because these requests pull real
    segments rather than a few lines of text. Measured at 18 KB and 2.92
    requests per source, 24 puts the whole index at about a quarter of an
    hour -- which is the right trade against being 32 simultaneous video
    clients from one house.
*/
const DEEP_HOSTS = 24;
/**
 * Follow every live source through to a segment of real video.
 *
 * ONLY THE ONES THE SHALLOW PASS FOUND ALIVE. A source that did not answer
 * at all has nothing to follow, and asking it again immediately would
 * double the cost of the sweep to learn nothing.
 *
 * FAVOURITES FIRST. Not because they are checked differently -- everything
 * is checked the same way now -- but because this pass has a deadline, and
 * if it is going to run out of time it should run out on a Bulgarian
 * shopping channel rather than on something somebody said they watch.
 *
 * Grouped by host and paced exactly like the shallow sweep, for the same
 * reason: several of these hosts carry dozens of channels, and a burst of
 * video requests from one address is what gets that address blocked.
 */
export async function deepen(built, proxy, deadline) {
    const wanted = new Set(allFavourites());
    const first = [];
    const rest = [];
    for (const channel of built.all) {
        for (const stream of channel.streams) {
            // Nothing to follow on a source that never answered.
            if (known(stream.url) !== true)
                continue;
            (wanted.has(channel.id) ? first : rest).push(stream);
        }
    }
    const queues = new Map();
    for (const stream of [...first, ...rest]) {
        const host = hostOf(stream.url);
        const queue = queues.get(host) || [];
        queue.push(stream);
        queues.set(host, queue);
    }
    const hosts = [...queues.values()].sort((a, b) => b.length - a.length);
    if (hosts.length === 0)
        return { tried: 0, proven: 0 };
    let at = 0;
    let tried = 0;
    let proven = 0;
    console.log(`stremio-tv: deep check starting -- ${first.length + rest.length} live sources ` +
        `across ${hosts.length} hosts${proxy ? ", through the tunnel" : ""}` +
        `${first.length ? `, ${first.length} of them favourites and first in the queue` : ""}`);
    const total = first.length + rest.length;
    const ticker = setInterval(() => {
        console.log(`stremio-tv: deep check ${tried}/${total} sources, ${proven} played video`);
    }, PROGRESS_MS);
    ticker.unref();
    async function worker() {
        for (;;) {
            if (halted || Date.now() > deadline)
                return;
            const queue = hosts[at++];
            if (!queue)
                return;
            for (const stream of queue) {
                if (halted || Date.now() > deadline)
                    return;
                try {
                    if (await deepVerify(stream, proxy))
                        proven += 1;
                }
                catch {
                    /* `deepVerify` swallows its own failures. */
                }
                tried += 1;
                await pause(BREATH_MS);
            }
        }
    }
    await Promise.all(Array.from({ length: DEEP_HOSTS }, () => worker()));
    clearInterval(ticker);
    return { tried, proven };
}
/**
 * Run it tonight, and every night.
 *
 * A plain timer rather than cron: this process is the only thing that
 * knows the index, and a container that restarts at noon should not lose
 * its nightly slot -- so the next occurrence of the hour is computed each
 * time rather than counted from boot.
 *
 * And it does NOT run at boot. A deploy in the evening would otherwise
 * start half an hour of checking while somebody is watching, which is the
 * one thing the hour was chosen to avoid. The store on disk is what covers
 * the gap.
 */
let halted = false;
let sweepTimer = null;
/** Called from the plugin's `dispose()`. Cancels the next nightly run and
 *  makes any pass already in flight stop at its next source, so a plugin
 *  replaced mid-sweep does not carry on beside its successor. */
export function stopSweep() {
    halted = true;
    if (sweepTimer)
        clearTimeout(sweepTimer);
    sweepTimer = null;
}
export function scheduleSweep() {
    if (config.liveSweepHour < 0 || config.liveSweepHour > 23) {
        console.log("stremio-tv: nightly live sweep is off");
        return;
    }
    const next = () => {
        const when = new Date();
        when.setHours(config.liveSweepHour, 0, 0, 0);
        if (when.getTime() <= Date.now())
            when.setDate(when.getDate() + 1);
        return when.getTime() - Date.now();
    };
    const arm = () => {
        if (halted)
            return;
        const timer = sweepTimer = setTimeout(() => {
            void sweep().catch((cause) => console.error("stremio-tv: live sweep failed", cause));
            arm();
        }, next());
        /*
            Unreferenced, so a shutdown is not held up by a timer that may
            be twenty hours away.
        */
        timer.unref();
    };
    arm();
    console.log(`stremio-tv: nightly live sweep at ${String(config.liveSweepHour).padStart(2, "0")}:00` +
        (routeLive() ? ", through the tunnel" : ""));
}
