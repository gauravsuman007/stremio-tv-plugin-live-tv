/**
 * The `PluginHost` contract this plugin is built against.
 *
 * Structurally identical to stremio-tv's own `src/plugin-types.ts`
 * `PluginHost` (source of truth -- kept in sync by eye, no npm workspace
 * link between the two repos in this pass). stremio-tv builds the real
 * object from its own live modules (`fetchvia.ts`, `playback.ts`,
 * `session.ts`, `vpn.ts`, `html.ts`, `pages/chrome.ts`, `pages/browse.ts`)
 * and calls this plugin's default export -- a factory, `(host) =>
 * StremioTvPlugin` -- with it exactly once, at load time.
 *
 * `setHost`/`host` is this repo's way of giving every module here (not
 * just `plugin-entry.ts`, which receives it directly) access to the same
 * object without threading it through every function signature --
 * `channels.ts`, `sweep.ts` and the moved `pages/*.ts` all read `host` at
 * call time, always after the factory has run.
 */
// eslint-disable-next-line import/no-mutable-exports
export let host;
export function setHost(value) {
    host = value;
}
