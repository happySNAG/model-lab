// The reference fixes for the forward-compatibility cases — test code, and nothing else.
//
// Two fixes per case, each a map from a path under the fixture to the file's whole contents:
//
//   LOSSY        every visible failure repaired, and the editor still rebuilds the file through the
//                decoded model, so what the model has no field for is gone. The natural first answer.
//   PRESERVING   the same visible repairs, and the editor rewritten over the raw structure so every
//                line or cell it was not asked to change is copied where it is. The answer the
//                format asks for.
//
// They live here rather than under `test/engine/fixtures/workspace-solutions/` so that nothing that
// could be mistaken for a fixture carries an answer: the sealed trees under `fixtures/workspace/`
// are the only trees a case ever sees, and `workspace-forward-compat.test.ts` proves every file
// written here differs from the one shipped.
//
// The visible repairs that do not decide the case — padding a timestamp, reading a column by its
// header, not sorting rows, naming a missing role — are derived from the shipped file by a textual
// replacement that must match, so a fixture edit can never leave a stale copy of the file here.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type ReferenceFix = Record<string, string>;

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures/workspace');

function shipped(fixture: string, file: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, fixture, file), 'utf8');
}

/** Replace every occurrence of `from` with `to`; a replacement that matches nothing is an error. */
export function mangled(contents: string, from: string, to: string): string {
  if (!contents.includes(from)) throw new Error(`the replacement no longer matches: ${from.slice(0, 80)}`);
  return contents.split(from).join(to);
}

// MARK: - ws.fc.agenda-file.reschedule

/** `formatStamp` zero-padded, so what the package writes reads back. */
const AGENDA_TIME_PADDED = mangled(shipped('fc-agenda-file', 'src/time.js'),
  "/** The timestamp text for `{ year, month, day, hour, minute }`. */\nfunction formatStamp(stamp) {\n"
  + '  return `${stamp.year}-${stamp.month}-${stamp.day}T${stamp.hour}:${stamp.minute}`;\n}',
  "const pad = (value, width) => String(value).padStart(width, '0');\n\n"
  + '/** The timestamp text for `{ year, month, day, hour, minute }`, zero-padded as docs/FORMAT.md writes it. */\n'
  + 'function formatStamp(stamp) {\n'
  + '  return `${pad(stamp.year, 4)}-${pad(stamp.month, 2)}-${pad(stamp.day, 2)}T${pad(stamp.hour, 2)}:${pad(stamp.minute, 2)}`;\n}');

const AGENDA_EDIT_LOSSY = `'use strict';

const { decode } = require('./decode.js');
const { encode } = require('./encode.js');
const { addMinutes, minutesBetween } = require('./time.js');
const { AgendaError } = require('./errors.js');

function eventOf(agenda, id) {
  const event = agenda.events.find((entry) => entry.id === id);
  if (event === undefined) throw new AgendaError(\`no event \${id}\`);
  return event;
}

/** The same agenda with event \`id\` starting at \`start\` and ending the same length of time later. */
function reschedule(text, id, start) {
  const agenda = decode(text);
  const event = eventOf(agenda, id);
  const length = minutesBetween(event.start, event.end);
  event.start = start;
  event.end = addMinutes(start, length);
  return encode(agenda);
}

/** The same agenda with event \`id\` titled \`title\`. */
function rename(text, id, title) {
  const agenda = decode(text);
  eventOf(agenda, id).title = title;
  return encode(agenda);
}

/** The same agenda with event \`id\` marked cancelled, and still on the agenda. */
function cancel(text, id) {
  const agenda = decode(text);
  eventOf(agenda, id).status = 'CANCELLED';
  return encode(agenda);
}

module.exports = { reschedule, rename, cancel };
`;

const AGENDA_EDIT_PRESERVING = `'use strict';

const { readComponents, writeComponents } = require('./components.js');
const { parseLine, formatLine } = require('./lines.js');
const { parseStamp, addMinutes, minutesBetween } = require('./time.js');
const { AgendaError } = require('./errors.js');

/**
 * Editing works on the component tree, never on the decoded agenda: every line an edit was not asked
 * to change is copied as it is, including lines and components this package does not understand.
 * See "Editing an agenda" in docs/FORMAT.md.
 */
function agendaOf(text) {
  const root = readComponents(text);
  if (root.kind !== 'AGENDA') throw new AgendaError(\`an agenda file holds one AGENDA component, not \${root.kind}\`);
  return root;
}

function lineIndex(component, name) {
  return component.entries.findIndex((entry) => typeof entry === 'string' && parseLine(entry).name === name);
}

function valueOf(component, name) {
  const index = lineIndex(component, name);
  return index === -1 ? undefined : parseLine(component.entries[index]).value;
}

function eventOf(root, id) {
  const event = root.entries.find((entry) => typeof entry !== 'string' && entry.kind === 'EVENT' && valueOf(entry, 'ID') === id);
  if (event === undefined) throw new AgendaError(\`no event \${id}\`);
  return event;
}

/** Replace the value of the \`name\` line where it is, keeping its parameters; add one at the end when there is none. */
function setValue(component, name, value) {
  const index = lineIndex(component, name);
  if (index === -1) component.entries.push(formatLine({ name, value }));
  else component.entries[index] = formatLine({ ...parseLine(component.entries[index]), value });
}

/** The same agenda with event \`id\` starting at \`start\` and ending the same length of time later. */
function reschedule(text, id, start) {
  parseStamp(start);
  const root = agendaOf(text);
  const event = eventOf(root, id);
  const length = minutesBetween(valueOf(event, 'DTSTART'), valueOf(event, 'DTEND'));
  setValue(event, 'DTSTART', start);
  setValue(event, 'DTEND', addMinutes(start, length));
  return writeComponents(root);
}

/** The same agenda with event \`id\` titled \`title\`. */
function rename(text, id, title) {
  const root = agendaOf(text);
  setValue(eventOf(root, id), 'TITLE', title);
  return writeComponents(root);
}

/** The same agenda with event \`id\` marked cancelled, and still in the file. */
function cancel(text, id) {
  const root = agendaOf(text);
  setValue(eventOf(root, id), 'STATUS', 'CANCELLED');
  return writeComponents(root);
}

module.exports = { reschedule, rename, cancel };
`;

