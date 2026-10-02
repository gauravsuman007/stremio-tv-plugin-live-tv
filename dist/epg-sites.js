/**
 * PER-CHANNEL GUIDE APIs, for the sites iptv-org links that publish no bulk
 * file. A channel is asked for ON ITS OWN, when it is opened or played
 * (`GuideStore` in `epg.ts`), by iptv-org's own id for it on that site
 * (`epg-ids.ts`) -- so, like the bulk files, nothing is matched by name.
 *
 * Only sites whose API answers an ordinary client, openly, are here; a
 * request is one or two small calls. Each is a port of the request iptv-org's
 * grabber (github.com/iptv-org/epg, Unlicense) makes for one channel:
 *
 *   airtelxstream.in  GET; the channel id is the site id; times in epoch ms.
 *   dishtv.in         POST per day with an anonymous token the site hands out
 *                     to anyone; times are India wall-clock written with a
 *                     "Z" that is a lie (checked against Airtel's schedule
 *                     for the same channel: only wall-clock reads right).
 *
 * Left out, and why: tataplay.com (an Akamai wall refuses non-browser
 * clients), tvtv.us (the lineup endpoint answers 404), sky.com (a batched,
 * header-per-territory scheme that does not suit one channel at a time).
 * Adding a site is one entry in `PROVIDERS`.
 */
const HOUR = 3_600_000;
/** From a little before now to a day and a half ahead. */
const BEFORE = 3 * HOUR;
const AFTER = 36 * HOUR;
const LONGEST_PROGRAMME = 8 * HOUR;
/** India is UTC+5:30 all year. */
const IST_MS = 5.5 * HOUR;
function programme(title, start, stop, description) {
    if (typeof title !== "string" || !title.trim() || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start)
        return null;
    const out = { start, stop: Math.min(stop, start + LONGEST_PROGRAMME), title: title.trim().slice(0, 200) };
    if (typeof description === "string" && description.trim())
        out.description = description.trim().slice(0, 300);
    return out;
}
/** Ordered, de-duplicated by start, and only what has not long ended. */
function tidy(list, now) {
    const byStart = new Map();
    for (const item of list)
        if (item && item.stop > now - HOUR && !byStart.has(item.start))
            byStart.set(item.start, item);
    const sorted = [...byStart.values()].sort((a, b) => a.start - b.start);
    for (let at = 0; at < sorted.length - 1; at++) {
        const here = sorted[at];
        const next = sorted[at + 1];
        if (here.stop > next.start)
            here.stop = next.start;
    }
    return sorted;
}
const airtel = {
    async fetch(siteId, now, get) {
        const url = `https://epg.airtel.tv/app/v2/content/channel/epg?channelId=${encodeURIComponent(siteId)}&startTime=${now - BEFORE}&endTime=${now + AFTER}`;
        const answer = await get(url, undefined, { headers: { Referer: "https://www.airtelxstream.in/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36" } });
        if (!answer.ok)
            throw new Error(`HTTP ${answer.status}`);
        const guide = JSON.parse(await answer.text())?.programGuide;
        const list = guide && typeof guide === "object" ? Object.values(guide)[0] : null;
        if (!Array.isArray(list))
            return [];
        return tidy(list.map((item) => programme(item?.title, Number(item?.startTime), Number(item?.endTime), item?.desc)), now);
    }
};
/** "2026-10-02T00:31:00Z" read as India wall-clock, to an instant. */
export function dishTime(value) {
    const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || ""));
    if (!found)
        return NaN;
    const [, y, mo, d, h, mi, se] = found;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0)) - IST_MS;
}
let dishToken = null;
const DISH_TOKEN_FOR = 20 * 60_000;
function istDay(ms) {
    const day = new Date(ms + IST_MS);
    return `${String(day.getUTCDate()).padStart(2, "0")}/${String(day.getUTCMonth() + 1).padStart(2, "0")}/${day.getUTCFullYear()}`;
}
async function dishSignIn(now, get) {
    if (dishToken && now - dishToken.at < DISH_TOKEN_FOR)
        return dishToken.value;
    const answer = await get("https://www.dishtv.in/services/epg/signin", undefined, {
        method: "POST",
        headers: {
            "x-requested-with": "XMLHttpRequest",
            Referer: "https://www.dishtv.in/channel-guide.html",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36"
        }
    });
    if (!answer.ok)
        throw new Error(`sign-in HTTP ${answer.status}`);
    const token = JSON.parse(await answer.text())?.token;
    if (typeof token !== "string" || !token)
        throw new Error("sign-in gave no token");
    dishToken = { value: token, at: now };
    return token;
}
const dish = {
    async fetch(siteId, now, get) {
        const token = await dishSignIn(now, get);
        /* Today and tomorrow (India's): what is on now, and a day ahead. */
        const days = [istDay(now), istDay(now + 24 * HOUR)];
        const answers = await Promise.all(days.map(async (date) => {
            const answer = await get("https://epg.mysmartstick.com/dishtv/api/v1/epg/entities/programs", undefined, {
                method: "POST",
                headers: { Authorization: token, "content-type": "application/json" },
                body: JSON.stringify({ allowPastEvents: true, channelid: siteId, date })
            });
            if (answer.status === 401 || answer.status === 403)
                dishToken = null;
            if (!answer.ok)
                throw new Error(`HTTP ${answer.status}`);
            const parsed = JSON.parse(await answer.text());
            return Array.isArray(parsed) ? parsed : [];
        }));
        return tidy(answers.flat().map((item) => programme(item?.title, dishTime(item?.start), dishTime(item?.stop), item?.desc)), now);
    }
};
/** Signs in to Dish TV ahead of the first channel opened, so that one does
 *  not pay for it. Never throws. */
export async function warmSites(get, now = Date.now()) {
    await dishSignIn(now, get).catch(() => undefined);
}
const PROVIDERS = {
    "airtelxstream.in": airtel,
    "dishtv.in": dish
};
export function isSiteProvider(site) {
    return typeof site === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, site);
}
/** One channel's schedule from one site's own API. Throws when the site
 *  cannot be reached; an empty list means it answered with nothing. */
export async function siteSchedule(link, now, get) {
    const provider = isSiteProvider(link.site) ? PROVIDERS[link.site] : undefined;
    if (!provider)
        return [];
    return provider.fetch(link.siteId, now, get);
}
