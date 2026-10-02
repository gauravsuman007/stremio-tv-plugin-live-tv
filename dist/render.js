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
/**
 * What swaps a card's logo for the plugin's own stored copy (`logos.ts`),
 * set once by the factory. Unset, a card is exactly what core draws.
 */
let swapLogo = null;
export function setLogoSwap(swap) {
    swapLogo = swap;
}
/** A placeholder core will accept as a logo, so it draws a picture to replace. */
const NO_LOGO = "https://logo.invalid/none";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const swapped = swapLogo ? swapLogo(channel) : null;
    const given = swapped && !channel.logo ? { ...channel, logo: NO_LOGO } : channel;
    const card = host.render.chanCard(client, chips && chips.length ? { ...given, chips } : given, direct, lazy);
    if (!swapped)
        return card;
    /*
        Core made the card's picture a link through its own image route
        (`/img/<b64 of the logo>?w=480&h=1`, the halo included). Point it at
        this plugin's stored copy instead -- a link in the viewer's own
        session -- and drop core's size and halo query with it.
    */
    const core = host.render.art(client, given.logo);
    if (!core)
        return card;
    return card.replace(new RegExp(`${escapeRegExp(core)}(?:\\?w=\\d+(?:&amp;|&)h=1)?`, "g"), () => client.link(swapped).replace(/&/g, "&amp;"));
};
export const chrome = (client, current, signedIn) => host.render.chrome(client, current, signedIn);
export const art = (client, url) => host.render.art(client, url);
export const failureNote = (failures) => host.render.failureNote(failures);
export const KEYS = () => host.render.KEYS;
export const vpnBadge = (status, scope) => host.vpnBadge(status, scope);
export const vpnSheet = (status, action, back, scope) => host.vpnSheet(status, action, back, scope);
