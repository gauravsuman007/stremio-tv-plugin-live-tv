/**
 * WHAT IS ON: a channel's programme schedule, fetched one channel at a time.
 *
 * Source: epg.pw, a free guide covering ~15,000 channels in ~20 countries,
 * with a per-channel JSON API -- so this never downloads a whole country's
 * guide to answer for one channel.
 *
 * DYNAMIC, WITH A WARM SET
 * ------------------------
 * - A schedule is fetched the first time a channel is opened or played, and
 *   kept until EITHER its timeline runs out (the last programme it knows
 *   ended) OR it is more than 12 hours old at the moment it is asked for
 *   again. Nothing is refreshed for a channel nobody looks at.
 * - A first fetch costs about a second (two small requests, in parallel), so
 *   the LAST 50 CHANNELS anyone opened or played are refreshed every 12
 *   hours in the background, one at a time: those are the channels someone
 *   is likely to open again, and they open with the guide already there.
 * - The channel directory (id + name + country for every guide channel) is
 *   read once a week from the head of epg.pw's full XMLTV file -- the
 *   <channel> entries come first, so the read stops at the first
 *   <programme> and is ~2 MB, not the 50 MB file.
 *
 * TIME ZONES
 * ----------
 * Every time held here is an absolute instant (epoch ms). The API is asked
 * for UTC and every timestamp it returns carries its own offset, which
 * `Date.parse` honours, so the server's own zone never enters into it. The
 * only text this module writes about time is RELATIVE ("35 min left",
 * "in 20 min"), which is the same in every zone; clock times are left to
 * whoever draws them for a viewer whose zone they know.
 *
 * MATCHING, AND WHY SIMILAR NAMES STAY APART
 * ------------------------------------------
 * A channel is matched to a guide entry only on an EXACT normalized name in
 * the SAME country (see `epgKey`). Normalizing removes spelling noise only
 * ("SkyDramaHD" = "Sky Drama HD", "BBC 1" = "BBC One", "Colors TV" =
 * "Colors") and deliberately keeps every word that tells two channels
 * apart: "Star Sports 1" never matches "Star Sports 1 Hindi", "Sky Cinema"
 * never matches "Sky Cinema Action", "Quest" never matches "Quest +1". A
 * channel with no country matches only a name that is unique across the
 * whole directory. No match means no guide -- a wrong guide is worse than
 * none. `<configDir>/epg-overrides.json` (`{"<channel id>": "<epg.pw id>"
 * | null}`) pins or blocks any channel by hand.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
const API = "https://epg.pw/api/epg.json";
const DIRECTORY_URL = "https://epg.pw/xmltv/epg.xml.gz";
const HOUR = 3_600_000;
/** A schedule older than this is refetched when next asked for. */
export const STALE_AFTER = 12 * HOUR;
/** How often the warm set is refreshed, and how big it is. */
const WARM_EVERY = 12 * HOUR;
const WARM_SIZE = 50;
const DIRECTORY_STALE_AFTER = 7 * 24 * HOUR;
/** After a failed fetch, the same channel is not asked about again for this long. */
const RETRY_AFTER = 15 * 60_000;
/** A programme with nothing after it in the window has no known end; one
 *  longer than this is cut, so a gap in the source never reads as one
 *  programme lasting a day. */
const LONGEST_PROGRAMME = 8 * HOUR;
const REQUEST_TIMEOUT = 8_000;
/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */
const NUMBER_WORDS = {
    one: "1", two: "2", three: "3", four: "4", five: "5",
    six: "6", seven: "7", eight: "8", nine: "9", ten: "10"
};
/** Words that never tell two channels apart: picture quality, and "TV". */
const FILLER = new Set(["tv", "channel", "the", "hd", "fhd", "uhd", "sd", "hq", "4k", "8k", "hevc"]);
/**
 * The comparison key for a channel name. See the file header: spelling is
 * flattened, distinguishing words (numbers, "+1", regions, languages,
 * "kids", "action") are all kept.
 */
