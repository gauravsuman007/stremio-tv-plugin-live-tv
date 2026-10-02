/**
 * The Live TV plugin's entry point: `(host) => StremioTvPlugin`, compiled
 * to `dist/plugin.mjs`, the path `plugins.ts`'s loader expects at
 * `<pluginsDir>/<id>/plugin.mjs`.
 *
 * Ported wholesale from what used to be `index.ts`'s own `/tv*` route
 * table (plus `metaFor`/`listFor`'s channel branch and the local
 * `rankChannel`, now `channels.ts#rankReachability`) -- see that history
 * for the reasoning behind any one route; what changed here is only the
 * plumbing: a raw `IncomingMessage`/`ServerResponse` became a
 * `PluginRouteContext`/`PluginResponse`, and every stremio-tv import
 * became a `host` call.
 */

import { setHost } from "./host.js";
import { initPluginConfig } from "./plugin-config.js";
import { chanCard, chrome, escape, page, setLogoSwap } from "./render.js";
import {
    channelIndex,
    channelMeta,
    regionChips,
    channelStreamList,
    allChannelsRanked,
    channelsIn,
    codecFor,
    sourceNameOf,
    countries,
    countryNamed,
    describeChannel,
    findChannel,
    forgetChannels,
    expireScraperResult,
    stopChannelRefresh,
    isChannelId,
    liveRails,
    loadChecks,
    provenFor,
    rankReachability,
    runScraperNow,
    searchChannels,
    warmChannel,
    flushChecks,
    type Channel
} from "./channels.js";
import { channelSearchPage, livePage } from "./pages/tv.js";
import { browsePage, worldPage } from "./pages/browse.js";
import { arrange, moved, railsPage, visibleRails, type RailSlot } from "./pages/rails.js";
import {
    forgetGithubSource,
    importFromGithub,
    importFromStoredSource,
    listGithubSources,
    rememberGithubSource,
    versionSupersedes,
    type GithubSource
} from "./github-import.js";
import { importSummary as describeImport, scraperConfigPage, scrapersPage, type GithubSourceRow, type ScraperRow } from "./pages/scrapers.js";
import {
    allScrapers,
    builtinScraperIds,
    deleteScraper,
    lastRun,
    loadDynamicScrapers,
    requestScraperStop,
    scraperEnabled,
    scraperRunning,
    setScraperEnabled
} from "./scrapers.js";
import { seedOrUpdateDefaultScraper } from "./default-scraper.js";
import { getScraperConfig, setScraperConfig } from "./scraper-config.js";
import { startScraperScheduler, stopScraperScheduler } from "./scraper-scheduler.js";
import { lastTaskRun, runScraperTask } from "./scraper-tasks.js";
import { scheduleSweep, stopSweep, sweep, sweepState } from "./sweep.js";
import { liveFetch, registerStream } from "./relay.js";
import { GuideStore, defaultFetcher, nowLine } from "./epg.js";
import { warmSites } from "./epg-sites.js";
import { BulkGuide } from "./epg-bulk.js";
import { LogoStore } from "./logos.js";
import { liveStreamColumn } from "./stream-column.js";
import { zoneForCountry } from "./timezones.js";
import { existsSync as fileExists, readFileSync as readFile, writeFileSync as writeFile } from "node:fs";
import { pluginConfig } from "./plugin-config.js";

import { PLUGIN_API_VERSION } from "./plugin-types.js";
import type { PluginFactory, PluginRoute, PluginRouteContext } from "./plugin-types.js";
import type { LiveStream, MetaDetail, Sourced, Stream } from "./types.js";

const COUNTRY_PAGE = 60;
/** How long a page waits for a channel's own guide lookup before it renders
 *  without (see `scheduleFor`). Core waits 800 ms for the player's extras. */
const TITLE_PAGE_BUDGET_MS = 400;
const PLAYER_BUDGET_MS = 600;

function html(body: string, status = 200) {
    return { status, body };
}

function redirect(client: PluginRouteContext["client"], to: string) {
    return { status: 303, headers: { location: client.link(to) }, body: "" };
}

