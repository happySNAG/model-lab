// The one place the product's own name is read, rather than typed.
//
// Every user-visible name — window title, installer, artefact filenames, the terminal banner — is
// already decided by `package.json` and `electron-builder.yml`. Reading it from one place means a
// future rename touches configuration rather than source, and means nothing in the engine, the
// service or the terminal hard-codes a product name it does not own.
//
// THE REBRAND THIS WAS BUILT FOR HAS NOW HAPPENED. The product is Cernum, and it cost exactly what
// this module was meant to make it cost: `package.json` and `electron-builder.yml` changed, and no
// engine, service or terminal source hard-coded a name that had to be chased.
//
// One consequence reached past this module and had to be handled on its own. Electron derives the
// `userData` directory from the application's name, so the rename silently repoints it -- see
// `src/main/user-data-migration.ts`, which carries a person's campaigns and evidence across.

import packageJSON from '../../package.json';

export interface ProductIdentity {
  /** The displayed name, e.g. in a terminal banner. */
  name: string;
  /** The short slug used for directory names and the terminal command. */
  slug: string;
  version: string;
  description: string;
}

export const PRODUCT: ProductIdentity = {
  name: (packageJSON as { productName?: string; name: string }).productName ?? packageJSON.name,
  slug: packageJSON.name,
  version: packageJSON.version,
  description: packageJSON.description,
};

/**
 * The product's promise, in three words.
 *
 * TEST is the campaign: the same prompts, the same budgets, the same judge, every time.
 * DISCERN is the part most benchmarks skip: a number is reported with what it does NOT prove --
 *   which identity was verified, what a cost figure is, how wide the interval is, what was withheld
 *   for a person to rule on.
 * DECIDE belongs to the person. This application ranks candidates WITHIN one benchmark and hands
 *   over the evidence; it never routes, promotes or recommends a model on its own authority.
 */
export const TAGLINE = 'Test. Discern. Decide.';

/** The command a person types to drive a campaign from a terminal. */
export const TERMINAL_COMMAND = 'cernum';

/** Where campaigns live under the application's data directory. */
export const CAMPAIGN_DIRECTORY_NAME = 'campaigns';

/**
 * Environment overrides, under the new name and the old one.
 *
 * A rename must not break a script somebody already wrote. `CERNUM_*` is canonical and is read
 * first; the pre-rename `MODEL_LAB_*` names keep working and are not deprecated out from under
 * anyone. Both are read in ONE place so the two can never drift apart.
 */
export function environmentOverride(suffix: 'USER_DATA' | 'CAMPAIGN_ROOT' | 'OLLAMA_ENDPOINT',
                                    environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = environment[`CERNUM_${suffix}`];
  if (current !== undefined && current.length > 0) return current;
  const legacy = environment[`MODEL_LAB_${suffix}`];
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined;
}
