/**
 * The live relay's plugin half: `liveFetch` (core plugin API 1.2.0).
 *
 * WHY THIS EXISTS
 * ---------------
 * stremio-tv relays every live channel itself, through `/live/<url>` --
 * playlist, variants, segments, keys -- so the whole channel travels the
 * same path as the VPN switch says it should (see core's `live.ts`). Until
 * API 1.2.0 that relay fetched every one of those URLs the same way, with a
 * fixed VLC User-Agent and no Referer, which left two kinds of source
 * unplayable no matter how well a scraper resolved them:
 *
 *   * A CDN that insists on a `Referer` or `User-Agent`. A scraper could
 *     already SAY so (`ScrapedStream.referrer`/`userAgent`), and the
 *     nightly checks honoured it, but playback never did -- so the check
 *     called a mirror alive that the television could not play.
 *   * A CDN that disguises its video. dlhd's segments are real PNG images
 *     with the MPEG-TS packed into their pixels; a player fetching one finds
 *     a picture. Unwrapping it is a few lines of plain code, but it has to
 *     happen on EVERY segment, forever, which a URL alone cannot carry.
 *
 * Core now asks a plugin first. This module answers for the URLs that need
 * either of those things and returns `null` for every other URL, so an
 * ordinary channel is untouched -- core fetches it exactly as before.
 *
 * HOW A SEGMENT IS RECOGNISED
 * ---------------------------
 * Only a channel's top-level playlist URL is known in advance (it is in the
 * scraper's catalogue); its segments live on whatever host the playlist
 * names -- for dlhd, a TikTok image CDN. So each playlist this relay
 * answers is read on the way through, and every URI in it (variants,
 * segments, keys, init maps) is remembered under the same rule as the
 * playlist that named it. Core asks for the playlist before any of its
 * segments, and asks again every few seconds while the channel plays, so
 * the table stays ahead of the player. Entries expire, and the table is
 * capped, so a long night of channel-surfing cannot grow it without bound.
 *
 * A playlist URL nobody has asked about yet -- the first request after the
 * plugin reloaded mid-playback, say -- is looked up in the channel index
 * instead, so a reload does not break a channel that is already playing.
 */
import { Readable } from "node:stream";
import { host } from "./host.js";
import { channelIndex } from "./channels.js";
import { allScrapers } from "./scrapers.js";
/** The same default core sends, so a stream that only needed a Referer
 *  is not also handed a different User-Agent than everything else. */
const DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";
/** A rule outlives its playlist's last refresh by this long. Long enough
 *  for a paused player to resume; short enough that a channel nobody is
 *  watching costs nothing by morning. */
const RULE_TTL_MS = 30 * 60_000;
/** More than every segment of every channel a household plays at once. */
const MAX_RULES = 50_000;
/** A playlist longer than this is not one. Same bound core uses. */
const MAX_PLAYLIST = 4 * 1024 * 1024;
/** And a segment larger than this is not one either -- a decoder is never
 *  handed an unbounded download to hold in memory. */
const MAX_SEGMENT = 64 * 1024 * 1024;
/** Enough to tell a playlist from anything else. */
const PEEK = 8 * 1024;
const rules = new Map();
/** Whether this mirror needs the relay at all. Most do not. */
export function needsRelay(stream) {
    return Boolean(stream.referrer || stream.userAgent || stream.decoder);
}
function ruleOf(stream) {
    return {
        referrer: stream.referrer,
        userAgent: stream.userAgent,
        decoder: stream.decoder ? { scraper: stream.source, name: stream.decoder } : undefined,
        at: Date.now()
    };
}
function remember(url, rule) {
    /*
        Re-inserted rather than updated in place, so the Map's insertion
        order stays "least recently confirmed first" and the cap below can
        drop from the front without sorting anything.
    */
    rules.delete(url);
    rules.set(url, { ...rule, at: Date.now() });
    if (rules.size <= MAX_RULES)
        return;
    for (const key of rules.keys()) {
        rules.delete(key);
        if (rules.size <= MAX_RULES * 0.9)
            break;
    }
}
/**
 * Make a mirror's playlist known before the player asks for it -- called
 * with every stream `streamsFor` hands to core.
 */
export function registerStream(stream) {
    if (needsRelay(stream))
        remember(stream.url, ruleOf(stream));
}
/** For tests: forget every rule. */
export function resetRelayForTest() {
    rules.clear();
}
async function ruleFor(url) {
    const known = rules.get(url);
    if (known && Date.now() - known.at < RULE_TTL_MS)
        return known;
    if (known)
        rules.delete(url);
    /*
        NOT IN THE TABLE: maybe a channel's own playlist, asked for by a
        player that started before this plugin instance did. Answered from
        the index, through a map of only the mirrors that need the relay --
        built once per index, because core asks this for EVERY live URL,
        and walking ten thousand channels per segment of an ordinary
        channel would be a cost paid by everybody for the sake of a few.
    */
    const built = await channelIndex();
    if (!built)
        return null;
    let needing = byIndex.get(built);
    if (!needing) {
        needing = new Map();
        for (const channel of built.all) {
            for (const stream of channel.streams)
                if (needsRelay(stream))
                    needing.set(stream.url, stream);
        }
        byIndex.set(built, needing);
    }
    const stream = needing.get(url);
    if (!stream)
        return null;
    const rule = ruleOf(stream);
    remember(url, rule);
    return rule;
}
/** Per index build: the mirrors that need the relay, by URL. */
const byIndex = new WeakMap();
/** Every URI a playlist names, resolved -- bare lines and `URI="..."`
 *  attributes alike (keys and init maps are fetched through the relay
 *  too, and need the same headers). */