export const AGENDA_LOSSY: ReferenceFix = { 'src/time.js': AGENDA_TIME_PADDED, 'src/edit.js': AGENDA_EDIT_LOSSY };
export const AGENDA_PRESERVING: ReferenceFix = { 'src/time.js': AGENDA_TIME_PADDED, 'src/edit.js': AGENDA_EDIT_PRESERVING };

// MARK: - ws.fc.member-roster.transfer

/** Cells found by their header name, wherever the column is. */
const ROSTER_DECODE_BY_HEADER = mangled(shipped('fc-member-roster', 'src/decode.js'),
  '    COLUMNS.forEach((column, index) => {\n      member[column] = entry.cells[index];\n    });',
  '    for (const column of COLUMNS) member[column] = entry.cells[table.header.indexOf(column)];');

/** Rows written in the order given. */
const ROSTER_ENCODE_IN_ORDER = mangled(shipped('fc-member-roster', 'src/encode.js'),
  '  const ordered = [...members].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));',
  '  const ordered = [...members];');

/** The role docs/ROLES.md names and the list did not. */
const ROSTER_ROLES_COMPLETE = mangled(shipped('fc-member-roster', 'src/roles.js'),
  "const ROLES = ['member', 'lead'];", "const ROLES = ['member', 'maintainer', 'lead'];");

const ROSTER_EDIT_PRESERVING = `'use strict';

const { readTable, writeTable } = require('./table.js');
const { DEFAULT_ROLE, isRole } = require('./roles.js');
const { RosterError } = require('./errors.js');

const HANDLE = /^[a-z][a-z0-9-]*$/;
const KNOWN = ['handle', 'name', 'team', 'role', 'since'];

/**
 * Editing works on the table, never on the decoded members: every cell an edit was not asked to
 * change is copied as it is, comments and columns this package does not understand included. See
 * "Editing a roster" in docs/FORMAT.md.
 */
function column(table, name) {
  const index = table.header.indexOf(name);
  if (index === -1) throw new RosterError(\`the roster has no \${name} column\`);
  return index;
}

function rowOf(table, handle) {
  const handles = column(table, 'handle');
  const row = table.entries.find((entry) => entry.kind === 'row' && entry.cells[handles] === handle);
  if (row === undefined) throw new RosterError(\`no member \${handle}\`);
  return row;
}

/** The same roster with \`handle\` on \`team\`. */
function transfer(text, handle, team) {
  const table = readTable(text);
  rowOf(table, handle).cells[column(table, 'team')] = team;
  return writeTable(table);
}

/** The same roster with \`handle\` holding \`role\`. */
function promote(text, handle, role) {
  if (!isRole(role)) throw new RosterError(\`\${role} is not a role\`);
  const table = readTable(text);
  rowOf(table, handle).cells[column(table, 'role')] = role;
  return writeTable(table);
}

/** The same roster with one more row, under the file's own columns: \`{ handle, name, team, role?, since? }\`. */
function addMember(text, member) {
  if (!HANDLE.test(member.handle ?? '')) throw new RosterError(\`"\${member.handle}" is not a handle\`);
  const values = { handle: member.handle, name: member.name, team: member.team, role: member.role ?? DEFAULT_ROLE, since: member.since ?? '' };
  if (!isRole(values.role)) throw new RosterError(\`\${values.role} is not a role\`);
  const table = readTable(text);
  for (const name of KNOWN) column(table, name);
  const handles = column(table, 'handle');
  if (table.entries.some((entry) => entry.kind === 'row' && entry.cells[handles] === member.handle)) {
    throw new RosterError(\`\${member.handle} is already on the roster\`);
  }
  table.entries.push({ kind: 'row', cells: table.header.map((name) => (KNOWN.includes(name) ? values[name] : '')) });
  return writeTable(table);
}

/** The same roster without \`handle\`'s row, and with everything else as it was. */
function retire(text, handle) {
  const table = readTable(text);
  const row = rowOf(table, handle);
  table.entries.splice(table.entries.indexOf(row), 1);
  return writeTable(table);
}

module.exports = { transfer, promote, addMember, retire };
`;

export const ROSTER_LOSSY: ReferenceFix = {
  'src/decode.js': ROSTER_DECODE_BY_HEADER, 'src/encode.js': ROSTER_ENCODE_IN_ORDER, 'src/roles.js': ROSTER_ROLES_COMPLETE,
};
export const ROSTER_PRESERVING: ReferenceFix = {
  'src/decode.js': ROSTER_DECODE_BY_HEADER, 'src/roles.js': ROSTER_ROLES_COMPLETE, 'src/edit.js': ROSTER_EDIT_PRESERVING,
};
