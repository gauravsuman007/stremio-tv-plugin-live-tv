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

export function initPluginConfig(configDir: string): void {
    base = configDir;
}

export const pluginConfig = {
    get scrapersDir(): string {
        return base ? `${base}/scrapers` : "";
    },
    get scraperStore(): string {
        return base ? `${base}/scrapers.json` : "";
    },
    get githubSourcesStore(): string {
        return base ? `${base}/github-sources.json` : "";
    },
    get liveChecks(): string {
        return base ? `${base}/live-checks.json` : "";
    },
    /** Same env var as the original, single-deployment config -- there is
     *  still only one process, so one knob for when the sweep runs. */
    liveSweepHour: Number(process.env.LIVE_SWEEP_HOUR ?? 3)
};
