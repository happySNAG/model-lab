'use strict';

const { writeComponents } = require('./components.js');
const { formatLine } = require('./lines.js');
const { parseStamp, formatStamp } = require('./time.js');

/** A timestamp checked, and written in the format's own form. */
const stamp = (text) => formatStamp(parseStamp(text));

/** A new agenda holding this model: `{ name?, events }`, each event `{ id, title, start, end, room?, status? }`. */
function encode(agenda) {
  const root = { kind: 'AGENDA', entries: ['VERSION:1'] };
  if (agenda.name !== undefined) root.entries.push(formatLine({ name: 'NAME', value: agenda.name }));
  for (const event of agenda.events) {
    const entries = [
      formatLine({ name: 'ID', value: event.id }),
      formatLine({ name: 'TITLE', value: event.title }),
      formatLine({ name: 'DTSTART', value: stamp(event.start) }),
      formatLine({ name: 'DTEND', value: stamp(event.end) }),
    ];
    if (event.room !== undefined) entries.push(formatLine({ name: 'ROOM', value: event.room }));
    if (event.status !== undefined && event.status !== 'CONFIRMED') {
      entries.push(formatLine({ name: 'STATUS', value: event.status }));
    }
    root.entries.push({ kind: 'EVENT', entries });
  }
  return writeComponents(root);
}

module.exports = { encode };
