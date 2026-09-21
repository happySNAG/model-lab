# The six rules

Every rule has an id, a code, a field it is about, and a message. All four are part of what this
package promises a caller and **none of them changes**.

| # | id | field | code | fails when |
|---|----|-------|------|------------|
| 1 | `name-format` | `name` | `NAME_FORMAT` | the name is not 1–40 characters of lowercase letters, digits and hyphens, starting with a letter |
| 2 | `replica-count` | `replicas` | `REPLICA_COUNT` | the replica count is not a whole number from 1 to 20 |
| 3 | `port-range` | `port` | `PORT_RANGE` | the port is not a whole number from 1024 to 65535 |
| 4 | `image-tag` | `image` | `IMAGE_TAG` | the image names no tag, or names the tag `latest` |
| 5 | `env-names` | `env` | `ENV_NAME` | an environment variable name is not upper-case letters, digits and underscores, starting with a letter |
| 6 | `limits-present` | `limits` | `LIMITS` | the cpu or memory limit is missing, not positive, or the memory limit is below 64 MiB |

## The messages

    NAME_FORMAT     name must be 1-40 characters of lowercase letters, digits and hyphens
    REPLICA_COUNT   replicas must be a whole number from 1 to 20
    PORT_RANGE      port must be a whole number from 1024 to 65535
    IMAGE_TAG       image must name an explicit tag other than latest
    ENV_NAME        environment variable names must be upper-case letters, digits and underscores
    LIMITS          cpu and memory limits are required, and memory must be at least 64 MiB

`ENV_NAME` is reported **once per offending name**, and the offending name is appended to the path:
`env.myVar`. Every other rule reports at most once, with the field as the path.

## What an error is

    { rule, code, path, message }

`rule` is the id from the table, `code` is the code, `path` is the field the rule is about, and
`message` is the sentence above, exactly.

## The order errors come back in

**Errors come back in rule order — the order of the table above — and never in the order the fields
happen to appear in the configuration that was handed in.** A caller printing the errors of two
configurations that break the same rules sees the same list in the same order, whichever way round
the two files were written. Within one rule that reports more than once, the offending items keep
the order they appear in the configuration.

A configuration that breaks nothing validates to an empty list.
