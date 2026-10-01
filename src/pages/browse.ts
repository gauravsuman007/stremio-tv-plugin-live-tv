/**
 * Browse and World TV: the whole catalogue, grouped.
 *
 * WHY TWO MORE PAGES WHEN THE RAILS EXIST
 * ---------------------------------------
 * The Live TV page is a set of recommendations -- a dozen rails, fourteen
 * cards each, chosen for this household. That answers "what's on"; it
 * cannot answer "where is Tamil news", or "what does Kenya have", because
 * those channels were never going to make a rail. So:
 *
 *   * BROWSE is the guide: pick a region (this household's own countries
 *     first), then a genre down the side, then -- where the region speaks
 *     more than one language, which for India is the point -- a language
 *     along the top. Every count is shown, so nobody presses into an empty
 *     group. A country page is the same page with the region fixed.
 *   * WORLD TV is the atlas: every country with channels, by continent,
 *     the biggest first, each one press from its own Browse page.
 *
 * Both are built from `taxonomy.ts`'s fixed genre list rather than each
 * scraper's own category words, which is what keeps the side list to a
 * dozen entries instead of sixty.
 *
 * DRAWN FOR CHROMIUM 53
 * ---------------------
 * Floats and inline-blocks, margins for spacing, no grid, no flex gap --
 * see core's `html.ts` for the full list of what that engine drops in
 * silence. Chips and tabs reuse core's own `.step` / `.step.on`, and cards
 * core's own `chanCard`/`.wall`, so these pages look like the rest of the
 * surface rather than like a plugin.
 */

import { chanCard, chrome, escape, page, vpnBadge, vpnSheet } from "../render.js";
import { relayAvailable } from "../relay-support.js";
import { describeChannel } from "../channels.js";
import { CONTINENT_LABELS, GENRES, continentOf, genreLabel, genreOf, languageLabel, languagesOf } from "../taxonomy.js";

import type { Client, VpnStatus } from "../host.js";
import type { Channel, Country } from "../channels.js";

/** The Live TV section's own tabs. `current` is the one drawn lit. */
export type LiveTab = "home" | "browse" | "world" | "search";

/**
 * The bar under every Live TV heading. One row of core's own `.step`
 * buttons, so the remote reaches them the same way it reaches every other
 * button on the surface.
 */
export function liveNav(client: Client, current: LiveTab): string {
    const tab = (id: LiveTab, href: string, label: string): string =>
        `<a class="step${id === current ? " on" : ""}" href="${escape(client.link(href))}">${label}</a>`;

    return `<p class="bar">${tab("home", "/tv", "For you")}${tab("browse", "/tv/browse", "Browse")}${tab("world", "/tv/world", "&#127757; World TV")}${tab("search", "/tv/search", "&#9906; Search")}<a class="step" href="${escape(client.link("/tv/rails"))}">&#9776; Arrange</a><a class="step" href="${escape(client.link("/tv/scrapers"))}">Sources</a></p>`;
}

/*
    NO STYLESHEET OF OUR OWN. These pages are built from core's skin and
    its plugin kit (`.chiprow`, `.sidenav`/`.sidemain`, `.step .n` -- see
    core's `html.ts` and `docs/plugin-template.ts`), so a change to the
    palette, the type scale or the focus treatment there reaches them with
    nothing to copy.

    The one exception is a core older than plugin API 1.2.0, which has no
    kit: there, and only there, these few rules stand in for it, so a
    plugin updated before its host is not drawn unstyled.
*/
const KIT_FALLBACK = `<style>
.chiprow { margin: 0 0 .4em 0; }
.chiprow .lab { display: inline-block; min-width: 8em; font-size: .62em; font-weight: 700; color: #808080; text-transform: uppercase; }
.step .n { font-weight: 400; opacity: .7; margin-left: .45em; }
.sidenav { float: left; width: 13.5em; margin: 0 1.6em 1em 0; }
.sidenav a { display: block; padding: .5em .9em; margin: 0 0 .2em 0; border-radius: 4px; color: #b3b3b3; font-size: .88em; font-weight: 700; }
.sidenav a.on { background: #ffffff; color: #141414; }
.sidenav a.off { opacity: .35; }
.sidenav .n { float: right; }
.sidemain { overflow: hidden; }
.sidemain .wall .chan { width: 23%; margin-right: 2%; }
</style>`;

function kit(): string {
    return relayAvailable() ? "" : KIT_FALLBACK;
}

/** Cards past the first two rows of a wall load as they near the screen
 *  (core's shared script), the way Home defers its posters. */
const EAGER = 8;

function routing(client: Client, status: VpnStatus | null, back: string): string {
    const panel = vpnSheet(status, client.link("/vpn"), back);

    return panel ? `<section class="routing">${vpnBadge(status)}${panel}</section>` : "";
}

