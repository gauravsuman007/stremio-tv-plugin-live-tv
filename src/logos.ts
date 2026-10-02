/**
 * Every channel logo, kept on disk and made fit for an OLED television.
 *
 * WHAT IT DOES
 * ------------
 * One pass over the channel index: each logo URL not yet dealt with is
 * downloaded, its ORIGINAL saved under `<configDir>/logos/` (so it keeps
 * working when the host it came from does not), and a display copy made:
 *
 *   ok         readable on a dark tile as it is -- kept as a stored,
 *              downsized transparent PNG.
 *   processed  hard to read (a black wordmark, a navy one) or wrapped in a
 *              white rectangle -- background cut away, recoloured, served
 *              as a near-black tile (option C, see `logo-image.ts`).
 *   svg        an SVG original: stored and served as it is.
 *   failed     gone, or not a picture -- the card shows the channel's
 *              name in a tinted pill instead (option E), as it does for a
 *              channel that never had a logo.
 *
 * WHEN IT RUNS
 * ------------
 * Shortly after the plugin loads (so an update does not wait for the
 * night), every night after that, and from a button on the Sources page.
 * Every run skips what is already settled: a logo is looked at again only
 * when its URL is new, its `LOGO_DESIGN` is older, it failed a fortnight
 * ago, or a month has passed. So the first run does the work and the
 * nightly one finds almost nothing.
 *
 * HOW IT REACHES THE SCREEN
 * -------------------------
 * stremio-tv draws a channel card from a logo URL it fetches itself and
 * bakes a white halo under. `swap()` rewrites that one picture in the card
 * to this plugin's own `/tv/logo/...` route (a session-relative link the
 * television can reach), which core's halo never touches. A logo not dealt
 * with yet is left exactly as it was.
 *
 * Every host is asked politely: many hosts at once, one request at a time
 * per host with a pause, and a host that answers 429 three times in a row
 * is left alone for the rest of the run.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { assess, decodePng, encodePng, fitToPng, LOGO_DESIGN, pillSvg, readable, recolor, tileSvg } from "./logo-image.js";

export type LogoStatus = "ok" | "processed" | "svg" | "failed" | "retry";

interface Entry {
    url: string;
    status: LogoStatus;
    /** When it was last settled (ms). */
    at: number;
    /** `LOGO_DESIGN` it was made under. */
    v: number;
    /** Not looked at again before this (ms): failed and retry only. */
    retry?: number;
    /** Last pass that still had a channel using it (ms), for tidying up. */
    seen: number;
    why?: string;
}

export interface LogoPass {
    at: number;
    seconds: number;
    reason: string;
    channels: number;
    noLogo: number;
    fetched: number;
    reprocessed: number;
    skipped: number;
    failed: number;
    ok: boolean;
    error?: string;
}

export interface LogoProgress {
    total: number;
    done: number;
}

export interface Fetched {
    status: number;
    type: string;
    body: Buffer;
    retryAfter?: number;
}

export interface LogoChannel {
    id: string;
    name: string;
    logo: string;
}

export interface LogoStoreOptions {
    dir: string;
    stateFile: string;
    channels: () => Promise<LogoChannel[]>;
    fetcher?: (url: string) => Promise<Fetched>;
    now?: () => number;
    log?: (line: string) => void;
    /** Local hour of the nightly pass, -1 for off. */
    hour?: number;
    /** Pause between two requests to one host. */
    breathMs?: number;
    /** Wait before the first pass after start. */
    startDelayMs?: number;
}

const DAY = 86_400_000;
const REVALIDATE = 30 * DAY;
const RETRY_FAILED = 14 * DAY;
const RETRY_SOON = 2 * 3_600_000;
const FORGET_AFTER = 14 * DAY;
const MAX_BYTES = 8 * 1024 * 1024;
const HOSTS = 12;

/** Wikimedia answers 429 to a client that does not say who it is (core does the same). */
const USER_AGENT = "stremio-tv/1.0 (+https://github.com/gauravsuman007/stremio-tv)";

