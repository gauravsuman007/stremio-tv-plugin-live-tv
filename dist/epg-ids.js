/**
 * iptv-org's OWN guide mapping: which guide, and which channel inside it,
 * carries a given iptv-org channel.
 *
 * `https://iptv-org.github.io/api/guides.json` lists, for every iptv-org
 * channel id ("NationalGeographic.in"), the sites that publish a schedule
 * for it and that site's own id for the channel. For the sources that
 * publish ONE bulk XMLTV file the match is therefore by ID -- nothing is
 * compared by name, so nothing can be confused with a look-alike:
 *
 *   epg.iptvx.one   site_id "1-2"                 -> that file, channel "1-2"
 *   i.mjh.nz        site_id "Plex/gb#<channel>"   -> /Plex/gb.xml.gz, channel "<channel>"
 *
 * Every other site in `guides.json` is a per-channel, per-day scraper with
 * no downloadable file. The few with an open per-channel API (`epg-sites.ts`:
 * Airtel Xstream, Dish TV) are kept apart, as `dynamic`, and asked for one
 * channel at a time when it is opened; the rest fall through to the
 * name-matched guide (`epg.ts`).
 *
 * The mapping is ~25 MB of JSON, so it is read at most once a week and only
 * the supported sites' rows are kept (see `BulkGuide`).
 */
import { isSiteProvider } from "./epg-sites.js";
export const GUIDES_URL = "https://iptv-org.github.io/api/guides.json";
const IPTVX_URL = "https://epg.iptvx.one/epg.xml.gz";
/** The file and in-file channel id for one `guides.json` row, or null for a
 *  site that has no bulk file. */
export function guideLink(site, siteId) {
    if (typeof site !== "string" || typeof siteId !== "string" || !siteId)
        return null;
    if (site === "epg.iptvx.one")
        return { url: IPTVX_URL, channel: siteId };
    if (site === "i.mjh.nz") {
        const cut = siteId.indexOf("#");
        const path = siteId.slice(0, cut);
        const channel = siteId.slice(cut + 1);
        /* A path is letters, digits and slashes: it goes into a URL. */
        if (cut > 0 && channel && /^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(path) && !path.includes("..")) {
            return { url: `https://i.mjh.nz/${path}.xml.gz`, channel };
        }
    }
    return null;
}
/** The supported rows of `guides.json`, keyed by iptv-org channel id. */
export function buildLinks(rows, now = Date.now()) {
    const links = {};
    const dynamic = {};
    /* The preference when one channel is in several guides and they
       cover it equally: the small, exact regional/service files first,
       then the Russian-language aggregate. */
    const order = (url) => (url.includes("i.mjh.nz") ? 0 : 1);
    if (Array.isArray(rows)) {
        for (const row of rows) {
            const channel = row?.channel;
            const link = typeof channel === "string" && channel ? guideLink(row.site, row.site_id) : null;
            if (typeof channel === "string" && channel && isSiteProvider(row.site) && typeof row.site_id === "string" && row.site_id) {
                const list = dynamic[channel] || (dynamic[channel] = []);
                if (!list.some((known) => known.site === row.site && known.siteId === row.site_id))
                    list.push({ site: row.site, siteId: row.site_id });
            }
            if (!link || typeof channel !== "string")
                continue;
            const list = links[channel] || (links[channel] = []);
            if (!list.some((known) => known.url === link.url && known.channel === link.channel))
                list.push(link);
        }
    }
    for (const list of Object.values(links))
        list.sort((a, b) => order(a.url) - order(b.url) || a.url.localeCompare(b.url));
    return { fetchedAt: now, links, dynamic };
}
