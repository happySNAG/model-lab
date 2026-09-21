'use strict';

/**
 * Folding: the one place this package decides what a letter becomes.
 *
 * `docs/FOLDING.md` is the contract. Everything that compares, files, slugs or abbreviates a name
 * asks `foldDiacritics`; nothing else in this package does letter arithmetic.
 */

/**
 * The letters that carry no mark and have no decomposition, and the letters they stand for.
 *
 * COMPLETE FOR THE ALPHABETS THIS PACKAGE SUPPORTS, AND USED BY NOTHING YET. A letter in this table
 * cannot be folded by dropping a mark, because there is no mark to drop: it is a letter in its own
 * right and the only way to write it in ASCII is to say what it stands for.
 */
const LETTER_FOLDS = {
  'ø': 'o', 'Ø': 'O',
  'æ': 'ae', 'Æ': 'AE',
  'œ': 'oe', 'Œ': 'OE',
  'ß': 'ss',
  'đ': 'd', 'Đ': 'D',
  'ð': 'd', 'Ð': 'D',
  'ł': 'l', 'Ł': 'L',
  'þ': 'th', 'Þ': 'Th',
  'ı': 'i',
};

/** Every combining mark, whatever letter it was sitting on. */
const COMBINING_MARK = /\p{M}/gu;

/**
 * A name in its plain-ASCII form.
 *
 * See `docs/FOLDING.md` for what this promises.
 */
function foldDiacritics(text) {
  const substituted = Array.from(String(text))
    .map((character) => (Object.prototype.hasOwnProperty.call(LETTER_FOLDS, character)
      ? LETTER_FOLDS[character] : character))
    .join('');
  return substituted.normalize('NFD').replace(COMBINING_MARK, '');
}

/** Folded, and lowercased, which is what a comparison wants. */
function foldForComparison(text) {
  return foldDiacritics(text).toLowerCase();
}

module.exports = { LETTER_FOLDS, foldDiacritics, foldForComparison };