function urisOf(text, base) {
    const found = [];
    const add = (uri) => {
        try {
            found.push(new URL(uri, base).href);
        }
        catch {
            /* Not a URL; core leaves the line alone, and so does this. */
        }
    };
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line)
            continue;
        if (line.startsWith("#")) {
            for (const match of line.matchAll(/URI="([^"]*)"/g))
                add(match[1]);
            continue;
        }
        add(line);
    }
    return found;
}
function decoderFor(rule) {
    if (!rule.decoder)
        return null;
    const scraper = allScrapers().find((entry) => entry.id === rule.decoder?.scraper);
    return scraper?.decoders?.[rule.decoder.name] || null;
}
async function readAll(iterator, first, limit) {
    const chunks = [...first];
    let size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    while (true) {
        const next = await iterator.next();
        if (next.done)
            break;
        const chunk = Buffer.from(next.value);
        size += chunk.length;
        if (size > limit)
            return null;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function answer(status, url, type, body) {
    return { status, url, type, length: body.length, body: Readable.from([body]) };
}
/**
 * Core's `liveFetch` hook. `null` for every URL this plugin has no rule
 * for -- which is nearly all of them.
 */
export async function liveFetch(url, options) {
    const rule = await ruleFor(url);
    if (!rule)
        return null;
    const upstream = await host.fetchVia(url, {
        proxy: options.proxy,
        headers: {
            "user-agent": rule.userAgent || DEFAULT_UA,
            ...(rule.referrer ? { referer: rule.referrer } : {})
        }
    });
    const iterator = upstream.body[Symbol.asyncIterator]();
    const peeked = [];
    let size = 0;
    while (size < PEEK) {
        const next = await iterator.next();
        if (next.done)
            break;
        const chunk = Buffer.from(next.value);
        peeked.push(chunk);
        size += chunk.length;
    }
    const head = Buffer.concat(peeked);
    /*
        A PLAYLIST: read it whole, remember everything it names, and hand
        it back as it came. Core rewrites it afterwards, exactly as it
        would one it fetched itself.
    */
    if (head.subarray(0, 1024).toString("utf8").trimStart().startsWith("#EXTM3U")) {
        const whole = await readAll(iterator, [head], MAX_PLAYLIST);
        if (!whole) {
            upstream.body.destroy?.();
            return answer(502, upstream.url, "text/plain", Buffer.from("The channel sent something too large to be a playlist."));
        }
        for (const uri of urisOf(whole.toString("utf8"), upstream.url))
            remember(uri, rule);
        remember(url, rule);
        return answer(upstream.status, upstream.url, "application/vnd.apple.mpegurl", whole);
    }
    const decode = decoderFor(rule);
    /*
        A SEGMENT THAT NEEDS UNWRAPPING: whole, decoded, typed as what it
        now is. An upstream error is passed on as it is -- decoding an error
        page would only turn a clear failure into a confusing one.
    */
    if (decode && upstream.status < 400) {
        const whole = await readAll(iterator, [head], MAX_SEGMENT);
        if (!whole) {
            upstream.body.destroy?.();
            return answer(502, upstream.url, "text/plain", Buffer.from("Segment too large."));
        }
        try {
            const decoded = Buffer.from(await decode(new Uint8Array(whole.buffer, whole.byteOffset, whole.length), url));
            return answer(upstream.status, upstream.url, "video/mp2t", decoded);
        }
        catch (cause) {
            console.error(`live-tv: decoder "${rule.decoder?.name}" of "${rule.decoder?.scraper}" failed on ${url}`, cause);
            return answer(502, upstream.url, "text/plain", Buffer.from("This segment could not be decoded."));
        }
    }
    /*
        ANYTHING ELSE -- a segment that only needed the right headers, a
        key, an error -- passed through as the bytes that arrived, from
        the SAME iterator that produced the head (two readers on one
        socket tear it down; see core's `live.ts`).
    */
    async function* rest() {
        yield head;
        while (true) {
            const next = await iterator.next();
            if (next.done)
                return;
            yield Buffer.from(next.value);
        }
    }
    return { status: upstream.status, url: upstream.url, type: upstream.type, length: upstream.length, body: Readable.from(rest()) };
}
