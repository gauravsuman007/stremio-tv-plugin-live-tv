/**
 * The shape a live-TV scraper hands back. Nothing here is repo-specific on
 * purpose: this file is also handed out, BYTE-IDENTICAL, as
 * `docs/scraper-template.ts` in this same repository, to a session that
 * cannot see the rest of this codebase -- so it must stand on its own and
 * stay small enough to read once. Whenever this file changes, copy it over
 * `docs/scraper-template.ts` in the same commit (`cp src/scraper-types.ts
 * docs/scraper-template.ts`) -- nothing enforces the two staying identical.
 *
 * This is also, in turn, the canonical upstream copy that
 * `stremio-tv-scrapers-live-tv`'s own `template/scraper-template.mts`
 * (a richer, example-augmented version of the same contract) is manually
 * kept in sync against -- see that repository's `AGENTS.md`.
 */

export interface ScrapedStream {
    url: string;
    /** Free text, e.g. "1080p" -- not trusted, only shown. */
    quality: string;
    /** Short warnings such as "Geo-blocked" or "Not 24/7". */
    labels: string[];
    /** Sent as `Referer` on EVERY request this stream makes -- the
     *  playlist, each variant, each segment and key -- because the Live TV
     *  plugin relays all of them. "" when the CDN does not care. */
    referrer: string;
    /** Sent as `User-Agent` on every request, same as `referrer`. "" for
     *  the relay's default (a VLC string, which most IPTV CDNs accept). */
    userAgent: string;
    /**
     * OPTIONAL. The name of an entry in this same scraper's `decoders`
     * (see `Scraper.decoders`) that every SEGMENT of this stream must pass
     * through before a player can read it. Leave it out for an ordinary
     * stream -- which is nearly all of them.
     *
     * For a CDN that serves its video in disguise: dlhd's segments are real
     * PNG images with the MPEG-TS steganographically packed into their
     * pixels, so a player fetching one directly finds a picture and no
     * video. The plugin relays the stream, recognises each segment as this
     * stream's (playlists are read as they pass, and every URI in them is
     * remembered), and hands the bytes to your decoder on the way through.
     * Playlists themselves are never decoded.
     *
     * Kept as a NAME rather than the function itself because a scraper's
     * catalogue is stored as JSON between runs; the function is looked up
     * on the loaded scraper at play time. A name with no matching decoder,
     * or a running stremio-tv too old to let the plugin relay segments
     * (plugin API below 1.2.0), drops the stream rather than handing a
     * player something it cannot play.
     */
    decoder?: string;
    /**
     * OPTIONAL. The name of an entry in this same scraper's `resolvers`
     * (see `Scraper.resolvers`) that turns this stream's `url` into a
     * playable one AT THE MOMENT IT IS NEEDED. Leave it out for an ordinary
     * stream -- nearly all of them.
     *
     * For a source whose playable address cannot be written down ahead of
     * time: it is signed and expires (zlive's lasts two and a half hours),
     * or it is bound to the caller, or it is minted by a handshake that
     * must be repeated. Resolved once at scrape time, such a URL is stale by
     * the time anyone presses Play, and -- worse -- a source that has
     * changed its handshake answers an out-of-date one with a decoy rather
     * than an error, which is then indistinguishable from a working channel.
     *
     * With a resolver, `url` is a HANDLE: any stable, unique URL that names
     * the stream (convention: `https://<scraper id>.invalid/<key>` -- a
     * host that can never resolve, so a handle that somehow escaped
     * resolution fails cleanly instead of fetching something else). It is
     * what the host stores evidence against, ranks, and shows. It is never
     * fetched. The host calls the resolver for every check, probe and play,
     * and fetches what it returns.
     *
     * A NAME, for the reason `decoder` is one: the catalogue is stored as
     * JSON. A name with no matching resolver drops the stream.
     */
    resolver?: string;
}

/**
 * What a resolver hands back: the real address, and -- only when they
 * differ from the stream's own -- the headers it needs. The host caches the
 * answer for a few minutes and asks again when it lapses, so this may do a
 * network round trip, but a resolver is called on the way to a press of
 * Play and should answer in a few seconds. Return `null` when the stream
 * cannot be resolved right now; the host treats that as a dead mirror and
 * moves on to the next, which is exactly what a throw does too.
 */
export interface ResolvedStream {
    url: string;
    referrer?: string;
    userAgent?: string;
}

/** `handle` is the stream's own `url`. See `ScrapedStream.resolver`. */
export type StreamResolver = (handle: string) => Promise<ResolvedStream | null>;

/**
 * Turns one segment, exactly as the CDN served it, into what a player
 * expects -- normally MPEG-TS, whose 188-byte packets each begin `0x47`.
 * `url` is the segment's own address, for a decoder whose scheme depends
 * on it. Throw if the bytes are not what you expected: the relay then
 * answers that one segment with an error, and the player moves on, the
 * same as a segment that failed to download.
 *
 * Runs on the server for every segment of every viewer, so keep it to
 * pure computation over the bytes: no network, no state between calls,
 * nothing that grows. `node:zlib` and `node:crypto` are the tools for the
 * jobs this usually takes (an inflate, a gunzip, an AES block).
 */
