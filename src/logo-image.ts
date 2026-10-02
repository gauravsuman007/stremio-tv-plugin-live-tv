/**
 * Logo pictures for an OLED television: the pure image work behind
 * `logos.ts`. No network and no state in this file.
 *
 * WHAT A LOGO IS HERE
 * -------------------
 * A transparent PNG drawn for whatever background its broadcaster had in
 * mind -- often white, so half of them are black wordmarks that disappear
 * on a dark tile -- or a JPEG with its own white rectangle, which is a lit
 * block on an OLED. Two fixes, chosen with the operator:
 *
 *   C. A near-black tile with a hairline border, the logo lifted to a
 *      readable lightness inside it (hue kept, so a navy logo becomes a
 *      light blue one and a red one stays red). White rectangles around a
 *      logo are cut away first.
 *   E. A channel with no logo at all (or one that cannot be fetched) gets
 *      its name in a pill tinted from the name, so it is the same colour
 *      every night.
 *
 * Both are SVG, and that is deliberate: stremio-tv's image route bakes a
 * WHITE halo under every raster channel logo (so black wordmarks show on
 * its grey tile) but relays an SVG untouched. A tile or pill served as SVG
 * therefore arrives with no white around it.
 *
 * Decoding any format (PNG, JPEG, WebP, GIF) is ffmpeg's job -- the same
 * binary stremio-tv already ships for artwork -- so there is no image
 * library here. It is asked for one RGBA PNG; reading that back needs only
 * `node:zlib`.
 */

import { deflateSync, inflateSync } from "node:zlib";
import { spawn } from "node:child_process";

/** Bump when the look changes: every stored logo is reprocessed from its saved original. */
export const LOGO_DESIGN = 1;

/** The tile and pill are drawn on this canvas; core fits it into a 16:9 card. */
const TILE_W = 320;
const TILE_H = 180;
export const TILE_BG = "#121212";
const TILE_BORDER = "#2a2a2a";

/** The largest a stored picture is made: twice what a card shows, never more than the original. */
export const FIT_W = 320;
export const FIT_H = 180;

export interface Raster {
    width: number;
    height: number;
    /** Straight (not premultiplied) RGBA, row after row. */
    data: Uint8Array;
}

/* ---- ffmpeg: any format in, one RGBA PNG out ---- */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const PARALLEL = 3;
const DEADLINE_MS = 10_000;

let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= PARALLEL) await new Promise<void>((go) => waiting.push(go));

    running += 1;

    try {
        return await work();
    } finally {
        running -= 1;
        waiting.shift()?.();
    }
}

/**
 * The picture, fitted inside FIT_W x FIT_H (never enlarged) as an RGBA PNG,
 * or null when ffmpeg is missing or cannot read it.
 */
