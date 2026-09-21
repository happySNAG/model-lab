'use strict';

/** An attendee, as this package holds one. */
function createAttendee(fields) {
  if (typeof fields.id !== 'string' || fields.id.length === 0) {
    throw new TypeError('an attendee needs a non-empty id');
  }
  return {
    id: fields.id,
    givenName: typeof fields.givenName === 'string' ? fields.givenName : '',
    familyName: typeof fields.familyName === 'string' ? fields.familyName : '',
  };
}

/** The name a person is shown by: given name first, family name if there is one. */
function displayName(attendee) {
  return [attendee.givenName, attendee.familyName].filter((part) => part.length > 0).join(' ');
}

/** Attendees sorted by the name they are shown by. */
function sortedByDisplayName(attendees) {
  return [...attendees].sort((a, b) => {
    const left = displayName(a);
    const right = displayName(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

module.exports = { createAttendee, displayName, sortedByDisplayName };
