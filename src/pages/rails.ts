/**
 * WHICH RAILS THIS TELEVISION SHOWS, AND IN WHAT ORDER.
 *
 * The live page is built out of guesses -- what a household's countries
 * are, what it watches, which themes are worth a heading. The guesses are
 * decent and they are still guesses, and the one thing a viewer can say
 * for certain is "not that one, and that one first". So the arrangement
 * is theirs to state, and it is stated per set: see `session.ts` for why
 * that is the right owner.
 *
 * WHY THE ARRANGEMENT IS SPARSE AND NOT A MANIFEST
 * ------------------------------------------------
 * The rails are DERIVED -- a country added to the config, a language the
 * house starts watching, a theme that finally has enough channels behind
 * it, and there is a new rail that nobody has an opinion about yet. If
 * the stored arrangement were the whole list of what to show, every one
 * of those would arrive invisible, and the only symptom would be a page
 * that quietly never changes. So what is stored is the opinions only:
 * an order, and the ones switched off. Anything unheard of is shown, in
 * the place the service would have put it.
 *
 * WHY IT IS LINKS AND NOT DRAG AND DROP
 * -------------------------------------
 * There is no pointer on a sofa. Up, Down and Hide are three presses of a
 * direction pad away from each other and each one is a plain link, so the
 * page works on a set whose script never ran.
 */

import { chrome, escape, page } from "../render.js";

import type { Client } from "../host.js";

/** One rail the page could show, whether or not it currently does. */
export interface RailSlot {
    id: string;
    heading: string;
    /** How many channels are behind it, for the arranging page to say. */
    count: number;
}

export interface RailPrefs {
    order: string[];
    off: string[];
}

/**
 * The natural list, rearranged by what this set has said.
 *
 * A slot nobody has an opinion about is inserted after whatever came
 * before it naturally, rather than appended -- so a new country rail
 * lands among the country rails instead of under the sweep line.
 */
export function arrange(slots: RailSlot[], prefs: RailPrefs): RailSlot[] {
    const byId = new Map(slots.map((slot) => [slot.id, slot]));
    const spoken = prefs.order.filter((id) => byId.has(id));
    const placed = spoken.map((id) => byId.get(id) as RailSlot);
    const known = new Set(spoken);

    for (const [index, slot] of slots.entries()) {
        if (known.has(slot.id)) continue;

        // Its natural predecessor, if that one has a place already.
        let at = 0;

        for (let back = index - 1; back >= 0; back -= 1) {
            const earlier = slots[back];

            if (!earlier) continue;

            const before = placed.findIndex((held) => held.id === earlier.id);

            if (before >= 0) {
                at = before + 1;
                break;
            }
        }

        placed.splice(at, 0, slot);
        known.add(slot.id);
    }

    return placed;
}

/** The same list, minus what this set switched off. */
export function visibleRails(slots: RailSlot[], prefs: RailPrefs): RailSlot[] {
    const off = new Set(prefs.off);

    return arrange(slots, prefs).filter((slot) => !off.has(slot.id));
}

/** Move one id one place, and return the whole order that results. */
export function moved(slots: RailSlot[], prefs: RailPrefs, id: string, by: -1 | 1): string[] {
    const list = arrange(slots, prefs).map((slot) => slot.id);
    const at = list.indexOf(id);
    const to = at + by;
    const swap = list[to];

    if (at < 0 || to < 0 || to >= list.length || swap === undefined) return list;

    list[at] = swap;
    list[to] = id;

    return list;
}

export function railsPage(
    client: Client,
    signedIn: boolean,
    slots: RailSlot[],
    prefs: RailPrefs,
    /** True when nothing has been said, so Reset can say so. */
    plain: boolean
): string {
    const off = new Set(prefs.off);
    const list = arrange(slots, prefs);

    const act = (what: string, id: string, label: string, enabled = true): string => {
        const href = `${client.link("/tv/rails")}?${what}=${encodeURIComponent(id)}`;

        return enabled
            ? `<a class="step" href="${escape(href)}">${label}</a>`
            : `<span class="step off">${label}</span>`;
    };

    const rows = list
        .map((slot, index) => {
            const hidden = off.has(slot.id);

            return `<li class="railrow${hidden ? " railoff" : ""}">
<span class="railname">${escape(slot.heading)}</span>
<span class="railsay">${escape(hidden ? "Hidden" : `${slot.count} channel${slot.count === 1 ? "" : "s"}`)}</span>
<span class="railacts">${act("up", slot.id, "&uarr; Up", index > 0 && !hidden)} ${act(
                "down",
                slot.id,
                "&darr; Down",
                index < list.length - 1 && !hidden
            )} ${act(hidden ? "show" : "hide", slot.id, hidden ? "Show" : "Hide")}</span>
</li>`;
        })
        .join("\n");

    return page({
        title: "Arrange Live TV",
        body: `${chrome(client, "live", signedIn)}
<div class="tvhead">
<h1>Arrange Live TV</h1>
<p class="bar"><a class="step" href="${escape(client.link("/tv"))}">&lsaquo; Live TV</a> ${
            plain
                ? `<span class="step off">Reset</span>`
                : `<a class="step" href="${escape(`${client.link("/tv/rails")}?reset=1`)}">Reset</a>`
        }</p>
</div>
<p class="hint">${escape(
            "This is for this television only. Rails the service adds later appear on their own -- hiding one here never hides a rail that does not exist yet."
        )}</p>
${list.length ? `<ul class="rails">\n${rows}\n</ul>` : `<p class="empty">There are no rails to arrange yet.</p>`}`
    });
}
