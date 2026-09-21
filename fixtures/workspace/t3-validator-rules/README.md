# t3-validator-rules

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/schema.js     the fields a service configuration has, and what each one is called.
    src/errors.js     what a validation error is.
    src/validate.js   the validator. One function, one chain of conditions, six rules inside it.
    src/report.js     validation errors as a person reads them.
    src/explain.js    what this package checks, as data a caller can print.
    src/defaults.js   the configuration a caller gets when it names nothing.
    src/index.js      the public API.
    test/             the suite.

## What this package does

It checks a service configuration against six rules and answers with the errors it found.

`docs/RULES.md` is the six rules: what each one is called, what it checks, what it answers with when
it fails, and the order the errors come back in. **That document describes what this package
promises to a caller, and none of it is changing.**

`docs/ARCHITECTURE.md` describes how the six rules are meant to be arranged inside the package, and
`src/validate.js` does not currently match it.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