export type SegmentDecoder = (segment: Uint8Array, url: string) => Uint8Array | Promise<Uint8Array>;

export interface ScrapedChannel {
    /**
     * Must be globally unique and must start with `live:<your-scraper-id>:`
     * -- see `idFor()` in the template. Two scrapers are never trusted to
     * agree on one id space, so nothing here is merged by name.
     */
    id: string;
    name: string;
    /** ISO-ish country code as your source writes it, or "" if unknown. */
    country: string;
    /** The same country written out. "" falls back to the code. */
    countryName: string;
    /** That country's flag emoji, or "". Repeated per channel rather than
     *  looked up separately -- one small string is cheaper than a second
     *  method every scraper would otherwise have to implement. */
    countryFlag: string;
    categories: string[];
    /** ISO 639-3 codes for the main feed. */
    languages: string[];
    logo: string;
    website: string;
    network: string;
    /** At least one, or the channel is dropped -- see the merge step. */
    streams: ScrapedStream[];
}

/*
    THE MERGE STEP, SAID PLAINLY: `fromScraper` (`channels.ts`) folds
    `name`+`country` (lowercased, diacritics stripped, "HD"/"FHD"/"4K"/
    "backup"/"feed" tokens dropped) into a key. A channel or live event
    whose key already exists -- from iptv-org's own list or an earlier
    scraper in this same rebuild -- is never added as a second card; its
    `streams` are appended onto the existing entry instead, each mirror
    still tagged internally with which scraper it came from (for the
    source list's badge) even though `ScrapedStream` itself carries no
    such field -- a scraper never sees or sets this, it is attributed
    centrally at merge time. `rankStreams` gives a non-iptv-org mirror a
    small edge over an iptv-org one when nothing else (verified liveness,
    codec) already told them apart, on the premise that a scraper worth
    running at all is usually curating better mirrors than a bulk public
    list -- but real evidence of a mirror working or not always outranks
    that hunch. None of this requires a scraper to do anything differently
    -- it falls out of writing `name` the way a person would say it.
*/

export interface ScrapedRail {
    /**
     * A short slug, unique within THIS scraper only -- `[a-z0-9-]`, 40
     * characters or fewer. The final id shown to a viewer and used for
     * hide/reorder is built centrally from it (`rail:<scraper id>-<this>`),
     * so two scrapers can both call theirs "sport" with no collision.
     */
    id: string;
    /**
     * Shown as the rail's heading, same as any other rail -- and the one
     * place two scrapers deliberately share text instead of namespacing
     * away from each other: a rail here whose heading, trimmed and
     * case-folded, matches another scraper's is merged centrally into one
     * rail carrying both scrapers' channels (deduplicated the same way a
     * repeated channel is -- see the merge step above), rather than shown
     * as two same-titled rails side by side. A live-events rail should be
     * called exactly "Live Events" for this reason -- one rail, each event
     * on it with however many sources actually carry it, not one rail per
     * scraper. Pick a generic heading like "Sports" only when merging with
     * whoever else uses it is actually what you want.
     */
    heading: string;
    /**
     * Ids of channels THIS SAME `build()` CALL also returned in `channels`.
     * An id belonging to another scraper, or to a channel this call did not
     * itself return, is dropped rather than resolved -- a rail is not a way
     * to reach into somebody else's catalogue. An empty rail after that
     * filtering is simply not shown, the same as any other rail with
     * nothing behind it.
     */
    channelIds: string[];
}

/** What one `build()` call hands back: every channel this source currently
 *  carries, and -- optionally -- named groupings of that scraper's own
 *  channels to offer as rails on the Live TV page. Most scrapers have no
 *  opinion about grouping and leave `rails` out entirely; the generic
 *  country/theme/kids rails are built centrally regardless. */
export interface ScrapedCatalogue {
    channels: ScrapedChannel[];
    rails?: ScrapedRail[];
}

/** A value one of a scraper's own config fields can hold. */
export type ScraperConfigValue = string | number | boolean;

/**
 * One user-settable knob a scraper declares for itself -- an interval, a
 * pacing delay, a page size, anything the person running this deployment
 * might reasonably want to change without editing code. Shown in Settings >
 * Live TV > Sources next to a gear icon for the scraper that declared it,
 * pre-filled with its CURRENT value (stored, or `default` if never set).
 *
 * A scraper with nothing to configure simply omits `configSchema` entirely
 * -- this is optional for a reason, most scrapers have no knobs worth
 * exposing.
 */
