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
import { relayAvailable } from "./relay-support.js";
import { genreLabel, genreOf, languageLabel, languagesOf } from "./taxonomy.js";
import { allScrapers, beginScraperRun, endScraperRun, lastRun, recordRun, scraperEnabled, scraperStopRequested } from "./scrapers.js";
import type { ScrapedCatalogue, Scraper } from "./scraper-types.js";
import type { Addon, AddonFailure, MetaDetail, MetaPreview, Sourced, Stream } from "./types.js";

const fetchVia: typeof host.fetchVia = (url, options) => host.fetchVia(url, options);

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

export interface ChannelStream {
    url: string;
    quality: string;
    /** iptv-org's own warnings: "Not 24/7", "Geo-blocked" and so on. */
    labels: string[];
    referrer: string;
    userAgent: string;
    /** The scraper's named segment decoder for this mirror, or absent --
     *  see `ScrapedStream.decoder` and `relay.ts`. */
    decoder?: string;
    /**
     * The scraper that contributed THIS mirror -- "iptv-org" for the
     * built-in list, otherwise a `Scraper.id`. Set here, once, when a
     * scraper's output is merged in (`fromScraper`); never part of the
     * scraper contract itself (`ScrapedStream` has no such field), because
     * a scraper does not get to claim credit for someone else's mirror and
     * should not have to think about attribution at all.
     *
     * This is what lets a channel carry mirrors from SEVERAL scrapers at
     * once (see `matchKey`) while the source list still says, per mirror,
     * where it actually came from -- and what `rankStreams` reads to give
     * a non-iptv-org mirror a slight edge, see `SOURCE_RANK`.
     */
    source: string;
}

export interface Channel {
    /** The full id as this surface uses it, including the prefix. */
    id: string;
    name: string;
    /** ISO country code as iptv-org writes it -- note "UK", not "GB". */
    country: string;
    /** And the same country written out, for the pages that show it to a
     *  person. "IN" under a channel's title is not information. */
    countryName: string;
    categories: string[];
    /** ISO 639-3 codes, from the channel's main feed. */
    languages: string[];
    logo: string;
    website: string;
    network: string;
    streams: ChannelStream[];
    /** The composite described in the docstring. Never an audience figure. */
    score: number;
    /** The raw ids of the channels from OTHER scrapers merged into this card
     *  (it keeps the first scraper's id). The guide matches by an iptv-org
     *  id, which may be only here. */
    mergedIds?: string[];
}

export interface Country {
    code: string;
    name: string;
    flag: string;
    channels: number;
}

/** A scraper's own rail, resolved to a real id and a "from" line, but not
 *  yet to channels -- that happens in `liveRails`, against the FINAL
 *  index, so a channel dropped as a duplicate also disappears from any
 *  rail that named it. */
interface ScraperRailDecl {
    id: string;
    heading: string;
    by: string;
    channelIds: string[];
}

interface Index {
    at: number;
    byId: Map<string, Channel>;
    byCountry: Map<string, Channel[]>;
    countries: Country[];
    all: Channel[];
    rails: ScraperRailDecl[];
}

/*
    HOW MUCH A CATEGORY IS WORTH.

    Not a judgement about what is worth watching. It is a correction for a
    bias in the source: channels that are free to redistribute are massively
    over-mirrored relative to how much anyone watches them, and mirror count
    is the main signal here. Without this the top of India's list is a
    religious broadcaster with seventeen mirrors, above every news channel
    in the country.
*/
const CATEGORY_WEIGHT: Record<string, number> = {
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
const MAJOR =
    /^(bbc|itv|channel [45]|sky|cnn|cnbc|msnbc|nbc|cbs|abc|fox|pbs|cbc|bloomberg|euronews|al jazeera|france 24|dw|trt|nhk|rt |cgtn|star|colors|zee|sony|set |ndtv|aaj tak|india today|republic|times now|news18|abp|dd |doordarshan|sun |asianet|maa |gemini|udaya|discovery|national geographic|nat geo|history|cartoon network|nickelodeon|disney|mtv|axn|amc|tnt|tlc)\b/i;

/** The composite, exported so its two corrections can be tested. */
export function scoreOf(
    mirrors: ChannelStream[],
    categories: string[],
    name: string,
    logo = "",
    website = "",
    network = ""
): number {
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

    const about = categories.reduce(
        (worst, category) => Math.min(worst, CATEGORY_WEIGHT[category] ?? 0),
        categories.length ? 30 : 0
    );

    return (
        carried +
        about +
        (MAJOR.test(name) ? 120 : 0) +
        (logo ? 10 : 0) +
        (website ? 6 : 0) +
        (network ? 10 : 0)
    );
}

let index: Index | null = null;
let loading: Promise<Index | null> | null = null;

/** Bumped whenever the merged index is invalidated, so a merge that was
 *  already running when a scraper delivered cannot cache its stale result. */
let generation = 0;

function invalidate(): void {
    generation += 1;
    index = null;
}

/** A scraper's own id, valid on its own terms -- see `LIVE_PREFIX` and the
 *  iptv-org exception to it. */
function ownId(scraperId: string, id: string): boolean {
    return scraperId === "iptv-org" ? id.startsWith(PREFIX) : id.startsWith(`${LIVE_PREFIX}${scraperId}:`);
}

/*
    CROSS-SOURCE IDENTITY, FOR THE ONE THING `ownId` DELIBERATELY DOES NOT
    DO: recognise that "BBC News" from iptv-org and "BBC News HD" from a
    second scraper are the same channel to a viewer, even though nothing
    forces the two scrapers to agree on an id.

    Deliberately blunt -- name plus country, both folded hard -- because a
    false MISS (two entries for one channel) only costs a viewer a second
    tile, while a false MATCH would silently merge two unrelated channels'
    mirrors into one entry. Same key shape works for a live event ("Real
    Madrid vs Barcelona" from two scrapers is the same fixture) as for an
    ordinary channel; nothing here needs to tell the two apart.
*/
function normalizeChannelKey(name: string, country: string): string {
    const folded = name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\b(hd|fhd|uhd|sd|4k|hevc|backup|feed)\b/g, "")
        .replace(/[^a-z0-9]+/g, "");

    return `${folded}|${country.toUpperCase()}`;
}

/*
    A dropped-in or GitHub-imported scraper is somebody else's code, doing
    its own network fetching entirely outside this repo -- if its `build()`
    never resolves (an upstream host that accepts a connection and then says
    nothing, a fetch with no timeout of its own), `await`ing it here would
    hang this whole rebuild forever, and every page that waits on the
    channel index (chiefly `/tv`) with it. One scraper's bug must not be
    able to spin the Live TV page's loading circle for good.

    This is NOT a budget for how long a legitimate build() may take --
    a scraper with a large catalogue (ntv.st's ~9k channels, each needing
    its own resolve round-trip against a flaky third party with its own
    retries) can genuinely take several minutes on a cold cache, and every
    well-behaved scraper already bounds its OWN network calls with a much
    shorter per-request timeout of its own; a truly hung request is caught
    there, long before this outer one would ever fire. This value only
    needs to be longer than any real scraper's worst-case cold build, not
    short -- previously 45s, which was shorter than ntv.st's own cold-crawl
    time and caused it to "fail" on nearly every rebuild that found the
    cache cold, wiping out an otherwise-successful crawl still in flight.
*/
const SCRAPER_BUILD_TIMEOUT_MS = 60 * 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (cause) => {
                clearTimeout(timer);
                reject(cause);
            }
        );
    });
}

