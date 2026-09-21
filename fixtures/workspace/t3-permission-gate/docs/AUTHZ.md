# Who may do what

## Roles

    reader     may look at documents.
    writer     may look at documents and change the ones that are not locked.
    curator    may do anything to a document, including removing it.
    admin      may do anything to a document, including removing it.

There are exactly four roles and they are listed above. An actor whose role is not one of these four
may do nothing at all.

## Actions

The five actions, in order:

    read  update  delete  export  archive

## The decision

|          | read  | update | delete | export | archive |
|----------|-------|--------|--------|--------|---------|
| reader   | yes*  | no     | no     | no     | no      |
| writer   | yes*  | yes**  | no     | no     | no      |
| curator  | yes   | yes    | yes    | yes    | yes     |
| admin    | yes   | yes    | yes    | yes    | yes     |

`*` A document marked **confidential** is not readable by a `reader` or a `writer`, whatever the
rest of this table says. Confidentiality narrows; it never widens.

`**` A document marked **locked** may not be updated by a `writer`. A `curator` or an `admin` may
update a locked document.

A document marked **archived** may still be read and exported by anyone the table allows. It may not
be updated or deleted by anybody at all — an archived document is a record of what was, and changing
it is not a permission question but a refusal.

## Refusals

A refusal is a `ForbiddenError` carrying the action, the actor's role and the document id. It is not
a return value: a handler that got an answer rather than an exception may proceed.

**Authorization is decided first.** A caller who may not update a document is refused with a
`ForbiddenError` whether or not that document is archived. A caller who may update it, and finds it
archived, gets a `ConflictError` — which is a fact about the document rather than about the caller,
and is therefore the handler's to raise and not the policy's.
