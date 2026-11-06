'use strict';

const { AgendaError } = require('./errors.js');

const NAME = /^[A-Z][A-Z0-9-]*$/;

/**
 * One property line, taken apart: `{ name, parameters, value }`. See "A line" in docs/FORMAT.md.
 *
 * Parameters keep the order they were written in, so a line put back together by `formatLine` is
 * the line that was read.
 */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) throw new AgendaError(`"${line}" is not a property: it has no colon`);
  const [name, ...rest] = line.slice(0, colon).split(';');
  if (!NAME.test(name)) throw new AgendaError(`"${name}" is not a property name`);
  const parameters = {};
  for (const parameter of rest) {
    const equals = parameter.indexOf('=');
    if (equals === -1) throw new AgendaError(`"${parameter}" is not a parameter: it has no equals sign`);
    const key = parameter.slice(0, equals);
    if (!NAME.test(key)) throw new AgendaError(`"${key}" is not a parameter name`);
    parameters[key] = parameter.slice(equals + 1);
  }
  return { name, parameters, value: line.slice(colon + 1) };
}

/** The line for `{ name, parameters, value }`; `parameters` may be left out. */
function formatLine({ name, parameters = {}, value }) {
  const head = [name, ...Object.entries(parameters).map(([key, parameterValue]) => `${key}=${parameterValue}`)];
  return `${head.join(';')}:${value}`;
}

module.exports = { parseLine, formatLine };
