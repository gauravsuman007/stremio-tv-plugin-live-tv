/**
 * The Live TV page, and its country lists.
 *
 * WHY LIVE TV IS NOT JUST ANOTHER CATALOGUE
 * -----------------------------------------
 * Everything else on this surface is a thing you choose once and then
 * watch. Live TV is a thing you SURF: the viewer does not know what they
 * want, they know roughly where to look -- the news, the sport, their own
 * country, the four channels they always end up on. So the page is built
 * out of those, and the one rail that matters most is the one nobody has to
 * think about: the channels this household has already been watching.
 *
 * A channel is not a poster. The artwork a channel has is a LOGO -- wide,
 * usually transparent, drawn for a corner of a screen and not for a 2:3
 * tile -- so these cards are their own shape: a wide dark tile with the
 * logo centred in it and the name underneath. Cropping a logo into the
 * poster shape the rest of the surface uses cuts the wordmark in half,
 * which is exactly the part that identifies it.
 *
 * WHY THE VPN PANEL IS ON EVERY ONE OF THESE PAGES
 * ------------------------------------------------
 * Because live TV is the only traffic this service routes, and because the
 * consequence of getting it wrong is invisible: with the switch on and the
 * tunnel down NOTHING plays, and with it off everything plays from the
 * house's own address. Both are states somebody needs to know they are in
 * BEFORE pressing a channel, not after -- so the state and the switch are
 * at the top of the page rather than four presses away in Settings.
 */
import { chanCard, chrome, escape, failureNote, KEYS, page, vpnBadge, vpnSheet } from "../render.js";
import { describeChannel } from "../channels.js";
import { liveNav } from "./browse.js";
/** One country tile: the flag, the name, and how many channels are behind it. */
function countryCard(client, country) {
    return `<span class="card flagcard"><a href="${escape(client.link(`/tv/country/${encodeURIComponent(country.code)}`))}">
<span class="art"><span class="flag">${escape(country.flag || country.code)}</span></span>
<span class="label">${escape(country.name)}</span>
<span class="year">${country.channels} channels</span>
</a></span>`;
}
/*
    WHICH LOGOS WAIT. The same rule core's Home uses for posters: the first
    two rails on screen load whole, and every rail loads its first seven
    cards at once; the rest name their logo in "data-src" and core's shared
    script swaps it in as the rail scrolls near. A dozen rails of fourteen
    logos is a hundred and fifty images a 2016 panel would otherwise decode
    before the page answered the remote.
*/
const EAGER_RAILS = 2;
const EAGER_CARDS = 7;
function lazyAt(position, index) {
    return position >= EAGER_RAILS && index >= EAGER_CARDS;
}
function chanShelf(client, heading, by, channels, more, position) {
    if (channels.length === 0)
        return "";
    const link = more
        ? ` <a class="by" href="${escape(more)}">${escape(by)} &rsaquo;</a>`
        : ` <span class="by">${escape(by)}</span>`;
    return `<section class="shelf">
<h2>${escape(heading)}${link}</h2>
<div class="strip">
${channels.map((channel, index) => chanCard(client, { ...channel, note: describeChannel(channel) }, false, lazyAt(position, index))).join("\n")}
</div>
</section>`;
}
/**
 * WHAT THE NIGHT FOUND, said on the page.
 *
 * Because the ordering of every rail above now depends on it, and a page
 * whose ordering depends on something invisible is a page nobody can
 * reason about. On a cold install it says so instead of showing a number,
 * which is the honest version of "the rails are still guessing".
 */
