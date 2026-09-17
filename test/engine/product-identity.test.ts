// Cernum · the product's own name, and the rename's back-compatibility.

import { describe, expect, it } from 'vitest';
import { PRODUCT, TAGLINE, TERMINAL_COMMAND, environmentOverride } from '../../src/shared/product';

describe('the product names itself once', () => {
  it('is Cernum, and reads that from packaging rather than a literal in source', () => {
    expect(PRODUCT.name).toBe('Cernum');
    expect(PRODUCT.slug).toBe('cernum');
    expect(TERMINAL_COMMAND).toBe('cernum');
  });

  it('carries the tagline', () => {
    expect(TAGLINE).toBe('Test. Discern. Decide.');
  });
});

describe('the rename does not break a script somebody already wrote', () => {
  it('prefers the CERNUM_ name', () => {
    expect(environmentOverride('CAMPAIGN_ROOT', { CERNUM_CAMPAIGN_ROOT: '/new' })).toBe('/new');
  });

  it('still honours the pre-rename MODEL_LAB_ name', () => {
    expect(environmentOverride('CAMPAIGN_ROOT', { MODEL_LAB_CAMPAIGN_ROOT: '/old' })).toBe('/old');
    expect(environmentOverride('USER_DATA', { MODEL_LAB_USER_DATA: '/old' })).toBe('/old');
    expect(environmentOverride('OLLAMA_ENDPOINT', { MODEL_LAB_OLLAMA_ENDPOINT: 'http://127.0.0.1:11435' }))
      .toBe('http://127.0.0.1:11435');
  });

  it('lets the new name win when both are set, rather than picking silently', () => {
    expect(environmentOverride('USER_DATA', { CERNUM_USER_DATA: '/new', MODEL_LAB_USER_DATA: '/old' })).toBe('/new');
  });

  it('treats an empty value as unset, so an exported-but-blank variable is not a path', () => {
    expect(environmentOverride('USER_DATA', { CERNUM_USER_DATA: '', MODEL_LAB_USER_DATA: '/old' })).toBe('/old');
    expect(environmentOverride('USER_DATA', {})).toBeUndefined();
  });
});