/** How much a head start a non-iptv-org mirror gets over an iptv-org one
 *  when nothing else (evidence, codec) has already told them apart -- see
 *  `rankStreams`. Small on purpose: real evidence of working or not
 *  working must always outrank a mere hunch about which source is nicer. */
const SOURCE_RANK: Record<string, number> = { "iptv-org": 0 };

function sourceRank(source: string): number {
    return SOURCE_RANK[source] ?? 1;
}

async function fromScraper(
    byId: Map<string, Channel>,
    flagOf: Map<string, string>,
    rails: ScraperRailDecl[]
): Promise<number> {
    let added = 0;

    /*
        THE CROSS-SCRAPER IDENTITY INDEX, shared across every scraper this
        build() pass touches, in whatever order `allScrapers()` returns
        them -- neither scraper is "the base" one, whichever contributes a
        name+country match FIRST becomes the canonical entry and every
        later match merges its mirrors in under that id. See
        `normalizeChannelKey`.
    */
    const byKey = new Map<string, string>();

    /*
        RAILS ARE MERGED BY HEADING, so two scrapers that both call their
        events rail "Live Events" produce one rail with both scrapers'
        events on it, each event itself already deduplicated by the same
        name+country matching as an ordinary channel -- an event carried by
        both scrapers ends up as one card with two mirrors, ranked like any
        other multi-source channel.
    */
    const byHeading = new Map<string, ScraperRailDecl>();

    /*
        MERGED FROM WHAT EACH SCRAPER LAST DELIVERED, never from a live
        fetch -- see `refreshScraper`. Merging is pure CPU, so this runs in
        `allScrapers()`'s order (the deterministic "whichever matches first
        becomes canonical" rule above) without any scraper's network time
        being able to delay another's channels.
    */
    const results = allScrapers()
        .filter((scraper) => scraperEnabled(scraper.id))
        .map((scraper) => {
            const held = results_.get(scraper.id);

            return held ? { scraper, raw: held.catalogue } : null;
        });

    for (const result of results) {
        if (!result) continue;
        const { scraper, raw } = result;

        let kept = 0;
        // This scraper's own raw id -> the canonical id it ended up under,
        // so its own rails (which speak in its own raw ids) can be
        // resolved even for a channel that was merged into someone else's
        // entry rather than added under its own id.
        const mine = new Map<string, string>();

        for (const channel of raw.channels) {
            // A scraper that returns a stray id or an empty channel is a
            // bug in that scraper, not something the whole index should
            // fail over -- the bad entry is dropped and the rest kept.
            if (!channel.streams.length) continue;

            if (!ownId(scraper.id, channel.id)) {
                console.error(
                    `stremio-tv: scraper "${scraper.id}" produced an id outside its namespace, dropped: ${channel.id}`
                );
                continue;
            }

            if (byId.has(channel.id)) {
                console.error(`stremio-tv: duplicate live channel id, kept the first: ${channel.id}`);
                continue;
            }

            /*
                A MIRROR THAT NEEDS A DECODER IS KEPT ONLY WHEN IT CAN PLAY:
                the scraper must actually export that decoder, and the
                running stremio-tv must be new enough to let `relay.ts`
                apply it (plugin API 1.2.0). Otherwise it would sit in the
                list looking like any other mirror and hand the player a
                picture instead of video.
            */
            const playable = channel.streams.filter(
                (stream) => !stream.decoder || (relayAvailable() && typeof scraper.decoders?.[stream.decoder] === "function")
            );

            if (!playable.length) continue;

            const taggedStreams: ChannelStream[] = playable.map((stream) => ({
                ...stream,
                source: scraper.id
            }));

            const key = normalizeChannelKey(channel.name, channel.country);
            const existingId = byKey.get(key);
            const existing = existingId ? byId.get(existingId) : undefined;

            if (existing) {
                /*
                    MERGE, DO NOT ADD. The existing entry keeps its own id,
                    metadata and place in the index -- only its mirror list
                    grows, deduplicated by URL so re-running against an
                    already-merged index (or a scraper that lists the same
                    CDN edge twice) never doubles a mirror up.
                */
                const seen = new Set(existing.streams.map((stream) => stream.url));
                for (const stream of taggedStreams) {
                    if (seen.has(stream.url)) continue;
                    seen.add(stream.url);
                    existing.streams.push(stream);
                }
                existing.score = scoreOf(
                    existing.streams,
                    existing.categories,
                    existing.name,
                    existing.logo,
                    existing.website,
                    existing.network
                );
                (existing.mergedIds || (existing.mergedIds = [])).push(channel.id);
                mine.set(channel.id, existing.id);
                kept += 1;
                continue;
            }

            const built: Channel = {
                id: channel.id,
                name: channel.name,
                country: channel.country,
                countryName: channel.countryName || channel.country,
                categories: channel.categories,
                languages: channel.languages,
                logo: channel.logo,
                website: channel.website,
                network: channel.network,
                streams: taggedStreams,
                score: 0
            };

            built.score = scoreOf(
                built.streams,
                built.categories,
                built.name,
                built.logo,
                built.website,
                built.network
            );

            byId.set(built.id, built);
            byKey.set(key, built.id);
            mine.set(built.id, built.id);
            if (channel.countryFlag) flagOf.set(built.id, channel.countryFlag);
            kept += 1;
        }

        /*
            A RAIL IS AN OPINION ABOUT THIS SCRAPER'S OWN CHANNELS, NEVER A
            WAY TO REACH INTO SOMEBODY ELSE'S.

            `channelIds` is resolved against `mine` -- the ids this exact
            call just contributed, after streams-empty and namespace and
            duplicate filtering, mapped through to wherever a merge sent
            them -- not against the final index, which is still being
            assembled and could still change from a later scraper. An id
            that did not survive is dropped silently; an id that was never
            this scraper's is dropped with a log line, the same posture as
            a stray channel id.
        */
        for (const rail of raw.rails || []) {
            if (!RAIL_SLUG.test(rail.id)) {
                console.error(`stremio-tv: scraper "${scraper.id}" gave a rail an unusable id, dropped: ${rail.id}`);
                continue;
            }

            const channelIds = rail.channelIds
                .map((id) => {
                    const canonical = mine.get(id);
                    if (canonical) return canonical;

                    console.error(
                        `stremio-tv: scraper "${scraper.id}"'s rail "${rail.id}" named a channel it did not itself return, dropped: ${id}`
                    );
                    return null;
                })
                .filter((id): id is string => Boolean(id));

            if (!channelIds.length) continue;

            const headingKey = rail.heading.trim().toLowerCase();
            const already = byHeading.get(headingKey);

            if (already) {
                const seen = new Set(already.channelIds);
                for (const id of channelIds) {
                    if (seen.has(id)) continue;
                    seen.add(id);
                    already.channelIds.push(id);
                }
                if (!already.by.includes(scraper.name)) already.by += `, ${scraper.name}`;
            } else {
                byHeading.set(headingKey, {
                    id: `rail:${scraper.id}-${rail.id}`,
                    heading: rail.heading,
                    by: `From ${scraper.name}`,
                    channelIds: [...channelIds]
                });
            }
        }

        added += kept;
    }

    rails.push(...byHeading.values());

    return added;
}

