/**
 * THE WHOLE GUIDE, EVERY 12 HOURS.
 *
 * epg.pw publishes one XMLTV file for every channel it carries (~50 MB
 * gzipped, ~470 MB of XML, ~1.4 million programmes). Every 12 hours this
 * streams it once -- never holding it whole -- and keeps, for each channel
 * in THIS plugin's index that matched a guide channel, the programmes from
 * 12 hours ago to 36 hours ahead. So any channel page opens with its
 * schedule already there, whether or not anybody has looked at it before.
 *
 * Matching is `epg.ts`'s `matchChannel`: exact normalized name, and
 * STRICTLY the same country -- nothing is ever matched across countries,
 * and a channel with no country is not matched at all. Every run records
 * how many of the index's channels matched and how many did not, per
 * country, for the Sources page.
 *
 * Per-channel fetching (`GuideStore` in `epg.ts`) still exists, switched
 * off by default; see `plugin.ts`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { buildIndex, countryCode, matchChannel, parseDirectory } from "./epg.js";
const HOUR = 3_600_000;
export const BULK_EVERY = 12 * HOUR;
const KEEP_BEFORE = 12 * HOUR;
const KEEP_AFTER = 36 * HOUR;
const GUIDE_URL = "https://epg.pw/xmltv/epg.xml.gz";
/** "20261001083000 +0530" -> epoch ms. */
export function parseXmltvTime(value) {
    const found = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(value.trim());
    if (!found)
        return NaN;
    const [, y, mo, d, h, mi, se, sign, oh, om] = found;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0));
    const offset = sign ? (Number(oh || 0) * 60 + Number(om || 0)) * (sign === "-" ? -1 : 1) : 0;
    return utc - offset * 60_000;
}
function unescapeXml(text) {
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, "&")
        .trim();
}
/** One `<programme ...>...</programme>` block, or null. */
export function parseProgramme(block) {
    const head = /<programme\b([^>]*)>/.exec(block);
    if (!head)
        return null;
    const attrs = head[1];
    const channel = /\bchannel="([^"]*)"/.exec(attrs)?.[1];
    const start = parseXmltvTime(/\bstart="([^"]*)"/.exec(attrs)?.[1] || "");
    const stop = parseXmltvTime(/\bstop="([^"]*)"/.exec(attrs)?.[1] || "");
    const title = unescapeXml(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1] || "");
    if (!channel || !title || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start)
        return null;
    const programme = { start, stop, title: title.slice(0, 200) };
    const subtitle = unescapeXml(/<sub-title\b[^>]*>([\s\S]*?)<\/sub-title>/.exec(block)?.[1] || "");
    const description = unescapeXml(/<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(block)?.[1] || "");
    const category = unescapeXml(/<category\b[^>]*>([\s\S]*?)<\/category>/.exec(block)?.[1] || "");
    if (subtitle && subtitle !== title)
        programme.subtitle = subtitle.slice(0, 200);
    if (description && description !== title)
        programme.description = description.slice(0, 300);
    if (category)
        programme.category = category.slice(0, 60);
    return { channel, programme };
}
/** Which of our channels each guide channel feeds, plus the counts. */
export function mapChannels(guide, channels, overrides = {}) {
    const index = buildIndex(guide);
    const feeds = new Map();
    const countries = new Map();
    let matched = 0;
    let noCountry = 0;
    for (const channel of channels) {
        const code = countryCode(channel.country);
        const tally = countries.get(code || "--") || countries.set(code || "--", { code: code || "--", channels: 0, matched: 0 }).get(code || "--");
        tally.channels++;
        let epgId;
        if (Object.prototype.hasOwnProperty.call(overrides, channel.id)) {
            const pinned = overrides[channel.id];
            epgId = typeof pinned === "string" && pinned ? pinned : null;
        }
        else {
            if (!/^[A-Z]{2}$/.test(code))
                noCountry++;
            epgId = matchChannel(index, channel)?.id ?? null;
        }
        if (!epgId)
            continue;
        matched++;
        tally.matched++;
        (feeds.get(epgId) || feeds.set(epgId, []).get(epgId)).push(channel.id);
    }
    return {
        feeds,
        status: {
            channels: channels.length,
            matched,
            unmatched: channels.length - matched,
            noCountry,
            countries: [...countries.values()].sort((a, b) => b.channels - a.channels)
        }
    };
}
export class BulkGuide {
    options;
    schedules = new Map();
    state = null;
    running = null;
    timer = null;
    halted = false;
    now;
    log;
    constructor(options) {
        this.options = options;
        this.now = options.now || Date.now;
        this.log = options.log || (() => undefined);
        this.read();
    }
    /** The schedule for one of our channels, minus what already ended. */
    programmesFor(channelId) {
        const list = this.schedules.get(channelId);
        if (!list)
            return null;
        const now = this.now();
        const left = list.filter((programme) => programme.stop > now - 6 * HOUR);
        return left.some((programme) => programme.stop > now) ? left : null;
    }
    status() {
        return this.state;
    }
    isRunning() {
        return Boolean(this.running);
    }
    /** Runs now unless a run is already going; resolves when it ends. */
    refresh() {
        if (!this.running) {
            this.running = this.run().finally(() => {
                this.running = null;
            });
        }
        return this.running;
    }
    /** First run soon if the last one is older than 12 hours, then every 12. */
    start(firstAfter = 30_000) {
        this.halted = false;
        this.clearTimer();
        const last = this.state?.at || 0;
        const due = Math.max(firstAfter, last + BULK_EVERY - this.now());
        this.timer = setTimeout(() => void this.tick(), due);
    }
    stop() {
        this.halted = true;
        this.clearTimer();
    }
    async tick() {
        this.timer = null;
        await this.refresh().catch(() => undefined);
        if (!this.halted)
            this.timer = setTimeout(() => void this.tick(), BULK_EVERY);
    }
    clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    overrides() {
        const file = this.options.overridesFile;
        if (!file || !existsSync(file))
            return {};
        try {
            return JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            return {};
        }
    }
    async run() {
        const began = this.now();
        const channels = await this.options.channels();
        const keepFrom = began - KEEP_BEFORE;
        const keepTo = began + KEEP_AFTER;
        const kept = new Map();
        let feeds = new Map();
        let counts = null;
        let guideChannels = 0;
        let programmes = 0;
        try {
            /* Ten minutes: it is a 50 MB download, read as it arrives. */
            const answer = await this.options.fetcher(GUIDE_URL, 10 * 60_000);
            if (!answer.ok || !answer.body)
                throw new Error(`HTTP ${answer.status}`);
            const body = answer.body;
            const gunzip = createGunzip();
            const decoder = new StringDecoder("utf8");
            let buffer = "";
            let head = "";
            let inProgrammes = false;
            await new Promise((resolve, reject) => {
                const fail = (error) => {
                    body.destroy();
                    gunzip.destroy();
                    reject(error);
                };
                gunzip.on("data", (chunk) => {
                    if (this.halted) {
                        fail(new Error("stopped"));
                        return;
                    }
                    buffer += decoder.write(chunk);
                    if (!inProgrammes) {
                        const first = buffer.indexOf("<programme");
                        if (first < 0) {
                            /* Still in the channel list: keep whole entries only. */
                            const cut = buffer.lastIndexOf("</channel>");
                            if (cut >= 0) {
                                head += buffer.slice(0, cut + 10);
                                buffer = buffer.slice(cut + 10);
                            }
                            return;
                        }
                        head += buffer.slice(0, first);
                        buffer = buffer.slice(first);
                        inProgrammes = true;
                        const guide = parseDirectory(head);
                        guideChannels = guide.length;
                        const mapped = mapChannels(guide, channels, this.overrides());
                        feeds = mapped.feeds;
                        counts = mapped.status;
                        head = "";
                    }
                    let from = 0;
                    for (;;) {
                        const end = buffer.indexOf("</programme>", from);
                        if (end < 0)
                            break;
                        const block = buffer.slice(from, end + 12);
                        from = end + 12;
                        /* Cheap check before any parsing: is it one of ours? */
                        const id = /channel="([^"]*)"/.exec(block)?.[1];
                        if (!id || !feeds.has(id))
                            continue;
                        const parsed = parseProgramme(block);
                        if (!parsed || parsed.programme.stop < keepFrom || parsed.programme.start > keepTo)
                            continue;
                        for (const channelId of feeds.get(id)) {
                            (kept.get(channelId) || kept.set(channelId, []).get(channelId)).push(parsed.programme);
                        }
                        programmes++;
                    }
                    buffer = buffer.slice(from);
                });
                gunzip.on("end", () => resolve());
                gunzip.on("error", fail);
                body.on("error", fail);
                body.pipe(gunzip);
            });
            if (!counts)
                throw new Error("the guide had no programmes");
            for (const list of kept.values()) {
                list.sort((a, b) => a.start - b.start);
                /* Overlaps (two listings of one slot) keep the first. */
                for (let at = list.length - 1; at > 0; at--) {
                    if (list[at].start < list[at - 1].stop) {
                        if (list[at].start === list[at - 1].start)
                            list.splice(at, 1);
                        else
                            list[at - 1].stop = list[at].start;
                    }
                }
            }
            this.schedules = kept;
            this.state = {
                at: this.now(),
                ok: true,
                seconds: Math.round((this.now() - began) / 1000),
                guideChannels,
                programmes,
                ...counts
            };
            this.log(`[epg] guide: ${this.state.matched}/${this.state.channels} channels matched, ${programmes} programmes, ${this.state.seconds}s`);
        }
        catch (error) {
            const message = error.message;
            this.log(`[epg] guide fetch failed: ${message}`);
            /* A failed run keeps the schedules already held. */
            this.state = {
                ...(this.state || {
                    guideChannels: 0,
                    programmes: 0,
                    channels: channels.length,
                    matched: 0,
                    unmatched: channels.length,
                    noCountry: 0,
                    countries: []
                }),
                at: this.now(),
                ok: false,
                error: message,
                seconds: Math.round((this.now() - began) / 1000)
            };
        }
        this.write();
    }
    read() {
        const file = this.options.file;
        if (!file || !existsSync(file))
            return;
        try {
            const stored = JSON.parse(readFileSync(file, "utf8"));
            this.state = stored.status || null;
            this.schedules = new Map(Object.entries(stored.schedules || {}));
        }
        catch (error) {
            this.log(`[epg] could not read ${file}: ${error.message}`);
        }
    }
    write() {
        const file = this.options.file;
        if (!file)
            return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, JSON.stringify({ status: this.state ?? undefined, schedules: Object.fromEntries(this.schedules) }));
            renameSync(`${file}.tmp`, file);
        }
        catch (error) {
            this.log(`[epg] could not write ${file}: ${error.message}`);
        }
    }
}
