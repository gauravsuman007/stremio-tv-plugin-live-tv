/**
 * ClearKey streams: DASH encrypted with Common Encryption, served as HLS.
 *
 * WHY THE HOST DOES THIS
 * ----------------------
 * Some sources restream a DRM-protected channel and publish the ClearKey
 * next to it (`kid:key`, for the Shaka or dash.js on their own page). A
 * `ScrapedStream` with a `clearKey` is exactly that: a `.mpd` and the key
 * that opens it. A television's browser cannot be handed a key through a
 * URL -- and an LG webOS 4.5 Chromium 53 has no business running a DASH
 * player in script anyway -- so the decryption happens HERE, once, for
 * every viewer of the channel:
 *
 *   ffmpeg -cenc_decryption_key KEY -i MANIFEST -c copy -f hls ... DIR
 *
 * It copies, never re-encodes, so the cost is a connection and some disk,
 * not a CPU core. The relay (`relay.ts`) then answers the playlist and the
 * segments out of DIR, and to everything downstream -- core's playlist
 * rewrite, hls.js, the television -- this is an ordinary HLS channel.
 *
 * HOW A SEGMENT IS RECOGNISED
 * ---------------------------
 * The playlist handed back names its segments as
 * `https://clearkey.invalid/<session>/<file>`. That host never resolves and
 * is never fetched: `liveFetch` recognises it by shape (`segmentOf`) and
 * answers from the session's directory, so, unlike a decoder's segments,
 * no per-URL rule table is needed and nothing expires out from under a
 * paused player.
 *
 * LIFETIME
 * --------
 * One ffmpeg per distinct stream (manifest + key + headers + proxy),
 * shared by every viewer. Every playlist and segment request counts as
 * activity; a session idle for `IDLE_MS` is killed and its directory
 * deleted, so a channel nobody watches costs nothing. At most
 * `MAX_SESSIONS` run at once -- the least recently used is evicted for a
 * new one. `stopClearKey()` (the plugin's `dispose()`) kills them all.
 *
 * WHAT IS NOT DONE
 * ----------------
 * The first video and first audio track only; no subtitles; no keys per
 * track (see `ScrapedStream.clearKey`). A wrong key is not detectable
 * before playing: ffmpeg copies encrypted samples without complaint, so the
 * picture is the test. The checks (`channels.ts`) go as far as the manifest.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
/** The host the playlist's segment URIs are written with. Never fetched. */
export const CLEARKEY_HOST = "clearkey.invalid";
/** How long a session may go unasked-for before it is stopped. */
const IDLE_MS = 45_000;
/** How long the first playlist may take to appear: the manifest, the init
 *  segments and a few seconds of media, over somebody else's CDN. */
const START_MS = 25_000;
/** A source that failed to start is not retried for this long, so a dead
 *  manifest does not become an ffmpeg launch per player retry. */