export interface BrowseScope {
    /** "" for every country. */
    country: string;
    /** Heading, e.g. "India" or "All channels". */
    title: string;
    flag: string;
    /** The path this page lives at, which every filter link keeps. */
    path: string;
    /** True on `/tv/browse`, where the region is a chip; false on a
     *  country's own page, where it is the page. */
    regionChips: boolean;
}

export interface BrowseInput {
    scope: BrowseScope;
    /** The household's countries, for the region chips, with names. */
    regions: { code: string; name: string; flag: string }[];
    /** Every channel in scope (already filtered to `scope.country`). */
    channels: Channel[];
    genre: string;
    language: string;
    skip: number;
    perPage: number;
    status: VpnStatus | null;
    /** Turns a language code into a name, for languages `taxonomy.ts`
     *  does not know -- core's own table. */
    languageName: (code: string) => string;
}

/** Counts, most first, then by the given order. */
function counted<T extends string>(values: T[]): Map<T, number> {
    const counts = new Map<T, number>();

    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);

    return counts;
}

export function browsePage(client: Client, signedIn: boolean, input: BrowseInput): string {
    const { scope, channels } = input;

    /*
        THREE PASSES OVER ONE LIST, each narrowing the last: genres are
        counted over the whole region (so the side list never changes as a
        language is picked -- a list that reshuffles under the remote is a
        list nobody can learn), languages over the chosen genre (so a
        language chip never leads to an empty page), and the wall is what
        survives both.
    */
    const browsable = channels.filter((channel) => genreOf(channel) !== null);
    const genreCounts = counted(browsable.map((channel) => genreOf(channel) as string));
    const genre = input.genre && genreCounts.has(input.genre) ? input.genre : "";
    const inGenre = genre ? browsable.filter((channel) => genreOf(channel) === genre) : browsable;

    const languageCounts = counted(inGenre.flatMap((channel) => languagesOf(channel)));
    const languages = [...languageCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14);
    const language = input.language && languageCounts.has(input.language) ? input.language : "";
    const shown = language ? inGenre.filter((channel) => languagesOf(channel).includes(language)) : inGenre;
    const slice = shown.slice(input.skip, input.skip + input.perPage);

    const link = (over: { c?: string; g?: string; l?: string; skip?: number }): string => {
        const c = over.c !== undefined ? over.c : scope.country;
        const g = over.g !== undefined ? over.g : genre;
        const l = over.l !== undefined ? over.l : language;
        const parts: string[] = [];

        if (scope.regionChips && c) parts.push(`c=${encodeURIComponent(c)}`);
        if (g) parts.push(`g=${encodeURIComponent(g)}`);
        if (l) parts.push(`l=${encodeURIComponent(l)}`);
        if (over.skip) parts.push(`skip=${over.skip}`);

        return `${client.link(scope.path)}${parts.length ? `?${parts.join("&")}` : ""}`;
    };

    const chip = (href: string, label: string, on: boolean, count?: number): string =>
        `<a class="step${on ? " on" : ""}" href="${escape(href)}">${label}${count !== undefined ? `<span class="n">${count.toLocaleString("en")}</span>` : ""}</a>`;

    /*
        REGIONS: the household's countries, then everywhere, then the atlas
        for anything else. Changing region clears the genre and language,
        because "Tamil" in the United Kingdom is an empty page.
    */
    const regionRow = scope.regionChips
        ? `<p class="chiprow"><span class="lab">Region</span>${input.regions
              .map((region) => chip(link({ c: region.code, g: "", l: "" }), `${escape(region.flag)} ${escape(region.name)}`, region.code === scope.country))
              .join("")}${chip(link({ c: "", g: "", l: "" }), "All countries", !scope.country)}${chip(client.link("/tv/world"), "More countries &rsaquo;", false)}</p>`
        : "";

    /*
        LANGUAGES only where there is a choice to make: two or more
        languages with at least two channels each. A single-language
        country gets no row at all rather than one chip that does nothing.
    */
    const languageRow =
        languages.length >= 2
            ? `<p class="chiprow"><span class="lab">Language</span>${chip(link({ l: "" }), "All", !language)}${languages
                  .map(([code, count]) => chip(link({ l: code }), escape(languageLabel(code, input.languageName)), code === language, count))
                  .join("")}</p>`
            : "";

    const side = `<nav class="sidenav">${[
        `<a class="${genre ? "" : "on"}" href="${escape(link({ g: "", l: "" }))}">All genres<span class="n">${browsable.length.toLocaleString("en")}</span></a>`,
        ...GENRES.map((entry) => {
            const count = genreCounts.get(entry.id) || 0;

            /*
                An empty genre is drawn dimmed, not removed, so the list
                keeps one shape from country to country and the remote
                lands on News in the same place every time.
            */
            return count
                ? `<a class="${entry.id === genre ? "on" : ""}" href="${escape(link({ g: entry.id, l: "" }))}">${escape(entry.label)}<span class="n">${count.toLocaleString("en")}</span></a>`
                : `<a class="off" href="${escape(link({ g: entry.id, l: "" }))}">${escape(entry.label)}<span class="n">0</span></a>`;
        })
    ].join("")}</nav>`;

    const pager =
        shown.length > input.perPage
            ? `<p class="bar">${
                  input.skip > 0 ? `<a class="step" href="${escape(link({ skip: Math.max(0, input.skip - input.perPage) }))}">&lsaquo; Back</a>` : ""
              }${input.skip + input.perPage < shown.length ? `<a class="step" href="${escape(link({ skip: input.skip + input.perPage }))}">More &rsaquo;</a>` : ""}</p>`
            : "";

    const what = [genre ? genreLabel(genre) : "", language ? languageLabel(language, input.languageName) : ""].filter(Boolean).join(", ");
    const main = slice.length
        ? `<p class="hint">${escape(
              `${input.skip + 1}-${input.skip + slice.length} of ${shown.length.toLocaleString("en")}${what ? ` (${what})` : ""}, channels that played at the last check first`
          )}</p>
<div class="wall">
${slice.map((channel, at) => chanCard(client, { ...channel, note: describeChannel(channel) }, false, at >= EAGER)).join("\n")}
</div>
${pager}`
        : `<p class="empty">Nothing here yet${what ? ` for ${escape(what)}` : ""}. Try another genre, or All.</p>`;

    return page({
        title: `Live TV: ${scope.title}`,
        body: `${chrome(client, "live", signedIn)}
${kit()}
<div class="tvhead">
<h1>${scope.flag ? `<span class="flag">${escape(scope.flag)}</span> ` : ""}${escape(scope.title)}</h1>
${liveNav(client, scope.regionChips ? "browse" : "world")}
</div>
${routing(client, input.status, scope.path)}
${regionRow}
${languageRow}
<div>
${side}
<div class="sidemain">
${main}
</div>
</div>`
    });
}

