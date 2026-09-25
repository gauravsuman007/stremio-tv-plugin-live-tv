/**
 * The `PluginHost` contract this plugin is built against.
 *
 * Structurally identical to stremio-tv's own `src/plugin-types.ts`
 * `PluginHost` (source of truth -- kept in sync by eye, no npm workspace
 * link between the two repos in this pass). stremio-tv builds the real
 * object from its own live modules (`fetchvia.ts`, `playback.ts`,
 * `session.ts`, `vpn.ts`, `html.ts`, `pages/chrome.ts`, `pages/browse.ts`)
 * and calls this plugin's default export -- a factory, `(host) =>
 * StremioTvPlugin` -- with it exactly once, at load time.
 *
 * `setHost`/`host` is this repo's way of giving every module here (not
 * just `plugin-entry.ts`, which receives it directly) access to the same
 * object without threading it through every function signature --
 * `channels.ts`, `sweep.ts` and the moved `pages/*.ts` all read `host` at
 * call time, always after the factory has run.
 */

export interface Fetched {
    status: number;
    url: string;
    type: string;
    length: number | null;
    body: NodeJS.ReadableStream;
}

export interface ViaOptions {
    proxy?: string;
    headers?: Record<string, string>;
    hops?: number;
    timeoutMs?: number;
}

export interface VpnStatus {
    enabled: boolean;
    connected: boolean;
    exitNodeName: string | null;
    exitNodes: { id: string; name: string }[];
    routeLive: boolean;
    egress?: { ok: boolean } | null;
    detail?: string | null;
}

export interface VpnCapability {
    configured: boolean;
    status: VpnStatus | null;
    liveProxy?: (session?: unknown) => Promise<string>;
}

/** Source of truth: stremio-tv `src/session.ts` `SeenChannel`. */
export interface SeenChannel {
    id: string;
    name: string;
    logo: string;
    when: number;
}

/** Source of truth: stremio-tv `src/client.ts` `Client`. Kept opaque on
 *  `request`/`session` -- this plugin never reads either directly, it only
 *  passes the `Client` it is given straight through to `host.render.*`. */
export interface Client {
    request: unknown;
    session: unknown;
    readonly authKey: string;
    link(path: string): string;
}

export type Tab = "board" | "live" | "discover" | "library" | "search" | "settings";

export interface PageOptions {
    title: string;
    body: string;
    refresh?: number;
    script?: string;
    bare?: boolean;
}

export interface PluginHost {
    fetchVia(url: string, options?: ViaOptions): Promise<Fetched>;
    contentTypeFor(name: string): string;
    session: {
        recentChannels(session: unknown): SeenChannel[];
        favouriteChannels(session: unknown): SeenChannel[];
        isFavourite(session: unknown, id: string): boolean;
        toggleFavourite(session: unknown, channel: SeenChannel): boolean;
        allFavourites(): string[];
        markChannel(session: unknown, channel: SeenChannel): void;
        railPrefs(session: unknown): { order: string[]; off: string[] };
        setRailOrder(session: unknown, order: string[], off: string[]): void;
        clearRails(session: unknown): void;
        routeLive(session?: unknown): boolean;
        setRouteLive(on: boolean, session?: unknown): void;
    };
    liveCountries: string[];
    languages: string[];
    languageCode(name: string): string;
    languageName(code: string): string;
    canCopyVideo(session: unknown, codec: string): boolean;
    canCopyLiveAudio(session: unknown, codec: string): boolean;
    undecodableFor(session: unknown): string[];
    requestVpnCapability(pluginId: string, session?: unknown): Promise<VpnCapability>;
    vpnBadge(status: VpnStatus | null): string;
    vpnSheet(status: VpnStatus | null, action: string, back: string): string;
    render: {
        escape(value: unknown): string;
        page(options: PageOptions): string;
        chrome(client: Client, current: Tab, signedIn: boolean): string;
        art(client: Client, url: string | undefined): string;
        chanCard(client: Client, channel: { id: string; name: string; logo: string; note?: string }, direct?: boolean): string;
        failureNote(failures: { addon: string; reason: string }[]): string;
        KEYS: string[];
    };
}

// eslint-disable-next-line import/no-mutable-exports
export let host: PluginHost;

export function setHost(value: PluginHost): void {
    host = value;
}
