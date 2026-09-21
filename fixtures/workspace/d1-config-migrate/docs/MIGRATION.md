# Upgrading a version 1 configuration

shipit 2 upgrades a version 1 file in memory every time it loads one. The person who wrote the file
does not see the upgraded version and did not ask for it, so the upgrade has one overriding rule:

**It changes what it recognises, and nothing else.**

## What it recognises

| version 1                    | version 2                                                      |
|------------------------------|----------------------------------------------------------------|
| `name`, `region`             | unchanged                                                      |
| `timeout` (seconds, or a duration such as `"90s"`, `"2m"`, `"1h"`) | `timeoutSeconds`, a whole number of seconds |
| `color: true` / `false`      | `color: "always"` / `"never"`                                  |
| `color: "auto"`              | unchanged                                                      |
| `deploy.strategy: "blue-green"` | `deploy.strategy: "blueGreen"`                              |
| `deploy.strategy: "rolling"` / `"recreate"` | unchanged                                       |
| `deploy.maxSurge`            | unchanged                                                      |
| `notify.slack: "#channel"`   | `notify.channels: [{ "kind": "slack", "target": "#channel" }]` |

The result carries `"version": 2`.

## What it does not recognise

A configuration file is not only shipit's. Plugins keep their settings in it, newer releases of
shipit add keys this one has never heard of, and people leave notes in it. So:

- **A key the upgrade does not recognise is carried into the result exactly as written**, at the top
  level or inside `deploy` or `notify` alike. It is not dropped, renamed or reformatted.
- **A recognised key whose value the upgrade cannot interpret is left exactly as written** — under
  its version 1 name, with its version 1 value — and a warning naming its path is added to the
  result. It is never replaced with a default and never dropped, because the only person who can say
  what `"timeout": "soon"` was meant to be is the person who wrote it, and they cannot see the
  upgraded file to notice a guess.

A warning is `{ path, message }`, where `path` is the key's dotted path, e.g. `"deploy.strategy"`.