async function build(): Promise<Index | null> {
    try {
        const byId = new Map<string, Channel>();
        const flagOf = new Map<string, string>();
        const rails: ScraperRailDecl[] = [];

        await fromScraper(byId, flagOf, rails);

        if (!byId.size) return null;

        const byCountry = new Map<string, Channel[]>();

        for (const channel of byId.values()) {
            const bucket = byCountry.get(channel.country) || [];

            bucket.push(channel);
            byCountry.set(channel.country, bucket);
        }

        for (const bucket of byCountry.values()) bucket.sort(better);

        const countries: Country[] = [...byCountry.entries()]
            .filter(([code]) => code)
            .map(([code, bucket]) => ({
                code,
                name: bucket[0]?.countryName || code,
                flag: bucket.map((channel) => flagOf.get(channel.id) || "").find(Boolean) || "",
                channels: bucket.length
            }))
            .sort((a, b) => b.channels - a.channels || a.name.localeCompare(b.name));

        const all = [...byId.values()].sort(better);

        console.log(
            `stremio-tv: live index -- ${all.length} channels across ${countries.length} countries`
        );

        return { at: Date.now(), byId, byCountry, countries, all, rails };
    } catch (cause) {
        console.error("stremio-tv: could not build the live index", cause);
        return null;
    }
}

/**
 * Best first, and TOTAL, for the same reason the stream list is: a rail
 * whose order is not stable repoints every card on it between one page and
 * the next.
 */
