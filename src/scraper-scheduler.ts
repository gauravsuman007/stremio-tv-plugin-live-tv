/**
 * Runs each scraper's own tasks on its own configured interval -- see
 * `intervalConfigKey` on `ScraperTask`. This is what lets one scraper's
 * fast-moving data (ntv.st's live-events rail, by default once an hour)
 * refresh on a different cadence than its slow one (the full channel list,
 * by default twice a day) without either forcing the other's pace or
 * needing a special case here: every scraper declares its own tasks and
 * its own interval fields, and this module only ever reads them generically.
 */

import { forgetChannels } from "./channels.js";
import { getScraperConfig } from "./scraper-config.js";
import { allScrapers } from "./scrapers.js";
import { lastTaskRun, runScraperTask } from "./scraper-tasks.js";

const TICK_MS = 60_000;

async function tick(): Promise<void> {
    for (const scraper of allScrapers()) {
        if (!scraper.tasks?.length) continue;

        const values = getScraperConfig(scraper);
        let changed = false;

        for (const task of scraper.tasks) {
            if (!task.intervalConfigKey) continue;

            const minutes = Number(values[task.intervalConfigKey]);

            if (!Number.isFinite(minutes) || minutes <= 0) continue;

            const last = lastTaskRun(scraper.id, task.id);

            if (last && Date.now() - last.at < minutes * 60_000) continue;

            try {
                await runScraperTask(scraper, task.id, values);
                changed = true;
            } catch (cause) {
                console.error(`stremio-tv: scheduled task ${scraper.id}/${task.id} failed`, cause);
            }
        }

        // One rebuild per scraper per tick is enough even if several of its
        // tasks came due together -- the next page load picks up whatever
        // just ran.
        if (changed) forgetChannels();
    }
}

let started = false;

export function startScraperScheduler(): void {
    if (started) return;

    started = true;
    setInterval(() => void tick().catch((cause) => console.error("stremio-tv: scraper scheduler tick failed", cause)), TICK_MS).unref();
}
