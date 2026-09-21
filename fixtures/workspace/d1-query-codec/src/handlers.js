'use strict';

/** The issues a listing request asks for, described rather than fetched. */
function listIssues(parameters) {
  const filter = parameters.filter ?? {};
  return {
    page: Number(parameters.page ?? '1'),
    status: typeof filter.status === 'string' ? filter.status : 'any',
    labels: Array.isArray(filter.labels) ? filter.labels : [],
    assignee: typeof filter.assignee === 'string' ? filter.assignee : null,
  };
}

function showIssue(parameters, match) {
  return { id: match.id, tab: parameters.tab ?? 'conversation' };
}

module.exports = { listIssues, showIssue };
