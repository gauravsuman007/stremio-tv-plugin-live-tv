/**
 * THE WHOLE GUIDE, EVERY 12 HOURS -- in two tiers.
 *
 * 1. BY ID (exact). iptv-org's own mapping (`epg-ids.ts`) says which bulk
 *    XMLTV file carries an iptv-org channel and under which id. The files
 *    that publish one downloadable guide -- i.mjh.nz (Plex, Pluto, Samsung,
 *    Roku, PBS, Sky Go, Foxtel, the Australian cities...) and
 *    epg.iptvx.one -- are streamed once each, and a channel is matched by
 *    that id. Nothing is compared by name, so look-alikes cannot mix.
 * 2. BY NAME (guarded). epg.pw publishes one XMLTV file for every channel it
 *    carries (~50 MB gzipped, ~1.4 million programmes), streamed once. A
 *    channel with no ID-mapped schedule is matched by `epg.ts`'s
 *    `matchChannel`: exact name, STRICTLY the same country, and the other
 *    rules in that file's header.
 *
 * Either way each file is streamed, never held whole, and only the
 * programmes of channels in THIS plugin's index from 12 hours ago to 36
 * hours ahead are kept, so any channel page opens with its schedule already
 * there. Every run records how many channels matched, by which tier and in
 * which country, for the Sources page.
 *
 * Per-channel fetching (`GuideStore` in `epg.ts`) runs on top of this for a
 * channel neither tier covered; see `plugin.ts`.
 */


import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

import { buildIndex, countryCode, matchChannel, parseDirectory, type Fetcher, type GuideChannel, type GuideSubject } from "./epg.js";
import { GUIDES_URL, buildLinks, type GuideLink, type LinkTable } from "./epg-ids.js";
import type { SiteLink } from "./epg-sites.js";
import type { Programme } from "./plugin-types.js";

const HOUR = 3_600_000;
export const BULK_EVERY = 12 * HOUR;
const KEEP_BEFORE = 12 * HOUR;
const KEEP_AFTER = 36 * HOUR;
const GUIDE_URL = "https://epg.pw/xmltv/epg.xml.gz";
/** guides.json is ~25 MB: the supported rows are kept for a week. */
const LINKS_STALE_AFTER = 7 * 24 * HOUR;

export interface CountryMatch {
    code: string;
    channels: number;
    matched: number;
}

export interface BulkStatus {
    /** When the last run finished (ok or not); 0 = never. */
    at: number;
    ok: boolean;
    error?: string;
    seconds: number;
    /** Guide channels in the file, and programmes kept. */
    guideChannels: number;
    programmes: number;
    /** This plugin's channels at the time of the run. */
    channels: number;
    matched: number;
    unmatched: number;
    /** Of the unmatched: how many had no country, so could not be tried. */
    noCountry: number;
    /** Of the unmatched: how many are in a country the guide has no
     *  channels for at all, so there was nothing to match against. */
    uncovered?: number;
    /** Of the matched: how many were matched by iptv-org's own id, and how
     *  many bulk guide files were read (and how many of those failed). */
    byId?: number;
    sources?: { ok: number; failed: number };
    countries: CountryMatch[];
}

/** "20261001083000 +0530" -> epoch ms. */
export function parseXmltvTime(value: string): number {
    const found = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(value.trim());

    if (!found) return NaN;

    const [, y, mo, d, h, mi, se, sign, oh, om] = found;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0));
    const offset = sign ? (Number(oh || 0) * 60 + Number(om || 0)) * (sign === "-" ? -1 : 1) : 0;

    return utc - offset * 60_000;
}

function unescapeXml(text: string): string {
    return text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, "&")
        .trim();
}