const FAILED_MS = 30_000;
const MAX_SESSIONS = 6;
/** How long the files of a stream that ended stay served before a request starts it again. */
const ENDED_MS = 8_000;
/** Segments to keep listed, and the target length of each. */
const LIST_SIZE = 8;
const SEGMENT_SECONDS = 4;
const sessions = new Map();
const failed = new Map();
let available = null;
/** Whether an ffmpeg that can read DASH and decrypt CENC is on this host. Asked once. */
export function ffmpegAvailable() {
    if (available !== null)
        return available;
    try {
        const run = spawnSync(FFMPEG, ["-hide_banner", "-h", "demuxer=dash"], { encoding: "utf8", timeout: 10_000 });
        available = run.status === 0 && /cenc_decryption_key/.test(`${run.stdout}${run.stderr}`);
    }
    catch {
        available = false;
    }
    return available;
}
/** For tests. */
export function forgetFfmpegForTest(value = null) {
    available = value;
}
/** A well-formed key: 16 bytes, hex. Anything else is refused before it reaches a command line. */
export function validKey(key) {
    return typeof key === "string" && /^[0-9a-fA-F]{32}$/.test(key);
}
function idOf(job) {
    return createHash("sha1")
        .update([job.manifest, job.key.toLowerCase(), job.referrer, job.userAgent, job.proxy].join("\n"))
        .digest("hex")
        .slice(0, 20);
}
/** `https://clearkey.invalid/<session>/<file>` -> its parts, or null. */
export function segmentOf(url) {
    const match = new RegExp(`^https://${CLEARKEY_HOST.replace(/\./g, "\\.")}/([0-9a-f]{20})/([A-Za-z0-9._-]+)$`).exec(url);
    return match ? { id: match[1], file: match[2] } : null;
}
function args(job, dir) {
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...(job.userAgent ? ["-user_agent", job.userAgent] : []),
        ...(job.referrer ? ["-referer", job.referrer] : []),
        ...(/^http:\/\//i.test(job.proxy) ? ["-http_proxy", job.proxy] : []),
        "-rw_timeout",
        "15000000",
        "-allowed_extensions",
        "ALL",
        "-cenc_decryption_key",
        job.key,
        "-i",
        job.manifest,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-f",
        "hls",
        "-hls_time",
        String(SEGMENT_SECONDS),
        "-hls_list_size",
        String(LIST_SIZE),
        /* temp_file: a segment is renamed into place when complete, so nothing half-written is ever served. */
        "-hls_flags",
        "delete_segments+omit_endlist+independent_segments+temp_file",
        "-hls_segment_filename",
        join(dir, "s%d.ts"),
        join(dir, "index.m3u8")
    ];
}
function stop(session) {
    session.stopped = true;
    sessions.delete(session.id);
    try {
        session.child.kill("SIGKILL");
    }
    catch {
        /* already gone */
    }
    try {
        rmSync(session.dir, { recursive: true, force: true });
    }
    catch {
        /* best effort */
    }
}
/** Does this playlist list at least one segment? (ffmpeg writes it atomically.) */
function playlistIn(session) {
    try {
        const text = readFileSync(join(session.dir, "index.m3u8"), "utf8");
        return text.includes("#EXTINF") ? text : null;
    }
    catch {
        return null;
    }
}
function start(job, id) {
    if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.touched - b.touched)[0];
        if (oldest)
            stop(oldest);
    }
    const dir = mkdtempSync(join(tmpdir(), "live-tv-clearkey-"));
    const child = spawn(FFMPEG, args(job, dir), { stdio: ["ignore", "ignore", "pipe"] });
    const log = [];
    child.stderr?.on("data", (chunk) => {
        log.push(...chunk.toString().split("\n").filter(Boolean));
        if (log.length > 20)
            log.splice(0, log.length - 20);
    });
    const session = {
        id,
        dir,
        child,
        touched: Date.now(),
        stopped: false,
        exitedAt: 0,
        log,
        ready: Promise.resolve(false)
    };
    session.ready = new Promise((resolve) => {
        const began = Date.now();
        const poll = setInterval(() => {
            if (session.stopped) {
                clearInterval(poll);
                resolve(false);
            }
            else if (playlistIn(session)) {
                clearInterval(poll);
                resolve(true);
            }
            else if (Date.now() - began > START_MS) {
                clearInterval(poll);
                resolve(false);
            }
        }, 250);
        /* Not unref'd: it ends by itself within START_MS, and an awaited start must never be abandoned. */
    });
    child.on("exit", (code) => {
        session.exitedAt = Date.now();
        if (session.stopped)
            return;
        /*
            An ffmpeg that left without ever producing a playlist failed, and
            is cleared away now. One that wrote segments and then ended is a
            stream that ended: its last segments stay readable for a player
            that is still catching up, until the idle reaper takes them.
        */
        if (!playlistIn(session)) {
            console.error(`live-tv: clearkey ffmpeg for ${new URL(job.manifest).host} exited ${code}: ${session.log.slice(-3).join(" | ")}`);
            stop(session);
        }
    });
    child.on("error", (cause) => {
        console.error("live-tv: clearkey ffmpeg could not start", cause);
        stop(session);
    });
    sessions.set(id, session);
    ensureReaper();
    return session;
}
let reaper = null;
function ensureReaper() {
    if (reaper)
        return;
    reaper = setInterval(() => {
        for (const session of [...sessions.values()]) {
            if (Date.now() - session.touched > IDLE_MS)
                stop(session);
        }
        for (const [id, at] of failed)
            if (Date.now() - at > FAILED_MS)
                failed.delete(id);
        if (!sessions.size && !failed.size && reaper) {
            clearInterval(reaper);
            reaper = null;
        }
    }, 5_000);
    reaper.unref?.();
}
function answer(status, url, type, body) {
    return { status, url, type, length: body.length, body: Readable.from([body]) };
}
/**
 * The playlist for a ClearKey stream: starts (or joins) the session, waits
 * for the first segments, and returns the playlist with every segment named
 * by an absolute `clearkey.invalid` URL. A 502 when it cannot be started.
 */