export function fitToPng(source: Uint8Array): Promise<Buffer | null> {
    return slot(
        () =>
            new Promise<Buffer | null>((done) => {
                const scale = `scale='min(${FIT_W},iw)':'min(${FIT_H},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;
                let child;

                try {
                    child = spawn(
                        FFMPEG,
                        ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", `${scale},format=rgba`, "-c:v", "png", "-f", "image2pipe", "pipe:1"],
                        { stdio: ["pipe", "pipe", "ignore"] }
                    );
                } catch {
                    done(null);
                    return;
                }

                const chunks: Buffer[] = [];
                const timer = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS);

                child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
                child.on("error", () => {
                    clearTimeout(timer);
                    done(null);
                });
                child.on("close", (code) => {
                    clearTimeout(timer);

                    const body = Buffer.concat(chunks);

                    done(code === 0 && body.length > 0 ? body : null);
                });
                child.stdin.on("error", () => undefined);
                child.stdin.end(Buffer.from(source));
            })
    );
}

/* ---- PNG: just enough to read ffmpeg's output and write our own ---- */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 8-bit RGBA, no interlacing -- the one shape `fitToPng` asks ffmpeg for. */
export function decodePng(file: Uint8Array): Raster | null {
    const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);

    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;

    let width = 0;
    let height = 0;
    const parts: Buffer[] = [];

    for (let at = 8; at + 8 <= bytes.length; ) {
        const length = bytes.readUInt32BE(at);
        const type = bytes.toString("latin1", at + 4, at + 8);
        const body = bytes.subarray(at + 8, at + 8 + length);

        if (type === "IHDR") {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);

            if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) return null;
        } else if (type === "IDAT") parts.push(body);
        else if (type === "IEND") break;

        at += 12 + length;
    }

    if (!width || !height || width > 4096 || height > 4096 || !parts.length) return null;

    let raw: Buffer;

    try {
        raw = inflateSync(Buffer.concat(parts));
    } catch {
        return null;
    }

    const stride = width * 4;

    if (raw.length < (stride + 1) * height) return null;

    const data = new Uint8Array(stride * height);

    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)] as number;
        const line = y * (stride + 1) + 1;
        const out = y * stride;

        for (let x = 0; x < stride; x += 1) {
            const left = x >= 4 ? (data[out + x - 4] as number) : 0;
            const up = y ? (data[out - stride + x] as number) : 0;
            const upLeft = y && x >= 4 ? (data[out - stride + x - 4] as number) : 0;
            let value = raw[line + x] as number;

            if (filter === 1) value += left;
            else if (filter === 2) value += up;
            else if (filter === 3) value += (left + up) >> 1;
            else if (filter === 4) {
                const guess = left + up - upLeft;
                const dl = Math.abs(guess - left);
                const du = Math.abs(guess - up);
                const dul = Math.abs(guess - upLeft);

                value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
            }

            data[out + x] = value & 255;
        }
    }

    return { width, height, data };
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n += 1) {
        let c = n;

        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

        table[n] = c >>> 0;
    }

    return table;
})();

function crc32(bytes: Buffer): number {
    let c = 0xffffffff;

    for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 255] as number) ^ (c >>> 8);

    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const out = Buffer.alloc(12 + body.length);
    const tagged = Buffer.concat([Buffer.from(type, "latin1"), body]);

    out.writeUInt32BE(body.length, 0);
    tagged.copy(out, 4);
    out.writeUInt32BE(crc32(tagged), 8 + body.length);

    return out;
}

export function encodePng(raster: Raster): Buffer {
    const { width, height, data } = raster;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);

    /* Filter 1 (Sub): a flat-coloured logo compresses far better than unfiltered. */
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 1;

        for (let x = 0; x < stride; x += 1) {
            const left = x >= 4 ? (data[y * stride + x - 4] as number) : 0;

            raw[y * (stride + 1) + 1 + x] = ((data[y * stride + x] as number) - left) & 255;
        }
    }

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;

    return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ---- colour ---- */

function relativeLuminance(r: number, g: number, b: number): number {
    const lin = (v: number): number => {
        const s = v / 255;

        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const TILE_LUMINANCE = relativeLuminance(0x12, 0x12, 0x12);

/** WCAG contrast of a colour against the tile. */
function contrastOnTile(r: number, g: number, b: number): number {
    return (relativeLuminance(r, g, b) + 0.05) / (TILE_LUMINANCE + 0.05);
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
    const rf = r / 255;
    const gf = g / 255;
    const bf = b / 255;
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    const l = (max + min) / 2;

    if (max === min) return [0, 0, l];

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === rf ? (gf - bf) / d + (gf < bf ? 6 : 0) : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4;

    return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];

    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/* ---- the logo itself ---- */

export interface Assessment {
    /** Visible (non-transparent) pixels, after any background was cut away. */
    visible: number;
    /** How many of those would be hard to read on the tile. */
    hardShare: number;
    /** A light rectangle (or a black one) was behind the logo and has been cut away. */
    cutBackground: boolean;
    /** Both a lot of light and a lot of dark: lifting the dark parts must stay gentle. */
    mixed: boolean;
}

/**
 * Cut away a plain background: the colour all round the border, when it is
 * opaque, near-white or near-black, and the same all the way. Flood-filled
 * inwards so a white letter inside a coloured plate is left alone; soft
 * edges fade rather than leave a ring.
 */
function cutBackground(raster: Raster): boolean {
    const { width, height, data } = raster;
    const at = (x: number, y: number): number => (y * width + x) * 4;
    const border: number[] = [];

    for (let x = 0; x < width; x += 1) border.push(at(x, 0), at(x, height - 1));
    for (let y = 1; y < height - 1; y += 1) border.push(at(0, y), at(width - 1, y));

    const opaque = border.filter((i) => (data[i + 3] as number) > 240);

    if (opaque.length < border.length * 0.9) return false;

    let r = 0;
    let g = 0;
    let b = 0;

    for (const i of opaque) {
        r += data[i] as number;
        g += data[i + 1] as number;
        b += data[i + 2] as number;
    }

    r /= opaque.length;
    g /= opaque.length;
    b /= opaque.length;

    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

    /* A coloured plate is part of the logo; only white-ish and black-ish are not. */
    if (brightness > 40 && brightness < 205) return false;

    const distance = (i: number): number => Math.hypot((data[i] as number) - r, (data[i + 1] as number) - g, (data[i + 2] as number) - b);

    if (opaque.some((i) => distance(i) > 40)) return false;

    const SOFT = 18;
    const HARD = 60;
    const seen = new Uint8Array(width * height);
    const queue: number[] = [];

    const push = (x: number, y: number): void => {
        if (x < 0 || y < 0 || x >= width || y >= height || seen[y * width + x]) return;

        seen[y * width + x] = 1;

        if (distance(at(x, y)) < HARD) queue.push(y * width + x);
    };

    for (let x = 0; x < width; x += 1) {
        push(x, 0);
        push(x, height - 1);
    }

    for (let y = 0; y < height; y += 1) {
        push(0, y);
        push(width - 1, y);
    }

    let cut = 0;

    for (let head = 0; head < queue.length; head += 1) {
        const p = queue[head] as number;
        const x = p % width;
        const y = (p - x) / width;
        const d = distance(at(x, y));
        const keep = Math.min(1, Math.max(0, (d - SOFT) / (HARD - SOFT)));
        const index = at(x, y) + 3;

        data[index] = Math.round((data[index] as number) * keep);
        cut += 1;
        push(x + 1, y);
        push(x - 1, y);
        push(x, y + 1);
        push(x, y - 1);
    }

    return cut > width * height * 0.04;
}

/** Read a logo's pixels: cut a plain background, then count what is hard to read on the tile. */
export function assess(raster: Raster): Assessment {
    const cut = cutBackground(raster);
    const { data } = raster;
    let visible = 0;
    let hard = 0;
    let light = 0;
    let dark = 0;

    for (let i = 0; i < data.length; i += 4) {
        const a = (data[i + 3] as number) / 255;

        if (a < 0.25) continue;

        visible += 1;

        const r = data[i] as number;
        const g = data[i + 1] as number;
        const b = data[i + 2] as number;

        if (contrastOnTile(r, g, b) < 2.2) hard += 1;

        const y = 0.299 * r + 0.587 * g + 0.114 * b;

        if (y > 170) light += 1;
        else if (y < 60) dark += 1;
    }

    return {
        visible,
        hardShare: visible ? hard / visible : 0,
        cutBackground: cut,
        mixed: visible > 0 && light / visible > 0.15 && dark / visible > 0.15
    };
}

/** Is this logo already fine on the tile as it stands? */
export function readable(assessment: Assessment): boolean {
    return !assessment.cutBackground && assessment.hardShare <= 0.2;
}

/**
 * Lift what is too dark and calm what is glaring, keeping every hue. Dark
 * neutrals (black wordmarks) go to a soft off-white; dark chromatic pixels
 * (navy, maroon) to a light version of the same colour; when a logo has
 * both light and dark parts the dark ones are only brought to mid-tone, so
 * a black letter on a white disc still shows against it.
 */
export function recolor(raster: Raster, assessment: Assessment): Raster {
    const out = new Uint8Array(raster.data);
    const bright = assessment.mixed ? 0.9 : 0.93;
    let lit = 0;

    for (let i = 0; i < out.length; i += 4) {
        if ((out[i + 3] as number) > 128 && 0.299 * (out[i] as number) + 0.587 * (out[i + 1] as number) + 0.114 * (out[i + 2] as number) > 215) lit += 1;
    }

    /* A big white plate is a lit block on an OLED: bring it down. */
    const slab = lit / (raster.width * raster.height) > 0.3;
    const ceiling = slab ? 0.72 : bright;

    for (let i = 0; i < out.length; i += 4) {
        if ((out[i + 3] as number) === 0) continue;

        const [h, s, l] = toHsl(out[i] as number, out[i + 1] as number, out[i + 2] as number);
        let target = l;
        const chromatic = Math.min(1, Math.max(0, (s - 0.1) / 0.3));

        if (assessment.mixed) {
            const floor = 0.46;

            if (l < floor) target = floor - (floor - l) * 0.25;
        } else {
            const floor = 0.88 - (0.88 - 0.66) * chromatic;

            if (l < floor) target = floor - (floor - l) * 0.08;
        }

        if (target > ceiling) target = ceiling;

        if (target !== l) {
            const [r, g, b] = fromHsl(h, s, target);

            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
        }
    }

    return { width: raster.width, height: raster.height, data: out };
}

/* ---- SVG ---- */

const xml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch] as string);

/** Option C: the recoloured logo on a near-black rounded tile with a hairline border. */
export function tileSvg(png: Uint8Array): string {
    const data = Buffer.from(png).toString("base64");

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${TILE_W} ${TILE_H}" width="${TILE_W}" height="${TILE_H}">
<rect x="1" y="1" width="${TILE_W - 2}" height="${TILE_H - 2}" rx="14" fill="${TILE_BG}" stroke="${TILE_BORDER}" stroke-width="2"/>
<image x="24" y="18" width="${TILE_W - 48}" height="${TILE_H - 36}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${data}"/>
</svg>`;
}

function hashOf(text: string): number {
    let h = 2166136261;

    for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;

    return h;
}

/** Rough text width in em, for a bold sans-serif: there is no font to measure with. */
function emWidth(text: string): number {
    let width = 0;

    for (const ch of text) {
        width += /[A-Z]/.test(ch) ? 0.74 : /[mwMW@]/.test(ch) ? 0.88 : /[iljtfr.,:;'!|\s]/.test(ch) ? 0.36 : /[0-9]/.test(ch) ? 0.64 : /[⺀-鿿가-힯]/.test(ch) ? 1.05 : 0.62;
    }

    return width;
}

/** Split a name into one or two balanced lines. */
function lines(name: string): string[] {
    const words = name.split(/\s+/).filter(Boolean);

    if (emWidth(name) <= 9 || words.length < 2) return [name];

    let best: string[] = [name];
    let bestWidth = Infinity;

    for (let cut = 1; cut < words.length; cut += 1) {
        const pair = [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
        const widest = Math.max(emWidth(pair[0] as string), emWidth(pair[1] as string));

        if (widest < bestWidth) {
            best = pair;
            bestWidth = widest;
        }
    }

    return best;
}

/**
 * Option E: the channel's name in a pill tinted from the name itself -- a
 * deep fill, a bright text of the same hue. Deterministic, so a channel
 * is the same colour every night.
 */
export function pillSvg(name: string): string {
    const text = (name.trim() || "TV").slice(0, 44);
    const hue = hashOf(text.toLowerCase()) % 360;
    const [fr, fg, fb] = fromHsl(hue, 0.42, 0.11);
    const [tr, tg, tb] = fromHsl(hue, 0.72, 0.74);
    const parts = lines(text);
    const widest = Math.max(...parts.map(emWidth));
    const size = Math.max(14, Math.min(34, 232 / widest));
    const leading = size * 1.22;
    const padX = size * 0.8;
    const padY = size * 0.55;
    const w = Math.min(TILE_W - 12, widest * size + padX * 2);
    const h = parts.length * leading + padY * 2 - (leading - size);
    const x = (TILE_W - w) / 2;
    const y = (TILE_H - h) / 2;
    const first = TILE_H / 2 - ((parts.length - 1) * leading) / 2 + size * 0.35;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE_W} ${TILE_H}" width="${TILE_W}" height="${TILE_H}">
<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(h / 2, 40).toFixed(1)}" fill="${hex(fr, fg, fb)}"/>
${parts
    .map(
        (part, n) =>
            `<text x="${TILE_W / 2}" y="${(first + n * leading).toFixed(1)}" text-anchor="middle" font-family="Roboto, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="${size.toFixed(1)}" fill="${hex(tr, tg, tb)}">${xml(part)}</text>`
    )
    .join("\n")}
</svg>`;
}
