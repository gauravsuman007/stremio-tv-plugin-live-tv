/**
 * Pure data types duplicated from stremio-tv's own modules.
 *
 * This plugin is a separate package with no npm workspace/registry link
 * back to stremio-tv (out of scope for this pass -- see the repo's own
 * README), so it cannot `import` these from stremio-tv's source tree. They
 * are structurally identical to stremio-tv's originals; each one below
 * points at its source of truth so the two can be kept in sync by eye.
 */

/** Source of truth: stremio-tv `src/addons.ts` `Addon`. */
export interface Addon {
    base: string;
    manifest: { id: string; name: string; types: string[]; [key: string]: unknown };
    flags?: Record<string, unknown>;
}

/** Source of truth: stremio-tv `src/addons.ts` `MetaPreview`. */
export interface MetaPreview {
    id: string;
    type: string;
    name: string;
    poster?: string;
    posterShape?: string;
    background?: string;
    description?: string;
    releaseInfo?: string;
    imdbRating?: string | number;
    genres?: string[];
}

/** Source of truth: stremio-tv `src/addons.ts` `MetaDetail`. */
export interface MetaDetail extends MetaPreview {
    background?: string;
    logo?: string;
    cast?: string[];
    director?: string[];
    writer?: string[];
    runtime?: string;
    country?: string;
    awards?: string;
    videos?: unknown[];
    trailers?: { source?: string; type?: string }[];
    trailerStreams?: { ytId?: string; title?: string }[];
}

/** Source of truth: stremio-tv `src/addons.ts` `Stream`. */
export interface Stream {
    url?: string;
    infoHash?: string;
    fileIdx?: number;
    ytId?: string;
    externalUrl?: string;
    name?: string;
    title?: string;
    description?: string;
    behaviorHints?: { bingeGroup?: string; filename?: string; [key: string]: unknown };
    sources?: string[];
}

/** Source of truth: stremio-tv `src/addons.ts` `Sourced<T>`. */
export interface Sourced<T> {
    from: Addon;
    value: T;
}

/** Source of truth: stremio-tv `src/addons.ts` `AddonFailure`. */
export interface AddonFailure {
    addon: string;
    reason: string;
}

/**
 * Source of truth: stremio-tv `src/remux.ts` `LiveMux`. What a plugin's
 * `liveMux()` callback hands back once the core pipeline has probed a
 * resolved stream URL -- live-specific ffmpeg options only, the rest of
 * `remux.ts` is unchanged for a live vs. a VOD source.
 */
export interface LiveMux {
    proxy?: string;
    encode?: boolean;
    [key: string]: unknown;
}

/** Source of truth: stremio-tv `src/plugin-types.ts` `LiveStream`. */
export interface LiveStream extends Stream {
    live: true;
    liveMux?: (probe: unknown) => LiveMux | null;
}