const keyOf = (url: string): string => createHash("sha1").update(url).digest("hex").slice(0, 20);
const pillKey = (id: string): string => createHash("sha1").update(id).digest("hex").slice(0, 12);

async function defaultFetcher(url: string): Promise<Fetched> {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(12_000), redirect: "follow" });
    const stated = Number(response.headers.get("content-length"));

    if (stated > MAX_BYTES) return { status: 413, type: "", body: Buffer.alloc(0) };

    const body = Buffer.from(await response.arrayBuffer());
    const wait = Number(response.headers.get("retry-after"));

    return { status: response.status, type: response.headers.get("content-type") || "", body: body.length > MAX_BYTES ? Buffer.alloc(0) : body, retryAfter: wait > 0 ? wait : undefined };
}

const looksLikeSvg = (body: Buffer, type: string): boolean => /svg/i.test(type) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(body.subarray(0, 600).toString("utf8"));

function writeAtomic(file: string, body: Buffer | string): void {
    writeFileSync(`${file}.tmp`, body);
    renameSync(`${file}.tmp`, file);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export class LogoStore {
    private entries = new Map<string, Entry>();
    private pass: LogoPass | null = null;
    private progress: LogoProgress | null = null;
    private noLogo = 0;
    private runningPass: Promise<void> | null = null;
    private startTimer: ReturnType<typeof setTimeout> | null = null;
    private nightTimer: ReturnType<typeof setTimeout> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private dirty = false;
    private halted = false;
    private readonly now: () => number;
    private readonly log: (line: string) => void;
    private readonly fetcher: (url: string) => Promise<Fetched>;
    private readonly breath: number;

    constructor(private readonly options: LogoStoreOptions) {
        this.now = options.now || Date.now;
        this.log = options.log || (() => undefined);
        this.fetcher = options.fetcher || defaultFetcher;
        this.breath = options.breathMs ?? 350;
        this.read();
    }

    /* ---- the schedule ---- */

    /** Arm the first pass (soon) and the nightly one. Nothing runs until then. */
    start(): void {
        this.halted = false;

        if (this.startTimer) return;

        this.startTimer = setTimeout(() => {
            this.startTimer = null;
            void this.refresh("startup").catch(() => undefined);
        }, this.options.startDelayMs ?? 30_000);
        this.startTimer.unref();

        const hour = this.options.hour ?? 4;

        if (hour < 0 || hour > 23) return;

        const arm = (): void => {
            if (this.halted) return;

            const when = new Date(this.now());

            when.setHours(hour, 0, 0, 0);

            if (when.getTime() <= this.now()) when.setDate(when.getDate() + 1);

            this.nightTimer = setTimeout(() => {
                void this.refresh("nightly").catch(() => undefined);
                arm();
            }, when.getTime() - this.now());
            this.nightTimer.unref();
        };

        arm();
    }

    /** Stops every timer and any pass in flight; the state is written, not dropped. */
    stop(): void {
        this.halted = true;

        for (const timer of [this.startTimer, this.nightTimer, this.saveTimer]) if (timer) clearTimeout(timer);

        this.startTimer = this.nightTimer = this.saveTimer = null;
        this.flush();
    }

    isRunning(): boolean {
        return Boolean(this.runningPass);
    }

    /** Runs now unless a pass is already going; resolves when it ends. */
    refresh(reason = "manual"): Promise<void> {
        if (!this.runningPass) {
            this.halted = false;
            this.runningPass = this.run(reason).finally(() => {
                this.runningPass = null;
                this.progress = null;
            });
        }

        return this.runningPass;
    }

    lastPass(): LogoPass | null {
        return this.pass;
    }

    progressNow(): LogoProgress | null {
        return this.progress;
    }

    counts(): Record<LogoStatus, number> & { noLogo: number } {
        const counts = { ok: 0, processed: 0, svg: 0, failed: 0, retry: 0, noLogo: this.noLogo };

        for (const entry of this.entries.values()) counts[entry.status] += 1;

        return counts;
    }

    /* ---- what a card should show ---- */

    /**
     * The picture a channel's card should carry in place of its logo, as an
     * app-relative path (`/tv/logo/...`), or null to leave the logo alone.
     */
    swap(channel: LogoChannel): string | null {
        if (!channel.logo) return `/tv/logo/g${pillKey(channel.id)}.svg?n=${encodeURIComponent(channel.name)}&d=${LOGO_DESIGN}`;

        const key = keyOf(channel.logo);
        const entry = this.entries.get(key);

        if (!entry) return null;

        const v = `v=${entry.at}.${entry.v}`;

        if (entry.status === "ok") return `/tv/logo/u${key}.png?${v}`;
        if (entry.status === "processed" || entry.status === "svg") return `/tv/logo/u${key}.svg?${v}`;
        if (entry.status === "failed") return `/tv/logo/g${pillKey(channel.id)}.svg?n=${encodeURIComponent(channel.name)}&d=${LOGO_DESIGN}`;

        return null;
    }

    /** The answer to a `/tv/logo/:file` request. */
    serve(file: string, query: URLSearchParams): { status: number; headers: Record<string, string>; body: string | Buffer } {
        const cache = { "cache-control": "public, max-age=86400" };
        const gone = { status: 404, headers: { "content-type": "text/plain" }, body: "no such logo" };
        const pill = /^g[0-9a-f]{12}\.svg$/.exec(file);

        if (pill) return { status: 200, headers: { ...cache, "content-type": "image/svg+xml" }, body: pillSvg(String(query.get("n") || "")) };

        const named = /^u([0-9a-f]{20})\.(png|svg)$/.exec(file);
        const entry = named ? this.entries.get(named[1] as string) : undefined;

        if (!named || !entry) return gone;

        const key = named[1] as string;

        try {
            if (named[2] === "png" && entry.status === "ok") return { status: 200, headers: { ...cache, "content-type": "image/png" }, body: readFileSync(`${this.options.dir}/${key}.png`) };

            if (named[2] === "svg" && entry.status === "processed")
                return { status: 200, headers: { ...cache, "content-type": "image/svg+xml" }, body: tileSvg(readFileSync(`${this.options.dir}/${key}.tile.png`)) };

            if (named[2] === "svg" && entry.status === "svg")
                return { status: 200, headers: { ...cache, "content-type": "image/svg+xml" }, body: readFileSync(`${this.options.dir}/${key}.orig`) };
        } catch {
            return gone;
        }

        return gone;
    }

    /* ---- one pass ---- */

    private needs(entry: Entry | undefined, now: number): "fetch" | "rebuild" | null {
        if (!entry) return "fetch";

        if (entry.status === "failed" || entry.status === "retry") return now >= (entry.retry || 0) ? "fetch" : null;

        if (now - entry.at > REVALIDATE) return "fetch";

        if (entry.v !== LOGO_DESIGN) return existsSync(`${this.options.dir}/${keyOf(entry.url)}.orig`) ? "rebuild" : "fetch";

        return null;
    }

    private async run(reason: string): Promise<void> {
        const began = this.now();
        const summary: LogoPass = { at: began, seconds: 0, reason, channels: 0, noLogo: 0, fetched: 0, reprocessed: 0, skipped: 0, failed: 0, ok: true };

        try {
            mkdirSync(this.options.dir, { recursive: true });

            const channels = await this.options.channels();
            const urls = new Set<string>();

            for (const channel of channels) {
                if (channel.logo) urls.add(channel.logo);
                else summary.noLogo += 1;
            }

            summary.channels = channels.length;
            this.noLogo = summary.noLogo;

            const fetchQueue = new Map<string, string[]>();
            const rebuildQueue: string[] = [];

            for (const url of urls) {
                const entry = this.entries.get(keyOf(url));

                if (entry) entry.seen = began;

                const need = this.needs(entry, began);

                if (need === "rebuild") rebuildQueue.push(url);
                else if (need === "fetch") {
                    let host = "";

                    try {
                        host = new URL(url).host;
                    } catch {
                        this.settle(url, "failed", "not a URL", began + RETRY_FAILED);
                        summary.failed += 1;
                        continue;
                    }

                    (fetchQueue.get(host) || fetchQueue.set(host, []).get(host)!).push(url);
                } else summary.skipped += 1;
            }

            const total = rebuildQueue.length + [...fetchQueue.values()].reduce((sum, list) => sum + list.length, 0);

            this.progress = { total, done: 0 };

            if (total) {
                this.log(`[logos] ${reason}: ${total} logos to settle (${rebuildQueue.length} from disk, ${total - rebuildQueue.length} to download) of ${urls.size}`);

                if (!(await this.ffmpegWorks())) throw new Error("ffmpeg is not available");

                await Promise.all([this.rebuildAll(rebuildQueue, summary), this.fetchAll(fetchQueue, summary)]);
            }

            if (!this.halted) this.tidy(began);
        } catch (error) {
            summary.ok = false;
            summary.error = (error as Error).message;
            this.log(`[logos] pass failed: ${summary.error}`);
        }

        summary.seconds = Math.round((this.now() - began) / 1000);
        this.pass = summary;
        this.dirty = true;
        this.flush();

        if (summary.fetched || summary.reprocessed || !summary.ok) {
            this.log(`[logos] done in ${summary.seconds}s: ${summary.fetched} downloaded, ${summary.reprocessed} rebuilt from disk, ${summary.failed} failed, ${summary.skipped} already settled`);
        }
    }

    private async ffmpegWorks(): Promise<boolean> {
        /* A 1x1 PNG is the smallest honest question to put to the decoder. */
        const probe = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });

        return Boolean(await fitToPng(probe));
    }

    private async rebuildAll(urls: string[], summary: LogoPass): Promise<void> {
        let next = 0;

        const worker = async (): Promise<void> => {
            while (!this.halted) {
                const url = urls[next++];

                if (!url) return;

                try {
                    const original = readFileSync(`${this.options.dir}/${keyOf(url)}.orig`);

                    await this.build(url, original);
                    summary.reprocessed += 1;
                } catch {
                    this.settle(url, "retry", "stored original unreadable", this.now() + RETRY_SOON);
                }

                if (this.progress) this.progress.done += 1;
            }
        };

        await Promise.all([worker(), worker(), worker()]);
    }

    private async fetchAll(byHost: Map<string, string[]>, summary: LogoPass): Promise<void> {
        const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);
        let next = 0;

        const worker = async (): Promise<void> => {
            while (!this.halted) {
                const took = hosts[next++];

                if (!took) return;

                const [host, list] = took;
                let refused = 0;

                for (const url of list) {
                    if (this.halted) return;

                    const outcome = await this.download(url, summary);

                    if (this.progress) this.progress.done += 1;

                    refused = outcome === "limited" ? refused + 1 : 0;

                    if (refused >= 3) {
                        this.log(`[logos] ${host} keeps answering 429; leaving its remaining logos for the next run`);

                        if (this.progress) this.progress.done += list.length - list.indexOf(url) - 1;

                        break;
                    }

                    await sleep(outcome === "limited" ? 5_000 : this.breath);
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(HOSTS, hosts.length) }, worker));
    }

    /** One logo: fetch, keep the original, build the display copy. */
    private async download(url: string, summary: LogoPass): Promise<"done" | "limited" | "failed"> {
        const now = this.now();
        let got: Fetched;

        try {
            got = await this.fetcher(url);
        } catch {
            this.settle(url, "retry", "unreachable", now + RETRY_SOON);

            return "failed";
        }

        if (got.status === 429) {
            this.settle(url, "retry", "rate limited", now + RETRY_SOON);

            return "limited";
        }

        if (got.status >= 500 || got.status === 0) {
            this.settle(url, "retry", `HTTP ${got.status}`, now + RETRY_SOON);

            return "failed";
        }

        if (got.status !== 200 || !got.body.length || (/^text\/html/i.test(got.type) && !looksLikeSvg(got.body, got.type))) {
            this.settle(url, "failed", got.status === 200 ? "not a picture" : `HTTP ${got.status}`, now + RETRY_FAILED);
            summary.failed += 1;

            return "failed";
        }

        this.write(`${keyOf(url)}.orig`, got.body);

        const status = await this.build(url, got.body);

        summary.fetched += 1;

        if (status === "failed") summary.failed += 1;

        return "done";
    }

    /** Make the display copy from an original already on disk. */
    private async build(url: string, original: Buffer): Promise<LogoStatus> {
        const key = keyOf(url);
        const now = this.now();

        for (const stale of [`${key}.png`, `${key}.tile.png`]) rmSync(`${this.options.dir}/${stale}`, { force: true });

        if (looksLikeSvg(original, "")) {
            this.settle(url, "svg", "");

            return "svg";
        }

        const fitted = await fitToPng(original);
        const raster = fitted ? decodePng(fitted) : null;

        if (!fitted || !raster) {
            this.settle(url, "failed", "could not be decoded", now + RETRY_FAILED);

            return "failed";
        }

        const read = assess(raster);

        if (read.visible < 24) {
            this.settle(url, "failed", "empty picture", now + RETRY_FAILED);

            return "failed";
        }

        if (readable(read)) {
            this.write(`${key}.png`, fitted);
            this.settle(url, "ok", "");

            return "ok";
        }

        this.write(`${key}.tile.png`, encodePng(recolor(raster, read)));
        this.settle(url, "processed", read.cutBackground ? "background cut away" : "lifted for a dark tile");

        return "processed";
    }

    private settle(url: string, status: LogoStatus, why: string, retry?: number): void {
        this.entries.set(keyOf(url), { url, status, at: this.now(), v: LOGO_DESIGN, retry, seen: this.now(), why: why || undefined });
        this.dirty = true;
        this.schedule();
    }

    private write(name: string, body: Buffer | string): void {
        writeAtomic(`${this.options.dir}/${name}`, body);
    }

    /** Files and entries no channel has used for a fortnight. */
    private tidy(now: number): void {
        const live = new Set<string>();

        for (const [key, entry] of this.entries) {
            if (now - entry.seen > FORGET_AFTER) this.entries.delete(key);
            else live.add(key);
        }

        try {
            for (const name of readdirSync(this.options.dir)) {
                const key = name.split(".")[0] as string;

                if (/^[0-9a-f]{20}$/.test(key) && !live.has(key)) rmSync(`${this.options.dir}/${name}`, { force: true });
            }
        } catch {
            /* Nothing to tidy if the directory is not there. */
        }

        this.dirty = true;
    }

    /* ---- the state file ---- */

    private read(): void {
        try {
            if (!existsSync(this.options.stateFile)) return;

            const saved = JSON.parse(readFileSync(this.options.stateFile, "utf8")) as { entries?: Entry[]; pass?: LogoPass; noLogo?: number };

            for (const entry of saved.entries || []) if (entry && entry.url) this.entries.set(keyOf(entry.url), entry);

            this.pass = saved.pass || null;
            this.noLogo = saved.noLogo || 0;
        } catch {
            /* A broken state file is an empty one: everything is looked at again, from the originals on disk where they are. */
        }
    }

    private schedule(): void {
        if (this.saveTimer || this.halted) return;

        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush();
        }, 3_000);
        this.saveTimer.unref();
    }

    flush(): void {
        if (!this.dirty || !this.options.stateFile) return;

        try {
            writeAtomic(this.options.stateFile, JSON.stringify({ v: 1, pass: this.pass, noLogo: this.noLogo, entries: [...this.entries.values()] }));
            this.dirty = false;
        } catch (error) {
            this.log(`[logos] could not save the state: ${(error as Error).message}`);
        }
    }
}
