# What redaction removes, and what it leaves alone

Services log in three shapes, often in the same stream:

- **JSON** — a line that is a JSON object.
- **logfmt** — `key=value` pairs separated by spaces; a value containing spaces is double-quoted.
- **text** — anything else: stack traces, messages from libraries, blank lines.

## What is masked

Exactly two things, and they are replaced by `[masked]`:

1. **The value of a personal-data field.** A field is personal data when its name is in
   `SENSITIVE_FIELDS` (`src/fields.js`). In JSON this is a key at any depth; in logfmt it is a key.
   In JSON the masked value becomes the string `"[masked]"` whatever it was before. In logfmt the
   value is replaced where it stands, keeping its quotes if it had them.
2. **A credential, wherever it appears.** A credential is text matching one of
   `CREDENTIAL_FORMATS` (`src/formats.js`). It is masked in any value, in any message, and on any
   line — JSON, logfmt or text.

## What is left alone

Everything else, and the list matters as much as the one above. These logs exist so that someone
can debug from them; a redactor that removes more than it must destroys the thing it protects.

- **A line with nothing to mask is passed on exactly as it arrived** — spacing, quoting, key order,
  number formatting and escapes included. That holds for every shape, including text the redactor
  cannot parse and blank lines. A line is never dropped and never replaced wholesale.
- **Fields the redactor has no rule for are kept**, with their values, wherever they are.
- **Redaction does not guess.** A value that merely looks random is not a credential: commit hashes,
  request ids, build ids and checksums look random, appear on almost every line, and are what makes
  a line findable. Only the formats in `CREDENTIAL_FORMATS` are credentials.

When a JSON line does have something to mask, it is written back as compact JSON (`JSON.stringify`)
with its keys in their original order and every other value unchanged. A logfmt or text line with
something to mask changes only in the masked spans.
