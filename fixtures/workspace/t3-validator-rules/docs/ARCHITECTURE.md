# Architecture

## A rule is a module

**Each of the six rules in `docs/RULES.md` is its own module under `src/rules/`, named after its
id**: `src/rules/name-format.js`, `src/rules/replica-count.js`, and so on.

A rule module exports one object:

    id          the rule's id, exactly as docs/RULES.md spells it.
    code        the code its errors carry, exactly as docs/RULES.md spells it.
    appliesTo   the field the rule is about — the path its errors carry.
    check       check(configuration) -> an array of errors, empty when the rule is satisfied.

A rule knows about its own field and nothing else. It does not know which rules run before it, it
does not know whether any of them found anything, and it can be required on its own and asked about
a configuration without the rest of the package being involved.

## The registry is the order

`src/rules/index.js` holds the rules **in the order `docs/RULES.md` lists them** and exports:

    RULES        the rule objects, in that order.
    listRules()  their ids, in that order.

That list is the single statement of what rules exist and what order they run in. There is no second
place where a rule is named, and no rule runs because something remembered to call it. Everything
that needs to know which rules there are — the validator that runs them and `src/explain.js`, which
describes them to a caller — reads this list, so the two can never disagree about what this package
checks.

## The validator is a driver

`validate(configuration)` walks `RULES`, asks each one, and concatenates what they answer with. It
makes no decisions about any individual field: every condition in `docs/RULES.md` lives in the rule
module that owns it, and the order the errors come back in is the registry's order rather than
anything the validator works out.

## What is not changing

`docs/RULES.md` is the contract with a caller: the ids, the codes, the paths, the messages, the
order and the shape of an error are all exactly what they are today. This is a rearrangement of the
inside of this package and a caller must not be able to tell it happened.
