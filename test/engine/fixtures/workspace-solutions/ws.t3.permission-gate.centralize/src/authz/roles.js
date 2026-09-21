'use strict';

const ROLES = ['reader', 'writer', 'curator', 'admin'];

const GRANTS = {
  reader: ['read'],
  writer: ['read', 'update'],
  curator: ['read', 'update', 'delete', 'export', 'archive'],
  admin: ['read', 'update', 'delete', 'export', 'archive'],
};

const NARROWED_BY_CONFIDENTIALITY = ['reader', 'writer'];
const NARROWED_BY_LOCK = ['writer'];

module.exports = { ROLES, GRANTS, NARROWED_BY_CONFIDENTIALITY, NARROWED_BY_LOCK };
