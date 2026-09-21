# Architecture

## The layers

    src/handlers/   what a caller can ask for. One file per action. A handler validates its
                    arguments, decides nothing about permission, and calls the store.
    src/store/      where documents live. The store knows nothing about actors.
    src/model/      what a document is and what an actor is. No behaviour beyond construction.
    src/authz/      the authorization boundary. See below.

## The authorization boundary

**Every permission decision in this service is made in one place: `src/authz/policy.js`.**

That module exports:

    ACTIONS                              every action this service can be asked for, as an array of
                                         strings, in the order they are listed in docs/AUTHZ.md.
    authorize(actor, action, resource)   the decision. Returns nothing when the actor may do it, and
                                         throws a ForbiddenError when it may not.

`authorize` is **total**: it has an answer for every action in `ACTIONS`, and an action that is not
in `ACTIONS` is not a question it will guess at — it throws an `UnknownActionError` rather than
letting an unrecognised action through or silently refusing it.

**A handler must not know role names.** A handler that compares `actor.role` against a string has
made a permission decision, and a service with five handlers that each make their own decisions has
five policies that drift apart — which is how `export` came to have none at all. The role names
belong to `src/authz/`, and nothing under `src/handlers/` names one.

**The boundary cannot be walked around.** A caller reaching the store directly is out of scope for
this package; a *handler* reaching the store without having asked `authorize` first is the thing
this structure exists to make impossible to do by accident. Every handler asks, every time, before
it touches the store.

## What is not changing

`src/search.js`, `src/pagination.js` and `src/render.js` read documents that have already been
handed to them. They take no actor, they make no decision, and they are not part of this boundary.
