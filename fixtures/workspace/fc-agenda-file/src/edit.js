'use strict';

const { decode } = require('./decode.js');
const { encode } = require('./encode.js');
const { AgendaError } = require('./errors.js');

function eventOf(agenda, id) {
  const event = agenda.events.find((entry) => entry.id === id);
  if (event === undefined) throw new AgendaError(`no event ${id}`);
  return event;
}

/** The same agenda with event `id` starting at `start`. See "Editing an agenda" in docs/FORMAT.md. */
function reschedule(text, id, start) {
  const agenda = decode(text);
  eventOf(agenda, id).start = start;
  return encode(agenda);
}

/** The same agenda with event `id` titled `title`. */
function rename(text, id, title) {
  const agenda = decode(text);
  eventOf(agenda, id).title = title;
  return encode(agenda);
}

/** The same agenda with event `id` cancelled. */
function cancel(text, id) {
  const agenda = decode(text);
  eventOf(agenda, id);
  return encode({ ...agenda, events: agenda.events.filter((event) => event.id !== id) });
}

module.exports = { reschedule, rename, cancel };
