/*
    THE LIVE RELAY'S PLUGIN HALF (`relay.ts`, core plugin API 1.2.0).

    The promises: a URL this plugin has no rule for is left to core; a
    mirror that needs a Referer gets it on its playlist AND on every segment
    the playlist names (those live on hosts nothing knew about in advance);
    a mirror with a decoder has its segments decoded and typed as video,
    its playlists never touched; and a decoder mirror is only offered at all
    when the running core will actually call `liveFetch`.
*/
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { initPluginConfig } = await import("../dist/plugin-config.js");
const { useScrapersForTest } = await import("../dist/scrapers.js");
const { channelIndex, resetChannelResultsForTest, forgetChannels } = await import("../dist/channels.js");
const { liveFetch, registerStream, resetRelayForTest } = await import("../dist/relay.js");

initPluginConfig(mkdtempSync(`${tmpdir()}/live-tv-relay-`));

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

/* A "segment" of real-looking TS, and the disguise the CDN wraps it in. */
const TS = Buffer.alloc(188 * 50);
for (let p = 0; p < 50; p += 1) TS[p * 188] = 0x47;
const WRAPPED = Buffer.concat([Buffer.from("FAKEPNG!"), TS]);

const seen = [];
const origin = createServer((request, response) => {
    seen.push({ url: request.url, referer: request.headers.referer || "" });

    if (request.url === "/locked.m3u8" && request.headers.referer !== "https://site.example/") {
        response.writeHead(403);
        response.end("no");
        return;
    }

    if (request.url.endsWith(".m3u8")) {
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE,URI="key.bin"\n#EXTINF:6,\n${base}/other-host/seg.png\n`);
        return;
    }

    response.writeHead(200, { "content-type": "image/png" });
    response.end(WRAPPED);
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const base = `http://127.0.0.1:${origin.address().port}`;

const read = async (fetched) => {
    const chunks = [];
    for await (const chunk of fetched.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
};

/* ---- an unknown URL is core's, not ours ------------------------------- */

useScrapersForTest([]);
resetChannelResultsForTest();
forgetChannels();
ok((await liveFetch(`${base}/plain.m3u8`, { proxy: "" })) === null, "a URL with no rule is left to core");

/* ---- headers on the playlist and on every segment it names -------------- */

resetRelayForTest();
registerStream({ url: `${base}/locked.m3u8`, quality: "", labels: [], referrer: "https://site.example/", userAgent: "", source: "s" });

const list = await liveFetch(`${base}/locked.m3u8`, { proxy: "" });
ok(list && list.status === 200, "a Referer-locked playlist answers once the Referer is sent");
ok((await read(list)).toString().startsWith("#EXTM3U"), "and comes back as the playlist it was");

const segment = await liveFetch(`${base}/other-host/seg.png`, { proxy: "" });
ok(segment !== null, "a segment named by that playlist is recognised, on a host nothing listed");
await read(segment);
ok(seen.at(-1).referer === "https://site.example/", "and is fetched with the same Referer");
ok((await liveFetch(`${base}/key.bin`, { proxy: "" })) !== null, "a key named in a URI= attribute is recognised too");

/* ---- a decoder unwraps segments, never playlists ------------------------ */

const decoding = {
    id: "wrapper",
    name: "Wrapper",
    version: "1",
    decoders: { strip: (bytes) => bytes.subarray(8) },
    build: async () => ({
        channels: [
            {
                id: "live:wrapper:one",
                name: "Wrapped One",
                country: "IN",
                countryName: "India",
                categories: [],
                languages: [],
                logo: "",
                website: "",
                network: "",
                streams: [{ url: `${base}/wrapped.m3u8`, quality: "", labels: [], referrer: "", userAgent: "", decoder: "strip" }]
            },
            {
                id: "live:wrapper:two",
                name: "Missing Decoder",
                country: "IN",
                countryName: "India",
                categories: [],
                languages: [],
                logo: "",
                website: "",
                network: "",
                streams: [{ url: `${base}/two.m3u8`, quality: "", labels: [], referrer: "", userAgent: "", decoder: "nope" }]
            }
        ]
    })
};

/* An old core: no pluginApiVersion, so nothing that needs decoding is offered. */
delete testHost.pluginApiVersion;
resetRelayForTest();
useScrapersForTest([decoding]);
resetChannelResultsForTest();
forgetChannels();
let index = null;
for (let tries = 0; tries < 50 && !index; tries += 1) {
    index = await channelIndex();
    if (!index) await new Promise((r) => setTimeout(r, 100));
}
ok(!index || !index.byId.has("live:wrapper:one"), "on a core older than API 1.2.0 a decoder mirror is not offered");

/* A new core: offered, and played through the decoder. */
testHost.pluginApiVersion = "1.2.0";
resetChannelResultsForTest();
forgetChannels();
index = null;
for (let tries = 0; tries < 50 && !(index && index.byId.size); tries += 1) {
    index = await channelIndex();
    if (!(index && index.byId.size)) await new Promise((r) => setTimeout(r, 100));
}
ok(index && index.byId.has("live:wrapper:one"), "on API 1.2.0 the decoder mirror is offered");
ok(!index.byId.has("live:wrapper:two"), "but not one naming a decoder the scraper does not export");

/* Not registered by hand this time: the relay must find it in the index. */
resetRelayForTest();
const wrappedList = await liveFetch(`${base}/wrapped.m3u8`, { proxy: "" });
ok(wrappedList && (await read(wrappedList)).toString().startsWith("#EXTM3U"), "the playlist is found from the index and passed through undecoded");

const decoded = await liveFetch(`${base}/other-host/seg.png`, { proxy: "" });
const bytes = await read(decoded);
ok(decoded.type === "video/mp2t", "a decoded segment is typed as video");
ok(bytes.equals(TS), "and is exactly what the decoder returned");

origin.close();
console.log(`relay: ${checks} checks ok`);
process.exit(0);