export function epgKey(name) {
    let text = String(name || "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        /* A timeshift is part of the identity: "Quest +1" is not "Quest". */
        .replace(/\+\s*(\d+)/g, " plus$1 ")
        .replace(/\+/g, " plus ")
        .replace(/&/g, " and ")
        /* "SkyDramaHD" -> "Sky Drama HD", "BBC1" -> "BBC 1". */
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])(\d)/g, "$1 $2")
        .replace(/(\d)([A-Za-z])/g, (whole, digit, letter, at, all) => /^[kK]\b/.test(all.slice(at + 1)) ? whole : `${digit} ${letter}`)
        .toLowerCase();
    text = text.replace(/[^a-z0-9]+/g, " ").trim();
    const tokens = text
        .split(" ")
        .filter(Boolean)
        .map((token) => NUMBER_WORDS[token] || token);
    const meaningful = tokens.filter((token) => !FILLER.has(token));
    /* "TV 2" / "Channel 4": with the filler gone only a bare number is
       left, which would collide -- keep the name whole instead. */
    if (!meaningful.length || meaningful.every((token) => /^\d+$/.test(token)))
        return tokens.join(" ");
    return meaningful.join(" ");
}
/** Whether a raw name advertises HD -- used only to choose between the
 *  SD and HD listing of what is otherwise the same channel. */
function saysHd(name) {
    return /(hd|uhd|fhd|4k)\b/i.test(name.replace(/([a-z])(HD)\b/g, "$1 $2"));
}
/** iptv-org writes the United Kingdom as "UK"; everybody else as "GB". */
export function countryCode(raw) {
    const code = String(raw || "").trim().toUpperCase();
    return code === "UK" ? "GB" : code;
}
export function buildIndex(channels) {
    const byCountry = new Map();
    const byKey = new Map();
    for (const channel of channels) {
        const key = epgKey(channel.name);
        if (!key)
            continue;
        const country = countryCode(channel.country);
        let keys = byCountry.get(country);
        if (!keys)
            byCountry.set(country, (keys = new Map()));
        (keys.get(key) || keys.set(key, []).get(key)).push(channel);
        (byKey.get(key) || byKey.set(key, []).get(key)).push(channel);
    }
    return { byCountry, byKey };
}
/**
 * The guide channel for one of ours, or null. Exact key, same country; a
 * channel with no country only when the name is unique worldwide. Several
 * listings of the same name in one country are the same channel listed
 * twice (SD and HD, two providers): the one whose HD-ness matches wins,
 * then the lowest id, so the choice never changes between runs.
 */
export function matchChannel(index, subject) {
    const key = epgKey(subject.name);
    if (!key)
        return null;
    const country = countryCode(subject.country);
    let candidates;
    if (country) {
        candidates = index.byCountry.get(country)?.get(key) || [];
    }
    else {
        const everywhere = index.byKey.get(key) || [];
        const countries = new Set(everywhere.map((channel) => countryCode(channel.country)));
        candidates = countries.size === 1 ? everywhere : [];
    }
    if (!candidates.length)
        return null;
    const hd = saysHd(subject.name);
    return [...candidates].sort((a, b) => Number(saysHd(a.name) !== hd) - Number(saysHd(b.name) !== hd) ||
        Number(a.id) - Number(b.id) ||
        a.id.localeCompare(b.id))[0];
}
/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */
function unescapeXml(text) {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, "&");
}
/** The <channel> entries of an XMLTV document (or of its head). */
export function parseDirectory(xml) {
    const out = [];
    const pattern = /<channel\s+id="([^"]+)"\s*>([\s\S]*?)<\/channel>/g;
    let found;
    while ((found = pattern.exec(xml))) {
        const body = found[2];
        const display = /<display-name(?:\s+lang="([^"]*)")?\s*>([\s\S]*?)<\/display-name>/.exec(body);
        if (!display)
            continue;
        const name = unescapeXml(display[2].trim());
        if (name)
            out.push({ id: unescapeXml(found[1]), name, country: countryCode(display[1] || "") });
    }
    return out;
}
/**
 * epg.pw's answers (one or more days) into one ordered schedule. The API
 * gives each programme's START only; each one ends where the next begins,
 * and the last one -- whose end nobody said -- is dropped.
 */
