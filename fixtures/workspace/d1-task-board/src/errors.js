'use strict';

class UnknownTaskError extends Error {
  constructor(id) {
    super(`there is no task ${id}`);
    this.name = 'UnknownTaskError';
  }
}

class UnknownMemberError extends Error {
  constructor(name) {
    super(`${name} is not a member of this team`);
    this.name = 'UnknownMemberError';
  }
}

class TaskClosedError extends Error {
  constructor(id) {
    super(`task ${id} is closed`);
    this.name = 'TaskClosedError';
  }
}

module.exports = { UnknownTaskError, UnknownMemberError, TaskClosedError };