export async function clearKeyPlaylist(job) {
    const id = idOf(job);
    const denied = (why) => answer(502, job.manifest, "text/plain", Buffer.from(why));
    if (!validKey(job.key))
        return denied("This source's key is not a valid ClearKey.");
    if (!ffmpegAvailable())
        return denied("This server has no ffmpeg that can decrypt this source.");
    if (Date.now() - (failed.get(id) || 0) < FAILED_MS)
        return denied("This source could not be started a moment ago.");
    let session = sessions.get(id);
    /* A stream that ended is asked for again: start it afresh rather than serve a playlist that will never move. */
    if (session && session.exitedAt && Date.now() - session.exitedAt > ENDED_MS) {
        stop(session);
        session = undefined;
    }
    session ||= start(job, id);
    session.touched = Date.now();
    /*
        ONE RETRY, and only for an ffmpeg that exited on its own. A CDN that
        refuses the first connection and accepts the next is common enough
        (measured: a Bein feed failed once and played the second time);
        one that is simply off the air fails both in under a second, which
        is cheap, and is then remembered for FAILED_MS.
    */
    let ready = await session.ready;
    if (!ready && session.exitedAt) {
        session = start(job, id);
        session.touched = Date.now();
        ready = await session.ready;
    }
    if (!ready) {
        failed.set(id, Date.now());
        stop(session);
        return denied("This source did not start.");
    }
    const text = playlistIn(session);
    if (!text)
        return denied("This source stopped.");
    const out = text
        .split("\n")
        .map((line) => (line && !line.startsWith("#") ? `https://${CLEARKEY_HOST}/${id}/${basename(line.trim())}` : line))
        .join("\n");
    return answer(200, `https://${CLEARKEY_HOST}/${id}/index.m3u8`, "application/vnd.apple.mpegurl", Buffer.from(out));
}
/** One segment of a running session, or a 404 when it is gone (the player then asks for the playlist again). */
export function clearKeySegment(url) {
    const parts = segmentOf(url);
    if (!parts)
        return null;
    const session = sessions.get(parts.id);
    if (!session || !/^s\d+\.ts$/.test(parts.file))
        return answer(404, url, "text/plain", Buffer.from("No such segment."));
    session.touched = Date.now();
    try {
        return answer(200, url, "video/mp2t", readFileSync(join(session.dir, parts.file)));
    }
    catch {
        return answer(404, url, "text/plain", Buffer.from("No such segment."));
    }
}
/** How many sessions are running, for tests and the Sources page. */
export function clearKeySessions() {
    return sessions.size;
}
/** Kill every ffmpeg and delete every directory: the plugin's `dispose()`. */
export function stopClearKey() {
    for (const session of [...sessions.values()])
        stop(session);
    failed.clear();
    if (reaper) {
        clearInterval(reaper);
        reaper = null;
    }
}
process.once("exit", () => {
    for (const session of sessions.values()) {
        try {
            session.child.kill("SIGKILL");
            rmSync(session.dir, { recursive: true, force: true });
        }
        catch {
            /* the process is ending */
        }
    }
});
