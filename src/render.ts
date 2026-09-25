/**
 * Thin, call-time wrappers around `host.render`/`host.vpnBadge`/
 * `host.vpnSheet`, shared by every moved page module.
 *
 * Deferred to call time, not bound at module load: ESM evaluates every
 * module's top-level code at import time, which happens before
 * stremio-tv's loader calls this plugin's factory (`setHost` runs inside
 * it) -- binding `const page = host.render.page` at module scope would
 * capture `undefined`.
 */

import { host } from "./host.js";

import type { Client, PageOptions, Tab, VpnStatus } from "./host.js";

export const escape = (value: unknown): string => host.render.escape(value);
export const page = (options: PageOptions): string => host.render.page(options);
export const chanCard = (
    client: Client,
    channel: { id: string; name: string; logo: string; note?: string },
    direct?: boolean
): string => host.render.chanCard(client, channel, direct);
export const chrome = (client: Client, current: Tab, signedIn: boolean): string =>
    host.render.chrome(client, current, signedIn);
export const art = (client: Client, url: string | undefined): string => host.render.art(client, url);
export const failureNote = (failures: { addon: string; reason: string }[]): string => host.render.failureNote(failures);
export const KEYS = (): string[] => host.render.KEYS;
export const vpnBadge = (status: VpnStatus | null): string => host.vpnBadge(status);
export const vpnSheet = (status: VpnStatus | null, action: string, back: string): string => host.vpnSheet(status, action, back);
