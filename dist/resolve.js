/**
 * Stream resolvers: turning a scraper's HANDLE into an address that can be
 * fetched right now. See `ScrapedStream.resolver` for why a scraper would
 * want that; this file is the host's half.
 *
 * Nothing but the fetch layers calls this -- the check, the deep check, the
 * codec probe and the relay -- because everything else here (evidence,
 * ranking, the source list, the relay's rule table) is keyed by the
 * stream's own `url`, and that is deliberately the handle, which does not
 * change from one resolution to the next. Evidence gathered last night
 * therefore still describes this mirror this morning, which it could not if
 * the key were an address that expires every two hours.
 */
import { allScrapers } from "./scrapers.js";
/**
 * How long one answer is reused. Resolutions are cheap to repeat but not
 * free (one is a handshake with somebody else's server), and a press of
 * Play asks several times in quick succession: the ranking's check, the
 * relay's playlist, the player's own re-fetches, a remux. Short, because the
 * point of resolving late is that the address is fresh.
 */
const FRESH_MS = 5 * 60_000;
/** A failure is remembered much more briefly: it is usually a blip, and the
 *  next press ought to try again. Long enough that a page of mirrors that
 *  all fail does not hammer the source once per request. */
const FAILED_MS = 20_000;
/** A resolver is on the way to a press of Play; it does not get long. */
const RESOLVE_MS = 12_000;
const MAX_ENTRIES = 5_000;
const answers = new Map();
const asking = new Map();
export function resolverOf(stream) {
    if (!stream.resolver)
        return null;
    const scraper = allScrapers().find((entry) => entry.id === stream.source);
    const found = scraper?.resolvers?.[stream.resolver];
    return typeof found === "function" ? found : null;
}
/**
 * The address to fetch for this mirror. `null` means it cannot be resolved
 * right now, which every caller treats as a dead mirror -- never as a
 * reason to fetch the handle.
 *
 * A stream with no resolver is its own answer, synchronously cheap.
 */
export async function aimOf(stream) {
    if (!stream.resolver)
        return { url: stream.url, referrer: stream.referrer, userAgent: stream.userAgent };
    const kept = answers.get(stream.url);
    if (kept && Date.now() - kept.at < (kept.aim ? FRESH_MS : FAILED_MS))
        return kept.aim;
    const running = asking.get(stream.url);
    if (running)
        return running;
    const resolver = resolverOf(stream);
    if (!resolver)
        return null;
    const work = (async () => {
        let timer;
        try {
            const got = await Promise.race([
                resolver(stream.url),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(null), RESOLVE_MS);
                    timer.unref?.();
                })
            ]);
            if (!got || !/^https?:\/\//i.test(got.url))
                return null;
            return {
                url: got.url,
                referrer: got.referrer ?? stream.referrer,
                userAgent: got.userAgent ?? stream.userAgent
            };
        }
        catch (cause) {
            console.error(`live-tv: resolver "${stream.resolver}" of "${stream.source}" threw for ${stream.url}`, cause);
            return null;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    })();
    asking.set(stream.url, work);
    try {
        const aim = await work;
        answers.delete(stream.url);
        answers.set(stream.url, { at: Date.now(), aim });
        if (answers.size > MAX_ENTRIES) {
            for (const key of answers.keys()) {
                answers.delete(key);
                if (answers.size <= MAX_ENTRIES * 0.9)
                    break;
            }
        }
        return aim;
    }
    finally {
        asking.delete(stream.url);
    }
}
/** Forget what has been resolved -- a scraper was reloaded, or a test. */
export function forgetResolved() {
    answers.clear();
}