function better(a: Channel, b: Channel): number {
    return b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/*
    ===================================================================
    SCRAPER RESULTS: HELD, PERSISTED, REFRESHED IN THE BACKGROUND
    ===================================================================

    Each scraper's last successful `build()` result is kept in memory AND
    written to `<configDir>/scraper-results/<id>.json`, and the channel
    index is merged from those held results -- never from a live fetch.
    Consequences, all deliberate:

      * A slow scraper (ntv.st's cold crawl takes many minutes) cannot
        delay or empty the page: whatever the others delivered is merged
        the moment it exists, and the slow one folds in when it finishes.
      * A plugin update, restart or reload loses nothing: the results are
        read back from disk at first use and served immediately while a
        stale one refreshes behind them.
      * A failed refresh keeps the previous result. Only a success ever
        replaces one.
*/

interface HeldResult {
    at: number;
    version: string;
    catalogue: ScrapedCatalogue;
}

const results_ = new Map<string, HeldResult>();
const refreshing = new Map<string, Promise<void>>();
const retryAfter = new Map<string, number>();
const RETRY_BACKOFF_MS = 10 * 60_000;
let diskLoaded = false;

function resultFile(id: string): string {
    return config.scraperResultsDir && /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? `${config.scraperResultsDir}/${id}.json` : "";
}

function saveResult(id: string, held: HeldResult): void {
    const file = resultFile(id);

    if (!file) return;

    try {
        mkdirSync(dirname(file), { recursive: true });

        const temporary = `${file}.tmp`;

        writeFileSync(temporary, JSON.stringify({ v: 1, ...held }), { mode: 0o600 });
        renameSync(temporary, file);
    } catch (cause) {
        console.error(`stremio-tv: could not persist scraper "${id}"'s result`, cause);
    }
}

function loadResults(): void {
    if (diskLoaded) return;

    diskLoaded = true;

    for (const scraper of allScrapers()) {
        const file = resultFile(scraper.id);

        if (!file || results_.has(scraper.id)) continue;

        try {
            const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HeldResult> & { v?: number };

            // Validated rather than trusted: this file outlives the code
            // that wrote it, and a malformed one must not break the page.
            if (parsed.v !== 1 || !parsed.catalogue || !Array.isArray(parsed.catalogue.channels)) continue;

            results_.set(scraper.id, {
                at: Number(parsed.at) || 0,
                version: String(parsed.version || ""),
                catalogue: parsed.catalogue
            });
        } catch {
            // Missing on a first run -- nothing to restore.
        }
    }
}

let halted = false;

/** Called from the plugin's `dispose()`. A refresh already in flight is
 *  left to finish and PERSIST (a long crawl must not be thrown away by an
 *  update), but no longer touches this orphaned module's index. */
export function stopChannelRefresh(): void {
    halted = true;
}

function needsRefresh(scraper: { id: string; version?: string }): boolean {
    if (refreshing.has(scraper.id)) return false;
    if ((retryAfter.get(scraper.id) || 0) > Date.now()) return false;

    const held = results_.get(scraper.id);

    return !held || Date.now() - held.at > INDEX_TTL_MS || held.version !== String(scraper.version || "");
}

function refreshScraper(scraper: Scraper): Promise<void> {
    const running = refreshing.get(scraper.id);

    if (running) return running;

    const started = (async () => {
        try {
            const raw = await withTimeout(scraper.build(), SCRAPER_BUILD_TIMEOUT_MS, `scraper "${scraper.id}"`);

            if (scraperStopRequested(scraper.id)) return;

            const held: HeldResult = { at: Date.now(), version: String(scraper.version || ""), catalogue: raw };

            saveResult(scraper.id, held);
            if (halted) return;

            results_.set(scraper.id, held);
            retryAfter.delete(scraper.id);
            recordRun(scraper.id, {
                at: held.at,
                ok: true,
                channels: raw.channels.filter((channel) => channel.streams.length).length,
                error: ""
            });
            invalidate();
        } catch (cause) {
            console.error(`stremio-tv: scraper "${scraper.id}" failed`, cause);
            if (halted || scraperStopRequested(scraper.id)) return;

            retryAfter.set(scraper.id, Date.now() + RETRY_BACKOFF_MS);
            recordRun(scraper.id, {
                at: Date.now(),
                ok: false,
                channels: 0,
                error: cause instanceof Error ? cause.message : String(cause)
            });
        } finally {
            refreshing.delete(scraper.id);
        }
    })();

    refreshing.set(scraper.id, started);

    return started;
}

function refreshStale(): void {
    for (const scraper of allScrapers()) {
        if (scraperEnabled(scraper.id) && needsRefresh(scraper)) void refreshScraper(scraper);
    }
}

/**
 * The index, merged from every enabled scraper's held result.
 *
 * With any result held (restored from disk, or delivered) this never waits
 * on the network: it merges what exists and refreshes the stale in the
 * background, each completion invalidating the merged index so the next
 * request folds it in. Only with NOTHING held (a first install) does a
 * request wait at all, and then for at most `FIRST_BUILD_WAIT_MS`, so the
 * page reports "no channels yet" instead of hanging.
 */
const FIRST_BUILD_WAIT_MS = 8_000;

export async function channelIndex(): Promise<Index | null> {
    if (index) {
        refreshStale();

        return index;
    }

    loadResults();
    refreshStale();

    const usable = allScrapers().some((scraper) => scraperEnabled(scraper.id) && results_.has(scraper.id));

    if (!usable && refreshing.size) {
        await Promise.race([
            Promise.all([...refreshing.values()]),
            new Promise<void>((resolve) => setTimeout(resolve, FIRST_BUILD_WAIT_MS).unref())
        ]);
    }

    if (index) return index;

    if (!loading) {
        const started = generation;

        loading = build().then((built) => {
            loading = null;
            if (built && !halted && started === generation) index = built;

            return built;
        });
    }

    return loading;
}

/** Drop the merged index, so the next page re-merges the held results
 *  (no network). */
export function forgetChannels(): void {
    invalidate();
}

/** Drop every held result too, in memory only. For the tests. */
export function resetChannelResultsForTest(): void {
    invalidate();
    loading = null;
    results_.clear();
    refreshing.clear();
    retryAfter.clear();
    diskLoaded = false;
    halted = false;
}

/** Mark one scraper's held result stale so its next refresh really
 *  re-runs `build()` -- for when its own task just changed what it
 *  would return. */
export function expireScraperResult(id: string): void {
    const held = results_.get(id);

    if (held) held.at = 0;
    retryAfter.delete(id);
    invalidate();
}

/**
 * One scraper's `build()`, run by hand from Settings' "Run now". Shares
 * `refreshScraper` with the background refresh, so a manual run and a
 * background one can never crawl the same source twice at once.
 *
 * STOPPING IT IS HONEST, NOT REAL CANCELLATION. `Scraper.build()` takes no
 * abort signal (see `scraper-types.ts`) -- "Stop" only marks the run as no
 * longer wanted: its result is discarded and the button disappears, but a
 * fetch already in flight still runs to completion on the wire.
 */
export async function runScraperNow(id: string): Promise<{ ok: boolean; error: string }> {
    const scraper = allScrapers().find((s) => s.id === id);

    if (!scraper) return { ok: false, error: "No such source." };
    if (!beginScraperRun(id)) return { ok: false, error: "Already running." };

    try {
        retryAfter.delete(id);
        await refreshScraper(scraper);

        if (scraperStopRequested(id)) return { ok: false, error: "Stopped." };

        const run = lastRun(id);

        return run && !run.ok ? { ok: false, error: run.error } : { ok: true, error: "" };
    } finally {
        endScraperRun(id);
    }
}

export function isChannelId(id: string): boolean {
    return id.startsWith(PREFIX) || id.startsWith(LIVE_PREFIX);
}

/** The channel, if the index is already built -- for a page that cannot wait. */
export function peekChannel(id: string): Channel | null {
    return index?.byId.get(id) || null;
}

export async function findChannel(id: string): Promise<Channel | null> {
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

interface Check {
    at: number;
    ok: boolean;
}

const checks = new Map<string, Check>();

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
const deep = new Map<string, Check>();

/** The last deep answer for this URL whenever it was given, or null. */
export function deeplyKnown(url: string): boolean | null {
    const held = deep.get(url);

    return held ? held.ok : null;
}

/*
    AND WHAT THE VIDEO TURNED OUT TO BE.

    The deep store proves BYTES. It says nothing about whether a decoder
    can follow them, and that gap is where the worst failures live: a
    source that serves real segments of HEVC, or of MPEG-2, passes every
    test this service had and then freezes a browser with the sound still
    running. Measured in the pool: National Geographic's reachable mirror
    is MPEG-2 video, which no browser has ever decoded, and it passes the
    deep check cleanly.

    So the sweep now also asks ffprobe what the pictures are. This is
    EVIDENCE, not a verdict -- see `rankStreams`, which demotes an
    unplayable codec and never removes it. A mirror that cannot be decoded
    here may be the one that plays on the television, and a viewer with
    one awkward source is better off than a viewer with none.
*/
export interface CodecFact {
    at: number;
    /** ffprobe's name: h264, hevc, mpeg2video, vp9... "" when unknown. */
    video: string;
    audio: string;
    width: number;
    height: number;
    /**
     * ffprobe's `field_order`. Anything but "progressive" means the
     * picture is made of FIELDS, which Android's MediaCodec refuses
     * outright -- so this is the difference between a channel that can be
     * copied straight to the panel and one that has to be deinterlaced
     * and re-encoded first.
     *
     * Read from a real segment rather than from the playlist, which is
     * the only place it is reliable: measured, ffprobe over the HLS URL
     * says "unknown" for a feed whose segments plainly say "tt".
     */
    fields: string;
    /**
     * Which audio stream to take, by its own index in the transport
     * stream. Not always the first: an American feed routinely carries
     * AC-3 first and AAC second, and taking the first one meant
     * re-encoding sound that was already in the one codec every panel
     * decodes.
     */
    audioIndex: number;
    /**
     * Whether the track named by `audioIndex` is also the FIRST audio
     * stream in the transport stream.
     *
     * It decides whether a channel can be left to hls.js. An American
     * feed routinely carries AC-3 first and AAC second, and hls.js takes
     * the first -- so a device that cannot decode AC-3 gets a picture and
     * silence, which is how Disney was first reported. When the good
     * track is not the first one, the channel has to go through ffmpeg
     * whatever else is true of it, purely so that the track can be
     * chosen.
     */
    audioFirst: boolean;
}

const codecs = new Map<string, CodecFact>();

/** What this URL was last seen carrying, or null if nobody has looked. */
/**
 * What ffprobe calls a single picture. A "video" of one of these is not a
 * video: it is a segment still wrapped in its disguise (a decoder mirror
 * read without its decoder), and its width and height are the image's, not
 * the picture's -- the row once read "png 1458p".
 */
const STILL_IMAGE = ["png", "apng", "bmp", "gif", "webp", "tiff", "ppm", "jpegls"];

export function codecFor(url: string): CodecFact | null {
    const fact = codecs.get(url);

    return fact && !STILL_IMAGE.includes(fact.video) ? fact : null;
}

/** How many sources have been looked at, for the page to say. */
export function codecCount(): number {
    return codecs.size;
}

/*
    ===================================================================
    WHAT A HOST HAS BEEN WORTH, AND WHETHER THE STORE MAY BE TRUSTED
    ===================================================================

    The deep store answers per URL. But the failures are not scattered
    evenly across fifteen thousand URLs -- they cluster by HOST, because a
    host is one operator with one set of habits. Measured over the index:
    of 5,091 hosts, 96 carry twenty sources or more, and the good ones are
    close to perfect (stream.mcquack.net: 252 of 256 played) while the long
    tail of one-source hosts is where the rot lives.

    That makes a host's record a real signal about a mirror NOBODY HAS
    ASKED ABOUT -- which is the case the per-URL store cannot speak to at
    all, and exactly the tie `rankStreams` used to break on the alphabet.
*/

interface HostRecord {
    n: number;
    ok: number;
}

/** Rebuilt from the deep store rather than maintained alongside it, so a
 *  restart cannot leave the two disagreeing. */
let records: Map<string, HostRecord> | null = null;
let recordsAt = 0;

/** How long a derived view of the stores is reused before rebuilding. */
const DERIVED_MS = 60 * 1000;

/** Sources a host must carry before its record says anything. Below this
 *  a single unlucky channel would condemn every mirror on the host. */
const RECORD_MIN = 5;

function hostRecords(): Map<string, HostRecord> {
    if (records && Date.now() - recordsAt < DERIVED_MS) return records;

    const built = new Map<string, HostRecord>();

    for (const [url, held] of deep) {
        const host = hostOf(url);

        if (!host) continue;

        const seen = built.get(host) || { n: 0, ok: 0 };

        seen.n += 1;
        if (held.ok) seen.ok += 1;
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
export function reputationOf(url: string): number {
    const seen = hostRecords().get(hostOf(url));

    if (!seen || seen.n < RECORD_MIN) return 1;

    const rate = seen.ok / seen.n;

    if (rate >= 0.8) return 2;

    return rate <= 0.4 ? 0 : 1;
}

let trusted: { at: number; ok: boolean } | null = null;

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
export function deepEnough(): boolean {
    if (trusted && Date.now() - trusted.at < DERIVED_MS) return trusted.ok;

    let live = 0;

    for (const held of checks.values()) if (held.ok) live += 1;

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
export function checkSummary(): { at: number; tried: number; found: number } {
    let at = 0;
    let found = 0;

    for (const held of checks.values()) {
        if (held.at > at) at = held.at;
        if (held.ok) found += 1;
    }

    return { at, tried: checks.size, found };
}

/** The last answer for this URL whenever it was given, or null. */
export function known(url: string): boolean | null {
    const held = checks.get(url);

    return held ? held.ok : null;
}

function fresh(url: string): boolean | null {
    const held = checks.get(url);

    if (!held) return null;

    return Date.now() - held.at < (held.ok ? GOOD_MS : BAD_MS) ? held.ok : null;
}

function remember(url: string, ok: boolean): void {
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
let pendingWrite: NodeJS.Timeout | null = null;

export function saveChecks(): void {
    if (!config.liveChecks) return;

    try {
        mkdirSync(dirname(config.liveChecks), { recursive: true });

        const temporary = `${config.liveChecks}.tmp`;

        writeFileSync(
            temporary,
            JSON.stringify({
                v: 2,
                at: Date.now(),
                checks: [...checks],
                deep: [...deep],
                codecs: [...codecs]
            }),
            { mode: 0o600 }
        );
        renameSync(temporary, config.liveChecks);
    } catch (cause) {
        console.error("stremio-tv: could not write the live-check store", cause);
    }
}

/** Called from the plugin's `dispose()`: writes what is pending now
 *  rather than losing it with the discarded module. */
export function flushChecks(): void {
    if (!pendingWrite) return;

    clearTimeout(pendingWrite);
    pendingWrite = null;
    saveChecks();
}

function scheduleSave(): void {
    if (!config.liveChecks || pendingWrite) return;

    pendingWrite = setTimeout(() => {
        pendingWrite = null;
        saveChecks();
    }, 30_000);
    pendingWrite.unref();
}

export function loadChecks(): void {
    if (!config.liveChecks) return;

    try {
        const parsed = JSON.parse(readFileSync(config.liveChecks, "utf8")) as {
            checks?: [string, Check][];
            deep?: [string, Check][];
            codecs?: [string, CodecFact][];
        };

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

        for (const held of deep.values()) if (held.ok) played += 1;

        console.log(
            `stremio-tv: ${checks.size} live-source answers restored` +
                (deep.size ? `, ${played} of ${deep.size} followed through to video` : "") +
                (codecs.size ? `, ${codecs.size} with the codec known` : "")
        );
    } catch {
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
export async function verify(stream: ChannelStream, proxy = ""): Promise<boolean> {
    const already = fresh(stream.url);

    if (already !== null) return already;

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
        } else {
            upstream.body.resume();
        }
    } catch {
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
function head(body: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve) => {
        let text = "";

        body.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");

            if (text.length > 4096) {
                (body as unknown as { destroy: () => void }).destroy();
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
function urisIn(text: string, base: string): { variants: string[]; segments: string[] } {
    const variants: string[] = [];
    const segments: string[] = [];
    let next = false;

    for (const raw of text.split("\n")) {
        const line = raw.trim();

        if (!line) continue;

        if (line.startsWith("#")) {
            if (line.startsWith("#EXT-X-STREAM-INF")) next = true;
            continue;
        }

        try {
            (next ? variants : segments).push(new URL(line, base).href);
        } catch {
            /* Not a URL. Skipped rather than failing the whole playlist. */
        }

        next = false;
    }

    return { variants, segments };
}

/** GET a few bytes and say how many arrived, and what they looked like. */
async function taste(
    url: string,
    stream: ChannelStream,
    proxy: string,
    want: number,
    keep = false
): Promise<{ status: number; text: string; bytes: number; data: Buffer }> {
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
        const chunks: Buffer[] = [];
        const done = (): void =>
            resolve({ status: upstream.status, text, bytes, data: Buffer.concat(chunks) });

        upstream.body.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (keep) chunks.push(chunk);

            // Only the head is kept as text: a playlist declares itself in
            // its first line, and a segment is not text at all.
            if (text.length < 8192) text += chunk.toString("utf8");

            if (bytes >= want) {
                (upstream.body as unknown as { destroy: () => void }).destroy();
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
function askFfprobe(data: Buffer): Promise<CodecFact | null> {
    return new Promise((resolve) => {
        let out = "";
        let settled = false;

        const child = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=index,codec_name,codec_type,width,height,field_order",
            "-of", "json",
            "-i", "pipe:0"
        ]);

        const finish = (fact: CodecFact | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                child.kill("SIGKILL");
            } catch {
                /* Already gone, which is the outcome either way. */
            }
            resolve(fact);
        };

        const timer = setTimeout(() => finish(null), PROBE_MS);

        timer.unref();
        child.stdout.on("data", (chunk: Buffer) => {
            if (out.length < 64 * 1024) out += chunk.toString("utf8");
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
                const parsed = JSON.parse(out) as {
                    streams?: {
                        index?: number;
                        codec_name?: string;
                        codec_type?: string;
                        width?: number;
                        height?: number;
                        field_order?: string;
                    }[];
                };
                const found = parsed.streams || [];
                const video = found.find((entry) => entry.codec_type === "video");
                const sound = found.filter((entry) => entry.codec_type === "audio");
                /* AAC wherever there is one: see `audioIndex`. */
                const audio = sound.find((entry) => entry.codec_name === "aac") || sound[0];
                const audioFirst = !audio || !sound[0] || audio.index === sound[0].index;

                if (!video && !audio) return finish(null);

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
            } catch {
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
export async function probeCodec(stream: ChannelStream, proxy = ""): Promise<CodecFact | null> {
    try {
        const top = await taste(stream.url, stream, proxy, 64 * 1024);

        if (top.status >= 400 || !top.text.trimStart().startsWith("#EXTM3U")) return null;

        const first = urisIn(top.text, stream.url);
        let list: { url: string; text: string } | null = null;

        if (first.variants.length === 0) {
            list = { url: stream.url, text: top.text };
        } else {
            for (const variant of first.variants.slice(0, VARIANTS)) {
                const inner = await taste(variant, stream, proxy, 64 * 1024);

                if (inner.status < 400 && inner.text.trimStart().startsWith("#EXTM3U")) {
                    list = { url: variant, text: inner.text };
                    break;
                }
            }
        }

        if (!list) return null;

        const segment = urisIn(list.text, list.url).segments[0];

        if (!segment) return null;

        /*
            A DISGUISED SEGMENT is read whole and decoded first -- the
            first 192KB of a PNG says nothing about the video inside it,
            and an unknown codec is what sends a channel to a full
            re-encode at play time.
        */
        const decode = stream.decoder
            ? allScrapers().find((entry) => entry.id === stream.source)?.decoders?.[stream.decoder]
            : undefined;
        const got = await taste(segment, stream, proxy, decode ? 64 * 1024 * 1024 : PROBE_BYTES, true);

        if (got.status >= 400 || got.bytes < 32 * 1024) return null;

        /* A mirror that needs its decoder and has none here is not probed: the raw segment says nothing about the video. */
        if (stream.decoder && !decode) return null;

        const data = decode ? Buffer.from(await decode(new Uint8Array(got.data), segment)).subarray(0, PROBE_BYTES) : got.data;
        const fact = await askFfprobe(data);

        if (fact && STILL_IMAGE.includes(fact.video)) return null;

        /*
            A probe that found nothing is not written down. ffprobe failing
            on a truncated read is a fact about the read, and recording it
            as "this source has no video" would demote a working mirror on
            the strength of this service's own impatience.
        */
        if (!fact || (!fact.video && !fact.audio)) return null;

        codecs.set(stream.url, fact);
        scheduleSave();

        return fact;
    } catch {
        return null;
    }
}

/**
 * Follow one source from its playlist to a real segment of video.
 *
 * Returns true only when bytes of video actually arrived. Master playlists
 * are followed one level, which is as deep as live HLS goes.
 */
export async function deepVerify(stream: ChannelStream, proxy = ""): Promise<boolean> {
    let ok = false;

    try {
        const top = await taste(stream.url, stream, proxy, 64 * 1024);

        if (top.status < 400 && top.text.trimStart().startsWith("#EXTM3U")) {
            const first = urisIn(top.text, stream.url);
            const lists: { url: string; text: string }[] = [];

            if (first.variants.length === 0) {
                lists.push({ url: stream.url, text: top.text });
            } else {
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

                if (!segment) continue;

                const got = await taste(segment, stream, proxy, SEGMENT_BYTES);

                /*
                    Bytes, and not an error page wearing a 200. An HLS
                    segment is MPEG-TS or fragmented MP4; neither begins
                    with a "<".
                */
                ok = got.status < 400 && got.bytes >= 1024 && !got.text.trimStart().startsWith("<");

                if (ok) break;
            }
        }
    } catch {
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
    if (ok) remember(stream.url, true);

    scheduleSave();

    return ok;
}

/** How many of a channel's sources have been proven right through to video. */
export function provenFor(channel: Channel): number {
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
export function codecRank(url: string, cannot: string[]): number {
    const fact = codecFor(url);

    if (!fact || !fact.video) return 1;

    return cannot.includes(fact.video) || AWKWARD.includes(fact.video) ? 0 : 2;
}

/**
 * The full record of every mirror offered lately, by URL. The ranking
 * probes (`rankReachability`) only get a stream's URL back from core, and a
 * probe made with the bare URL loses the mirror's decoder and headers: a
 * DaddyLive mirror was read as a raw PNG and its "resolution" was the
 * image's. Looking the record up by URL keeps both.
 */
const STREAM_META = new Map<string, ChannelStream>();
const META_CAP = 20_000;

export function streamMeta(url: string): ChannelStream | undefined {
    return STREAM_META.get(url);
}

function rememberStreams(streams: ChannelStream[]): void {
    if (STREAM_META.size > META_CAP) STREAM_META.clear();

    for (const stream of streams) STREAM_META.set(stream.url, stream);
}

/** The mirror as the index knows it (decoder, headers), or just its URL. */
function fullStream(url: string): ChannelStream {
    return STREAM_META.get(url) || { url, quality: "", labels: [], referrer: "", userAgent: "", source: "" };
}

/**
 * How many lines a mirror's picture has: what was measured when somebody
 * looked (ffprobe's height), else what the list says, else 0 for nothing
 * known -- which sorts last, below every mirror with a number.
 */
export function pictureLines(stream: ChannelStream): number {
    const measured = codecFor(stream.url)?.height;

    if (measured) return measured;

    const said = stream.quality || "";

    if (/\b(4k|uhd)\b|2160/i.test(said)) return 2160;

    const found = /(\d{3,4})/.exec(said);

    return found ? Number(found[1]) : 0;
}

/**
 * A source row's heading, in words a viewer can use: "1080p . H.264",
 * "720p", or "Not checked yet" when nothing is known. The codec's warning
 * for this device rides along. (Core reads a quality tag for the row out
 * of this line -- "1080p", "4K" -- and shows the line itself as the
 * release name.)
 */
export function streamHeading(stream: ChannelStream, cannot: string[]): string {
    const fact = codecFor(stream.url);
    const lines = pictureLines(stream);
    const picture = lines >= 2160 ? "4K" : lines ? `${lines}p` : "";
    const NAMES: Record<string, string> = { h264: "H.264", hevc: "H.265", mpeg2video: "MPEG-2", vp9: "VP9", av1: "AV1" };
    const codec = fact && fact.video ? NAMES[fact.video] || fact.video : "";
    const said = [picture, codec].filter(Boolean).join(" \u00b7 ");

    if (!said) return "Not checked yet";

    return `${said}${codecRank(stream.url, cannot) === 0 ? ", which this device may not decode" : ""}`;
}

/**
 * The row's text. Line one is the heading; the gear line is where core
 * puts a source's origin next to "Live TV" -- here, WHICH scraper or site
 * the mirror came from (never the CDN that happens to serve it).
 */
function streamTitle(stream: ChannelStream, cannot: string[]): string {
    const origin = addonFor(stream.source).manifest.name;

    return [streamHeading(stream, cannot), ...stream.labels, origin ? `\u2699\ufe0f ${origin}` : ""].filter(Boolean).join("\n");
}

export function rankStreams(
    channel: Channel,
    /**
     * The video codecs this panel does not decode, from `undecodable`.
     * Empty means rank on everything else, which is what a set that has
     * never reported its capabilities gets.
     */
    cannot: string[] = []
): ChannelStream[] {
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
    const evidence = (stream: ChannelStream): number => {
        const followed = deeplyKnown(stream.url);

        if (followed === true) return 4;

        const answer = known(stream.url);

        if (answer === true) return followed === false ? 1 : 3;

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
    return [...channel.streams].sort(
        (a, b) =>
            evidence(b) - evidence(a) ||
            codecRank(b.url, cannot) - codecRank(a.url, cannot) ||
            /* A mirror that says it is not on all day, or fenced, goes behind any that does not. */
            a.labels.length - b.labels.length ||
            /* THE PICTURE, highest first, a mirror that says nothing last. */
            pictureLines(b) - pictureLines(a) ||
            sourceRank(b.source) - sourceRank(a.source) ||
            reputationOf(b.url) - reputationOf(a.url) ||
            a.url.localeCompare(b.url)
    );
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
export function disappointing(channel: Channel): boolean {
    let good = 0;
    let followed = 0;

    for (const stream of channel.streams) {
        if (known(stream.url) !== true) continue;

        good += 1;

        const answer = deeplyKnown(stream.url);

        if (answer === null) continue;

        followed += 1;

        // One mirror that played is enough. The channel works.
        if (answer === true) return false;
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
export function proofOf(channel: Channel): number {
    const seen = evidenceFor(channel);

    if (seen.good > 0) return 1000;

    return seen.bad > 0 && seen.bad === channel.streams.length ? -1000 : 0;
}

export function evidenceFor(channel: Channel): { good: number; bad: number } {
    let good = 0;
    let bad = 0;

    for (const stream of channel.streams) {
        const answer = known(stream.url);

        if (answer === true) good += 1;
        else if (answer === false) bad += 1;
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
export async function firstWorking(channel: Channel): Promise<ChannelStream | null> {
    for (const stream of rankStreams(channel)) {
        if (await verify(stream)) return stream;
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
 * The "addon" a MIRROR is attributed to -- one per `ChannelStream.source`,
 * not one for the whole channel, because a merged channel (see
 * `normalizeChannelKey`) can carry mirrors from several scrapers at once
 * and the source list is exactly where that has to stop being invisible.
 *
 * It is real in the sense that matters: this prints where a stream
 * actually came from. It is never fetched from -- there is no such
 * service -- so it carries a page as its base, which is what anyone
 * following the attribution wants.
 */
const SOURCE_ADDON = new Map<string, Addon>();

function addonFor(rawSource: string): Addon {
    // "" is what an untagged mirror carries -- a fixture built by hand, or
    // one of the two internal call sites above that only need `verify`'s
    // answer and never touch the source list. iptv-org is the honest
    // default for those, exactly as it was before every mirror carried its
    // own source.
    const source = rawSource || "iptv-org";

    const cached = SOURCE_ADDON.get(source);
    if (cached) return cached;

    const name = allScrapers().find((scraper) => scraper.id === source)?.name || source;
    const addon: Addon =
        source === "iptv-org"
            ? { base: "https://iptv-org.github.io", manifest: { id: "org.iptv.index", name: "iptv-org", types: ["tv"] } }
            : { base: "", manifest: { id: `live.${source}`, name, types: ["tv"] } };

    SOURCE_ADDON.set(source, addon);
    return addon;
}

/** The scraper's own name ("DaddyLive", "iptv-org") for a mirror's `source`. */
export function sourceNameOf(source: string): string {
    return addonFor(source).manifest.name || source;
}

export function channelPreview(channel: Channel): MetaPreview {
    return {
        id: channel.id,
        type: "tv",
        name: channel.name,
        poster: channel.logo,
        posterShape: "square",
        background: channel.logo,
        description: describeChannel(channel),
        /*
            The title page draws these as its fact pills (core's
            `factChips`): the browse genre and the languages, in words --
            "News · Tamil", not iptv-org's raw "news" and "tam".
        */
        genres: channelFacts(channel)
    };
}

/** The one line under a channel's name. Category, country, mirrors. */
export function describeChannel(channel: Channel): string {
    const carried =
        channel.streams.length === 1 ? "1 source" : `${channel.streams.length} sources`;
    const genre = genreOf(channel);

    return [channel.network, genre && genre !== "general" ? genreLabel(genre) : "", carried].filter(Boolean).join(" · ");
}

/** A country's flag, from its code (iptv-org's "UK" is GB's flag). */
function flagFor(channel: Channel): string {
    const code = channel.country === "UK" ? "GB" : channel.country;

    if (!/^[A-Z]{2}$/.test(code)) return "";

    return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/**
 * Where a channel is from and what it speaks, as pills: "🇬🇧 United
 * Kingdom", "English". The same words the title page shows, for a channel
 * card and for the player's chip row (core plugin API 1.3.0).
 */
export function regionChips(channel: Channel, languages = 2): string[] {
    const country = channel.countryName || channel.country;

    return [
        country ? [flagFor(channel), country].filter(Boolean).join(" ") : "",
        ...languagesOf(channel).slice(0, languages).map((code) => languageLabel(code, (raw) => host.languageName(raw)))
    ].filter(Boolean);
}

/** A channel's genre and languages, named, for the title page's pills. */
export function channelFacts(channel: Channel): string[] {
    const genre = genreOf(channel);

    return [
        genre && genre !== "general" ? genreLabel(genre) : "",
        ...languagesOf(channel).slice(0, 2).map((code) => languageLabel(code, (raw) => host.languageName(raw)))
    ].filter(Boolean);
}

export function channelMeta(channel: Channel): MetaDetail {
    return {
        ...channelPreview(channel),
        logo: channel.logo,
        country: channel.countryName || channel.country,
        /*
            The first fact pill on the title page (where a film has its
            year): where the channel broadcasts from, with its flag.
        */
        releaseInfo: [flagFor(channel), channel.countryName || channel.country].filter(Boolean).join(" "),
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

export async function channelStreamList(
    channel: Channel,
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
    cannot: string[] = []
): Promise<{ items: Sourced<Stream>[]; failures: AddonFailure[] }> {
    const ranked = rankStreams(channel, cannot);

    rememberStreams(ranked);

    if (routedDown) {
        return {
            items: ranked.map((stream) => ({
                from: addonFor(stream.source),
                value: {
                    url: stream.url,
                    name: "Live",
                    title: streamTitle(stream, cannot)
                } as Stream
            })),
            failures: [
                {
                    addon: "live-tv",
                    reason:
                        "live TV is set to go through the VPN and the tunnel is not connected, so nothing was checked"
                }
            ]
        };
    }

    const deadline = Date.now() + BUDGET_MS;
    const good: ChannelStream[] = [];
    const bad: ChannelStream[] = [];
    let tried = 0;

    for (let at = 0; at < Math.min(DEPTH, ranked.length); at += BATCH) {
        if (good.length >= WANT) break;
        /*
            The budget is checked between batches and not inside one: a
            batch already in flight is nearly free to finish, and cutting
            it off would throw away answers that have been paid for.
        */
        if (Date.now() > deadline) break;

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

    const failures: AddonFailure[] =
        good.length === 0 && tried > 0
            ? [
                  {
                      addon: "live-tv",
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
            from: addonFor(stream.source),
            value: {
                url: stream.url,
                name: at < good.length ? CHECKED : "Live",
                title: streamTitle(stream, cannot)
            } as Stream
        })),
        failures
    };
}

/** Whether anything on this list is known to be serving right now. */
export function anyChecked(items: Sourced<Stream>[]): boolean {
    return items.some((entry) => entry.value.name === CHECKED);
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
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
export function warmChannel(channel: Channel, proxy = ""): void {
    /*
        The same list the press will ask for, so the press finds it cached.
        No budget and no early stop: nobody is waiting on this, and a
        channel whose first dozen mirrors are geo-blocked is exactly the one
        worth having already looked past by the time Play is pressed.
    */
    void channelStreamList(channel, proxy).catch(() => null);
}

/*
    ===================================================================
    WHAT GOES ON A RAIL
    ===================================================================
*/

export interface Pick {
    /** Any of these categories. Empty means every category. */
    categories?: string[];
    /** Only these countries. Empty means everywhere. */
    countries?: string[];
    /** Any of these ISO 639-3 codes on the channel's main feed. */
    languages?: string[];
    limit?: number;
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
export function select(built: Index, want: Pick, home: string[] = []): Channel[] {
    const categories = want.categories || [];
    const languages = want.languages || [];
    const countries = want.countries || [];

    const kept = built.all.filter((channel) => {
        if (countries.length && !countries.includes(channel.country)) return false;
        if (categories.length && !categories.some((c) => channel.categories.includes(c))) return false;
        if (languages.length && !languages.some((l) => languagesOf(channel).includes(l))) return false;

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
    const rank = (channel: Channel): number => {
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
export async function searchChannels(term: string, limit = 60): Promise<Channel[]> {
    const wanted = term.trim().toLowerCase();

    /*
        The length is checked BEFORE the index is asked for. One letter is
        not a search -- it is the first press of a word -- and a keyboard
        whose first letter built a 25MB index would be a keyboard with a
        thirty-second first press.
    */
    if (wanted.length < 2) return [];

    const built = await channelIndex();

    if (!built) return [];

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
            return (
                bhead - ahead ||
                proofOf(b) - proofOf(a) ||
                b.score - a.score ||
                a.name.localeCompare(b.name)
            );
        })
        .slice(0, limit);
}

/**
 * One country's channels, best first. ALL of them -- the page that shows
 * them is what decides how many fit, and a cap here would silently make
 * its "of 745" a lie.
 */
export async function channelsIn(code: string): Promise<Channel[]> {
    const built = await channelIndex();

    /*
        Sorted HERE and not at index-build time, because the evidence
        changes under it: the index is built once and the sweep runs after,
        and a country page ordered by the build's own sort put BBC One --
        which cannot play from this house -- second in the United Kingdom
        while the rails had already sunk it. A copy, so the index's own
        order is left alone.
    */
    return [...(built?.byCountry.get(code.toUpperCase()) || [])].sort(
        (a, b) => proofOf(b) - proofOf(a) || better(a, b)
    );
}

/**
 * Every channel, for the Browse page's "All countries" -- ordered the way
 * a country page is (what the night proved first), for the same reason.
 */
export async function allChannelsRanked(): Promise<Channel[]> {
    const built = await channelIndex();

    return [...(built?.all || [])].sort((a, b) => proofOf(b) - proofOf(a) || better(a, b));
}

/** Every country that has channels, most first. */
export async function countries(): Promise<Country[]> {
    return (await channelIndex())?.countries || [];
}

export async function countryNamed(code: string): Promise<Country | null> {
    const built = await channelIndex();

    return built?.countries.find((entry) => entry.code === code.toUpperCase()) || null;
}

/*
    ===================================================================
    THE RAILS
    ===================================================================
*/

export interface Rail {
    /**
     * A STABLE NAME FOR THIS RAIL, so a household can hide it or move it.
     *
     * Not the heading: headings are prose and they change -- "Top channels
     * in India" is the country's name, which the index supplies and can
     * restyle. An arrangement kept against a heading would silently reset
     * itself the day that prose moved. These are built from what the rail
     * IS: the country code, the theme, the language.
     */
    id: string;
    heading: string;
    by: string;
    channels: Channel[];
    /** Where "see all" goes, for the rails that have somewhere to go. */
    more?: string;
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
export async function liveRails(
    home: string[],
    languages: { code: string; name: string }[],
    countryHref: (code: string) => string
): Promise<{ rails: Rail[]; countries: Country[]; down: boolean }> {
    const built = await channelIndex();

    if (!built) return { rails: [], countries: [], down: true };

    const named = new Map(built.countries.map((country) => [country.code, country.name]));
    const rails: Rail[] = [];

    /*
        THE HOUSEHOLD'S OWN MARKETS FIRST, one rail each.

        Before the themed rails rather than after them, because a live TV
        page that opens on a global Sports rail is a page about somebody
        else's television.
    */
    for (const code of home) {
        const channels = select(built, { countries: [code], limit: RAIL });

        if (!channels.length) continue;

        rails.push({
            id: `country:${code}`,
            heading: `Top channels in ${named.get(code) || code}`,
            by: "Most widely carried",
            channels,
            more: countryHref(code)
        });
    }

    /*
        A RAIL PER LANGUAGE, for the household's first market when it
        speaks more than one -- which for India is the whole story: the
        country rail above is Hindi and English by sheer weight of
        numbers, and a Tamil or Bengali household would otherwise have to
        go looking for every channel it actually watches. The market's own
        biggest language is skipped (the country rail already is that
        rail), and only languages with a real rail's worth of channels get
        one, at most six.
    */
    const first = home[0];

    if (first) {
        const local = built.byCountry.get(first) || [];
        const counts = new Map<string, number>();

        for (const channel of local) {
            for (const code of languagesOf(channel)) counts.set(code, (counts.get(code) || 0) + 1);
        }

        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

        for (const [code, count] of ranked.slice(1, 7)) {
            if (count < MIN_RAIL) continue;

            const channels = select(built, { countries: [first], languages: [code], limit: RAIL });
            const name = languageLabel(code, (raw) => languages.find((entry) => entry.code === raw)?.name || "");

            rails.push({
                id: `lang:${first}:${code}`,
                heading: `${name} channels`,
                by: `In ${named.get(first) || first}`,
                channels,
                more: `${countryHref(first)}?l=${encodeURIComponent(code)}`
            });
        }
    }

    const themed: { id: string; heading: string; categories: string[] }[] = [
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
        if (channels.length < MIN_RAIL) continue;

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
            .filter((channel): channel is Channel => Boolean(channel))
            .sort(better)
            .slice(0, RAIL);

        if (!channels.length) continue;

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
export async function rankReachability(
    found: { items: Sourced<Stream>[]; failures: AddonFailure[] },
    skipped: number[],
    session: unknown
): Promise<number[]> {
    const available = found.items.map((_, at) => at).filter((at) => !skipped.includes(at));

    let liveProxyNow: string | null = null;

    try {
        const capability = await host.requestVpnCapability("live-tv", session);

        liveProxyNow = capability.liveProxy ? await capability.liveProxy(session) : "";
    } catch {
        liveProxyNow = null;
    }

    const cost = (at: number): number => {
        const item = found.items[at];

        if (!item) return 9;

        const fact = codecFor(item.value.url || "");

        if (!fact) return 4;

        const picture = host.canCopyVideo(session, fact.video);
        const sound = host.canCopyLiveAudio(session, fact.audio);

        if (picture && sound && fact.fields === "progressive" && fact.audioFirst) return 0;
        if (picture && sound) return 1;
        if (picture) return 2;

        return 5;
    };

    const reachOf = (at: number): number => {
        const item = found.items[at];

        if (!item) return 90;

        const said = known(item.value.url || "");

        return item.value.name === CHECKED || said === true ? 0 : said === null ? 10 : 20;
    };

    const grade = (at: number): number => reachOf(at) + cost(at);
    const sorted = available.slice().sort((a, b) => grade(a) - grade(b));

    const alive =
        liveProxyNow === null
            ? sorted.map(() => false)
            : await Promise.all(
                  sorted.map(async (at) => {
                      const stream = found.items[at]?.value;

                      if (!stream?.url) return false;

                      return verify(fullStream(stream.url), liveProxyNow as string).catch(() => false);
                  })
              );

    const answered = sorted.filter((_, at) => alive[at]);
    const reachable = answered.length > 0 ? answered : sorted;

    const LOOK_AT = 4;

    await Promise.all(
        reachable.slice(0, LOOK_AT).map(async (at) => {
            const stream = found.items[at]?.value;

            if (!stream?.url || codecFor(stream.url) || liveProxyNow === null) return;

            await probeCodec(fullStream(stream.url), liveProxyNow).catch(() => null);
        })
    );

    const ranked = reachable.slice().sort((a, b) => grade(a) - grade(b));

    return [...ranked, ...sorted.filter((at) => !ranked.includes(at))];
}