export interface ScraperConfigField {
    /** Stable key, unique within this scraper's own schema. Never reuse a
     *  key for a field of a different meaning -- see the host's migration
     *  behaviour, which matches a stored value back to a field by key AND
     *  type. */
    key: string;
    /** Shown as the field's label in the settings form. */
    label: string;
    type: "number" | "string" | "boolean";
    /** Used both as the field's starting value and as the fallback a stored
     *  value is replaced with when it no longer matches this field (wrong
     *  type, or the field is new). */
    default: ScraperConfigValue;
    /** For a `"number"` field only -- enforced by the settings form, not
     *  re-checked by the host beyond clamping into range. */
    min?: number;
    max?: number;
    /** A short explanation shown under the field. */
    help?: string;
}

/** What a task's `run()` is handed: this scraper's current config values
 *  (already reconciled against `configSchema`), and a way to ask for one of
 *  this scraper's OTHER tasks to have run first. */
export interface ScraperTaskContext {
    config: Record<string, ScraperConfigValue>;
    /**
     * Ensures the named task (declared in this same scraper's `tasks`) has
     * run at least once during this run -- if it already has, this is a
     * no-op; otherwise it runs now, recursively satisfying that task's own
     * `dependsOn` first. This is how a task states a real prerequisite
     * ("resolve channels before building the events rail that references
     * them") without the caller needing to know the right order itself.
     */
    runTask(id: string): Promise<void>;
}

/**
 * One independently refreshable piece of work a scraper can offer, besides
 * its main `build()`. A scraper with a single source of data has no reason
 * to declare any -- `tasks` is optional -- but a scraper that fans out
 * across data that changes at different rates (a slow full channel list, a
 * fast-moving live-events feed) can split each into its own task, each with
 * its own refresh interval (via a `configSchema` field of type `"number"`)
 * and its own manual "Run now" button in Settings.
 */
export interface ScraperTask {
    /** Stable, unique within this scraper's own `tasks`. */
    id: string;
    /** Shown next to this task's "Run now" button and its last-run status. */
    label: string;
    /** Ids of this scraper's OTHER tasks that must have already run, in
     *  order, before this one starts -- whether this task is triggered by
     *  its own schedule or by hand. The host runs each exactly once per
     *  invocation, in dependency order, so declaring `dependsOn` is the
     *  whole story; nothing else needs to reason about ordering. A cycle is
     *  a bug in the scraper and fails loudly rather than hanging. */
    dependsOn?: string[];
    /**
     * The key of a `"number"` field in this same scraper's `configSchema`,
     * read as MINUTES between automatic runs -- the host's scheduler runs
     * this task on its own once that many minutes have passed since its
     * last run (successful or not), independently of every other task.
     * Omit for a task that only ever runs as someone else's dependency, or
     * only by hand from its "Run now" button.
     */
    intervalConfigKey?: string;
    run(ctx: ScraperTaskContext): Promise<void>;
}

export interface Scraper {
    /** Stable, short, lowercase-dashed. Used as a storage key and as the
     *  namespace in every id this scraper produces -- never rename one
     *  already shipped, or every favourite and watch-progress row keyed to
     *  its old ids goes stale. */
    id: string;
    /** Shown in the settings list. */
    name: string;
    /** OPTIONAL. See `ScraperConfigField`. */
    configSchema?: ScraperConfigField[];
    /** OPTIONAL. See `ScraperTask`. */
    tasks?: ScraperTask[];
    /**
     * OPTIONAL. Named segment decoders, referenced by `ScrapedStream.decoder`
     * -- see that field for when you need one, and `SegmentDecoder` for the
     * rules. A scraper whose streams play as they are leaves this out.
     */
    decoders?: Record<string, SegmentDecoder>;
    /**
     * OPTIONAL. Named stream resolvers, referenced by
     * `ScrapedStream.resolver` -- see that field for when you need one.
     */
    resolvers?: Record<string, StreamResolver>;
    /**
     * Dot-separated integers, e.g. "1.2.0" -- OPTIONAL, but required for a
     * scraper pulled in through a GitHub source (Settings > Live TV >
     * Sources) to ever be automatically updated: re-importing a source only
     * replaces a scraper already on disk when the incoming copy's version is
     * numerically greater, segment by segment, than what is currently
     * loaded, so a re-import can never silently regress a working scraper to
     * an older or broken one. A version beats no version at all -- an
     * unversioned scraper already in place is always superseded by a
     * versioned copy of the same id, since there is no other way to tell
     * whether an unversioned file is newer or older than what replaces it.
     * Bump it whenever `build()`'s behaviour changes; leaving it unset is
     * fine for a scraper only ever dropped in by hand, where there is a
     * person deciding whether to overwrite the file anyway.
     */
    version?: string;
    /** Fetch the whole catalogue this scraper knows about, fresh. Ranking,
     *  de-duplication and liveness checking all happen centrally, after
     *  this returns -- a scraper's only job is to say what exists and
     *  where, and optionally how it would like some of that grouped. Throw
     *  on failure; the caller keeps last night's channels. */
    build(): Promise<ScrapedCatalogue>;
}
