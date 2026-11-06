# The agenda format

An agenda is a text file of lines. Every line is a property or a component boundary, and the whole
file is one `AGENDA` component.

## A line

    NAME:value
    NAME;PARAM=value;PARAM=value:value

A name and a parameter name are uppercase letters, digits and hyphens. Parameters sit between the
name and the first colon, separated by semicolons; the value is everything after the first colon, to
the end of the line. A line is never folded and a value is never quoted. `BEGIN` and `END` are not
property names: they open and close components.

## A component

    BEGIN:KIND
    ...
    END:KIND

Components nest: an `EVENT` may hold an `ALARM`. The lines between `BEGIN` and `END` belong to that
component, in the order they are written.

## What this package understands

| component | property  | value                                  | where                                    |
|-----------|-----------|----------------------------------------|------------------------------------------|
| `AGENDA`  | `VERSION` | `1`                                    | first line of the agenda                 |
| `AGENDA`  | `NAME`    | the agenda's title                     | at most once                             |
| `AGENDA`  | `EVENT`   | a component, below                     | any number                               |
| `EVENT`   | `ID`      | letters, digits and hyphens; unique    | exactly once                             |
| `EVENT`   | `TITLE`   | the event's title                      | exactly once                             |
| `EVENT`   | `DTSTART` | a timestamp                            | exactly once                             |
| `EVENT`   | `DTEND`   | a timestamp, not before `DTSTART`      | exactly once                             |
| `EVENT`   | `ROOM`    | where it is                            | at most once                             |
| `EVENT`   | `STATUS`  | `CONFIRMED` or `CANCELLED`             | at most once; absent means `CONFIRMED`   |

A timestamp is `YYYY-MM-DDTHH:MM`, zero-padded, in the team's local time, without seconds.

Agendas are also written by other tools and by newer releases of this one, and they may carry
properties, parameters and components that are not in this table — on the agenda, inside an event,
or nested inside either.

## Reading an agenda

A reader takes what it understands. It ignores a property it does not know, a parameter it does not
know on a property it does, and a component it does not know, wherever they appear.

## Editing an agenda

A tool that rewrites an agenda changes the lines it was asked to change and **copies every other
line exactly**: the same text, in the same place relative to the lines around it. That includes
properties, parameters and components this package does not understand. Moving a meeting does not
require understanding its alarms, and a line another tool wrote belongs to that tool — reading may
ignore it; rewriting the file must not lose it. Replacing a property's value keeps the parameters on
its line.

- **reschedule** moves `DTSTART` to the new time and `DTEND` by the same amount, each where it is.
- **rename** replaces the value of the `TITLE` line, where it is.
- **cancel** sets `STATUS:CANCELLED`, replacing the `STATUS` line where there is one and otherwise
  adding one immediately before the event's `END:EVENT`. The event stays in the file: other tools
  that have it on their calendars find out it was cancelled by reading it.
