/**
 * NAMING THE VIDEO, AND WHAT THE NAME IS ALLOWED TO DO.
 *
 * The deep check proves bytes arrive. This proves what the bytes ARE, and
 * the point of the whole exercise is that the two answers differ: a source
 * serving flawless MPEG-2 passes the deep check and freezes a browser.
 *
 * Real segments, made here with ffmpeg, rather than fixtures: the probe
 * reads a truncated transport stream through a pipe, and every interesting
 * failure in it -- too few bytes to find a video packet, a codec named
 * from an audio packet that happened to come first -- lives in exactly the
 * bytes a handmade fixture would not reproduce.
 */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testHost } from "./_test-host.mjs";

const { setHost } = await import("../dist/host.js");
setHost(testHost);

const { probeCodec, codecFor, codecRank, rankStreams, verify, deepVerify } = await import("../dist/channels.js");

let checks = 0;
const check = (what, value) => {
    assert.ok(value, what);
    checks += 1;
};
const same = (what, value, expected) => {
    assert.equal(value, expected, what);
    checks += 1;
};

/* ---- two real segments, one playable here and one not ------------------ */

function have(tool) {
    try {
        execFileSync(tool, ["-version"], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
}

if (!have("ffmpeg") || !have("ffprobe")) {
    console.log("SKIPPED: codec checks need ffmpeg and ffprobe");
    process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "stremio-codec-"));

function make(name, codec) {
    const file = join(dir, name);

    execFileSync("ffmpeg", [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", codec, "-b:v", "1500k", "-g", "25",
        "-c:a", "aac",
        "-f", "mpegts", file
    ]);

    return readFileSync(file);
}

const H264 = make("h264.ts", "libx264");
const MPEG2 = make("mpeg2.ts", "mpeg2video");

check("the fixtures are big enough to be worth probing", H264.length > 64 * 1024 && MPEG2.length > 64 * 1024);

/* ---- an origin serving both, as HLS ------------------------------------ */

const origin = createServer((request, response) => {
    const path = request.url || "";

    if (path.endsWith(".m3u8")) {
        const segment = path.includes("mpeg2") ? "/mpeg2.ts" : "/h264.ts";

        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        response.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n${segment}\n`);

        return;
    }

    if (path === "/h264.ts" || path === "/mpeg2.ts") {
        response.writeHead(200, { "content-type": "video/mp2t" });
        response.end(path === "/h264.ts" ? H264 : MPEG2);

        return;
    }

    response.writeHead(404).end();
});

await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));

const port = origin.address().port;
const at = (path) => `http://127.0.0.1:${port}${path}`;
const stream = (url) => ({ url, quality: "", labels: [], userAgent: "", referrer: "" });

const GOOD = stream(at("/good.m3u8"));
const OLD = stream(at("/mpeg2.m3u8"));

/* ---- the probe --------------------------------------------------------- */

const named = await probeCodec(GOOD);

check("a real segment gets a name", named !== null);
same("and it is the codec that was encoded", named.video, "h264");
same("with the dimensions that were encoded", named.width, 640);
check("and the audio alongside it", named.audio === "aac");

const old = await probeCodec(OLD);

same("an MPEG-2 feed is named as one", old && old.video, "mpeg2video");

check("both are remembered", codecFor(GOOD.url).video === "h264" && codecFor(OLD.url).video === "mpeg2video");
same("and an unprobed URL is simply unknown", codecFor(at("/never")), null);

/* ---- what the name is allowed to do ------------------------------------ */

same("a codec this panel decodes ranks top", codecRank(GOOD.url, ["hevc"]), 2);
same("one it does not ranks bottom", codecRank(GOOD.url, ["h264"]), 0);
same("MPEG-2 ranks bottom without anybody saying so", codecRank(OLD.url, []), 0);
same("and an unprobed source sits between them", codecRank(at("/never"), []), 1);

check(
    "an unprobed source is never buried by a known-bad one",
    codecRank(at("/never"), []) > codecRank(OLD.url, [])
);

/* ---- in the ranking, as a demotion and never a removal ------------------ */

const channel = { id: "iptv:Test.xx", name: "Test", logo: "", categories: [], labels: [], streams: [OLD, GOOD] };

/*
    Both sources are given the same evidence, so the codec is what decides:
    without it the alphabet would, and /good sorts after /mpeg2.
*/
await verify(OLD);
await verify(GOOD);
await deepVerify(OLD);
await deepVerify(GOOD);

const order = rankStreams(channel, []);

same("both mirrors are still offered", order.length, 2);
same("the decodable one leads", order[0].url, GOOD.url);
same("and the awkward one is kept, below it", order[1].url, OLD.url);

/*
    A panel that cannot decode H.264 either: now NEITHER mirror suits it,
    so the codec stops deciding and the rungs below it take over. The
    thing being asserted is that this does not collapse into hiding both.
*/
const inverted = rankStreams(channel, ["h264"]);

same("a panel that suits neither mirror still gets both", inverted.length, 2);
check(
    "and neither is promoted over the other on a codec",
    codecRank(inverted[0].url, ["h264"]) === codecRank(inverted[1].url, ["h264"])
);

const only = rankStreams({ ...channel, streams: [OLD] }, []);

same("a channel whose only mirror is awkward still has it", only.length, 1);

origin.close();

console.log(`PASSED: ${checks} codec-probe and ranking checks`);
