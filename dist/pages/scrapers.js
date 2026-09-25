/**
 * Which live-TV sources are switched on, and what happened the last time
 * each one ran.
 *
 * WHY THERE IS NO "ADD A SCRAPER" BUTTON HERE
 * --------------------------------------------
 * A scraper is server code with the same reach as the rest of this
 * process. Accepting one through a form on a page this television can
 * open is accepting arbitrary code from whoever can reach it, which is
 * not a trade this surface makes for anyone -- not even for the
 * drop-in-a-file route below, which still means putting a file on the
 * host yourself. See the note at the top of this page's body, and
 * `docs/scraper-template.ts` in the repository.
 */
import { chrome, escape, page, vpnBadge, vpnSheet } from "../render.js";
function since(at) {
    if (!at)
        return "not yet run";
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1)
        return "just now";
    if (minutes < 60)
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48)
        return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return `${Math.round(hours / 24)} days ago`;
}
export function importSummary(result) {
    const parts = [];
    if (result.imported.length)
        parts.push(`imported ${result.imported.join(", ")}`);
    if (result.updated.length)
        parts.push(`updated ${result.updated.join(", ")}`);
    if (result.skipped.length)
        parts.push(`skipped ${result.skipped.map((s) => `${s.file} (${s.reason})`).join("; ")}`);
    if (result.errors.length)
        parts.push(`failed ${result.errors.map((e) => `${e.file}: ${e.error}`).join("; ")}`);
    return parts.length ? parts.join(". ") + "." : "Nothing in dist/ to import.";
}
export function scrapersPage(client, signedIn, rows, githubSources = [], importNote = null, vpn = null) {
    const list = rows
        .map((row) => {
        const status = !row.run
            ? "not yet run"
            : row.run.ok
                ? `${row.run.channels} channel${row.run.channels === 1 ? "" : "s"}, ${since(row.run.at)}`
                : `failed ${since(row.run.at)}: ${row.run.error}`;
        const toggle = row.sole
            ? `<span class="step off">${row.enabled ? "On" : "Off"} &mdash; the only source configured</span>`
            : `<a class="step" href="${escape(`${client.link("/tv/scrapers")}?${row.enabled ? "off" : "on"}=${encodeURIComponent(row.id)}`)}">${row.enabled ? "Switch off" : "Switch on"}</a>`;
        const gear = row.configurable
            ? `<a class="step" title="Settings" href="${escape(client.link(`/tv/scrapers/${encodeURIComponent(row.id)}/config`))}">&#9881;</a>`
            : "";
        return `<li class="railrow${row.enabled ? "" : " railoff"}">
<span class="railname">${escape(row.name)}${row.version ? ` <span class="railsay">v${escape(row.version)}</span>` : ""}</span>
<span class="railsay">${escape(status)}</span>
<span class="railacts">${gear}${toggle}</span>
</li>`;
    })
        .join("\n");
    const sourcesList = githubSources
        .map((source) => {
        const back = `owner=${encodeURIComponent(source.owner)}&repo=${encodeURIComponent(source.repo)}`;
        return `<li class="railrow">
<span class="railname">${escape(`${source.owner}/${source.repo}`)}${source.hasToken ? ` <span class="railsay">token saved</span>` : ""}</span>
<span class="railacts">
<form method="POST" action="${escape(client.link("/tv/scrapers/github-recheck"))}" style="display:inline">
<input type="hidden" name="owner" value="${escape(source.owner)}">
<input type="hidden" name="repo" value="${escape(source.repo)}">
<button class="step" type="submit">Check for updates</button>
</form>
<form method="POST" action="${escape(client.link("/tv/scrapers/github-forget"))}" style="display:inline">
<input type="hidden" name="owner" value="${escape(source.owner)}">
<input type="hidden" name="repo" value="${escape(source.repo)}">
<button class="step" type="submit">Forget</button>
</form>
</span>
</li>`;
    })
        .join("\n");
    const vpnPanel = vpnBadge(vpn) + vpnSheet(vpn, client.link("/vpn"), "/tv/scrapers");
    return page({
        title: "Live TV Sources",
        body: `${chrome(client, "live", signedIn)}
<div class="tvhead">
<h1>Live TV Sources</h1>
<p class="bar"><a class="step" href="${escape(client.link("/tv"))}">&lsaquo; Live TV</a></p>
</div>
${vpnPanel
            ? `<h3 class="lead">The VPN</h3>
<p class="hint">A live channel is a playlist on somebody else&rsquo;s server, fetched from this house for hours at a time. Sent through the tunnel it goes out from wherever the exit is instead. The exit is shared with Riven &mdash; there is one tunnel &mdash; so changing it here changes it there.</p>
${vpnPanel}`
            : ""}
<p class="hint">Every switched-on source is asked in the same nightly sweep, and a channel from one never crowds out a channel from another &mdash; only ranking decides what leads a rail. Switching a source off keeps its channels out of the index entirely, the next time it is rebuilt.</p>
${list.length ? `<ul class="rails">\n${list}\n</ul>` : `<p class="empty">No sources are configured.</p>`}
<p class="bar"><a class="step" href="${escape(`${client.link("/tv/scrapers")}?reload=1`)}">Reload sources</a></p>
${importNote ? `<p class="hint${importNote.ok ? "" : " error"}">${escape(importNote.text)}</p>` : ""}
<h3 class="lead">Import from GitHub</h3>
<p class="hint">Reads every <code>.mjs</code> file in a repository's <code>dist/</code> directory and drops in whichever ones are new or genuinely newer than what is already running &mdash; see &ldquo;Versioning&rdquo; below. A token is only needed for a private repository, and is remembered so you do not retype it on the next check.</p>
<form method="POST" action="${escape(client.link("/tv/scrapers/github-import"))}">
<label for="gh-repo">Repository (owner/repo)</label>
<input id="gh-repo" name="repo" type="text" placeholder="gauravsuman007/stremio-tv-scrapers" autocapitalize="off" autocomplete="off">
<label for="gh-token">Access token (private repos only)</label>
<input id="gh-token" name="token" type="password" autocomplete="off" placeholder="leave blank to keep the saved one">
<button class="go" type="submit">Import</button>
</form>
${sourcesList ? `<ul class="rails">\n${sourcesList}\n</ul>` : ""}
<h3 class="lead">Adding a source</h3>
<p class="hint">A scraper is server code, not something this page accepts from a form &mdash; it runs with the same reach as the rest of this service. Build one against <code>docs/scraper-template.ts</code> from the repository (it stands on its own and can be handed to a session with no access to the rest of the code): implement its one <code>build()</code> function against whatever list or API the new source publishes, and bring the finished file back. It compiles to a plain <code>.mjs</code> file &mdash; no TypeScript runs in this container, and it must be <code>.mjs</code> rather than <code>.js</code> since the mounted directory below has no <code>package.json</code> to say a bare <code>.js</code> is a module. From there, three routes wire it in:</p>
<p class="hint">&bull; <strong>Import from GitHub</strong> (above) &mdash; the repository's <code>dist/</code> is read directly and kept in sync on request; nothing to copy by hand.</p>
<p class="hint">&bull; <strong>Drop it in</strong> &mdash; copy the compiled <code>.mjs</code> file into the <code>scrapers</code> directory on the mounted data volume and press &ldquo;Reload sources&rdquo; above (or restart). No image rebuild, no redeploy; it appears on this page immediately.</p>
<p class="hint">&bull; <strong>Build it in</strong> &mdash; drop the <code>.ts</code> source into <code>src/scrapers/</code> and add it to <code>BUILTIN</code> in <code>src/scrapers.ts</code>. Needs a rebuild and a redeploy, and is worth it only for a source this deployment should never run without, even after a wiped data volume &mdash; nothing is built in by default, including iptv-org and ntv.st, which are themselves ordinary GitHub-imported sources.</p>
<p class="hint">A source may also, optionally, name its own rails over its own channels &mdash; those turn up on the Live TV page alongside the country and theme rails, credited to the source that asked for them.</p>
<h3 class="lead">Versioning</h3>
<p class="hint">A scraper may set a <code>version</code> (dot-separated numbers, e.g. <code>1.2.0</code>) on the object it exports. Importing from GitHub only ever replaces a scraper already running with a strictly newer version &mdash; a version always beats no version, but two scrapers with no version, or an equal one, leave what is already running untouched. This is what makes &ldquo;Check for updates&rdquo; safe to press without re-reading what changed first. &ldquo;Reload sources&rdquo; above is different: it re-reads the dropped-in directory as-is, no version check, because a file that landed there was already a deliberate choice by whoever copied it in.</p>`
    });
}
/**
 * One scraper's own settings: its config fields (pre-filled with their
 * current value, or the field's default if never set -- see
 * `scraper-config.ts`), and its tasks, each with a "Run now" button and
 * when it last ran. A scraper with neither never gets a gear icon linking
 * here in the first place (see `configurable` on `ScraperRow`).
 */
