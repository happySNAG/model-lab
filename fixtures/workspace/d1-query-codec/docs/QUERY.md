# Query parameters

## Values

A parameter value is one of:

- a **string**;
- an **array of strings**;
- an **object** whose keys are non-empty strings and whose values are parameter values, nested as
  deeply as needed.

The parameters of a URL are an object of that kind. An empty array or an empty object writes
nothing, and so reads back as absent.

## Writing

Every leaf string becomes one `name=value` pair. The name is the top-level key, followed by
`[key]` for each object it is inside and `[]` for an array element. Pairs are joined with `&` in the
order the keys and elements appear.

    { page: '2', filter: { status: 'open', labels: ['bug', 'ui'] } }
    page=2&filter[status]=open&filter[labels][]=bug&filter[labels][]=ui

Each key and each value is percent-encoded on its own with `encodeURIComponent`. So a key or a value
may contain any character at all — `&`, `=`, `[`, `]`, `%`, `+`, spaces, letters outside ASCII —
and none of them is ever mistaken for the syntax around it. The brackets and `=` and `&` that the
format itself writes are the only ones left unencoded.

## Reading

- The text is split at `&`, and each pair at its first `=`. A pair without `=` has the empty string
  as its value. Empty pairs are skipped.
- A `+` is a space, because that is how HTML forms write one.
- A name's brackets are found before anything is percent-decoded, so an encoded bracket is part of
  a key and never structure.
- `[]` appends to an array. `[key]` goes into an object. A key is always a name: `[0]` is the key
  `"0"` of an object, and only `[]` makes an array.

## The promise

For every parameter object described above, `decodeQuery(encodeQuery(parameters))` gives back an
object deep-equal to `parameters`, leaving out the empty arrays and objects that write nothing.
