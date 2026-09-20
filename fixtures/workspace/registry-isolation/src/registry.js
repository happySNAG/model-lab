'use strict';

/** What a registry falls back to when the caller names no options. */
const DEFAULT_OPTIONS = { label: 'registry', entries: [] };

/**
 * Build a registry.
 *
 * A REGISTRY OWNS ITS ENTRIES — see README.md. Creating one must leave it sharing state with
 * nothing: not with another registry, and not with the options object it was created from.
 */
function createRegistry(options) {
  const settings = options === undefined ? DEFAULT_OPTIONS : options;
  return { label: settings.label, entries: settings.entries };
}

/** Add a name. Registries are mutable containers; this is the only thing that writes to one. */
function register(registry, name) {
  registry.entries.push(name);
  return registry;
}

/** Every name in the registry, in the order it was added. */
function namesOf(registry) {
  return [...registry.entries];
}

module.exports = { DEFAULT_OPTIONS, createRegistry, register, namesOf };
