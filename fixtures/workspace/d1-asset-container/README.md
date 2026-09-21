# d1-asset-container

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What this is

A **slab** is the container a sprite tool stores its images in: a signature followed by a sequence
of typed, checksummed chunks. `docs/FORMAT.md` is the format, including what a tool that edits a
slab may and may not do to it.

## What is here

    src/chunks.js    reading and writing the chunk sequence: signature, lengths, types, checksums.
    src/crc32.js     the checksum every chunk carries.
    src/bytes.js     big-endian integers.
    src/decode.js    a slab, read into an image: size, pixels, name and notes.
    src/encode.js    an image, written out as a new slab.
    src/edit.js      changing an existing slab: its name and its notes.
    src/inspect.js   a listing of the chunks in a slab, for people and for tests.
    src/errors.js    the one error this package throws.
    src/index.js     the public API.
    test/            the suite.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