function countryTile(client: Client, country: Country): string {
    return `<span class="card flagcard"><a href="${escape(client.link(`/tv/country/${encodeURIComponent(country.code)}`))}">
<span class="art"><span class="flag">${escape(country.flag || country.code)}</span></span>
<span class="label">${escape(country.name)}</span>
<span class="year">${country.channels.toLocaleString("en")} channels</span>
</a></span>`;
}

/**
 * The atlas: this household's own countries, then every continent, each
 * one's countries biggest first. Continent chips at the top jump down the
 * page, because Oceania is a long way down on a remote.
 */
export function worldPage(client: Client, signedIn: boolean, countries: Country[], home: string[], status: VpnStatus | null): string {
    const total = countries.reduce((sum, country) => sum + country.channels, 0);
    const mine = home
        .map((code) => countries.find((country) => country.code === code))
        .filter((country): country is Country => Boolean(country));

    const byContinent = new Map<string, Country[]>();

    for (const country of countries) {
        const continent = continentOf(country.code);
        const list = byContinent.get(continent) || [];

        list.push(country);
        byContinent.set(continent, list);
    }

    const order = ["asia", "europe", "north-america", "latin-america", "africa", "oceania", "elsewhere"].filter((id) => byContinent.has(id));

    const jump = `<p class="chiprow"><span class="lab">Jump to</span>${order
        .map((id) => `<a class="step" href="#lt-${id}">${escape(CONTINENT_LABELS[id] || id)}<span class="n">${(byContinent.get(id) || []).length}</span></a>`)
        .join("")}</p>`;

    const section = (id: string, heading: string, by: string, list: Country[]): string =>
        list.length
            ? `<section class="shelf" id="lt-${escape(id)}">
<h2>${escape(heading)} <span class="by">${escape(by)}</span></h2>
<div class="wall">
${list.map((country) => countryTile(client, country)).join("\n")}
</div>
</section>`
            : "";

    return page({
        title: "Live TV: World TV",
        body: `${chrome(client, "live", signedIn)}
${kit()}
<div class="tvhead">
<h1>&#127757; World TV</h1>
${liveNav(client, "world")}
</div>
${routing(client, status, "/tv/world")}
<p class="lead">${escape(`${total.toLocaleString("en")} channels from ${countries.length} countries.`)}</p>
${jump}
${section("home", "Your countries", "Set for this household", mine)}
${order
    .map((id) => {
        const list = byContinent.get(id) || [];
        const channels = list.reduce((sum, country) => sum + country.channels, 0);

        return section(id, CONTINENT_LABELS[id] || id, `${list.length} countries, ${channels.toLocaleString("en")} channels`, list);
    })
    .join("\n")}`
    });
}
