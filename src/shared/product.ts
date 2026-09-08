// The one place the product's own name is read, rather than typed.
//
// Every user-visible name — window title, installer, artefact filenames, the terminal banner — is
// already decided by `package.json` and `electron-builder.yml`. Reading it from one place means a
// future rename touches configuration rather than source, and means nothing in the engine, the
// service or the terminal hard-codes a product name it does not own.
//
// This is NOT a rebrand. It changes no displayed string today; it removes the reason a rebrand
// would have to edit code at all.

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

/** The command a person types to drive a campaign from a terminal. */
export const TERMINAL_COMMAND = 'cernum';

/** Where campaigns live under the application's data directory. */
export const CAMPAIGN_DIRECTORY_NAME = 'campaigns';
