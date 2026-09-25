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
export const escape = (value) => host.render.escape(value);
export const page = (options) => host.render.page(options);
export const chanCard = (client, channel, direct) => host.render.chanCard(client, channel, direct);
export const chrome = (client, current, signedIn) => host.render.chrome(client, current, signedIn);
export const art = (client, url) => host.render.art(client, url);
export const failureNote = (failures) => host.render.failureNote(failures);
export const KEYS = () => host.render.KEYS;
export const vpnBadge = (status) => host.vpnBadge(status);
export const vpnSheet = (status, action, back) => host.vpnSheet(status, action, back);
