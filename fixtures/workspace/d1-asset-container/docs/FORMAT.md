# The slab format

A slab is the 8-byte signature `89 53 4C 42 0D 0A 1A 0A` followed by chunks, one after another,
until the end of the file.

## A chunk

| bytes | meaning                                                         |
|-------|-----------------------------------------------------------------|
| 4     | length of the data, big-endian                                  |
| 4     | type: four ASCII letters                                        |
| n     | data                                                            |
| 4     | CRC-32 of the type and the data together, big-endian            |

The first letter of the type says what a reader may do with a chunk it does not understand. An
**uppercase** first letter marks a *critical* chunk: the file cannot be displayed without
understanding it. A **lowercase** first letter marks an *ancillary* chunk: a reader may skip it and
still show the image.

## The chunks this package understands

| type   | kind      | data                                   | where                                     |
|--------|-----------|----------------------------------------|-------------------------------------------|
| `HEAD` | critical  | width and height, 2 bytes each         | first, exactly once                       |
| `PIXL` | critical  | pixel bytes                            | one or more, after `HEAD`                 |
| `name` | ancillary | the image's title, UTF-8               | at most once, after `HEAD`, before the first `PIXL` |
| `note` | ancillary | a free-text note, UTF-8                | any number, after `HEAD`, before `TAIL`   |
| `TAIL` | critical  | empty                                  | last, exactly once                        |

Slabs are also written by other tools and by newer releases of this one, and they may carry chunks
of types that are not in this table.

## Reading a slab

A reader shows what it understands. It skips an ancillary chunk it does not understand, and it
refuses a file carrying a critical chunk it does not understand, because the image it would show is
not the image in the file.

## Editing a slab

An editor changes the chunks it was asked to change and **copies every other chunk exactly**: the
same bytes, in the same place relative to the chunks around it. That includes chunks this package
does not understand, critical or ancillary. Renaming an image does not require understanding its
pixels, and a chunk another tool wrote belongs to that tool — reading may skip it; rewriting the
file must not lose it.

- **setName** replaces the `name` chunk where it is, or inserts one after `HEAD` and before the
  first `PIXL` when there is none.
- **addNote** adds a `note` chunk immediately before `TAIL`.
- **removeNotes** removes the `note` chunks.
