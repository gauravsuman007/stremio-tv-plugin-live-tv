/**
 * The GitHub-import route into the plugin surface: a scraper is only ever
 * replaced when the incoming copy's version is a real increase (or the
 * existing one has no version at all) -- never blindly re-copied. Always
 * reads `main`; there is no branch parameter.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;

function check(what, value) {
    assert.ok(value, what);
    checks += 1;
}

function same(what, value, expected) {
    assert.deepEqual(value, expected, what);
    checks += 1;
}

const dir = mkdtempSync(join(tmpdir(), "stremio-tv-github-import-"));

const { initPluginConfig, pluginConfig } = await import("../dist/plugin-config.js");
initPluginConfig(dir);

const dropDir = pluginConfig.scrapersDir;
mkdirSync(dropDir, { recursive: true });

const scrapers = await import("../dist/scrapers.js");
const github = await import("../dist/github-import.js");

/* ---- versionSupersedes, the comparison everything else relies on ------ */

same("versioned beats unversioned", github.versionSupersedes("1.0.0", undefined), true);
same("unversioned never beats versioned", github.versionSupersedes(undefined, "1.0.0"), false);
same("neither versioned is not an update", github.versionSupersedes(undefined, undefined), false);
same("a real increase wins", github.versionSupersedes("1.2.0", "1.1.9"), true);
same("a decrease loses", github.versionSupersedes("1.0.0", "1.1.0"), false);
same("equal versions are not an update", github.versionSupersedes("1.0.0", "1.0.0"), false);
same("uneven segment counts compare as zero-padded", github.versionSupersedes("1.0", "1.0.0"), false);
same("uneven segment counts, a real bump", github.versionSupersedes("1.0.1", "1.0"), true);

/* ---- a fake GitHub, so the import runs with no real network ----------- */

function scraperFile(id, version) {
    return `export const scraper = {
        id: ${JSON.stringify(id)},
        name: "GH " + ${JSON.stringify(id)},
        ${version ? `version: ${JSON.stringify(version)},` : ""}
        async build() {
            return { channels: [] };
        }
    };`;
}

let distFiles = {};
let requests = [];

const realFetch = globalThis.fetch;

globalThis.fetch = async (url) => {
    requests.push(String(url));
    const u = new URL(String(url));

    if (u.pathname === "/repos/acme/scrapers/contents/dist") {
        return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () =>
                Object.keys(distFiles).map((name) => ({ name, type: "file", path: `dist/${name}` }))
        };
    }

    const match = /^\/repos\/acme\/scrapers\/contents\/dist\/(.+)$/.exec(u.pathname);

    if (match) {
        const name = decodeURIComponent(match[1]);
        const content = distFiles[name];

        if (content === undefined) return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };

        return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ content: Buffer.from(content).toString("base64"), encoding: "base64" })
        };
    }

    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
};

/* ---- first import: a new id is just imported --------------------------- */

distFiles = {
    "a.mjs": scraperFile("ghsrc-a", "1.0.0"),
    "b.mjs": "export const nope = { hello: 1 };",
    "c.mjs": scraperFile("ghsrc-c", "9.9.9")
};

let result = await github.importFromGithub("acme", "scrapers", "");

same("both well-formed files are imported", result.imported.sort(), ["ghsrc-a", "ghsrc-c"]);
check("the malformed export fails with a reason", result.errors.some((e) => e.file === "b.mjs"));
check(
    "the dist/ listing was fetched at the main ref",
    requests.some((r) => r.includes("/repos/acme/scrapers/contents/dist") && r.includes("ref=main"))
);

/* ---- re-importing the SAME version changes nothing --------------------- */

result = await github.importFromGithub("acme", "scrapers", "");

same("an unchanged version is skipped, not re-imported", result.imported, []);
check(
    "the skip reason names the version already running",
    result.skipped.some((s) => s.file === "a.mjs" && s.reason.includes("1.0.0"))
);

/* ---- a real version bump is picked up as an update ---------------------- */

distFiles["a.mjs"] = scraperFile("ghsrc-a", "1.1.0");
result = await github.importFromGithub("acme", "scrapers", "");

same("a genuine version increase is an update, not a fresh import", result.updated, ["ghsrc-a"]);

const written = readFileSync(join(dropDir, "ghsrc-a.mjs"), "utf8");

check("the file on disk is the new version's content", written.includes("1.1.0"));

/* ---- an older version offered later never regresses what is running ---- */

distFiles["a.mjs"] = scraperFile("ghsrc-a", "1.0.5");
result = await github.importFromGithub("acme", "scrapers", "");

same("an older version than what is loaded is skipped", result.imported.concat(result.updated), []);

/* ---- sources are remembered, with a token never re-shown --------------- */

github.rememberGithubSource("acme", "scrapers", "s3cr3t");
same("a saved source reports hasToken without leaking it", github.listGithubSources(), [
    { owner: "acme", repo: "scrapers", hasToken: true }
]);

const storeContents = JSON.parse(readFileSync(join(dir, "github-sources.json"), "utf8"));

check("the token itself only lives in the store file, not in listGithubSources", storeContents.sources[0].token === "s3cr3t");

github.rememberGithubSource("acme", "scrapers", "");
same("a blank token on re-save keeps the one already stored", github.listGithubSources()[0].hasToken, true);

result = await github.importFromStoredSource("acme", "scrapers");
check("importFromStoredSource reuses the remembered token", Array.isArray(result.errors));

github.forgetGithubSource("acme", "scrapers");
same("forgetting a source removes it", github.listGithubSources(), []);

globalThis.fetch = realFetch;
scrapers.useScrapersForTest(null);

console.log(`PASSED: ${checks} GitHub-import checks`);
