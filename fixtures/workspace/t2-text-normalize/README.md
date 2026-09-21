# t2-text-normalize

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/unicode.js    folding: the one place this package turns a name written in any European
                      alphabet into its plain-ASCII form.
    src/slug.js       a URL slug.
    src/search.js     whether a query matches a piece of text.
    src/sortkey.js    the key a name is filed under, and sorting by it.
    src/initials.js   a person's initials.
    src/wrap.js       hard-wrapping a paragraph to a column width.
    src/escape.js     escaping text for embedding in HTML.
    src/index.js      the public API.
    test/             the suite.

## The rule this package is built around

**Text is folded once, centrally.** `foldDiacritics` in `src/unicode.js` is the only place this
package decides what a letter becomes, and everything that compares, files, slugs or abbreviates a
name asks it. A consumer that worked out its own answer would be a second opinion about what a name
is, and two of those is one too many — see `docs/FOLDING.md` for what folding promises.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
