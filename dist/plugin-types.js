/**
 * This plugin's own copy of the `StremioTvPlugin` contract.
 *
 * Source of truth: stremio-tv `src/plugin-types.ts`. Structurally
 * identical -- no npm workspace link between the two repos in this pass,
 * so this is kept in sync by eye, the same as `types.ts` and `host.ts`.
 * Synced against core's `PLUGIN_API_VERSION` "1.5.0" as of this pass --
 * see that constant's own doc comment in the core file for the
 * MAJOR/MINOR/PATCH rule a future sync needs to check against, and bump
 * `PLUGIN_API_VERSION` below (and `plugin.ts`'s `apiVersion` field)
 * together with whatever brought this file's shape up to date.
 */
/** The plugin contract's own version, independent of any one plugin's
 *  `version` -- see `StremioTvPlugin.apiVersion` and core's own doc
 *  comment on this same constant for the versioning rule. */
export const PLUGIN_API_VERSION = "1.5.0";