export function parseSchedule(answers, now = Date.now()) {
    const byStart = new Map();
    for (const answer of answers) {
        const list = answer?.epg_list;
        if (!Array.isArray(list))
            continue;
        for (const item of list) {
            const start = Date.parse(String(item?.start_date || ""));
            if (Number.isFinite(start) && typeof item.title === "string" && item.title.trim())
                byStart.set(start, item);
        }
    }
    const starts = [...byStart.keys()].sort((a, b) => a - b);
    const programmes = [];
    for (let at = 0; at < starts.length - 1; at++) {
        const start = starts[at];
        const stop = Math.min(starts[at + 1], start + LONGEST_PROGRAMME);
        const item = byStart.get(start);
        if (stop <= now - HOUR)
            continue;
        const programme = { start, stop, title: String(item.title).trim() };
        const description = typeof item.desc === "string" ? item.desc.trim() : "";
        if (description)
            programme.description = description;
        programmes.push(programme);
    }
    return programmes;
}
/* ------------------------------------------------------------------ */
/* Freshness                                                           */
/* ------------------------------------------------------------------ */
/**
 * Whether a cached schedule can be answered as is: younger than 12 hours
 * AND its timeline has not run out. See the file header.
 */
export function isFresh(entry, now = Date.now()) {
    if (!entry)
        return false;
    if (entry.retryAt && now < entry.retryAt)
        return true;
    if (now - entry.fetchedAt >= STALE_AFTER)
        return false;
    if (entry.epgId === null)
        return true;
    const last = entry.programmes[entry.programmes.length - 1];
    return Boolean(last && last.stop > now);
}
/** The programme on now and the one after, by absolute time. */
export function nowAndNext(programmes, now = Date.now()) {
    const index = programmes.findIndex((programme) => programme.start <= now && now < programme.stop);
    if (index >= 0)
        return { now: programmes[index], next: programmes[index + 1] };
    return { next: programmes.find((programme) => programme.start > now) };
}
function minutes(ms) {
    const total = Math.max(1, Math.ceil(ms / 60_000));
    if (total < 60)
        return `${total} min`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
/**
 * One line for a page that can only take text: "Now: X · 35 min left ·
 * Next: Y". Relative times only, so it reads the same in every time zone.
 */
export function nowLine(programmes, now = Date.now()) {
    const { now: on, next } = nowAndNext(programmes, now);
    const parts = [];
    if (on)
        parts.push(`Now: ${on.title}`, `${minutes(on.stop - now)} left`);
    if (next)
        parts.push(on ? `Next: ${next.title}` : `Next: ${next.title} in ${minutes(next.start - now)}`);
    return parts.join(" · ");
}
const defaultFetcher = async (url) => {
    const answer = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: { accept: "application/json, application/xml;q=0.9, */*;q=0.1" }
    });
    let wrapped;
    /* `body` is read lazily: wrapping it locks the response, after which
       `text()` can no longer read it. */
    return {
        ok: answer.ok,
        status: answer.status,
        get body() {
            wrapped ??= answer.body ? Readable.fromWeb(answer.body) : null;
            return wrapped;
        },
        text: () => answer.text()
    };
};
function utcDay(ms) {
    const day = new Date(ms);
    return `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}`;
}
export class GuideStore {
    options;
    entries = new Map();
    inFlight = new Map();
    recent = [];
    directory = null;
    index = null;
    directoryLoad = null;
    directoryRetryAt = 0;
    writeTimer = null;
    warmTimer = null;
    halted = false;
    fetcher;
    now;
    log;
    constructor(options) {
        this.options = options;
        this.fetcher = options.fetcher || defaultFetcher;
        this.now = options.now || Date.now;
        this.log = options.log || (() => undefined);
        this.read();
    }
    /**
     * The schedule for one of this plugin's channels: from the cache when
     * it is fresh, otherwise fetched (once, however many ask at the same
     * time). `remember` puts the channel at the front of the warm set.
     */
    async programmesFor(channelId, remember = true) {
        if (remember)
            this.remember(channelId);
        const cached = this.entries.get(channelId);
        if (isFresh(cached, this.now()))
            return cached && cached.programmes.length ? this.current(cached.programmes) : null;
        let pending = this.inFlight.get(channelId);
        if (!pending) {
            pending = this.refresh(channelId).finally(() => this.inFlight.delete(channelId));
            this.inFlight.set(channelId, pending);
        }
        return pending;
    }
    /** Whatever is cached right now, without fetching -- for a caller that
     *  cannot wait. Kicks off a fetch in the background when stale. */
    peek(channelId) {
        const cached = this.entries.get(channelId);
        if (!isFresh(cached, this.now()))
            void this.programmesFor(channelId, false).catch(() => undefined);
        return cached && cached.programmes.length ? this.current(cached.programmes) : null;
    }
    /** The channels in the warm set, most recent first. */
    recentChannels() {
        return [...this.recent];
    }
    remember(channelId) {
        if (this.recent[0] === channelId)
            return;
        this.recent = [channelId, ...this.recent.filter((id) => id !== channelId)].slice(0, WARM_SIZE);
        this.scheduleWrite();
    }
    /** Starts the 12-hourly refresh of the warm set; the first pass runs
     *  `firstAfter` ms from now. */
    startWarming(firstAfter = 2 * 60_000) {
        this.halted = false;
        this.stopWarmTimer();
        const pass = async () => {
            this.warmTimer = null;
            try {
                await this.warm();
            }
            catch (error) {
                this.log(`[epg] warm pass failed: ${error.message}`);
            }
            if (!this.halted)
                this.warmTimer = setTimeout(() => void pass(), WARM_EVERY);
        };
        this.warmTimer = setTimeout(() => void pass(), firstAfter);
    }
    /** One pass over the warm set: every stale schedule, one at a time. */
    async warm() {
        let fetched = 0;
        for (const channelId of [...this.recent]) {
            if (this.halted)
                break;
            if (isFresh(this.entries.get(channelId), this.now()))
                continue;
            await this.programmesFor(channelId, false).catch(() => null);
            fetched++;
            if (!this.halted)
                await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return fetched;
    }
    /** Stops the warm timer and any pass in flight, and writes the cache. */
    stop() {
        this.halted = true;
        this.stopWarmTimer();
        this.flush();
    }
    flush() {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        this.write();
    }
    /* ---------------------------------------------------------------- */
    stopWarmTimer() {
        if (this.warmTimer) {
            clearTimeout(this.warmTimer);
            this.warmTimer = null;
        }
    }
    /** Only what has not ended yet. */
    current(programmes) {
        const now = this.now();
        return programmes.filter((programme) => programme.stop > now);
    }
    async refresh(channelId) {
        const now = this.now();
        const epgId = await this.epgIdFor(channelId);
        if (epgId === undefined) {
            /* The directory itself could not be read: try again later,
               and keep whatever schedule was already held meanwhile. */
            const old = this.entries.get(channelId);
            return old ? this.current(old.programmes) : null;
        }
        if (epgId === null) {
            this.entries.set(channelId, { epgId: null, fetchedAt: now, programmes: [] });
            this.scheduleWrite();
            return null;
        }
        try {
            const base = `${API}?channel_id=${encodeURIComponent(epgId)}&timezone=UTC`;
            /* "Yesterday" (UTC) covers the programme already running just
               after midnight UTC; the default answer is today and tomorrow. */
            const answers = await Promise.all([`${base}&date=${utcDay(now - 24 * HOUR)}`, base].map(async (url) => {
                const answer = await this.fetcher(url);
                if (!answer.ok)
                    throw new Error(`HTTP ${answer.status}`);
                return JSON.parse(await answer.text());
            }));
            const programmes = parseSchedule(answers, now);
            this.entries.set(channelId, { epgId, fetchedAt: now, programmes });
            this.scheduleWrite();
            return programmes.length ? this.current(programmes) : null;
        }
        catch (error) {
            this.log(`[epg] ${channelId} (${epgId}): ${error.message}`);
            const old = this.entries.get(channelId);
            this.entries.set(channelId, {
                epgId,
                fetchedAt: old?.fetchedAt || 0,
                programmes: old?.programmes || [],
                retryAt: now + RETRY_AFTER
            });
            return old ? this.current(old.programmes) : null;
        }
    }
    /** undefined = the directory is unavailable; null = no match. */
    async epgIdFor(channelId) {
        const overrides = this.overrides();
        if (Object.prototype.hasOwnProperty.call(overrides, channelId)) {
            const pinned = overrides[channelId];
            return typeof pinned === "string" && pinned ? pinned : null;
        }
        const subject = await this.options.lookup(channelId);
        if (!subject)
            return null;
        const index = await this.loadIndex();
        if (!index)
            return undefined;
        return matchChannel(index, subject)?.id ?? null;
    }
    overrides() {
        const file = this.options.overridesFile;
        if (!file || !existsSync(file))
            return {};
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            return parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            return {};
        }
    }
    async loadIndex() {
        const now = this.now();
        if (this.index && this.directory && now - this.directory.fetchedAt < DIRECTORY_STALE_AFTER)
            return this.index;
        if (now < this.directoryRetryAt)
            return this.index;
        if (!this.directoryLoad) {
            this.directoryLoad = this.fetchDirectory()
                .then((channels) => {
                this.directory = { fetchedAt: this.now(), channels };
                this.index = buildIndex(channels);
                /* A new directory can change any match. */
                for (const [id, entry] of this.entries)
                    if (entry.epgId === null)
                        this.entries.delete(id);
                this.scheduleWrite();
                return this.index;
            })
                .catch((error) => {
                this.log(`[epg] directory: ${error.message}`);
                this.directoryRetryAt = this.now() + RETRY_AFTER;
                /* An old directory is far better than none. */
                return this.index;
            })
                .finally(() => {
                this.directoryLoad = null;
            });
        }
        return this.directoryLoad;
    }
    /** The head of the full XMLTV file, up to the first programme. */
    async fetchDirectory() {
        const answer = await this.fetcher(DIRECTORY_URL);
        if (!answer.ok || !answer.body)
            throw new Error(`HTTP ${answer.status}`);
        const body = answer.body;
        const gunzip = createGunzip();
        let text = "";
        await new Promise((resolve, reject) => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                body.unpipe(gunzip);
                body.destroy();
                gunzip.destroy();
                resolve();
            };
            gunzip.on("data", (chunk) => {
                text += chunk.toString("utf8");
                const end = text.indexOf("<programme");
                if (end >= 0) {
                    text = text.slice(0, end);
                    finish();
                }
                else if (text.length > 20_000_000) {
                    finish();
                }
            });
            gunzip.on("end", finish);
            gunzip.on("error", (error) => (done ? undefined : reject(error)));
            body.on("error", (error) => (done ? undefined : reject(error)));
            body.pipe(gunzip);
        });
        const channels = parseDirectory(text);
        if (!channels.length)
            throw new Error("no channels in the guide directory");
        return channels;
    }
    read() {
        const file = this.options.file;
        if (!file || !existsSync(file))
            return;
        try {
            const stored = JSON.parse(readFileSync(file, "utf8"));
            if (stored.directory && Array.isArray(stored.directory.channels)) {
                this.directory = stored.directory;
                this.index = buildIndex(stored.directory.channels);
            }
            for (const [id, entry] of Object.entries(stored.entries || {})) {
                if (entry && Array.isArray(entry.programmes))
                    this.entries.set(id, entry);
            }
            this.recent = Array.isArray(stored.recent) ? stored.recent.filter((id) => typeof id === "string").slice(0, WARM_SIZE) : [];
        }
        catch (error) {
            this.log(`[epg] could not read ${file}: ${error.message}`);
        }
    }
    scheduleWrite() {
        if (!this.options.file || this.writeTimer)
            return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.write();
        }, 5_000);
    }
    write() {
        const file = this.options.file;
        if (!file)
            return;
        const now = this.now();
        const keep = new Set(this.recent);
        const entries = {};
        /* Only the warm set and anything still running is worth a disk. */
        for (const [id, entry] of this.entries) {
            const last = entry.programmes[entry.programmes.length - 1];
            if (keep.has(id) || (last && last.stop > now))
                entries[id] = entry;
        }
        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify({ directory: this.directory || undefined, entries, recent: this.recent }));
        }
        catch (error) {
            this.log(`[epg] could not write ${file}: ${error.message}`);
        }
    }
}