export function scraperConfigPage(client, signedIn, row, note = null) {
    const action = client.link(`/tv/scrapers/${encodeURIComponent(row.id)}/config`);
    const fields = row.fields
        .map(({ field, value }) => {
        const id = `cfg-${field.key}`;
        const input = field.type === "boolean"
            ? `<input id="${escape(id)}" name="${escape(field.key)}" type="checkbox" value="1"${value ? " checked" : ""}>`
            : field.type === "number"
                ? `<input id="${escape(id)}" name="${escape(field.key)}" type="number" value="${escape(String(value))}"${field.min !== undefined ? ` min="${field.min}"` : ""}${field.max !== undefined ? ` max="${field.max}"` : ""}>`
                : `<input id="${escape(id)}" name="${escape(field.key)}" type="text" value="${escape(String(value))}">`;
        return `<label for="${escape(id)}">${escape(field.label)}</label>
${input}
${field.help ? `<p class="hint">${escape(field.help)}</p>` : ""}`;
    })
        .join("\n");
    const taskList = row.tasks
        .map(({ task, run }) => {
        const status = !run
            ? "not yet run"
            : run.ok
                ? `ran ${since(run.at)}`
                : `failed ${since(run.at)}: ${run.error}`;
        return `<li class="railrow">
<span class="railname">${escape(task.label)}</span>
<span class="railsay">${escape(status)}</span>
<span class="railacts">
<form method="POST" action="${escape(client.link(`/tv/scrapers/${encodeURIComponent(row.id)}/tasks/${encodeURIComponent(task.id)}/run`))}" style="display:inline">
<button class="step" type="submit">Run now</button>
</form>
</span>
</li>`;
    })
        .join("\n");
    return page({
        title: `${row.name} settings`,
        body: `${chrome(client, "live", signedIn)}
<div class="tvhead">
<h1>${escape(row.name)}</h1>
<p class="bar"><a class="step" href="${escape(client.link("/tv/scrapers"))}">&lsaquo; Live TV Sources</a></p>
</div>
${note ? `<p class="hint${note.ok ? "" : " error"}">${escape(note.text)}</p>` : ""}
${fields.length
            ? `<h3 class="lead">Configuration</h3>
<p class="hint">Any interval below governs both this scraper's own automatic refresh AND is the value used when you press &ldquo;Run now&rdquo; on a task that depends on it.</p>
<form method="POST" action="${escape(action)}">
${fields}
<button class="go" type="submit">Save</button>
</form>`
            : `<p class="hint">This scraper has no configuration of its own.</p>`}
${taskList.length
            ? `<h3 class="lead">Tasks</h3>
<p class="hint">Running a task runs whichever of its own prerequisites have not already run first, in the right order &mdash; there is no way to run one out of order from here.</p>
<ul class="rails">
${taskList}
</ul>`
            : ""}`
    });
}
