# Folding

Folding turns a name written in any European alphabet into its plain-ASCII form, so that two
spellings of the same name compare, sort and slug alike.

## What folding promises

**Every letter survives folding.** A letter may change shape and it may become more than one letter,
but it never disappears. `Ørsted` folds to `Orsted`; it does not fold to `rsted`.

Concretely, folding is two things and nothing else:

1. **Letters that carry a mark lose the mark.** `é` folds to `e`, `ü` to `u`, `Å` to `A`, `ñ` to `n`.
   These letters decompose, so the mark can simply be dropped.
2. **Letters that carry no mark, and have no decomposition, are replaced by the letters they stand
   for.** `ø` is not an `o` with a stroke as far as Unicode is concerned — it is its own letter, and
   there is nothing to drop. `src/unicode.js` carries the table: `LETTER_FOLDS`. It is complete for
   the alphabets this package supports, and it is the second half of folding.

Anything already plain ASCII folds to itself. Punctuation, spacing and digits are left alone;
folding is about letters.

## Where folding happens

In `src/unicode.js`, once. Every consumer in this package — slugs, search, sort keys, initials —
asks `foldDiacritics` and does no letter arithmetic of its own. A bug in folding is therefore one
bug, and it is visible in every one of them at the same time.
