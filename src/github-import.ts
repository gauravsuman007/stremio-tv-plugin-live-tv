/**
 * Pulling scrapers in from a GitHub repository instead of copying files by
 * hand.
 *
 * WHAT THIS DOES AND DOES NOT CHANGE
 * -------------------------------------
 * This is still the "dropped in" route from `scrapers.ts` -- it writes a
 * compiled `.mjs` file into `config.scrapersDir` and asks
 * `loadDynamicScrapers()` to pick it up, exactly like copying the file in
 * by hand would. It does not run any code from the target repository
 * except by handing the finished file to the same loader every other
 * dropped-in scraper goes through, with the same validation. What it adds
 * is fetching the file over the network instead of a person copying it,
 * and REMEMBERING a version number so a re-check only replaces a scraper
 * that is actually newer than what is already running.
 *
 * WHY `dist/`, NOT `scrapers/`
 * -------------------------------
 * This container runs no TypeScript compiler (see `scrapers.ts`'s own
 * header). A source repository's `.mts`/`.ts` files are therefore not
 * something this importer can use directly -- it reads the COMPILED
 * output, which by convention (see `stremio-tv-scrapers/AGENTS.md`) lives
 * in that repository's `dist/` directory, committed there rather than
 * gitignored specifically so an importer like this one can reach it.
 *
 * VERSIONING
 * -----------
 * A scraper's optional `version` field (`scraper-types.ts`) is what makes
 * "only import updates" possible at all: without it there is no way to
 * tell a newer copy of the same scraper from an older one, or from an
 * unrelated file that happens to reuse the id. `versionSupersedes` below
 * is the one comparison used everywhere that matters: a new copy replaces
 * an old one only if its version is a real increase (dot-separated
 * integers, compared segment by segment) over what is currently loaded --
 * or if what is currently loaded has NO version at all, since an
 * unversioned scraper can never be known to be newer than anything.
 *
 * ALWAYS `main`
 * --------------
 * There is deliberately no branch field, here or in the UI -- the import
 * has no legitimate reason to point at anything but the repository's
 * default branch of finished, committed scrapers. A feature branch under
 * active work is not something this route should ever pull into a running
 * deployment.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { pluginConfig as config } from "./plugin-config.js";
import { allScrapers, builtinScraperIds, loadDynamicScrapers, looksLikeScraper } from "./scrapers.js";

const SCRAPER_ID_RE = /^[a-z0-9-]{1,64}$/;

/** `true` when `next` is a real, comparable increase over `current` -- see
 *  the module docstring. Exported for the test suite. */
export function versionSupersedes(next: string | undefined, current: string | undefined): boolean {
    if (!next) return false; // an unversioned file is never known to be an update.
    if (!current) return true; // versioned beats unversioned, unconditionally.

    const a = next.split(".").map((part) => parseInt(part, 10) || 0);
    const b = current.split(".").map((part) => parseInt(part, 10) || 0);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;

        if (x !== y) return x > y;
    }

    return false; // equal -- not an update.
}

/* --------------------------------------------------------------------- *
 * Remembered sources: owner/repo, always `main`, and a token this
 * deployment never shows back once it has been entered once.
 * --------------------------------------------------------------------- */

/** Always `main` -- see the module docstring's note on why there is no
 *  branch field in the UI. */
const BRANCH = "main";

export interface GithubSource {
    owner: string;
    repo: string;
}

interface StoredSource extends GithubSource {
    token: string;
}

let sources: StoredSource[] = [];
let sourcesLoaded = false;

function ensureSourcesLoaded(): void {
    if (sourcesLoaded) return;

    sourcesLoaded = true;

    if (!config.githubSourcesStore) return;

    try {
        const parsed = JSON.parse(readFileSync(config.githubSourcesStore, "utf8")) as { sources?: StoredSource[] };

        sources = (parsed.sources || []).filter(
            (s) => s && typeof s.owner === "string" && typeof s.repo === "string"
        );
    } catch {
        // No store yet, or it is unreadable -- starting with no sources
        // configured is the same posture as a first boot.
    }
}

function persistSources(): void {
    if (!config.githubSourcesStore) return;

    try {
        mkdirSync(dirname(config.githubSourcesStore), { recursive: true });

        const temporary = `${config.githubSourcesStore}.tmp`;

        writeFileSync(temporary, JSON.stringify({ sources }), { mode: 0o600 });
        renameSync(temporary, config.githubSourcesStore);
    } catch (cause) {
        console.error("stremio-tv: could not write the GitHub sources store", cause);
    }
}

const keyOf = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

/** Every configured source, WITHOUT its token -- for rendering. */
export function listGithubSources(): (GithubSource & { hasToken: boolean })[] {
    ensureSourcesLoaded();

    return sources.map(({ owner, repo, token }) => ({ owner, repo, hasToken: !!token }));
}

/**
 * Remembers a source for next time. A blank `token` KEEPS whatever token
 * (if any) was already stored for this owner/repo -- the same "leave blank
 * to keep unchanged" convention as a password-change form, so re-running
 * an import never requires retyping a token that was already given once.
 */
export function rememberGithubSource(owner: string, repo: string, token: string): StoredSource {
    ensureSourcesLoaded();

    const key = keyOf(owner, repo);
    const existing = sources.find((s) => keyOf(s.owner, s.repo) === key);
    const resolved: StoredSource = { owner, repo, token: token || existing?.token || "" };

    sources = [...sources.filter((s) => keyOf(s.owner, s.repo) !== key), resolved];
    persistSources();

    return resolved;
}