/** One `<programme ...>...</programme>` block, or null. */
export function parseProgramme(block: string): { channel: string; programme: Programme } | null {
    const head = /<programme\b([^>]*)>/.exec(block);

    if (!head) return null;

    const attrs = head[1] as string;
    const channel = /\bchannel="([^"]*)"/.exec(attrs)?.[1];
    const start = parseXmltvTime(/\bstart="([^"]*)"/.exec(attrs)?.[1] || "");
    const stop = parseXmltvTime(/\bstop="([^"]*)"/.exec(attrs)?.[1] || "");
    const title = unescapeXml(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1] || "");

    if (!channel || !title || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return null;

    const programme: Programme = { start, stop, title: title.slice(0, 200) };
    const subtitle = unescapeXml(/<sub-title\b[^>]*>([\s\S]*?)<\/sub-title>/.exec(block)?.[1] || "");
    const description = unescapeXml(/<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(block)?.[1] || "");
    const category = unescapeXml(/<category\b[^>]*>([\s\S]*?)<\/category>/.exec(block)?.[1] || "");

    if (subtitle && subtitle !== title) programme.subtitle = subtitle.slice(0, 200);
    if (description && description !== title) programme.description = description.slice(0, 300);
    if (category) programme.category = category.slice(0, 60);

    return { channel, programme };
}

/** Which of our channels each guide channel feeds, plus the counts. */
export function mapChannels(
    guide: ReturnType<typeof parseDirectory>,
    channels: GuideSubject[],
    overrides: Record<string, string | null> = {}
): { feeds: Map<string, string[]>; status: Pick<BulkStatus, "channels" | "matched" | "unmatched" | "noCountry" | "uncovered" | "countries"> } {
    const index = buildIndex(guide);
    const feeds = new Map<string, string[]>();
    const countries = new Map<string, CountryMatch>();
    const guideCountries = new Set(guide.map((entry) => countryCode(entry.country)));
    let matched = 0;
    let noCountry = 0;
    let uncovered = 0;

    for (const channel of channels) {
        const code = countryCode(channel.country);
        const tally = countries.get(code || "--") || countries.set(code || "--", { code: code || "--", channels: 0, matched: 0 }).get(code || "--")!;

        tally.channels++;

        let epgId: string | null;

        if (Object.prototype.hasOwnProperty.call(overrides, channel.id)) {
            const pinned = overrides[channel.id];

            epgId = typeof pinned === "string" && pinned ? pinned : null;
        } else {
            if (!/^[A-Z]{2}$/.test(code)) noCountry++;

            epgId = matchChannel(index, channel)?.id ?? null;
        }

        if (!epgId) {
            if (/^[A-Z]{2}$/.test(code) && !guideCountries.has(code)) uncovered++;

            continue;
        }

        matched++;
        tally.matched++;
        (feeds.get(epgId) || feeds.set(epgId, []).get(epgId)!).push(channel.id);
    }

    return {
        feeds,
        status: {
            channels: channels.length,
            matched,
            unmatched: channels.length - matched,
            noCountry,
            uncovered,
            countries: [...countries.values()].sort((a, b) => b.channels - a.channels)
        }
    };
}

export interface BulkGuideOptions {
    /** Where schedules and the last status are kept; "" = memory only. */
    file: string;
    overridesFile?: string;
    /** Where iptv-org's guide mapping is kept; "" = memory only. */
    linksFile?: string;
    fetcher: Fetcher;
    /** Every channel in this plugin's index, right now. */
    channels: () => Promise<GuideSubject[]>;
    now?: () => number;
    log?: (line: string) => void;
}

interface BulkFile {
    status?: BulkStatus;
    schedules?: Record<string, Programme[]>;
}

/** The iptv-org id inside one of this plugin's channel ids, or "". */
export function iptvOrgId(channelId: string): string {
    return channelId.startsWith("iptv:") ? channelId.slice(5) : "";
}

/** Overlaps (two listings of one slot) keep the first; a programme that
 *  runs into the next is cut where the next begins. */
function tidy(list: Programme[]): void {
    list.sort((a, b) => a.start - b.start);

    for (let at = list.length - 1; at > 0; at--) {
        if ((list[at] as Programme).start < (list[at - 1] as Programme).stop) {
            if ((list[at] as Programme).start === (list[at - 1] as Programme).start) list.splice(at, 1);
            else (list[at - 1] as Programme).stop = (list[at] as Programme).start;
        }
    }
}

