'use strict';

const everything = () => true;

function inCategory(category) {
  return (product) => product.category === category;
}

function inStock(product) {
  return product.stock > 0;
}

module.exports = { everything, inCategory, inStock };
