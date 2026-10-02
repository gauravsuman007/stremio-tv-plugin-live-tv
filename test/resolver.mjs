/*
    STREAM RESOLVERS (`resolve.ts`, `ScrapedStream.resolver`).

    The promises: a mirror naming a resolver is only offered when the
    scraper exports it; its `url` is a handle that is NEVER fetched -- the
    relay, the check and the deep check all fetch what the resolver returns,
    at the moment they need it; what the playlist names is fetched with the
    RESOLVED headers; a resolution is reused for a few minutes and not
    asked for on every request; one that fails is a dead mirror (a 502, a
    failed check), never a fetch of the handle; and evidence stays keyed by
    the handle, which is the thing that does not change.
*/
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);
testHost.pluginApiVersion = "1.5.0";

const { initPluginConfig } = await import("../dist/plugin-config.js");
const { useScrapersForTest } = await import("../dist/scrapers.js");
const { channelIndex, resetChannelResultsForTest, forgetChannels, verify, deepVerify, known } = await import(
    "../dist/channels.js"
);
const { liveFetch, resetRelayForTest } = await import("../dist/relay.js");
const { forgetResolved } = await import("../dist/resolve.js");

initPluginConfig(mkdtempSync(`${tmpdir()}/live-tv-resolver-`));

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

const TS = Buffer.alloc(188 * 50);
for (let p = 0; p < 50; p += 1) TS[p * 188] = 0x47;

const seen = [];
const origin = createServer((request, response) => {
    seen.push({ url: request.url, referer: request.headers.referer || "", ua: request.headers["user-agent"] || "" });

    if (request.headers.referer !== "https://resolved.example/") {
        response.writeHead(403);
        response.end("no");
        return;
    }

    if (request.url.startsWith("/live-")) {
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/seg-${request.url.slice(6, 7)}.ts\n`);
        return;
    }

    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end(TS);
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const base = `http://127.0.0.1:${origin.address().port}`;

const read = async (fetched) => {
    const chunks = [];
    for await (const chunk of fetched.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
};

const HANDLE = "https://rsv.invalid/one";
const DEAD = "https://rsv.invalid/dead";
let asked = 0;
let broken = false;

const scraper = {
    id: "rsv",
    name: "Resolving",
    version: "1",
    resolvers: {
        fresh: async (handle) => {
            asked += 1;
            if (handle === DEAD || broken) return null;
            /* A different address every time, as a signed link would be. */
            return { url: `${base}/live-${asked}.m3u8`, referrer: "https://resolved.example/", userAgent: "Resolved/1" };
        }
    },
    build: async () => ({
        channels: [
            {
                id: "live:rsv:one",
                name: "Resolved One",
                country: "IN",
                countryName: "India",
                categories: [],
                languages: [],
                logo: "",
                website: "",
                network: "",
                streams: [{ url: HANDLE, quality: "", labels: [], referrer: "", userAgent: "", resolver: "fresh" }]
            },
            {
                id: "live:rsv:two",
                name: "Missing Resolver",
                country: "IN",
                countryName: "India",
                categories: [],
                languages: [],
                logo: "",
                website: "",
                network: "",
                streams: [{ url: "https://rsv.invalid/two", quality: "", labels: [], referrer: "", userAgent: "", resolver: "nope" }]
            }
        ]
    })
};

const load = async () => {
    resetChannelResultsForTest();
    forgetChannels();
    let index = null;
    for (let tries = 0; tries < 50 && !(index && index.byId.size); tries += 1) {
        index = await channelIndex();
        if (!(index && index.byId.size)) await new Promise((r) => setTimeout(r, 100));
    }
    return index;
};

/* ---- offered only when it can be resolved --------------------------------- */

resetRelayForTest();
useScrapersForTest([scraper]);
const index = await load();
ok(index && index.byId.has("live:rsv:one"), "a mirror naming an exported resolver is offered");
ok(!index.byId.has("live:rsv:two"), "one naming a resolver the scraper does not export is not");

const stream = index.byId.get("live:rsv:one").streams[0];

/* A core older than API 1.5.0 would hand the handle to the television. */
testHost.pluginApiVersion = "1.4.0";
const older = await load();
ok(!older || !older.byId.has("live:rsv:one"), "on a core older than API 1.5.0 a resolver mirror is not offered");
testHost.pluginApiVersion = "1.5.0";
ok(stream.url === HANDLE && stream.resolver === "fresh" && stream.source === "rsv", "the handle and the resolver's name survive the merge");

/* ---- the relay resolves the handle, and nothing fetches the handle ------- */

resetRelayForTest();
forgetResolved();
asked = 0;
seen.length = 0;

const list = await liveFetch(HANDLE, { proxy: "" });
ok(list && list.status === 200, "a handle is answered through the relay");
ok((await read(list)).toString().startsWith("#EXTM3U"), "as the playlist it resolved to");
ok(seen.length === 1 && seen[0].url === "/live-1.m3u8", "the resolved address was fetched, and only that");
ok(seen[0].referer === "https://resolved.example/" && seen[0].ua === "Resolved/1", "with the resolver's own headers");

const segment = await liveFetch(`${base}/seg-1.ts`, { proxy: "" });
ok(segment !== null, "what the playlist names is recognised");
ok((await read(segment)).equals(TS), "and passes through as the bytes that arrived");
ok(seen.at(-1).referer === "https://resolved.example/", "fetched with the RESOLVED referrer");

await liveFetch(HANDLE, { proxy: "" }).then(read);
ok(asked === 1, "a resolution is reused, not asked for again on every request");

/* ---- the checks use it too, and keep their evidence under the handle ----- */

forgetResolved();
asked = 0;
ok((await verify(stream)) === true, "the playlist check follows the resolver");
ok(known(HANDLE) === true, "and the evidence is stored against the handle");
ok(asked === 1, "after one resolution");
ok((await deepVerify(stream)) === true, "the deep check follows it to a real segment");
ok(asked === 1, "using the same resolution");

/* ---- failure is a dead mirror, not a fetch of the handle ------------------- */

forgetResolved();
resetRelayForTest();
seen.length = 0;
broken = true;
const refused = await liveFetch(HANDLE, { proxy: "" });
ok(refused && refused.status === 502, "a resolver that has nothing answers 502");
ok(seen.length === 0, "and nothing was fetched");
ok((await verify({ ...stream, url: "https://rsv.invalid/dead-check" })) === false, "an unresolvable mirror fails its check");

origin.close();
console.log(`resolver: ${checks} checks ok`);
process.exit(0);
