# d1-config-migrate

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

`shipit` deploys services, and it is configured by a JSON file in the service's repository. The
file format changed between version 1 and version 2 of the tool. Version 2 still reads a version 1
file: it upgrades it in memory every time it loads one, so nobody has to rewrite their file on the
day they upgrade the tool.

## What is here

    src/load.js        reads the text of a configuration file and decides which version it is.
    src/upgrade.js     turns a version 1 configuration into a version 2 one.
    src/rules.js       what each version 1 key becomes in version 2.
    src/durations.js   reading a duration such as "90s" or "2m".
    src/warnings.js    the list of things the person who wrote the file should be told about.
    src/validate.js    what a version 2 configuration has to contain before shipit will use it.
    src/index.js       the public API.
    examples/          configuration files as people actually write them.
    test/              the suite.

`docs/V2.md` describes the version 2 format. `docs/MIGRATION.md` is the contract for the upgrade:
what it changes, what it must leave alone, and what it tells the person about.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
