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
import { peekChannel, regionChips } from "./channels.js";
export const escape = (value) => host.render.escape(value);
export const page = (options) => host.render.page(options);
export const chanCard = (client, channel, direct, lazy) => {
    /*
        Every card carries its country and language (core API 1.3.0; an
        older core ignores the field). A favourite or a recently watched
        entry is only an id, name and logo, so it is looked up.
    */
    const known = channel.chips ? null : peekChannel(channel.id);
    const chips = channel.chips || (known ? regionChips(known, 1) : undefined);
    return host.render.chanCard(client, chips && chips.length ? { ...channel, chips } : channel, direct, lazy);
};
export const chrome = (client, current, signedIn) => host.render.chrome(client, current, signedIn);
export const art = (client, url) => host.render.art(client, url);
export const failureNote = (failures) => host.render.failureNote(failures);
export const KEYS = () => host.render.KEYS;
export const vpnBadge = (status, scope) => host.vpnBadge(status, scope);
export const vpnSheet = (status, action, back, scope) => host.vpnSheet(status, action, back, scope);
