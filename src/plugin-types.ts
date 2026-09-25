/**
 * This plugin's own copy of the `StremioTvPlugin` contract.
 *
 * Source of truth: stremio-tv `src/plugin-types.ts`. Structurally
 * identical -- no npm workspace link between the two repos in this pass,
 * so this is kept in sync by eye, the same as `types.ts` and `host.ts`.
 */

import type { Client, PluginHost } from "./host.js";
import type { LiveStream as SharedLiveStream } from "./types.js";

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

export interface StremioTvPlugin {
    id: string;
    name: string;
    version?: string;
    routes(): PluginRoute[];
    ownsContentId?(type: string, id: string): boolean;
    metaFor?(type: string, id: string, session?: unknown): Promise<Record<string, unknown> | null>;
    streamsFor?(type: string, id: string, session?: unknown): Promise<LiveStream[]>;
    searchContent?(query: string, limit: number): Promise<{ id: string; name: string; logo: string }[]>;
    settingsLink?: { label: string; href: string };
    configDir: string;
}

export type PluginFactory = (host: PluginHost, configDir: string) => StremioTvPlugin;
