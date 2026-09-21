# t2-schedule-window

A deliberately small repository used by Cernum's workspace-backed benchmark cases. It is plain
CommonJS run by `node` directly — no package manager, no dependencies, no network — so an attempt
against it measures the model rather than whether an install succeeded.

## What is here

    src/timeparse.js   clock text to minutes since midnight, and back.
    src/duration.js    the package's duration arithmetic. How long a window is, and how a length of
                       time is written for a person.
    src/interval.js    a booking window: the two clock times, the two minute marks, and how long it
                       runs for.
    src/overlap.js     whether two windows overlap.
    src/schedule.js    a room's bookings for a day, and the conflicts between them.
    src/agenda.js      the day as a person reads it, including how much of it is booked.
    src/room.js        rooms and their capacities.
    src/attendee.js    attendees and their display names.
    src/index.js       the public API.
    test/              the suite.

## The rules this package is built around

**A window is half-open.** It includes the minute it starts on and excludes the minute it ends on,
so 09:00–10:00 occupies 09:00 through 09:59 and nothing else. Two windows that merely touch —
one ends exactly when the next begins — do **not** overlap and are not a conflict.

**Duration arithmetic lives in one place.** `src/duration.js` is where a length of time is worked
out, and everything that needs one asks it. Nothing else in this package subtracts one minute mark
from another; a second opinion about how long a window is would be a second answer.

Nothing here is ever executed in place. Every attempt gets a copy; see `docs/ENGINE.md` in Cernum.
