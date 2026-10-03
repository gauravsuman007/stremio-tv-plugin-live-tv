/*
    CLEARKEY STREAMS (`clearkey.ts`, `ScrapedStream.clearKey`).

    The promises: a mirror carrying a ClearKey is offered only when this host
    can play it (the relay, a core that never gives it to the television
    directly, an ffmpeg that decrypts DASH, a well-formed key); asked for
    through the relay it comes back as ordinary HLS whose segments are served
    from an ffmpeg session; that ffmpeg is told the key, the manifest and the
    stream's own headers and nothing else a stream could smuggle onto a
    command line; one ffmpeg serves however many viewers; one that will not
    start is a 502, not a hang; the checks go as far as the manifest; and
    nothing outlives `stopClearKey()`.

    ffmpeg itself is a STUB (`FFMPEG_PATH`): a script that records its
    arguments and writes a small HLS directory. ffmpeg's own CENC writer
    makes fixtures its own reader rejects, so a faithful encrypted DASH cannot
    be made here, and what this file tests is this module's logic. The real
    thing was run against a live encrypted stream by hand when this was
    written (see AGENTS.md, "ClearKey streams").
*/
import assert from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(`${tmpdir()}/live-tv-clearkey-`);
const LOG = join(work, "ffmpeg.log");

/* ---- a stand-in ffmpeg ----------------------------------------------------- */

const STUB = join(work, "ffmpeg");
writeFileSync(
    STUB,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("-h")) { console.log("  -cenc_decryption_key <string>  Media decryption key (hex)"); process.exit(0); }
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ pid: process.pid, args }) + "\\n");
const manifest = at("-i");
if (/fails/.test(manifest)) { console.error("Invalid data found when processing input"); process.exit(1); }
const out = args[args.length - 1];
const pattern = at("-hls_segment_filename");
const ts = (n) => { const b = Buffer.alloc(188 * 20); for (let p = 0; p < 20; p++) b[p * 188] = 0x47; b[1] = n; return b; };
let list = "#EXTM3U\\n#EXT-X-VERSION:6\\n#EXT-X-TARGETDURATION:4\\n#EXT-X-MEDIA-SEQUENCE:0\\n";
for (let n = 0; n < 3; n++) { fs.writeFileSync(pattern.replace("%d", String(n)), ts(n)); list += "#EXTINF:4.000000,\\n" + pattern.replace(/.*[/\\\\]/, "").replace("%d", String(n)) + "\\n"; }
fs.writeFileSync(out + ".tmp", list); fs.renameSync(out + ".tmp", out);
setInterval(() => {}, 1000);
`
);
chmodSync(STUB, 0o755);
process.env.FFMPEG_PATH = STUB;

const { testHost } = await import("./_test-host.mjs");
const { setHost } = await import("../dist/host.js");
setHost(testHost);
testHost.pluginApiVersion = "1.6.0";

const { initPluginConfig } = await import("../dist/plugin-config.js");
const { useScrapersForTest } = await import("../dist/scrapers.js");
const { channelIndex, resetChannelResultsForTest, forgetChannels, verify, deepVerify, probeCodec, known } = await import(
    "../dist/channels.js"
);
const { liveFetch, resetRelayForTest, needsRelay } = await import("../dist/relay.js");
const { forgetResolved } = await import("../dist/resolve.js");
const { stopClearKey, clearKeySessions, forgetFfmpegForTest, segmentOf } = await import("../dist/clearkey.js");

initPluginConfig(mkdtempSync(`${tmpdir()}/live-tv-clearkey-cfg-`));

let checks = 0;
const ok = (value, said) => {
    assert.ok(value, said);
    checks += 1;
};

const KEY = "000102030405060708090a0b0c0d0e0f";
const KID = "11223344556677889900112233445566";

const origin = createServer((request, response) => {
    if (request.url === "/page.mpd") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>not a manifest</html>");
    } else if (request.url.endsWith(".mpd")) {
        response.writeHead(200, { "content-type": "application/dash+xml" });
        response.end('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"></MPD>');
    } else {
        response.writeHead(404);
        response.end("no");
    }
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const base = `http://127.0.0.1:${origin.address().port}`;

