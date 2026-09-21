'use strict';

// The import file every end-to-end check in this suite uses. One file, so the checks below are
// talking about the same six rows.

const PEOPLE = [
  'id,email,name,city,age',
  '1,ada@example.com,Ada Lovelace,London,36',
  '2,,Nobody,Paris,20',
  '3,GRACE@example.com ,Grace Hopper,New York,45',
  '4,ada@example.com,Ada L.,Cambridge,37',
  '5,alan@example.com,,Wilmslow,41',
  '6,grace@EXAMPLE.com,Grace H.,Arlington,46',
  '',
].join('\n');

module.exports = { PEOPLE };