function sweepLine(sweep, action) {
    const check = action
        ? `<form class="inline" method="POST" action="${escape(action)}">
<button class="pick" type="submit"${sweep.running ? " disabled" : ""}>Check now</button>
</form>`
        : "";
    const said = sweep.running
        ? "Checking every source now."
        : sweep.at
            ? `${sweep.found.toLocaleString("en")} of ${sweep.tried.toLocaleString("en")} sources answered when they were last checked, ${when(sweep.at)}.` +
                (sweep.deep
                    ? ` ${sweep.deep.toLocaleString("en")} of them played real video, which is the stronger test.`
                    : "")
            : "No sources have been checked yet -- the rails are ordered by what the list claims until tonight's check runs.";
    return `<p class="bar"><span class="hint">${escape(said)}</span> ${check}</p>`;
}
/** "3 hours ago", near enough. Nobody on a sofa wants a timestamp. */
function when(at) {
    const hours = Math.round((Date.now() - at) / 3_600_000);
    if (hours < 1)
        return "in the last hour";
    if (hours === 1)
        return "an hour ago";
    if (hours < 36)
        return `${hours} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
}
/**
 * The top of every live page: where this traffic is going out, and the
 * switch. See the file header for why it is not in Settings.
 */
function routing(client, status, back) {
    const panel = vpnSheet(status, client.link("/vpn"), back);
    if (!panel)
        return "";
    /*
        One line and a cog, not a section. The state is worth showing on
        every live page; the switches are worth showing when asked for.
    */
    return `<section class="routing">${vpnBadge(status)}${panel}</section>`;
}
export function livePage(client, signedIn, rows, recent, 
/** The channels this household said it wants. See `session.ts`. */
favourites, countries, status, failures, 
/** True when the index could not be built at all. */
down, 
/** What the nightly check last found, so the page can say. */
sweep, 
/** Where "check now" posts to. */
sweepAction = "", 
/**
 * The ids to draw, in the order this set arranged them. Empty means
 * the page the service builds on its own.
 */
show = []) {
    /*
        THE HOUSEHOLD'S OWN RAIL, ABOVE EVERY COMPUTED ONE.

        Everything below this is a guess -- a composite of how widely a
        channel is carried, what it broadcasts and what the night found.
        This one is not a guess, so it goes first, and its cards say so:
        a favourite's sources are followed all the way to video overnight,
        which no other channel's are.
    */
    const kept = (position) => favourites.length
        ? `<section class="shelf">
<h2>Favourites <span class="by">Checked in depth every night</span></h2>
<div class="strip">
${favourites.map((entry, index) => chanCard(client, entry, false, lazyAt(position, index))).join("\n")}
</div>
</section>`
        : "";
    const watched = (position) => recent.length
        ? `<section class="shelf">
<h2>Recently watched <span class="by">This household</span></h2>
<div class="strip">
${recent.map((entry, index) => chanCard(client, entry, true, lazyAt(position, index))).join("\n")}
</div>
</section>`
        : "";
    const places = countries.length
        ? `<section class="shelf">
<h2>Channels by country <a class="by" href="${escape(client.link("/tv/world"))}">Every country, in World TV &rsaquo;</a></h2>
<div class="strip">
${countries.map((country) => countryCard(client, country)).join("\n")}
</div>
</section>`
        : "";
    /*
        EVERY RAIL BY NAME, then drawn in the order the set asked for.

        The two household rails and the country wall are in here with the
        computed ones because they are rails to the person looking at them
        -- a page that can hide Sports but not "Recently watched" is a
        page that half-answers the request.
    */
    const drawn = new Map([
        ["fav", kept],
        ["recent", watched],
        ["places", () => places],
        ...rows.map((row) => [row.id, (position) => chanShelf(client, row.heading, row.by, row.channels, row.more, position)])
    ]);
    const natural = ["fav", "recent", ...rows.map((row) => row.id), "places"];
    /*
        Positions count only rails that actually draw, so an empty
        Favourites does not push the first real rail into the lazy zone.
    */
    let position = 0;
    const rails = (show.length ? show : natural)
        .map((id) => {
        const html = drawn.get(id)?.(position) || "";
        if (html)
            position += 1;
        return html;
    })
        .join("\n");
    return page({
        title: "Live TV",
        body: `${chrome(client, "live", signedIn)}
<div class="tvhead">
<h1>Live TV</h1>
${liveNav(client, "home")}
</div>
${routing(client, status, "/tv")}
${failureNote(failures)}
${down
            ? `<p class="empty">The channel index could not be reached, or no source is configured yet &mdash; see <a href="${escape(client.link("/tv/scrapers"))}">Sources</a>. Once a source answers it is cached for twelve hours, and this page fills in.</p>`
            : ""}
${rails}
${sweepLine(sweep, sweepAction)}
<p class="hint">${escape("Ordered by what last night's check found first, then by how widely each channel is carried, what it broadcasts and whether it is a major in its own market -- a stand-in for popularity, not an audience figure.")}</p>`
    });
}
/**
 * The channel keyboard.
 *
 * The same one Search uses, and deliberately a SEPARATE page from it: a
 * search here is a search of 10,000 channel names held in this process,
 * which answers instantly and never asks an addon anything. Folding it
 * into the main search would make every channel keystroke wait on the
 * catalogues. Channels still appear in the main search -- see `index.ts` --
 * this is the one that is only channels.
 */
export function channelSearchPage(client, signedIn, query, channels, status, pressed = "") {
    const to = (term, key) => {
        const parts = [];
        if (term)
            parts.push(`q=${encodeURIComponent(term)}`);
        if (key)
            parts.push(`k=${encodeURIComponent(key)}`);
        return `${client.link("/tv/search")}${parts.length ? `?${parts.join("&")}` : ""}`;
    };
    const ring = (key) => (key === pressed ? ` id="tvfocus"` : "");
    const keys = KEYS().map((letter) => `<a class="key" data-term="${escape(query + letter)}"${ring(letter)} href="${escape(to(query + letter, letter))}">${escape(letter)}</a>`).join("\n");
    const spaced = query && !/ $/.test(query) ? `${query} ` : query;
    const edits = `<a class="key key-wide" data-term="${escape(spaced)}"${ring("space")} href="${escape(to(spaced, "space"))}">Space</a>` +
        `<a class="key key-wide" data-term="${escape(query.slice(0, -1))}"${ring("del")} href="${escape(to(query.slice(0, -1), "del"))}">Delete</a>` +
        `<a class="key key-wide" data-term=""${ring("clear")} href="${escape(to("", "clear"))}">Clear</a>` +
        `<a class="key key-wide" href="${escape(client.link("/tv"))}">Done</a>`;
    const waiting = query.trim().length < 2;
    const results = waiting
        ? `<p class="empty">${query ? "Keep going &mdash; two letters is enough." : "Pick letters on the left."}</p>`
        : channels.length
            ? `<div class="wall">
${channels.map((channel, index) => chanCard(client, { ...channel, note: describeChannel(channel) }, false, index >= 8)).join("\n")}
</div>`
            : `<p class="empty">No channel called &ldquo;${escape(query)}&rdquo;.</p>`;
    return page({
        title: query ? `Channels: ${query}` : "Search channels",
        body: `${chrome(client, "live", signedIn)}
${routing(client, status, "/tv/search")}
<div class="searchrow">
<div class="keyside">
<p class="qbar"><span id="term">${query ? escape(query) : `<span class="ghost">Channel</span>`}</span><span class="caret">&#9612;</span></p>
<div class="keys">
${keys}
${edits}
</div>
<form method="GET" action="${escape(client.link("/tv/search"))}">
<label for="q">Or type, if this set has a keyboard</label>
<input id="q" name="q" type="search" value="${escape(query)}" autocomplete="off">
</form>
</div>
<div class="resside">
${!waiting ? `<p class="hint">${escape(`${channels.length} channel${channels.length === 1 ? "" : "s"} matching “${query}”`)}</p>` : ""}
${results}
</div>
</div>`
    });
}
