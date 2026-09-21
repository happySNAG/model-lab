'use strict';

const { validationError } = require('../errors.js');

module.exports = {
  id: 'image-tag',
  code: 'IMAGE_TAG',
  appliesTo: 'image',
  check(configuration) {
    const config = configuration === undefined ? {} : configuration;
    const image = typeof config.image === 'string' ? config.image : '';
    const separator = image.lastIndexOf(':');
    const tag = separator > image.lastIndexOf('/') ? image.slice(separator + 1) : '';
    if (tag.length > 0 && tag !== 'latest') return [];
    return [validationError('image-tag', 'IMAGE_TAG', 'image',
      'image must name an explicit tag other than latest')];
  },
};
