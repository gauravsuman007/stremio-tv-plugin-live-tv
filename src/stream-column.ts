/**
 * The channel's source list, drawn by this plugin (core plugin API 1.1.0's
 * `streamColumn`) instead of core's generic stream rows.
 *
 * Core's row can only say what a torrent row says: "Direct link" for any
 * URL, and "Live TV" as the source. Here a row says what matters for a
 * live mirror -- the picture (4K, 1080p...), the codec, WHICH scraper it
 * came from (not the CDN host), and, in red, when the mirror's video is
 * hidden inside PNG images and plays through this plugin's own relay
 * ("PNG proxy"). The markup reuses core's own row classes, so it looks and
 * focuses like every other row.
 */

import { CHECKED, pictureLines, streamMeta } from "./channels.js";
import { escape } from "./render.js";

import type { StreamColumn, StreamColumnInput } from "./plugin-types.js";

const NAMES: Record<string, string> = { h264: "H.264", hevc: "H.265", mpeg2video: "MPEG-2", vp9: "VP9", av1: "AV1" };

/** A filled red pill: legible on the dark row and on the red focus bar. */
const RED_TAG = 'style="background:#d81f2a;border-color:#d81f2a;color:#ffffff"';

export function liveStreamColumn(input: StreamColumnInput, codecOf: (url: string) => { video: string; audio: string } | null, sourceName: (source: string) => string): StreamColumn | null {
    if (input.type !== "tv" || !input.rows.length) return null;

    const rows = input.rows
        .map((row) => {
            const url = row.stream.url || "";
            const meta = streamMeta(url);
            const checked = row.stream.name === CHECKED;
            const lines = meta ? pictureLines(meta) : 0;
            const picture = lines >= 2160 ? "4K" : lines ? `${lines}p` : "";
            const fact = codecOf(url);
            const codec = fact && fact.video ? NAMES[fact.video] || fact.video : "";
            const sound = fact && fact.audio ? fact.audio.toUpperCase() : "";
            const proxied = Boolean(meta && meta.decoder);
            const origin = meta ? sourceName(meta.source) : row.from.manifest.name || "";
            const warned = meta ? meta.labels.join(" · ") : "";
            const status = proxied
                ? `<b class="tag" ${RED_TAG}>PNG proxy</b>`
                : checked
                  ? `<b class="tag tag-fill">Live</b><span class="sub">checked</span>`
                  : "";

            return `<a class="row srow good" href="${escape(row.href)}"><span class="scol">${status}</span><span class="qcol">${escape(picture)}</span><span class="mcol">
${codec || sound ? `<span class="what">${escape([codec, sound].filter(Boolean).join(" · "))}</span>` : ""}
${warned ? `<span class="rel">${escape(warned)}</span>` : ""}
<span class="who">${escape(origin)}</span>
<span class="note">${proxied ? (checked ? "Checked live, plays through the PNG relay" : "Plays through the PNG relay") : checked ? "Checked live, direct link" : "Direct link"}</span>
</span><span class="zcol"></span></a>`;
        })
        .join("\n");

    /*
        Core always draws its own "Torrents & debrid" column beside a
        plugin's; a channel never has one, so it is hidden rather than left
        as an empty half of the page.
    */
    return {
        heading: "Sources",
        html: `<style>.streamcols>.streamcol:first-child{display:none}.streamcol+.streamcol{margin-left:0}</style><div class="rows">${rows}</div>`
    };
}
