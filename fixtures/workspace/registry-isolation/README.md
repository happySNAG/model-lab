# registry-isolation

A deliberately tiny repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/registry.js   the whole package. `createRegistry` builds one, `register` adds a name to one,
                      `namesOf` reads one back.
    test/             the suite.

## The rule this package promises

**A REGISTRY OWNS ITS ENTRIES.** Creating one never leaves it sharing state with anything else —
not with another registry, and not with the options object it was created from. Concretely, all
three of these hold no matter what a caller does afterwards:

  * two registries created with no options are independent of each other;
  * two registries created from the SAME options object are independent of each other;
  * registering a name never changes the caller's options object, nor `DEFAULT_OPTIONS`.

The three are one promise, and a change that keeps only the first has not kept it. A caller who
holds an options object and builds two registries from it is doing an ordinary thing.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