interface StreamJob {
    fetcher: Fetcher;
    url: string;
    /** From the guide's own channel list to which guide channel feeds
     *  which of ours. */
    resolve: (guide: GuideChannel[]) => Map<string, string[]>;
    keepFrom: number;
    keepTo: number;
    halted: () => boolean;
    timeoutMs: number;
}

/**
 * One XMLTV file, read as it arrives: its channel list first (the head),
 * then each programme, kept only when its channel feeds one of ours and it
 * falls inside the window. Resolves with the kept schedules by OUR id.
 */
async function streamGuide(job: StreamJob): Promise<{ guideChannels: number; kept: Map<string, Programme[]>; programmes: number }> {
    const answer = await job.fetcher(job.url, job.timeoutMs);

    if (!answer.ok || !answer.body) throw new Error(`HTTP ${answer.status}`);

    const body = answer.body;
    const gunzip = createGunzip();
    const decoder = new StringDecoder("utf8");
    const kept = new Map<string, Programme[]>();
    let feeds = new Map<string, string[]>();
    let buffer = "";
    let head = "";
    let inProgrammes = false;
    let guideChannels = 0;
    let programmes = 0;

    await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => {
            body.destroy();
            gunzip.destroy();
            reject(error);
        };

        gunzip.on("data", (chunk: Buffer) => {
            if (job.halted()) {
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
                feeds = job.resolve(guide);
                head = "";
            }

            let from = 0;

            for (;;) {
                const end = buffer.indexOf("</programme>", from);

                if (end < 0) break;

                const block = buffer.slice(from, end + 12);

                from = end + 12;

                /* Cheap check before any parsing: is it one of ours? */
                const raw = /channel="([^"]*)"/.exec(block)?.[1];
                const id = raw && raw.includes("&") ? unescapeXml(raw) : raw;

                if (!id || !feeds.has(id)) continue;

                const parsed = parseProgramme(block);

                if (!parsed || parsed.programme.stop < job.keepFrom || parsed.programme.start > job.keepTo) continue;

                for (const channelId of feeds.get(id) as string[]) {
                    (kept.get(channelId) || kept.set(channelId, []).get(channelId)!).push({ ...parsed.programme });
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

    return { guideChannels, kept, programmes };
}

export class BulkGuide {
    private schedules = new Map<string, Programme[]>();
    private state: BulkStatus | null = null;
    private linkTable: LinkTable | null = null;
    private running: Promise<void> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private halted = false;
    private readonly now: () => number;
    private readonly log: (line: string) => void;

    constructor(private readonly options: BulkGuideOptions) {
        this.now = options.now || Date.now;
        this.log = options.log || (() => undefined);
        this.read();
    }

    /** The schedule for one of our channels, minus what already ended. */
    programmesFor(channelId: string): Programme[] | null {
        const list = this.schedules.get(channelId);

        if (!list) return null;

        const now = this.now();
        const left = list.filter((programme) => programme.stop > now - 6 * HOUR);

        return left.some((programme) => programme.stop > now) ? left : null;
    }

    status(): BulkStatus | null {
        return this.state;
    }

    /** The sites with a per-channel API that iptv-org links this channel
     *  to (`epg-sites.ts`); none until iptv-org's mapping has been read. */
    siteLinksFor(channelId: string): SiteLink[] {
        const id = iptvOrgId(channelId);

        return (id && this.linkTable?.dynamic?.[id]) || [];
    }

    isRunning(): boolean {
        return Boolean(this.running);
    }

    /** Runs now unless a run is already going; resolves when it ends. */
    refresh(): Promise<void> {
        if (!this.running) {
            this.running = this.run().finally(() => {
                this.running = null;
            });
        }

        return this.running;
    }

    /** First run soon if the last one is older than 12 hours, then every 12. */
    start(firstAfter = 30_000): void {
        this.halted = false;
        this.clearTimer();

        const last = this.state?.at || 0;
        const due = Math.max(firstAfter, last + BULK_EVERY - this.now());

        this.timer = setTimeout(() => void this.tick(), due);
    }

    stop(): void {
        this.halted = true;
        this.clearTimer();
    }

    private async tick(): Promise<void> {
        this.timer = null;
        await this.refresh().catch(() => undefined);

        if (!this.halted) this.timer = setTimeout(() => void this.tick(), BULK_EVERY);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private overrides(): Record<string, string | null> {
        const file = this.options.overridesFile;

        if (!file || !existsSync(file)) return {};

        try {
            return JSON.parse(readFileSync(file, "utf8")) as Record<string, string | null>;
        } catch {
            return {};
        }
    }

    /** iptv-org's guide mapping: from disk when under a week old, else
     *  fetched; an old copy is better than none when the fetch fails. */
    private async links(): Promise<LinkTable | null> {
        /* A table written before per-channel sites existed has no `dynamic`. */
        if (this.linkTable?.dynamic && this.now() - this.linkTable.fetchedAt < LINKS_STALE_AFTER) return this.linkTable;

        try {
            const answer = await this.options.fetcher(GUIDES_URL, 2 * 60_000);

            if (!answer.ok) throw new Error(`HTTP ${answer.status}`);

            const table = buildLinks(JSON.parse(await answer.text()) as unknown, this.now());

            if (!Object.keys(table.links).length) throw new Error("no usable rows");

            this.linkTable = table;
            this.writeLinks();
        } catch (error) {
            this.log(`[epg] iptv-org guide mapping: ${(error as Error).message}${this.linkTable ? " (using the old copy)" : ""}`);
        }

        return this.linkTable;
    }

    private async run(): Promise<void> {
        const began = this.now();
        const channels = await this.options.channels();
        const keepFrom = began - KEEP_BEFORE;
        const keepTo = began + KEEP_AFTER;
        const idCandidates = new Map<string, { url: string; list: Programme[] }[]>();
        const byChannel = new Map(channels.map((channel) => [channel.id, channel]));
        const overrides = this.overrides();
        const nameKept = new Map<string, Programme[]>();
        let nameCounts: ReturnType<typeof mapChannels>["status"] | null = null;
        let guideChannels = 0;
        let programmes = 0;
        let sourcesOk = 0;
        let sourcesFailed = 0;

        try {
            /* TIER 1: by iptv-org id, one file at a time. */
            const table = channels.some((channel) => iptvOrgId(channel.id)) ? await this.links() : null;
            const perFile = new Map<string, Map<string, string[]>>();

            if (table) {
                for (const channel of channels) {
                    /* A hand-made pin or block outranks the mapping. */
                    if (Object.prototype.hasOwnProperty.call(overrides, channel.id)) continue;

                    for (const link of table.links[iptvOrgId(channel.id)] || ([] as GuideLink[])) {
                        const file = perFile.get(link.url) || perFile.set(link.url, new Map()).get(link.url)!;

                        (file.get(link.channel) || file.set(link.channel, []).get(link.channel)!).push(channel.id);
                    }
                }
            }

            for (const [url, feeds] of perFile) {
                if (this.halted) throw new Error("stopped");

                try {
                    const got = await streamGuide({
                        fetcher: this.options.fetcher,
                        url,
                        resolve: () => feeds,
                        keepFrom,
                        keepTo,
                        halted: () => this.halted,
                        timeoutMs: 10 * 60_000
                    });

                    sourcesOk++;
                    guideChannels += got.guideChannels;
                    programmes += got.programmes;

                    for (const [channelId, list] of got.kept) {
                        (idCandidates.get(channelId) || idCandidates.set(channelId, []).get(channelId)!).push({ url, list });
                    }
                } catch (error) {
                    if ((error as Error).message === "stopped") throw error;

                    sourcesFailed++;
                    this.log(`[epg] ${url}: ${(error as Error).message}`);
                }
            }

            /* TIER 2: by name, epg.pw's whole guide. */
            const named = await streamGuide({
                fetcher: this.options.fetcher,
                url: GUIDE_URL,
                resolve: (guide) => {
                    const mapped = mapChannels(guide, channels, overrides);

                    nameCounts = mapped.status;

                    return mapped.feeds;
                },
                keepFrom,
                keepTo,
                halted: () => this.halted,
                /* Ten minutes: it is a 50 MB download, read as it arrives. */
                timeoutMs: 10 * 60_000
            });

            if (!nameCounts) throw new Error("the guide had no programmes");

            guideChannels += named.guideChannels;
            programmes += named.programmes;

            for (const [channelId, list] of named.kept) nameKept.set(channelId, list);

            /* Merge: the ID-matched schedule that covers the most of the
               window wins; a channel with none falls back to its name match. */
            const schedules = new Map<string, Programme[]>();
            let byId = 0;

            for (const [channelId, candidates] of idCandidates) {
                const code = countryCode(byChannel.get(channelId)?.country || "").toLowerCase();
                const live = (list: Programme[]): number => list.filter((programme) => programme.stop > began).length;
                /* The same channel can be in several REGIONAL files (Plex/gb,
                   Plex/us): the file of the channel's own country first, then
                   the one that covers the most of the window. */
                const ours = (url: string): number => (code && new RegExp(`/${code}(\\.xml|/)`).test(url) ? 0 : 1);
                const best = candidates
                    .filter((candidate) => live(candidate.list))
                    .sort((a, b) => ours(a.url) - ours(b.url) || live(b.list) - live(a.list))[0];

                if (best) {
                    tidy(best.list);
                    schedules.set(channelId, best.list);
                    byId++;
                }
            }

            for (const [channelId, list] of nameKept) {
                if (schedules.has(channelId)) continue;

                tidy(list);
                schedules.set(channelId, list);
            }

            const counts = nameCounts as ReturnType<typeof mapChannels>["status"];
            const tally = new Map(counts.countries.map((country) => [country.code, { ...country }]));
            const nameMatched = new Set<string>();

            /* "Matched" is any channel with a schedule, by either tier. */
            let matched = counts.matched;

            for (const channel of channels) if (nameKept.has(channel.id)) nameMatched.add(channel.id);

            for (const channelId of schedules.keys()) {
                if (nameMatched.has(channelId)) continue;

                const channel = byChannel.get(channelId);

                if (!channel) continue;

                matched++;
                const code = countryCode(channel.country) || "--";

                const row = tally.get(code);

                if (row) row.matched++;
            }

            this.schedules = schedules;
            this.state = {
                at: this.now(),
                ok: true,
                seconds: Math.round((this.now() - began) / 1000),
                guideChannels,
                programmes,
                ...counts,
                matched,
                unmatched: counts.channels - matched,
                byId,
                sources: { ok: sourcesOk, failed: sourcesFailed },
                countries: [...tally.values()].sort((a, b) => b.channels - a.channels)
            };
            this.log(`[epg] guide: ${matched}/${counts.channels} channels matched (${byId} by id), ${programmes} programmes, ${this.state.seconds}s`);
        } catch (error) {
            const message = (error as Error).message;

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

    private read(): void {
        const file = this.options.file;

        if (file && existsSync(file)) {
            try {
                const stored = JSON.parse(readFileSync(file, "utf8")) as BulkFile;

                this.state = stored.status || null;
                this.schedules = new Map(Object.entries(stored.schedules || {}));
            } catch (error) {
                this.log(`[epg] could not read ${file}: ${(error as Error).message}`);
            }
        }

        const linksFile = this.options.linksFile;

        if (linksFile && existsSync(linksFile)) {
            try {
                const stored = JSON.parse(readFileSync(linksFile, "utf8")) as LinkTable;

                if (stored && typeof stored.fetchedAt === "number" && stored.links && typeof stored.links === "object") this.linkTable = stored;
            } catch {
                /* Fetched again on the next run. */
            }
        }
    }

    private writeLinks(): void {
        const file = this.options.linksFile;

        if (!file || !this.linkTable) return;

        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, JSON.stringify(this.linkTable));
            renameSync(`${file}.tmp`, file);
        } catch (error) {
            this.log(`[epg] could not write ${file}: ${(error as Error).message}`);
        }
    }

    private write(): void {
        const file = this.options.file;

        if (!file) return;

        try {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.tmp`, JSON.stringify({ status: this.state ?? undefined, schedules: Object.fromEntries(this.schedules) } satisfies BulkFile));
            renameSync(`${file}.tmp`, file);
        } catch (error) {
            this.log(`[epg] could not write ${file}: ${(error as Error).message}`);
        }
    }
}
