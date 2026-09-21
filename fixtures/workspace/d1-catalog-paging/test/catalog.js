'use strict';

// The catalogue every suite pages through, added in the order a real catalogue grows: not by rank
// and not by id.
const PRODUCTS = [
  { id: 'p-07', name: 'Lantern', category: 'outdoor', rank: 90, stock: 4 },
  { id: 'p-02', name: 'Kettle', category: 'kitchen', rank: 70, stock: 12 },
  { id: 'p-11', name: 'Hammock', category: 'outdoor', rank: 70, stock: 0 },
  { id: 'p-04', name: 'Colander', category: 'kitchen', rank: 70, stock: 7 },
  { id: 'p-09', name: 'Tent', category: 'outdoor', rank: 50, stock: 2 },
  { id: 'p-01', name: 'Whisk', category: 'kitchen', rank: 50, stock: 30 },
  { id: 'p-12', name: 'Compass', category: 'outdoor', rank: 40, stock: 9 },
  { id: 'p-05', name: 'Ladle', category: 'kitchen', rank: 30, stock: 5 },
  { id: 'p-03', name: 'Trowel', category: 'garden', rank: 30, stock: 11 },
  { id: 'p-10', name: 'Rake', category: 'garden', rank: 30, stock: 0 },
  { id: 'p-06', name: 'Seed tray', category: 'garden', rank: 10, stock: 40 },
  { id: 'p-08', name: 'Sieve', category: 'kitchen', rank: 10, stock: 3 },
];

const LISTING_ORDER = ['p-07', 'p-02', 'p-04', 'p-11', 'p-01', 'p-09', 'p-12', 'p-03', 'p-05', 'p-10', 'p-06', 'p-08'];

module.exports = { PRODUCTS, LISTING_ORDER };