/**
 * A short "not here" page, in the surface's own skin -- core's page shell
 * and menu row, so it looks like every other page and the remote's Back
 * key works on it (a hand-built page had neither).
 */
function bareNote(client: PluginRouteContext["client"], heading: string, detail: string): string {
    const signedIn = Boolean((client.session as { authKey?: string } | undefined)?.authKey);

    return page({
        title: heading,
        body: `${chrome(client, "live", signedIn)}
<div class="tvhead"><h1>${escape(heading)}</h1></div>
<p class="lead">${escape(detail)}</p>
<p class="bar"><a class="go" href="${escape(client.link("/tv/scrapers"))}">&lsaquo; Sources</a></p>`
    });
}

function liveSlots(
    rails: { id: string; heading: string; channels: unknown[] }[],
    favourites: unknown[],
    recent: unknown[],
    countries: unknown[]
): RailSlot[] {
    const slots: RailSlot[] = [];

    if (favourites.length) slots.push({ id: "fav", heading: "Favourites", count: favourites.length });
    if (recent.length) slots.push({ id: "recent", heading: "Recently watched", count: recent.length });

    for (const rail of rails) {
        if (rail.channels.length) slots.push({ id: rail.id, heading: rail.heading, count: rail.channels.length });
    }

    if (countries.length) slots.push({ id: "places", heading: "Channels by country", count: countries.length });

    return slots;
}

