'use strict';

/** The rooms this building has, and how many people each one seats. */
const ROOMS = [
  { id: 'oak', name: 'Oak', seats: 4 },
  { id: 'elm', name: 'Elm', seats: 8 },
  { id: 'ash', name: 'Ash', seats: 20 },
];

function roomByID(id) {
  const found = ROOMS.find((room) => room.id === id);
  if (found === undefined) throw new RangeError(`no such room: ${id}`);
  return found;
}

/** The rooms that seat at least this many people, smallest first. */
function roomsSeating(people) {
  return ROOMS.filter((room) => room.seats >= people).sort((a, b) => a.seats - b.seats);
}

function describeRoom(room) {
  return `${room.name} (seats ${room.seats})`;
}

module.exports = { ROOMS, roomByID, roomsSeating, describeRoom };
