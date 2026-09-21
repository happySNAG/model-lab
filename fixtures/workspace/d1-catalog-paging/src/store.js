'use strict';

/**
 * The catalogue, in memory: products `{ id, name, category, rank, stock }`, in the order they were
 * added. Nothing about listing order lives here.
 */
function createStore(products = []) {
  return { products: products.map((product) => ({ ...product })) };
}

function insert(store, product) {
  if (store.products.some((existing) => existing.id === product.id)) {
    throw new Error(`a product with id ${product.id} is already in the catalogue`);
  }
  store.products.push({ ...product });
}

function remove(store, id) {
  const index = store.products.findIndex((product) => product.id === id);
  if (index !== -1) store.products.splice(index, 1);
}

/** Every product, as a fresh array. */
function all(store) {
  return store.products.map((product) => ({ ...product }));
}

module.exports = { createStore, insert, remove, all };
