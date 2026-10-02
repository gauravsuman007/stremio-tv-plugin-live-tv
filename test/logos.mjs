/**
 * The logo store (`logos.ts`) and its picture work (`logo-image.ts`): a
 * black wordmark is lifted for a dark tile, a white rectangle is cut away,
 * a readable logo is left alone, a gone one becomes a name pill -- and a
 * second pass settles nothing again. No network: the fetcher is a stub.
 * The store half needs ffmpeg (as stremio-tv itself does) and is skipped
 * where there is none.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { assess, decodePng, encodePng, pillSvg, readable, recolor, tileSvg } = await import("../dist/logo-image.js");
const { LogoStore } = await import("../dist/logos.js");

/** A 160x90 picture: `paint(x, y)` returns [r, g, b, a]. */
function picture(paint, width = 160, height = 90) {
    const data = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) data.set(paint(x, y), (y * width + x) * 4);
    }

    return { width, height, data };
}

const inBar = (x, y) => x > 30 && x < 130 && y > 35 && y < 55;
const blackOnClear = picture((x, y) => (inBar(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]));
const navyOnClear = picture((x, y) => (inBar(x, y) ? [13, 27, 61, 255] : [0, 0, 0, 0]));
const whiteOnClear = picture((x, y) => (inBar(x, y) ? [250, 250, 250, 255] : [0, 0, 0, 0]));
const redOnClear = picture((x, y) => (inBar(x, y) ? [220, 30, 50, 255] : [0, 0, 0, 0]));
const redOnWhite = picture((x, y) => (inBar(x, y) ? [200, 30, 40, 255] : [255, 255, 255, 255]));

/* ---- the PNG we write reads back as it was ---- */

const back = decodePng(encodePng(redOnWhite));

assert.equal(back.width, 160);
assert.deepEqual([...back.data.subarray(0, 8)], [...redOnWhite.data.subarray(0, 8)]);
assert.deepEqual([...back.data.subarray((50 * 160 + 80) * 4, (50 * 160 + 80) * 4 + 4)], [200, 30, 40, 255]);

/* ---- what is hard to read, and what is not ---- */

assert.equal(readable(assess(structuredClone(blackOnClear))), false, "black on a dark tile is not readable");
assert.equal(readable(assess(structuredClone(navyOnClear))), false, "navy is not readable");
assert.equal(readable(assess(structuredClone(whiteOnClear))), true, "white is");
assert.equal(readable(assess(structuredClone(redOnClear))), true, "a brand red is");

/* A white rectangle round a logo is cut away -- and then the logo is judged on its own. */
const plate = structuredClone(redOnWhite);
const plateRead = assess(plate);

assert.equal(plateRead.cutBackground, true);
assert.equal(plate.data[3], 0, "the corner is clear");
assert.equal(plate.data[(50 * 160 + 80) * 4 + 3], 255, "the logo is kept");
assert.equal(readable(plateRead), false, "a cut background always means a remade logo");

/* A coloured plate is part of the logo and stays. */
const blue = picture((x, y) => ((x - 80) ** 2 + (y - 45) ** 2 < 900 ? [255, 255, 255, 255] : [20, 60, 160, 255]));

assert.equal(assess(blue).cutBackground, false);

/* ---- recolouring: lifted, same hue, and never glaring ---- */

function mean(raster) {
    const at = (50 * 160 + 80) * 4;

    return [...raster.data.subarray(at, at + 4)];
}

const blackRead = assess(blackOnClear);
const lifted = mean(recolor(blackOnClear, blackRead));

assert.ok(lifted[0] > 180 && lifted[3] === 255, `black becomes a soft light grey, got ${lifted}`);
assert.ok(lifted[0] < 250, "but not white");

const navyLifted = mean(recolor(navyOnClear, assess(structuredClone(navyOnClear))));