export function forgetGithubSource(owner: string, repo: string): void {
    ensureSourcesLoaded();

    const key = keyOf(owner, repo);

    sources = sources.filter((s) => keyOf(s.owner, s.repo) !== key);
    persistSources();
}

function findSource(owner: string, repo: string): StoredSource | undefined {
    ensureSourcesLoaded();

    return sources.find((s) => keyOf(s.owner, s.repo) === keyOf(owner, repo));
}

/* --------------------------------------------------------------------- *
 * The import itself.
 * --------------------------------------------------------------------- */

interface GithubContentEntry {
    name: string;
    type: string;
    path: string;
}

async function githubApi<T>(path: string, token: string): Promise<T> {
    const response = await fetch(`https://api.github.com/${path}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "stremio-tv",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
    });

    if (response.status === 404) {
        throw new Error(
            token
                ? "not found -- check the repo, branch and dist/ path, and that the token can read this repo"
                : "not found -- check the repo and branch, or add a token if this is a private repo"
        );
    }

    if (response.status === 401 || response.status === 403) {
        const remaining = response.headers.get("x-ratelimit-remaining");

        throw new Error(
            remaining === "0"
                ? "GitHub's rate limit was hit -- add a token, or try again shortly"
                : "GitHub refused that token (401/403)"
        );
    }

    if (!response.ok) throw new Error(`GitHub API -> ${response.status}`);

    return response.json() as Promise<T>;
}

export interface ImportResult {
    imported: string[];
    updated: string[];
    skipped: { file: string; reason: string }[];
    errors: { file: string; error: string }[];
}

/**
 * Fetches every `.mjs` file in `<repo>/dist` on `main`, and replaces a
 * dropped-in scraper with it only when `versionSupersedes` says the fetched
 * copy is a real update (or the id is new). Never touches a scraper whose
 * id belongs to a built-in.
 */
export async function importFromGithub(owner: string, repo: string, token: string): Promise<ImportResult> {
    const result: ImportResult = { imported: [], updated: [], skipped: [], errors: [] };

    const listing = await githubApi<GithubContentEntry[] | GithubContentEntry>(
        `repos/${owner}/${repo}/contents/dist?ref=${BRANCH}`,
        token
    );

    const entries = (Array.isArray(listing) ? listing : [listing]).filter(
        (entry) => entry.type === "file" && entry.name.endsWith(".mjs")
    );

    if (!entries.length) {
        throw new Error(
            "no .mjs files in dist/ on that branch -- see that repo's AGENTS.md: compiled output must be committed there"
        );
    }

    if (!config.scrapersDir) throw new Error("SCRAPERS_DIR is not configured on this deployment");

    mkdirSync(config.scrapersDir, { recursive: true });

    // A fresh picture of what is already loaded, so versionSupersedes has
    // something real to compare against -- including anything a PREVIOUS
    // import in this same call already replaced.
    await loadDynamicScrapers();

    const builtins = new Set(builtinScraperIds());
    let changed = false;

    for (const entry of entries) {
        const tempPath = join(tmpdir(), `stremio-tv-github-import-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

        try {
            const file = await githubApi<{ content?: string; encoding?: string }>(
                `repos/${owner}/${repo}/contents/${entry.path}?ref=${BRANCH}`,
                token
            );

            if (!file.content || file.encoding !== "base64") {
                result.errors.push({ file: entry.name, error: "GitHub did not return file content" });
                continue;
            }

            const source = Buffer.from(file.content, "base64").toString("utf8");

            writeFileSync(tempPath, source);

            const loaded = await import(pathToFileURL(tempPath).href);
            const candidate: unknown = looksLikeScraper(loaded.default)
                ? loaded.default
                : Object.values(loaded).find(looksLikeScraper);

            if (!looksLikeScraper(candidate)) {
                result.errors.push({ file: entry.name, error: "does not export a scraper (needs id, name, build())" });
                continue;
            }

            if (!SCRAPER_ID_RE.test(candidate.id)) {
                result.errors.push({ file: entry.name, error: `id "${candidate.id}" is not a usable scraper id` });
                continue;
            }

            if (builtins.has(candidate.id)) {
                result.skipped.push({ file: entry.name, reason: `"${candidate.id}" is a built-in scraper's id` });
                continue;
            }

            const existing = allScrapers().find((s) => s.id === candidate.id);

            if (existing && !versionSupersedes(candidate.version, existing.version)) {
                result.skipped.push({
                    file: entry.name,
                    reason: existing.version
                        ? `already have v${existing.version}${candidate.version ? `, this is v${candidate.version}` : " (this file has no version)"}`
                        : "already loaded, and this file has no version to compare"
                });
                continue;
            }

            const finalPath = join(config.scrapersDir, `${candidate.id}.mjs`);

            writeFileSync(finalPath, source);
            (existing ? result.updated : result.imported).push(candidate.id);
            changed = true;
        } catch (cause) {
            result.errors.push({ file: entry.name, error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
            try {
                rmSync(tempPath, { force: true });
            } catch {
                /* best effort */
            }
        }
    }

    if (changed) await loadDynamicScrapers();

    return result;
}

/** Re-run an already-configured source's import, using its stored token. */
export async function importFromStoredSource(owner: string, repo: string): Promise<ImportResult> {
    const source = findSource(owner, repo);

    if (!source) throw new Error("that source is not configured");

    return importFromGithub(source.owner, source.repo, source.token);
}
