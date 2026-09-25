/**
 * The shape a live-TV scraper hands back. Nothing here is repo-specific on
 * purpose: this file is also handed out, unchanged, as `docs/scraper-template.ts`
 * to a session that cannot see the rest of this codebase, so it must stand
 * on its own and stay small enough to read once.
 */

export interface ScrapedStream {
    url: string;
    /** Free text, e.g. "1080p" -- not trusted, only shown. */
    quality: string;
    /** Short warnings such as "Geo-blocked" or "Not 24/7". */
    labels: string[];
    referrer: string;
    userAgent: string;
}

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

export interface ScrapedRail {
    /**
     * A short slug, unique within THIS scraper only -- `[a-z0-9-]`, 40
     * characters or fewer. The final id shown to a viewer and used for
     * hide/reorder is built centrally from it (`rail:<scraper id>-<this>`),
     * so two scrapers can both call theirs "sport" with no collision.
     */
    id: string;
    /** Shown as the rail's heading, same as any other rail. */
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
