/**
 * A minimal, test-only `PluginHost`, for suites that exercise this
 * plugin's own modules (`channels.ts`, `pages/*.ts`) in isolation, the
 * same way they ran before the split (directly against this repo's own
 * `dist/`, no stremio-tv process involved).
 *
 * `render.*` reimplements only the small, pure pieces of stremio-tv's
 * `html.ts`/`pages/chrome.ts` these tests actually assert on (HTML
 * escaping, and passing `body` through so a page's OWN template strings --
 * "Hidden", a heading, an `href` -- are still checked against the real
 * `pages/tv.ts`/`pages/rails.ts` this plugin ships). `chrome`/`art`/
 * `chanCard`/`failureNote`/`KEYS` are stubs: nothing here asserts on their
 * output, only on strings the moved page modules build themselves.
 *
 * `fetchVia` is a real (proxy-less) HTTP GET, because `channels.ts`'s
 * codec-probing tests serve real segments over real local HTTP servers.
 */

import http from "node:http";
import https from "node:https";

function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[ch]);
}

function fetchVia(url, options = {}) {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const request = transport.get(
            url,
            { headers: options.headers || {}, timeout: options.timeoutMs || 8000 },
            (incoming) => {
                const length = Number(incoming.headers["content-length"]);

                resolve({
                    status: incoming.statusCode || 0,
                    url,
                    type: String(incoming.headers["content-type"] || ""),
                    length: Number.isFinite(length) ? length : null,
                    body: incoming
                });
            }
        );

        request.on("timeout", () => request.destroy(new Error("timed out")));
        request.on("error", reject);
    });
}

export const testHost = {
    fetchVia,
    contentTypeFor: () => "video/mp4",
    session: {
        recentChannels: () => [],
        favouriteChannels: () => [],
        isFavourite: () => false,
        toggleFavourite: () => false,
        allFavourites: () => [],
        markChannel: () => {},
        railPrefs: () => ({ order: [], off: [] }),
        setRailOrder: () => {},
        clearRails: () => {},
        routeLive: () => false,
        setRouteLive: () => {}
    },
    liveCountries: ["IN", "US", "UK"],
    languages: ["eng"],
    languageCode: (name) => (name === "Hindi" || name === "hi" ? "hin" : name === "eng" ? "eng" : ""),
    languageName: (code) => code,
    canCopyVideo: () => false,
    canCopyLiveAudio: () => false,
    undecodableFor: () => [],
    requestVpnCapability: async () => ({ configured: false, status: null }),
    vpnBadge: () => "",
    vpnSheet: () => "",
    render: {
        escape,
        page: ({ body }) => body,
        chrome: () => "",
        art: (_client, url) => url || "",
        chanCard: (client, channel) =>
            `<span class="card chan"><a href="${escape(client.link(`/detail/tv/${encodeURIComponent(channel.id)}`))}">${escape(channel.name)}</a></span>`,
        failureNote: () => "",
        KEYS: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
    }
};
