/**
 * A scraper's own config values: migration when its `configSchema` changes
 * shape, and task ordering (`dependsOn`, run-once-per-call, cycle
 * detection) via `runScraperTask`.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "stremio-tv-scraper-config-"));

const { initPluginConfig } = await import("../dist/plugin-config.js");
initPluginConfig(dir);

const { getScraperConfig, setScraperConfig } = await import("../dist/scraper-config.js");
const { runScraperTask, lastTaskRun } = await import("../dist/scraper-tasks.js");

/* ---- migration ---------------------------------------------------------- */

const v1 = {
    id: "migrating",
    name: "Migrating",
    configSchema: [
        { key: "a", label: "A", type: "number", default: 10 },
        { key: "b", label: "B", type: "string", default: "x" }
    ],
    async build() {
        return { channels: [] };
    }
};

same("defaults when nothing stored", getScraperConfig(v1), { a: 10, b: "x" });

setScraperConfig(v1, { a: 42, b: "y" });
same("stored values come back", getScraperConfig(v1), { a: 42, b: "y" });

// A value of the wrong type never reaches storage.
setScraperConfig(v1, { a: "not a number", b: "z" });
same("wrong-typed value falls back to default", getScraperConfig(v1), { a: 10, b: "z" });

setScraperConfig(v1, { a: 7, b: "kept" });

const v2 = {
    id: "migrating",
    name: "Migrating",
    configSchema: [
        // "a" removed, "b" kept, "c" newly added.
        { key: "b", label: "B", type: "string", default: "x" },
        { key: "c", label: "C", type: "boolean", default: true }
    ],
    async build() {
        return { channels: [] };
    }
};

same("removed field dropped, kept field kept, new field defaulted", getScraperConfig(v2), {
    b: "kept",
    c: true
});

/* ---- task ordering -------------------------------------------------------- */

const order = [];

const grapher = {
    id: "grapher",
    name: "Grapher",
    tasks: [
        {
            id: "root",
            label: "Root",
            dependsOn: ["mid-a", "mid-b"],
            async run() {
                order.push("root");
            }
        },
        {
            id: "mid-a",
            label: "Mid A",
            dependsOn: ["leaf"],
            async run() {
                order.push("mid-a");
            }
        },
        {
            id: "mid-b",
            label: "Mid B",
            dependsOn: ["leaf"],
            async run() {
                order.push("mid-b");
            }
        },
        {
            id: "leaf",
            label: "Leaf",
            async run() {
                order.push("leaf");
            }
        }
    ],
    async build() {
        return { channels: [] };
    }
};

await runScraperTask(grapher, "root", {});

same("leaf ran once despite two dependents", order.filter((x) => x === "leaf").length, 1);
same("root ran last", order[order.length - 1], "root");
check("leaf ran before both of its dependents", order.indexOf("leaf") < order.indexOf("mid-a") && order.indexOf("leaf") < order.indexOf("mid-b"));
check("leaf task recorded as run", lastTaskRun("grapher", "leaf")?.ok === true);

/* ---- cycle detection ------------------------------------------------------ */

const cyclic = {
    id: "cyclic",
    name: "Cyclic",
    tasks: [
        { id: "a", label: "A", dependsOn: ["b"], async run() {} },
        { id: "b", label: "B", dependsOn: ["a"], async run() {} }
    ],
    async build() {
        return { channels: [] };
    }
};

await assert.rejects(() => runScraperTask(cyclic, "a", {}), /cycle/);
checks += 1;

const failing = lastTaskRun("cyclic", "a");
check("a failed task run recorded", failing !== null && failing.ok === false);

console.log(`PASSED: ${checks} scraper-config and task checks`);
