/**
 * Whether the running stremio-tv will actually call `liveFetch` -- see
 * `relay.ts`. Its own module, with nothing else in it, so `channels.ts` can
 * ask without importing the relay (which imports `channels.ts`).
 */
import { host } from "./host.js";
/** The first core plugin API that offers `liveFetch`. */
const RELAY_API = [1, 2, 0];
/** The first core plugin API that never hands a RESOLVER mirror straight to
 *  the television (`ScrapedStream.resolver`): its `url` is a handle, and a
 *  device fetching it directly would find nothing. */
const RESOLVER_API = [1, 5, 0];
/** The first core plugin API that never hands a CLEARKEY mirror straight to
 *  the television (`ScrapedStream.clearKey`): its `url` is an encrypted DASH
 *  manifest, which only this plugin's relay can turn into playable HLS. */
const CLEARKEY_API = [1, 6, 0];
function atLeast(need) {
    const said = (host.pluginApiVersion || "1.0.0").split(".").map((part) => Number(part) || 0);
    for (let at = 0; at < need.length; at += 1) {
        const have = said[at] || 0;
        const want = need[at] || 0;
        if (have !== want)
            return have > want;
    }
    return true;
}
export function relayAvailable() {
    return atLeast(RELAY_API);
}
/** Whether the running core knows what to do with a resolver mirror. */
export function resolverAvailable() {
    return atLeast(RESOLVER_API);
}
/** Whether the running core knows what to do with a ClearKey mirror. */
export function clearKeyApiAvailable() {
    return atLeast(CLEARKEY_API);
}
