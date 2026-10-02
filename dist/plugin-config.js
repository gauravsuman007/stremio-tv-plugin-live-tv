/**
 * This plugin's own on-disk layout, all beneath the `configDir` stremio-tv
 * hands it at load time (`<pluginsDir>/live-tv`).
 *
 * Source of truth for the ORIGINAL, single-deployment version of these
 * paths: stremio-tv `src/config.ts` (`scrapersDir`, `scraperStore`,
 * `githubSourcesStore`, `liveChecks`, `liveSweepHour`). Now that Live TV is
 * a dropped-in plugin rather than a core module, it keeps its own state
 * under its own directory instead of reading `SESSION_STORE`-relative env
 * vars directly -- `init()` is called once, by `plugin-entry.ts`'s factory,
 * with the `configDir` the loader assigned.
 */
let base = "";
export function initPluginConfig(configDir) {
    base = configDir;
}
export const pluginConfig = {
    get scrapersDir() {
        return base ? `${base}/scrapers` : "";
    },
    get scraperStore() {
        return base ? `${base}/scrapers.json` : "";
    },
    get githubSourcesStore() {
        return base ? `${base}/github-sources.json` : "";
    },
    get scraperResultsDir() {
        return base ? `${base}/scraper-results` : "";
    },
    /** The programme-guide cache: directory, schedules, warm set. */
    get epgStore() {
        return base ? `${base}/epg-cache.json` : "";
    },
    /** The whole guide, matched to our channels, and the last run's status. */
    get epgGuide() {
        return base ? `${base}/epg-guide.json` : "";
    },
    /** iptv-org's guide mapping (which bulk guide carries which channel). */
    get epgLinks() {
        return base ? `${base}/epg-links.json` : "";
    },
    /** `{"dynamic": boolean}` -- per-channel guide fetching, on by default. */
    get epgSettings() {
        return base ? `${base}/epg-settings.json` : "";
    },
    /** Hand-made guide matches: `{"<channel id>": "<epg.pw id>" | null}`. */
    get epgOverrides() {
        return base ? `${base}/epg-overrides.json` : "";
    },
    /** Every channel logo: the original, and the copy made for the television. */
    get logosDir() {
        return base ? `${base}/logos` : "";
    },
    /** What was decided about each logo, so a night's pass only looks at what is new. */
    get logoState() {
        return base ? `${base}/logos.json` : "";
    },
    get liveChecks() {
        return base ? `${base}/live-checks.json` : "";
    },
    /** Same env var as the original, single-deployment config -- there is
     *  still only one process, so one knob for when the sweep runs. */
    liveSweepHour: Number(process.env.LIVE_SWEEP_HOUR ?? 3),
    /** Local hour of the nightly logo pass; -1 turns the nightly run off. */
    liveLogoHour: Number(process.env.LIVE_LOGO_HOUR ?? 4)
};