/** A list with a clock: the Programs button. Plain SVG, as core requires. */
const PROGRAMS_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6h9M3.5 11h7M3.5 16h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="14" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M17 11.5V14l1.8 1.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const createPlugin: PluginFactory = (host, configDir) => {
    setHost(host);
    initPluginConfig(configDir);

    /*
        Kicked off here, not awaited -- seeding/updating the bundled
        default scraper is a plain file copy (see default-scraper.ts), but
        still must never delay stremio-tv's boot. `configDir` (and so
        `pluginConfig.scrapersDir`) is set above, before this runs.
        `loadDynamicScrapers()` is chained after it so a freshly seeded or
        updated file is picked up on this same boot rather than the next.
    */
    void seedOrUpdateDefaultScraper()
        .catch((cause) => console.error("live-tv: seeding/updating the default scraper failed", cause))
        .then(() => loadDynamicScrapers());

    /*
        Ported from stremio-tv's own boot sequence (`index.ts`'s
        `server.listen` callback, before Live TV was a plugin): warming
        the channel index costs the better part of half a minute on a
        cold cache, so it is paid here, at load time, rather than on the
        first press of Live TV. `loadChecks()` reads last night's answers
        before anything is served, and `scheduleSweep`/
        `startScraperScheduler` arm their own timers without running
        immediately.
    */
    void channelIndex().catch(() => null);
    loadChecks();
    scheduleSweep();
    startScraperScheduler();

    /*
        THE PROGRAMME GUIDE.

        The whole guide is fetched every 12 hours and matched to every
        channel in the index (`epg-bulk.ts`), so any channel page has its
        schedule. Per-channel fetching (`epg.ts`'s `GuideStore`: on open,
        cached until the timeline ends or 12 hours, last 50 kept warm) is
        still here for a channel the bulk run did not cover, but OFF by
        default -- a switch on the Sources page. Both stopped by
        `dispose()` like every other timer here.
    */
    const guideSettingsFile = pluginConfig.epgSettings;
    const readGuideSettings = (): { dynamic: boolean } => {
        try {
            if (guideSettingsFile && fileExists(guideSettingsFile)) {
                return { dynamic: (JSON.parse(readFile(guideSettingsFile, "utf8")) as { dynamic?: unknown }).dynamic !== false };
            }
        } catch {
            /* A broken settings file is the default: on. */
        }

        return { dynamic: true };
    };
    let guideSettings = readGuideSettings();

    const bulk = new BulkGuide({
        file: pluginConfig.epgGuide,
        overridesFile: pluginConfig.epgOverrides,
        linksFile: pluginConfig.epgLinks,
        fetcher: defaultFetcher,
        channels: async () => {
            const built = await channelIndex();

            return built ? [...built.byId.values()].map((channel) => ({ id: channel.id, name: channel.name, country: channel.country, languages: channel.languages, mergedIds: channel.mergedIds })) : [];
        },
        log: (line) => console.log(line)
    });

    bulk.start();

    const guide = new GuideStore({
        file: pluginConfig.epgStore,
        overridesFile: pluginConfig.epgOverrides,
        siteLinks: async (id) => {
            const channel = await findChannel(id);

            return bulk.siteLinksFor(channel || { id });
        },
        lookup: async (id) => {
            const channel = await findChannel(id);

            return channel ? { id: channel.id, name: channel.name, country: channel.country, languages: channel.languages, mergedIds: channel.mergedIds } : null;
        },
        log: (line) => console.log(line)
    });

    if (guideSettings.dynamic) {
        guide.startWarming();
        /* The channel directory is read now, not on the first channel opened. */
        void guide.ready().catch(() => undefined);
        void warmSites(defaultFetcher);
    }

    /*
        THE LOGOS: every one kept on disk and made fit for an OLED (see
        `logos.ts`). A pass runs shortly after load -- so an update does not
        wait for the night -- and again nightly; settled logos are skipped.
        Stopped by `dispose()`.
    */
    const logos = new LogoStore({
        dir: pluginConfig.logosDir,
        stateFile: pluginConfig.logoState,
        hour: pluginConfig.liveLogoHour,
        channels: async () => {
            const built = await channelIndex();

            return built ? [...built.byId.values()].map((channel) => ({ id: channel.id, name: channel.name, logo: channel.logo })) : [];
        },
        log: (line) => console.log(line)
    });

    setLogoSwap((channel) => logos.swap(channel));
    logos.start();

    /**
     * A channel's schedule: the whole-guide data first (in memory, instant),
     * then -- when per-channel fetching is on -- a lookup of its own, waited
     * for no longer than `budgetMs`. A lookup still running when the budget
     * ends carries on in the background and is there next time; 0 never
     * waits at all. So a page never takes longer than the budget because of
     * the guide.
     */
    async function scheduleFor(channelId: string, budgetMs: number): Promise<import("./plugin-types.js").Programme[] | null> {
        const fromBulk = bulk.programmesFor(channelId);

        if (fromBulk || !guideSettings.dynamic) return fromBulk;

        return guide.programmesWithin(channelId, budgetMs);
    }

    function setDynamicGuide(on: boolean): void {
        guideSettings = { dynamic: on };

        try {
            if (guideSettingsFile) writeFile(guideSettingsFile, JSON.stringify(guideSettings));
        } catch (error) {
            console.log(`[epg] could not save the guide setting: ${(error as Error).message}`);
        }

        if (on) guide.startWarming(5_000);
        else guide.stop();
    }

    async function sendScrapersPage(client: PluginRouteContext["client"], signedIn: boolean, session: unknown, note: { text: string; ok: boolean } | null) {
        const all = allScrapers();
        const rows: ScraperRow[] = all.map((scraper) => ({
            id: scraper.id,
            name: scraper.name,
            enabled: scraperEnabled(scraper.id),
            removable: !builtinScraperIds().includes(scraper.id),
            run: lastRun(scraper.id),
            running: scraperRunning(scraper.id),
            version: scraper.version,
            configurable: Boolean(scraper.configSchema?.length || scraper.tasks?.length)
        }));
        const githubSources: GithubSourceRow[] = listGithubSources();
        const capability = await host.requestVpnCapability("live-tv", session);

        return html(
            scrapersPage(client, signedIn, rows, githubSources, note, capability.status, {
                status: bulk.status(),
                running: bulk.isRunning(),
                dynamic: guideSettings.dynamic,
                warm: guideSettings.dynamic ? guide.recentChannels().length : 0
            }, {
                pass: logos.lastPass(),
                running: logos.isRunning(),
                progress: logos.progressNow(),
                counts: logos.counts()
            })
        );
    }

    async function sendScraperConfigPage(client: PluginRouteContext["client"], signedIn: boolean, scraperId: string, note: { text: string; ok: boolean } | null) {
        const scraper = allScrapers().find((s) => s.id === scraperId);

        if (!scraper) return null;

        const values = getScraperConfig(scraper);

        return html(
            scraperConfigPage(
                client,
                signedIn,
                {
                    id: scraper.id,
                    name: scraper.name,
                    fields: (scraper.configSchema || []).map((field) => ({ field, value: values[field.key] ?? field.default })),
                    tasks: (scraper.tasks || []).map((task) => ({ task, run: lastTaskRun(scraper.id, task.id) }))
                },
                note
            )
        );
    }

    const routes: PluginRoute[] = [
        {
            method: "GET",
            path: "/tv",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const { rails, countries, down } = await liveRails(
                    host.liveCountries,
                    host.languages
                        .map((entry) => ({ code: host.languageCode(entry), name: host.languageName(entry) }))
                        .filter((entry) => entry.code && entry.name),
                    (code) => ctx.client.link(`/tv/country/${encodeURIComponent(code)}`)
                );
                const mine = host.session.favouriteChannels(ctx.client.session);
                const lately = host.session.recentChannels(ctx.client.session);
                const places = countries.slice(0, 30);
                const slots = liveSlots(rails, mine, lately, places);
                const capability = await host.requestVpnCapability("live-tv", ctx.client.session);

                return html(
                    livePage(
                        ctx.client,
                        signedIn,
                        rails,
                        lately,
                        mine,
                        places,
                        capability.status,
                        [],
                        down,
                        sweepState(),
                        ctx.client.link("/tv/sweep"),
                        visibleRails(slots, host.session.railPrefs(ctx.client.session)).map((slot) => slot.id)
                    )
                );
            }
        },
        {
            method: "GET",
            path: "/tv/rails",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const { rails, countries, down: gone } = await liveRails(
                    host.liveCountries,
                    host.languages
                        .map((entry) => ({ code: host.languageCode(entry), name: host.languageName(entry) }))
                        .filter((entry) => entry.code && entry.name),
                    (code) => ctx.client.link(`/tv/country/${encodeURIComponent(code)}`)
                );
                const slots = liveSlots(
                    rails,
                    host.session.favouriteChannels(ctx.client.session),
                    host.session.recentChannels(ctx.client.session),
                    countries.slice(0, 30)
                );
                const prefs = host.session.railPrefs(ctx.client.session);
                const asked = (what: string) => String(ctx.query.get(what) || "");

                if (ctx.query.get("reset")) {
                    host.session.clearRails(ctx.client.session);
                    return redirect(ctx.client, "/tv/rails");
                }

                for (const [what, by] of [["up", -1], ["down", 1]] as [string, -1 | 1][]) {
                    const id = asked(what);

                    if (id) {
                        host.session.setRailOrder(ctx.client.session, moved(slots, prefs, id, by), prefs.off);
                        return redirect(ctx.client, "/tv/rails");
                    }
                }

                const hide = asked("hide");
                const show = asked("show");

                if (hide || show) {
                    const off = hide
                        ? [...new Set([...prefs.off, hide])]
                        : prefs.off.filter((entry) => entry !== show);

                    host.session.setRailOrder(ctx.client.session, arrange(slots, prefs).map((slot) => slot.id), off);
                    return redirect(ctx.client, "/tv/rails");
                }

                return html(railsPage(ctx.client, signedIn, slots, prefs, !gone));
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/guide",
            async handle(ctx) {
                if (ctx.form.get("refresh")) void bulk.refresh().catch(() => undefined);
                if (ctx.form.get("dynamic")) setDynamicGuide(ctx.form.get("dynamic") === "on");

                return redirect(ctx.client, "/tv/scrapers");
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/logos",
            async handle(ctx) {
                if (ctx.form.get("refresh")) void logos.refresh("manual").catch(() => undefined);

                return redirect(ctx.client, "/tv/scrapers");
            }
        },
        {
            /* A stored or generated logo, as the cards link to it (see `render.ts`). */
            method: "GET",
            path: "/tv/logo/:file",
            async handle(ctx) {
                return logos.serve(String(ctx.params.file), ctx.query);
            }
        },
        {
            method: "GET",
            path: "/tv/scrapers",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);

                if (ctx.query.has("reload")) {
                    await loadDynamicScrapers();
                    forgetChannels();
                    return redirect(ctx.client, "/tv/scrapers");
                }

                const all = allScrapers();
                const toOn = String(ctx.query.get("on") || "");
                const toOff = String(ctx.query.get("off") || "");
                const asked = toOn || toOff;

                if (asked && all.some((scraper) => scraper.id === asked)) {
                    setScraperEnabled(asked, Boolean(toOn));
                    forgetChannels();
                    return redirect(ctx.client, "/tv/scrapers");
                }

                return sendScrapersPage(ctx.client, signedIn, ctx.client.session, null);
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/delete",
            async handle(ctx) {
                const id = String(ctx.form.get("id") || "");

                if (deleteScraper(id)) forgetChannels();

                return redirect(ctx.client, "/tv/scrapers");
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/github-import",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const combo = String(ctx.form.get("repo") || "").trim();
                const slash = combo.indexOf("/");

                if (slash < 1 || slash === combo.length - 1) {
                    return sendScrapersPage(ctx.client, signedIn, ctx.client.session, {
                        text: `"${combo}" is not an "owner/repo" address.`,
                        ok: false
                    });
                }

                const owner = combo.slice(0, slash);
                const repo = combo.slice(slash + 1);
                const token = String(ctx.form.get("token") || "").trim();
                const source = rememberGithubSource(owner, repo, token);

                try {
                    const result = await importFromGithub(owner, repo, source.token);

                    if (result.imported.length || result.updated.length) forgetChannels();

                    return sendScrapersPage(ctx.client, signedIn, ctx.client.session, { text: describeImport(result), ok: true });
                } catch (cause) {
                    return sendScrapersPage(ctx.client, signedIn, ctx.client.session, {
                        text: `Import from ${owner}/${repo} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                        ok: false
                    });
                }
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/github-recheck",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const owner = String(ctx.form.get("owner") || "");
                const repo = String(ctx.form.get("repo") || "");

                try {
                    const result = await importFromStoredSource(owner, repo);

                    if (result.imported.length || result.updated.length) forgetChannels();

                    return sendScrapersPage(ctx.client, signedIn, ctx.client.session, { text: describeImport(result), ok: true });
                } catch (cause) {
                    return sendScrapersPage(ctx.client, signedIn, ctx.client.session, {
                        text: `Check for updates on ${owner}/${repo} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                        ok: false
                    });
                }
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/github-forget",
            async handle(ctx) {
                forgetGithubSource(String(ctx.form.get("owner") || ""), String(ctx.form.get("repo") || ""));

                return redirect(ctx.client, "/tv/scrapers");
            }
        },
        {
            method: "GET",
            path: "/tv/scrapers/:id/config",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const found = await sendScraperConfigPage(ctx.client, signedIn, ctx.params.id as string, null);

                return found || html(bareNote(ctx.client, "No such source.", "It may have been removed or renamed."), 404);
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/:id/config",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const scraperId = ctx.params.id as string;
                const scraper = allScrapers().find((s) => s.id === scraperId);

                if (!scraper) return html(bareNote(ctx.client, "No such source.", "It may have been removed or renamed."), 404);

                const values: Record<string, string | number | boolean> = {};

                for (const field of scraper.configSchema || []) {
                    if (field.type === "boolean") {
                        values[field.key] = ctx.form.has(field.key);
                    } else if (field.type === "number") {
                        const raw = Number(ctx.form.get(field.key));
                        let bounded = Number.isFinite(raw) ? raw : Number(field.default);

                        if (field.min !== undefined) bounded = Math.max(field.min, bounded);
                        if (field.max !== undefined) bounded = Math.min(field.max, bounded);

                        values[field.key] = bounded;
                    } else {
                        values[field.key] = String(ctx.form.get(field.key) ?? field.default);
                    }
                }

                setScraperConfig(scraper, values);

                return (await sendScraperConfigPage(ctx.client, signedIn, scraperId, { text: "Saved.", ok: true })) as ReturnType<typeof html>;
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/:id/tasks/:taskId/run",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const scraperId = ctx.params.id as string;
                const taskId = ctx.params.taskId as string;
                const scraper = allScrapers().find((s) => s.id === scraperId);

                if (!scraper) return html(bareNote(ctx.client, "No such source.", "It may have been removed or renamed."), 404);

                try {
                    await runScraperTask(scraper, taskId, getScraperConfig(scraper));
                    expireScraperResult(scraper.id);

                    return (await sendScraperConfigPage(ctx.client, signedIn, scraperId, { text: "Ran.", ok: true })) as ReturnType<typeof html>;
                } catch (cause) {
                    return (await sendScraperConfigPage(ctx.client, signedIn, scraperId, {
                        text: `Task failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                        ok: false
                    })) as ReturnType<typeof html>;
                }
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/:id/run",
            async handle(ctx) {
                const scraperId = ctx.params.id as string;

                if (!allScrapers().some((s) => s.id === scraperId)) {
                    return html(bareNote(ctx.client, "No such source.", "It may have been removed or renamed."), 404);
                }

                // Fire and forget, same as the nightly sweep's own manual
                // trigger below -- the page polls its "running" state on
                // reload rather than waiting on this request.
                void runScraperNow(scraperId).catch((cause) =>
                    console.error(`live-tv: manual run of "${scraperId}" failed`, cause)
                );

                return redirect(ctx.client, "/tv/scrapers");
            }
        },
        {
            method: "POST",
            path: "/tv/scrapers/:id/stop",
            async handle(ctx) {
                requestScraperStop(ctx.params.id as string);

                return redirect(ctx.client, "/tv/scrapers");
            }
        },
        {
            method: "POST",
            path: "/tv/sweep",
            async handle(ctx) {
                void sweep().catch((cause) => console.error("live-tv: sweep failed", cause));

                return redirect(ctx.client, "/tv");
            }
        },
        {
            method: "POST",
            path: "/tv/fav",
            async handle(ctx) {
                const id = String(ctx.form.get("id") || "");
                const asked = String(ctx.form.get("back") || "/tv");
                const back = asked.startsWith("/") && !asked.startsWith("//") ? asked : "/tv";

                if (isChannelId(id)) {
                    const channel = await findChannel(id);

                    if (channel) {
                        host.session.toggleFavourite(ctx.client.session, {
                            id: channel.id,
                            name: channel.name,
                            logo: channel.logo,
                            when: Date.now()
                        });
                    }
                }

                return redirect(ctx.client, back);
            }
        },
        {
            /*
                One country, as a Browse page with the region fixed: genres
                down the side, languages along the top where there is a
                choice. See `pages/browse.ts`.
            */
            method: "GET",
            path: "/tv/country/:code",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const code = (ctx.params.code as string).toUpperCase();
                const country = await countryNamed(code);

                if (!country) return redirect(ctx.client, "/tv");

                const capability = await host.requestVpnCapability("live-tv", ctx.client.session);

                return html(
                    browsePage(ctx.client, signedIn, {
                        scope: { country: code, title: country.name, flag: country.flag, path: `/tv/country/${encodeURIComponent(code)}`, regionChips: false },
                        regions: [],
                        channels: await channelsIn(code),
                        genre: String(ctx.query.get("g") || ""),
                        language: String(ctx.query.get("l") || ""),
                        skip: Math.max(0, Math.floor(Number(ctx.query.get("skip")) || 0)),
                        perPage: COUNTRY_PAGE,
                        status: capability.status,
                        languageName: (raw) => host.languageName(raw)
                    })
                );
            }
        },
        {
            /*
                The guide: region chips (this household's countries, then
                everywhere), genres, languages. `c` picks the region; with
                none it opens on the household's first country, because
                that is where nearly every visit is headed.
            */
            method: "GET",
            path: "/tv/browse",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const all = await countries();
                const regions = host.liveCountries
                    .map((code) => all.find((entry) => entry.code === code))
                    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
                    .map((entry) => ({ code: entry.code, name: entry.name, flag: entry.flag }));
                const asked = ctx.query.has("c") ? String(ctx.query.get("c") || "").toUpperCase() : regions[0]?.code || "";
                const country = asked ? all.find((entry) => entry.code === asked) : undefined;
                const code = country ? country.code : "";
                const capability = await host.requestVpnCapability("live-tv", ctx.client.session);

                return html(
                    browsePage(ctx.client, signedIn, {
                        scope: {
                            country: code,
                            title: country ? country.name : "All countries",
                            flag: country ? country.flag : "",
                            path: "/tv/browse",
                            regionChips: true
                        },
                        regions,
                        channels: code ? await channelsIn(code) : await allChannelsRanked(),
                        genre: String(ctx.query.get("g") || ""),
                        language: String(ctx.query.get("l") || ""),
                        skip: Math.max(0, Math.floor(Number(ctx.query.get("skip")) || 0)),
                        perPage: COUNTRY_PAGE,
                        status: capability.status,
                        languageName: (raw) => host.languageName(raw)
                    })
                );
            }
        },
        {
            method: "GET",
            path: "/tv/world",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const capability = await host.requestVpnCapability("live-tv", ctx.client.session);

                return html(worldPage(ctx.client, signedIn, await countries(), host.liveCountries, capability.status));
            }
        },
        {
            method: "GET",
            path: "/tv/search",
            async handle(ctx) {
                const signedIn = Boolean((ctx.client.session as { authKey?: string } | undefined)?.authKey);
                const typed = String(ctx.query.get("q") || "")
                    .replace(/^\s+/, "")
                    .replace(/\s+/g, " ")
                    .slice(0, 120);
                const capability = await host.requestVpnCapability("live-tv", ctx.client.session);

                return html(
                    channelSearchPage(
                        ctx.client,
                        signedIn,
                        typed,
                        await searchChannels(typed.trim()),
                        capability.status,
                        String(ctx.query.get("k") || "")
                    )
                );
            }
        }
    ];

    return {
        id: "live-tv",
        name: "Live TV",
        version: "1.15.1",
        apiVersion: PLUGIN_API_VERSION,
        configDir: "",
        dispose() {
            stopScraperScheduler();
            stopChannelRefresh();
            stopSweep();
            flushChecks();
            guide.stop();
            bulk.stop();
            logos.stop();
        },
        routes: () => routes,
        streamColumn: (input) => liveStreamColumn(input, (url) => codecFor(url), sourceNameOf),
        ownsContentId: (type, id) => type === "tv" && isChannelId(id),
        async metaFor(type, id) {
            if (!(type === "tv" && isChannelId(id))) return null;

            const channel = await findChannel(id);

            if (!channel) return null;

            const meta = channelMeta(channel);
            /*
                WHAT IS ON, in the one line of text every core can show.
                Waited for only briefly (`TITLE_PAGE_BUDGET_MS`): core asks
                for this on the press of Play too. A schedule that takes
                longer is fetched in the background and is on the page the
                next time it opens.
            */
            const programmes = await scheduleFor(channel.id, TITLE_PAGE_BUDGET_MS);
            const line = programmes ? nowLine(programmes) : "";

            const zone = zoneForCountry(channel.country);

            return {
                ...meta,
                description: line ? `${line}\n${meta.description || ""}`.trim() : meta.description,
                /*
                    The full schedule, for core's title page (plugin API
                    1.4.0; an older core ignores it). Times are instants;
                    the page writes them in the television's zone, and in
                    the channel's own (`timeZone`) beside it.
                */
                schedule: programmes && programmes.length
                    ? {
                          programmes,
                          timeZone: zone,
                          /* "UK time", not "United Kingdom of Great Britain... time". */
                          zoneLabel:
                              (channel.countryName || "").length <= 10 && channel.countryName
                                  ? channel.countryName
                                  : channel.country
                      }
                    : undefined
            } as unknown as Record<string, unknown>;
        },
        /*
            THE PLAYER (core API 1.3.0): where the channel is from and what
            it speaks, first in the chip row; and a Programs button, only
            when there is a schedule to show. Core waits 800 ms for this;
            a channel's first schedule usually arrives well inside that,
            and the last 50 played are kept warm (see `epg.ts`).
        */
        async playerExtras(type, id) {
            if (!(type === "tv" && isChannelId(id))) return null;

            const channel = await findChannel(id);

            if (!channel) return null;

            if (guideSettings.dynamic) guide.remember(channel.id);

            const programmes = (await scheduleFor(channel.id, PLAYER_BUDGET_MS)) || [];
            const now = Date.now();
            const ahead = now + 12 * 3_600_000;
            const items = programmes
                .filter((programme) => programme.stop > now && programme.start < ahead)
                .map((programme) => ({
                    label: programme.title,
                    note: programme.description ? programme.description.slice(0, 160) : undefined,
                    start: programme.start,
                    stop: programme.stop
                }));

            return {
                chips: regionChips(channel),
                buttons: items.length
                    ? [
                          {
                              id: "programs",
                              label: "Programs",
                              /* The sidebar's heading: the channel, with its logo (API 1.4.0). */
                              heading: channel.name,
                              logo: channel.logo || undefined,
                              icon: PROGRAMS_ICON,
                              items
                          }
                      ]
                    : []
            };
        },
        async streamsFor(type, id, session) {
            if (!(type === "tv" && isChannelId(id))) return [];

            const channel = await findChannel(id);

            if (!channel) return [];

            const capability = await host.requestVpnCapability("live-tv", session);
            let proxy = "";
            let down = false;

            try {
                proxy = capability.liveProxy ? await capability.liveProxy(session) : "";
            } catch {
                down = capability.status?.routeLive === true;
            }

            /*
                Every mirror that needs the relay -- a Referer, a
                User-Agent, a segment decoder -- is made known before core
                asks for its playlist. See `relay.ts`.
            */
            for (const stream of channel.streams) registerStream(stream);

            const list = await channelStreamList(channel, proxy, down, host.undecodableFor(session));
            const order = await rankReachability(list, [], session);

            return order
                .map((at) => list.items[at])
                .filter((entry): entry is Sourced<Stream> => Boolean(entry))
                .map((entry) => {
                    const url = entry.value.url || "";
                    /*
                        THE CODEC FACT `rankReachability` ALREADY GATHERED.

                        Not a fresh probe: ffprobe over an endless playlist
                        is a wait with no answer at the end of it (see
                        `live.ts`'s own file header, in stremio-tv), so the
                        core `/play` pipeline deliberately never probes a
                        live URL itself -- it calls `liveMux(null)` and
                        trusts this plugin to already know, from the same
                        cached-on-disk fact `rankReachability`'s `cost()`
                        just sorted by.
                    */
                    const fact = codecFor(url);
                    const videoNative = !!fact && host.canCopyVideo(session, fact.video);
                    const audioNative = !!fact && host.canCopyLiveAudio(session, fact.audio);
                    const playsAsItIs =
                        videoNative && audioNative && !!fact && fact.fields === "progressive" && fact.audioFirst;

                    return {
                        ...entry.value,
                        live: true as const,
                        /*
                            See `remux.ts#LiveMux` (duplicated here in
                            `types.ts`) -- the core pipeline calls this once
                            it has probed the resolved URL (for live, that
                            probe is always `null`; see above), asking only
                            "does THIS mirror, as it last answered, need
                            converting". `null` means "play it natively,
                            hls.js is enough" -- the core pipeline then
                            skips `/remux` entirely, exactly as it would for
                            a VOD source `decide()` called native.
                        */
                        liveMux: () => (playsAsItIs ? null : { proxy, encode: !videoNative })
                    };
                });
        },
        liveFetch,
        async searchContent(query, limit) {
            const channels = await searchChannels(query, limit);

            return channels.map((channel) => ({ id: channel.id, name: channel.name, logo: channel.logo }));
        },
        // Its settings are the sources page; "/tv" is the channel guide.
        settingsLink: { label: "Live TV", href: "/tv/scrapers" }
    };
};

export default createPlugin;
