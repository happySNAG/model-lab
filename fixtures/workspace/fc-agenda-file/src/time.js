'use strict';

const { AgendaError } = require('./errors.js');

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysIn(year, month) {
  return month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/** `YYYY-MM-DDTHH:MM` taken apart: `{ year, month, day, hour, minute }`. See docs/FORMAT.md. */
function parseStamp(text) {
  const match = STAMP.exec(text);
  if (match === null) throw new AgendaError(`"${text}" is not a timestamp`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59) {
    throw new AgendaError(`"${text}" is not a date and time that exists`);
  }
  return { year, month, day, hour, minute };
}

/** The timestamp text for `{ year, month, day, hour, minute }`. */
function formatStamp(stamp) {
  return `${stamp.year}-${stamp.month}-${stamp.day}T${stamp.hour}:${stamp.minute}`;
}

/**
 * Days since 1 March of the year 0, counted through the Gregorian calendar: one fixed origin, the
 * same for every stamp, so differences are exact. Years are grouped into 400-year eras of exactly
 * 146097 days, and the year is taken to start in March so that the leap day falls at its end.
 */
function dayNumber(year, month, day) {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

/** The date `days` days after that origin: `{ year, month, day }`. The inverse of `dayNumber`. */
function civilDate(days) {
  const era = Math.floor(days / 146097);
  const dayOfEra = days - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function toMinutes(stamp) {
  return dayNumber(stamp.year, stamp.month, stamp.day) * 1440 + stamp.hour * 60 + stamp.minute;
}

function fromMinutes(minutes) {
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  return { ...civilDate(days), hour: Math.floor(rest / 60), minute: rest % 60 };
}

/** The timestamp `minutes` after `text`; a negative count moves it earlier. */
function addMinutes(text, minutes) {
  return formatStamp(fromMinutes(toMinutes(parseStamp(text)) + minutes));
}

/** How many minutes `later` is after `earlier`; negative when it is before. */
function minutesBetween(earlier, later) {
  return toMinutes(parseStamp(later)) - toMinutes(parseStamp(earlier));
}

module.exports = { parseStamp, formatStamp, addMinutes, minutesBetween };
