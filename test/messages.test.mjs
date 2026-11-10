/**
 * The runtime messages of the website (website/messages.mjs): German has every English key, with the same
 * placeholders, so a language switch never shows a key or an unfilled `{name}`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGES } from '../website/messages.mjs';

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('German and English messages have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(MESSAGES.de).sort(), Object.keys(MESSAGES.en).sort());
  for (const [key, en] of Object.entries(MESSAGES.en))
    assert.deepEqual(placeholders(MESSAGES.de[key]), placeholders(en), key);
});
