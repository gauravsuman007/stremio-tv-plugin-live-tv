/**
 * This plugin's own copy of the `StremioTvPlugin` contract.
 *
 * Source of truth: stremio-tv `src/plugin-types.ts`. Structurally
 * identical -- no npm workspace link between the two repos in this pass,
 * so this is kept in sync by eye, the same as `types.ts` and `host.ts`.
 * Synced against core's `PLUGIN_API_VERSION` "1.2.0" as of this pass --
 * see that constant's own doc comment in the core file for the
 * MAJOR/MINOR/PATCH rule a future sync needs to check against, and bump
 * `PLUGIN_API_VERSION` below (and `plugin.ts`'s `apiVersion` field)
 * together with whatever brought this file's shape up to date.
 */

import type { Client, PluginHost, VpnStatus } from "./host.js";
import type { MetaPreview, Sourced, Stream, LiveStream as SharedLiveStream } from "./types.js";

export interface PluginRoute {
    method: "GET" | "POST";
    path: string;
    handle(ctx: PluginRouteContext): Promise<PluginResponse | void>;
}

export interface PluginRouteContext {
    method: string;
    path: string;
    query: URLSearchParams;
    form: URLSearchParams;
    headers: Record<string, string | string[] | undefined>;
    client: Client;
    params: Record<string, string>;
}

export interface PluginResponse {
    status?: number;
    headers?: Record<string, string>;
    body: string | Buffer;
}

export type LiveStream = SharedLiveStream;

/** The plugin contract's own version, independent of any one plugin's
 *  `version` -- see `StremioTvPlugin.apiVersion` and core's own doc
 *  comment on this same constant for the versioning rule. */
export const PLUGIN_API_VERSION = "1.2.0";

/** Source of truth: stremio-tv `src/plugin-types.ts` `LiveFetched` -- what
 *  `liveFetch` hands back: a fetched response whose body may be any
 *  readable stream (a decoded segment has no socket behind it). */
export interface LiveFetched {
    status: number;
    url: string;
    type: string;
    length: number | null;
    body: import("node:stream").Readable;
}

/** A shelf this plugin contributes to the home board, alongside the addon
 *  catalogue shelves -- e.g. a "Trending on X" rail that links to titles
 *  addons already own, without this plugin claiming any content id
 *  itself. */
export interface RailSection {
    name: string;
    by?: string;
    previews: MetaPreview[];
}

/** A stream a plugin injects into an EXISTING title's stream list --
 *  distinct from `LiveStream`/`streamsFor`, which only ever answers for
 *  an id this plugin owns outright. Shaped like an addon's own `Stream`
 *  so it merges into the same ranking pipeline as any other
 *  `Sourced<Stream>`. */
export type ExtraStream = Stream;

/** One row a plugin's own stream column is asked to draw: a stream this
 *  plugin offered through `extraStreamsFor`, with the `/play` link
 *  stremio-tv built for it. `from` is the attribution the plugin itself
 *  returned. */
export interface StreamColumnRow {
    href: string;
    from: { manifest: { id: string; name?: string } };
    stream: ExtraStream;
}

/** What `streamColumn` is handed. `vpn`/`vpnAction`/`back` are for
 *  `PluginHost.vpnBadge`/`vpnSheet`, when the plugin shows its routing. */
export interface StreamColumnInput {
    type: string;
    id: string;
    title: string;
    rows: StreamColumnRow[];
    vpn: VpnStatus | null;
    vpnAction: string;
    back: string;
}

/** A column on the "select quality" screen: `html` is inserted as is,
 *  under `heading`, beside the torrents & debrid column. */
export interface StreamColumn {
    heading: string;
    html: string;
}

export interface StremioTvPlugin {
    id: string;
    name: string;
    version?: string;
    /** The `PLUGIN_API_VERSION` this plugin's factory was written
     *  against. Optional for backward compatibility -- a missing
     *  `apiVersion` is treated as `"1.0.0"` by core, rather than
     *  rejected. See core's own doc comment on `PLUGIN_API_VERSION` for
     *  what a mismatch does. */
    apiVersion?: string;
    /** Called by stremio-tv just before this plugin instance is replaced
     *  or removed (update, disable, delete). Clear every timer, interval
     *  and background loop this plugin started -- the replacement is a
     *  freshly imported copy with its own, and nothing else will stop
     *  the old ones. */
    dispose?(): void | Promise<void>;
    /** Optional: a plugin may own no pages of its own (a search-only,
     *  rails-only, or stream-only plugin is a legitimate shape). */
    routes?(): PluginRoute[];
    /** Contribute a shelf to the home board (see `RailSection`), without
     *  owning any content id. `client` is the same `Client` a route
     *  handler gets, for locale/session-aware previews. */
    rails?(client: Client): Promise<RailSection[]>;
    /** Offer supplementary streams for ANY title -- addon-owned or owned
     *  by another plugin -- without claiming ownership of `id`. Merged
     *  into the same list/ranking as addon streams wherever
     *  `/play`/`/detail` assembles it. */
    extraStreamsFor?(type: string, id: string, session?: unknown): Promise<Sourced<ExtraStream>[]>;
    /** Draw this plugin's own column on the "select quality" screen (API
     *  1.1.0). When present, every stream whose `from.manifest.id` is
     *  this plugin's id leaves the torrents & debrid list and is handed
     *  here instead. Absent, or throwing, and those streams are drawn as
     *  ordinary rows. */
    streamColumn?(input: StreamColumnInput): StreamColumn | null;
    ownsContentId?(type: string, id: string): boolean;
    metaFor?(type: string, id: string, session?: unknown): Promise<Record<string, unknown> | null>;
    streamsFor?(type: string, id: string, session?: unknown): Promise<LiveStream[]>;
    /** API 1.2.0: answer one request of core's `/live` relay (a playlist,
     *  a segment, a key) before core fetches it itself; `null` means "not
     *  mine". Must honour `proxy`. See `relay.ts`. */
    liveFetch?(url: string, options: { proxy: string }): Promise<LiveFetched | null>;
    /** PROPOSED for core API 1.3.0 -- not in core yet, see `epg.ts` and
     *  the README. A channel's programme schedule, every time an absolute
     *  instant (epoch ms) so whoever draws it uses the VIEWER's own zone.
     *  `playing` is true when asked from the player rather than the title
     *  page. `null` when there is no schedule. An older core never calls
     *  it, which is harmless: the title page still gets the now/next line
     *  through `metaFor`'s description. */
    programmesFor?(type: string, id: string, context?: { playing?: boolean }): Promise<Programme[] | null>;
    searchContent?(query: string, limit: number): Promise<{ id: string; name: string; logo: string }[]>;
    settingsLink?: { label: string; href: string };
    configDir: string;
}

/** One programme on a channel. `start`/`stop` are epoch milliseconds (UTC
 *  instants), never clock times. */
export interface Programme {
    start: number;
    stop: number;
    title: string;
    subtitle?: string;
    description?: string;
    category?: string;
}

export type PluginFactory = (host: PluginHost, configDir: string) => StremioTvPlugin;