const read = async (fetched) => {
    const chunks = [];
    for await (const chunk of fetched.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
};

const launches = () =>
    existsSync(LOG)
        ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];

const stream = (url, extra = {}) => ({ url, quality: "", labels: [], referrer: "https://ck.example/", userAgent: "CK/1", ...extra });

const scraper = {
    id: "ck",
    name: "ClearKey",
    version: "1",
    decoders: { noop: (segment) => segment },
    build: async () => ({
        channels: [
            ["good", "Good Key", [stream(`${base}/manifest.mpd`, { clearKey: { kid: KID, key: KEY } })]],
            ["bad", "Malformed Key", [stream(`${base}/bad.mpd`, { clearKey: { kid: KID, key: "not-hex" } })]],
            ["inject", "Injecting Key", [stream(`${base}/inject.mpd`, { clearKey: { kid: KID, key: `${KEY} -f x` } })]],
            ["both", "Key And Decoder", [stream(`${base}/both.mpd`, { clearKey: { kid: KID, key: KEY }, decoder: "noop" })]],
            ["fails", "Wont Start", [stream(`${base}/fails.mpd`, { clearKey: { kid: KID, key: KEY } })]],
            ["page", "Not A Manifest", [stream(`${base}/page.mpd`, { clearKey: { kid: KID, key: KEY } })]]
        ].map(([id, name, streams]) => ({
            id: `live:ck:${id}`,
            name,
            country: "IN",
            countryName: "India",
            categories: [],
            languages: [],
            logo: "",
            website: "",
            network: "",
            streams
        }))
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

/* ---- offered only when this host can play it -------------------------------- */

resetRelayForTest();
useScrapersForTest([scraper]);
const index = await load();
ok(index && index.byId.has("live:ck:good"), "a ClearKey mirror is offered when the host can play it");
ok(!index.byId.has("live:ck:bad"), "one with a malformed key is not");
ok(!index.byId.has("live:ck:inject"), "nor one whose key would be more than a key on a command line");
ok(!index.byId.has("live:ck:both"), "nor one that also names a decoder");

const good = index.byId.get("live:ck:good").streams[0];
ok(good.clearKey && good.clearKey.key === KEY && good.url === `${base}/manifest.mpd`, "the key and the manifest address survive the merge");
ok(needsRelay(good), "and it is a relay mirror, never handed to the television directly");

testHost.pluginApiVersion = "1.5.0";
const older = await load();
ok(!older || !older.byId.has("live:ck:good"), "on a core older than API 1.6.0 it is not offered");
testHost.pluginApiVersion = "1.6.0";

forgetFfmpegForTest(false);
const noFfmpeg = await load();
ok(!noFfmpeg || !noFfmpeg.byId.has("live:ck:good"), "without an ffmpeg that decrypts DASH it is not offered");
forgetFfmpegForTest(null);

const again = await load();
ok(again && again.byId.has("live:ck:good"), "and it is again once there is one (the stub answers ffmpeg's own help)");
const stillGood = again.byId.get("live:ck:good").streams[0];

/* ---- the relay serves it as HLS ---------------------------------------------- */

resetRelayForTest();

const playlist = await liveFetch(stillGood.url, { proxy: "" });
ok(playlist && playlist.status === 200, `the manifest is answered through the relay (${playlist && playlist.status})`);
ok(playlist.type === "application/vnd.apple.mpegurl", "as a playlist");

const text = (await read(playlist)).toString();
ok(text.startsWith("#EXTM3U") && (text.match(/#EXTINF/g) || []).length === 3, "which is HLS with its segments");

const names = text.split("\n").filter((line) => line && !line.startsWith("#"));
ok(names.length === 3 && names.every((line) => segmentOf(line)), "each segment named by an absolute clearkey.invalid URL");
ok(clearKeySessions() === 1, "from one session");

const ran = launches();
ok(ran.length === 1, "and one ffmpeg");

const argv = ran[0].args;
const after = (flag) => argv[argv.indexOf(flag) + 1];
ok(after("-cenc_decryption_key") === KEY, "which was given the key");
ok(after("-i") === `${base}/manifest.mpd`, "and the manifest");
ok(after("-referer") === "https://ck.example/" && after("-user_agent") === "CK/1", "and the stream's own Referer and User-Agent");
ok(argv.includes("copy") && !argv.some((a) => /libx264|aac$/.test(a)), "copying, never re-encoding");
ok(argv.includes("-hls_flags") && /temp_file/.test(after("-hls_flags")), "writing each segment to its name only when complete");
ok(argv.filter((a) => a === "-i").length === 1, "with exactly one input");

const first = await liveFetch(names[0], { proxy: "" });
ok(first && first.status === 200 && first.type === "video/mp2t", "a segment comes from the session");
const ts = await read(first);
ok(ts.length === 188 * 20 && ts[0] === 0x47 && ts[188] === 0x47, "as the bytes ffmpeg wrote");

const second = await liveFetch(stillGood.url, { proxy: "" });
await read(second);
ok(clearKeySessions() === 1 && launches().length === 1, "a second viewer of the same stream does not start a second ffmpeg");

const unknown = await liveFetch(`https://clearkey.invalid/${"0".repeat(20)}/s0.ts`, { proxy: "" });
ok(unknown && unknown.status === 404, "a segment of a session that is not running is a 404");
const traversal = await liveFetch(`https://clearkey.invalid/${segmentOf(names[0]).id}/..%2F..%2Fetc%2Fpasswd`, { proxy: "" });
ok(traversal === null || traversal.status === 404, "and a file name that is not a segment is never opened");

/* ---- one that will not start is a 502 ------------------------------------------ */

const failing = again.byId.get("live:ck:fails").streams[0];
const before = launches().length;
const denied = await liveFetch(failing.url, { proxy: "" });
ok(denied && denied.status === 502, "a source ffmpeg cannot open answers 502, not a hang");
await liveFetch(failing.url, { proxy: "" }).then((r) => r && read(r));
ok(launches().length === before + 2, "after one immediate retry of its own (a CDN that refuses once is common)");
await liveFetch(failing.url, { proxy: "" }).then((r) => r && read(r));
ok(launches().length === before + 2, "and is then not relaunched on every request the player retries");

/* ---- the checks go as far as the manifest --------------------------------------- */

forgetResolved();
ok((await verify(stillGood)) === true, "the check passes a reachable MPD");
ok(known(stillGood.url) === true, "and the evidence is stored against the manifest address");
ok((await deepVerify(stillGood)) === true, "the deep check agrees");
ok((await probeCodec(stillGood)) === null, "the codec probe leaves it alone");
ok((await verify({ ...stillGood, url: `${base}/page.mpd` })) === false, "a page that is not an MPD fails the check");
ok((await verify({ ...stillGood, url: `${base}/gone.txt` })) === false, "so does a 404");

/* ---- it ends ------------------------------------------------------------------------ */

const pids = launches().map((entry) => entry.pid);
stopClearKey();
ok(clearKeySessions() === 0, "stopClearKey ends every session");
const gone = await liveFetch(names[0], { proxy: "" });
ok(gone && gone.status === 404, "a segment of an ended session is a 404 (the player asks for the playlist again)");

await new Promise((resolve) => setTimeout(resolve, 300));
const alive = pids.filter((pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
});
ok(alive.length === 0, `and no ffmpeg is left running (${alive.join(",") || "none"})`);

origin.close();
console.log(`clearkey: ${checks} checks ok`);
process.exit(0);