assert.ok(navyLifted[2] > navyLifted[0] + 40, `navy stays blue, got ${navyLifted}`);
assert.ok(navyLifted[2] > 150, `and is lifted, got ${navyLifted}`);
assert.equal(assess(recolor(structuredClone(blackOnClear), blackRead)).hardShare, 0, "nothing hard to read is left");

/* Light AND dark in one logo: the dark is only brought to mid-tone, so it still shows on the light. */
const disc = picture((x, y) => ((x - 80) ** 2 + (y - 45) ** 2 < 1600 ? ((x - 80) ** 2 + (y - 45) ** 2 < 300 ? [0, 0, 0, 255] : [255, 255, 255, 255]) : [0, 0, 0, 0]));
const discRead = assess(structuredClone(disc));

assert.equal(discRead.mixed, true);

const centre = mean(recolor(disc, discRead));

assert.ok(centre[0] > 60 && centre[0] < 150, `the black centre is mid-tone, got ${centre}`);

/* ---- the SVGs ---- */

const tile = tileSvg(encodePng(blackOnClear));

assert.match(tile, /^<svg /);
assert.match(tile, /data:image\/png;base64,/);
assert.match(tile, /#121212/);
assert.doesNotMatch(tile, /#fff/i, "no white on the tile");

assert.equal(pillSvg("Kids Box"), pillSvg("Kids Box"), "the same name is the same pill every night");
assert.notEqual(pillSvg("Kids Box"), pillSvg("Tele Vision"));
assert.match(pillSvg("A <b> & \"C\""), /A &lt;b&gt; &amp; &quot;C&quot;/);
assert.match(pillSvg("Al Jazeera English Documentary Plus Extra"), /<text[\s\S]*<text/, "a long name takes two lines");
assert.doesNotMatch(pillSvg("x".repeat(200)), /x{45}/, "and is cut short");

/* ---- the store ---- */

if (spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status !== 0) {
    console.log("logos: ffmpeg not found, skipping the store tests");
    process.exit(0);
}

const png = (raster) => encodePng(raster);
const served = new Map([
    ["https://a.test/black.png", { status: 200, type: "image/png", body: png(blackOnClear) }],
    ["https://a.test/white.png", { status: 200, type: "image/png", body: png(whiteOnClear) }],
    ["https://a.test/plate.png", { status: 200, type: "image/png", body: png(redOnWhite) }],
    ["https://a.test/vector.svg", { status: 200, type: "image/svg+xml", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>') }],
    ["https://b.test/gone.png", { status: 404, type: "text/html", body: Buffer.from("nope") }],
    ["https://b.test/page.png", { status: 200, type: "text/html; charset=utf-8", body: Buffer.from("<html>sign in</html>") }],
    ["https://c.test/limited.png", { status: 429, type: "", body: Buffer.alloc(0) }]
]);
const asked = [];
const fetcher = async (url) => {
    asked.push(url);

    return served.get(url) || { status: 404, type: "", body: Buffer.alloc(0) };
};
const channels = [
    { id: "live:t:black", name: "Black News", logo: "https://a.test/black.png" },
    { id: "live:t:white", name: "White News", logo: "https://a.test/white.png" },
    { id: "live:t:plate", name: "Plate TV", logo: "https://a.test/plate.png" },
    { id: "live:t:plate2", name: "Plate TV 2", logo: "https://a.test/plate.png" },
    { id: "live:t:vector", name: "Vector", logo: "https://a.test/vector.svg" },
    { id: "live:t:gone", name: "Gone Channel", logo: "https://b.test/gone.png" },
    { id: "live:t:page", name: "Page Channel", logo: "https://b.test/page.png" },
    { id: "live:t:limited", name: "Limited", logo: "https://c.test/limited.png" },
    { id: "live:t:none", name: "No Logo TV", logo: "" }
];

const root = mkdtempSync(join(tmpdir(), "logos-"));
const options = { dir: join(root, "logos"), stateFile: join(root, "logos.json"), channels: async () => channels, fetcher, breathMs: 0, hour: -1 };
const store = new LogoStore(options);

/* Nothing is touched before a pass: a card is what core draws, except a channel with no logo at all. */
assert.equal(store.swap(channels[0]), null);
assert.match(store.swap(channels[8]), /^\/tv\/logo\/g[0-9a-f]{12}\.svg\?n=No%20Logo%20TV/);

await store.refresh("test");

const pass = store.lastPass();

assert.equal(pass.ok, true, pass.error);
assert.equal(pass.channels, 9);
assert.equal(pass.noLogo, 1);

const counts = store.counts();

assert.equal(counts.ok, 1, "white is fine as it is");
assert.equal(counts.processed, 2, "black and the plate are remade");
assert.equal(counts.svg, 1);
assert.equal(counts.failed, 2, "a 404 and an HTML page");
assert.equal(counts.retry, 1, "a 429 is tried again later, not condemned");

const urlOf = (channel) => store.swap(channel);

assert.match(urlOf(channels[1]), /^\/tv\/logo\/u[0-9a-f]{20}\.png\?v=/);
assert.match(urlOf(channels[0]), /^\/tv\/logo\/u[0-9a-f]{20}\.svg\?v=/);
assert.equal(urlOf(channels[2]).split("?")[0], urlOf(channels[3]).split("?")[0], "one picture, kept once, for two channels");
assert.match(urlOf(channels[5]), /\/tv\/logo\/g[0-9a-f]{12}\.svg\?n=Gone%20Channel/, "a gone logo becomes a name pill");
assert.equal(urlOf(channels[7]), null, "a rate-limited logo keeps its original until it can be fetched");

/* What is served. */
const route = (path) => {
    const [file, query] = path.replace("/tv/logo/", "").split("?");

    return store.serve(file, new URLSearchParams(query));
};
const processed = route(urlOf(channels[0]));

assert.equal(processed.status, 200);
assert.equal(processed.headers["content-type"], "image/svg+xml");
assert.match(String(processed.body), /data:image\/png;base64,/);

const plain = route(urlOf(channels[1]));

assert.equal(plain.headers["content-type"], "image/png");
assert.ok(decodePng(plain.body), "the stored copy is a real PNG");
assert.match(String(route(urlOf(channels[4])).body), /<rect/, "an SVG original is served as it came");
assert.match(String(route(urlOf(channels[5])).body), /Gone Channel/);
assert.equal(route("/tv/logo/u" + "0".repeat(20) + ".png").status, 404);
assert.equal(route("/tv/logo/..%2Fx.png").status, 404);

/* Every original is on disk. */
assert.equal(readdirSync(options.dir).filter((name) => name.endsWith(".orig")).length, 4, "originals of the four that came through");

/* A second pass settles nothing: only the rate-limited one is asked for, and only once its wait is over. */
asked.length = 0;
await store.refresh("again");

assert.deepEqual(asked, [], "settled logos are not fetched again");

/* A new instance reads the same decisions from disk. */
const reopened = new LogoStore(options);

assert.equal(reopened.counts().processed, 2);
assert.equal(reopened.swap(channels[0]), urlOf(channels[0]));

/* A newer design remakes from the saved originals -- no download. */
const state = JSON.parse(readFileSync(options.stateFile, "utf8"));

for (const entry of state.entries) entry.v = 0;

writeFileSync(options.stateFile, JSON.stringify(state));
asked.length = 0;

const redesigned = new LogoStore(options);

await redesigned.refresh("redesign");

assert.deepEqual(asked.filter((url) => !url.startsWith("https://b.test") && !url.startsWith("https://c.test")), [], "rebuilt from disk, not downloaded");
assert.equal(redesigned.lastPass().reprocessed, 4);

/* A logo that moved is a new one. */
channels[1] = { ...channels[1], logo: "https://a.test/black.png" };
await redesigned.refresh("moved");
assert.match(redesigned.swap(channels[1]), /\.svg\?v=/, "black.png is processed, shared with the first channel");

/* Stopping holds nothing back. */
redesigned.stop();
console.log("logos: ok");
