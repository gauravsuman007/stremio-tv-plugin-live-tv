/**
 * Whether the running stremio-tv will actually call `liveFetch` -- see
 * `relay.ts`. Its own module, with nothing else in it, so `channels.ts` can
 * ask without importing the relay (which imports `channels.ts`).
 */
import { host } from "./host.js";
/** The first core plugin API that offers `liveFetch`. */
const RELAY_API = [1, 2, 0];
export function relayAvailable() {
    const said = (host.pluginApiVersion || "1.0.0").split(".").map((part) => Number(part) || 0);
    for (let at = 0; at < RELAY_API.length; at += 1) {
        const have = said[at] || 0;
        const need = RELAY_API[at] || 0;
        if (have !== need)
            return have > need;
    }
    return true;
}
