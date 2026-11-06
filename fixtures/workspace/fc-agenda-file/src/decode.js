'use strict';

const { readComponents } = require('./components.js');
const { parseLine } = require('./lines.js');
const { parseStamp, minutesBetween } = require('./time.js');
const { AgendaError } = require('./errors.js');

const STATUSES = ['CONFIRMED', 'CANCELLED'];
const REQUIRED = { id: 'ID', title: 'TITLE', start: 'DTSTART', end: 'DTEND' };

/**
 * The agenda in a text: `{ version, name, events }`, each event `{ id, title, start, end, room, status }`.
 *
 * Takes what it understands, as docs/FORMAT.md says a reader does: a property, a parameter or a
 * component it does not know is ignored, wherever it appears.
 */
function decode(text) {
  const root = readComponents(text);
  if (root.kind !== 'AGENDA') throw new AgendaError(`an agenda file holds one AGENDA component, not ${root.kind}`);
  const agenda = { version: undefined, name: undefined, events: [] };
  for (const entry of root.entries) {
    if (typeof entry !== 'string') {
      if (entry.kind === 'EVENT') agenda.events.push(decodeEvent(entry));
      continue;
    }
    const { name, value } = parseLine(entry);
    if (name === 'VERSION') agenda.version = value;
    else if (name === 'NAME') agenda.name = value;
  }
  const ids = agenda.events.map((event) => event.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) throw new AgendaError(`two events carry the id ${repeated}`);
  return agenda;
}

function decodeEvent(component) {
  const event = { id: undefined, title: undefined, start: undefined, end: undefined, room: undefined, status: 'CONFIRMED' };
  for (const entry of component.entries) {
    if (typeof entry !== 'string') continue;
    const { name, value } = parseLine(entry);
    if (name === 'ID') event.id = value;
    else if (name === 'TITLE') event.title = value;
    else if (name === 'DTSTART' || name === 'DTEND') {
      parseStamp(value);
      event[name === 'DTSTART' ? 'start' : 'end'] = value;
    } else if (name === 'ROOM') event.room = value;
    else if (name === 'STATUS') {
      if (!STATUSES.includes(value)) throw new AgendaError(`"${value}" is not a status`);
      event.status = value;
    }
  }
  for (const [field, property] of Object.entries(REQUIRED)) {
    if (event[field] === undefined) throw new AgendaError(`an event carries ${property} exactly once`);
  }
  if (minutesBetween(event.start, event.end) < 0) throw new AgendaError(`event ${event.id} ends before it starts`);
  return event;
}

module.exports = { decode };
