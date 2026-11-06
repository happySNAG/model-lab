'use strict';

const { AgendaError } = require('./errors.js');

/**
 * The components in an agenda text, as a tree: `{ kind, entries }`, where each entry is either a
 * property line, kept as the text it was written as, or a nested component.
 *
 * Nothing is interpreted beyond BEGIN and END, so what is read can be written back as it was.
 */
function readComponents(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const open = [];
  let root;
  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1}`;
    if (line.startsWith('BEGIN:')) {
      const component = { kind: line.slice(6), entries: [] };
      if (open.length === 0) {
        if (root !== undefined) throw new AgendaError(`${where}: a second component after the first has ended`);
        root = component;
      } else {
        open[open.length - 1].entries.push(component);
      }
      open.push(component);
    } else if (line.startsWith('END:')) {
      const current = open.pop();
      if (current === undefined) throw new AgendaError(`${where}: END:${line.slice(4)} with nothing open`);
      if (current.kind !== line.slice(4)) throw new AgendaError(`${where}: END:${line.slice(4)} closes BEGIN:${current.kind}`);
    } else {
      if (open.length === 0) throw new AgendaError(`${where}: a property outside any component`);
      if (line.trim() === '') throw new AgendaError(`${where}: a blank line is not a property`);
      open[open.length - 1].entries.push(line);
    }
  }
  if (open.length > 0) throw new AgendaError(`BEGIN:${open[open.length - 1].kind} is never closed`);
  if (root === undefined) throw new AgendaError('an agenda holds one component');
  return root;
}

/** The text for a component tree, one line per entry, ending with a line break. */
function writeComponents(component) {
  const lines = [];
  const emit = (current) => {
    lines.push(`BEGIN:${current.kind}`);
    for (const entry of current.entries) {
      if (typeof entry === 'string') lines.push(entry);
      else emit(entry);
    }
    lines.push(`END:${current.kind}`);
  };
  emit(component);
  return `${lines.join('\n')}\n`;
}

module.exports = { readComponents, writeComponents };
