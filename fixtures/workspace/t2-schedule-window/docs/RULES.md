# Windows, durations and conflicts

## A window is half-open

`[start, end)`. The minute it starts on is inside the window; the minute it ends on is not.

    09:00–10:00   occupies 09:00 … 09:59      runs for 60 minutes
    10:00–11:00   occupies 10:00 … 10:59      runs for 60 minutes

Those two windows **touch and do not overlap**. Booking one room for both is not a conflict, and
reporting it as one is a bug.

Two windows overlap when they share at least one minute. Sharing exactly one minute is overlapping:
09:00–10:00 and 09:59–11:00 share 09:59, so they are a conflict like any other.

## Duration

`minutesBetween(startMinute, endMinute)` is how long the window `[start, end)` runs for, in whole
minutes, and it is the only place in this package that works that out. It is part of the public
surface, so a consumer asking it directly gets the same answer the schedule does.

`durationLabel(minutes)` writes a length of time the way a person says it: `60` is `1 hour`, `90` is
`1 hour 30 minutes`, `45` is `45 minutes`, `0` is `no time`.

## A day

A day is 24 hours from midnight. `bookedMinutes` is the number of minutes of it a room's bookings
occupy; overlapping bookings are counted once each, because the question it answers is how much
time was asked for rather than how much of the day is busy.
