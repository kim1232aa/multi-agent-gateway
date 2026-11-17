import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effortArgument,
  levelsFor,
  supportsUltracode,
  THINKING_PROFILES,
  thinkingProfileDto,
  ultracodeSettings,
  versionAtLeast,
} from './thinking-levels.js';

test('versionAtLeast compares numerically, not as strings', () => {
  assert.equal(versionAtLeast('2.1.325', '2.1.284'), true);
  assert.equal(versionAtLeast('2.1.284', '2.1.284'), true);
  assert.equal(versionAtLeast('2.1.9', '2.1.284'), false, '9 < 284 numerically');
  assert.equal(versionAtLeast('2.2.0', '2.1.284'), true);
  assert.equal(versionAtLeast(undefined, '2.1.284'), false);
});

test('ultracode is a switch from 2.1.284 on, never an effort level', () => {
  assert.equal(supportsUltracode('claude', '2.1.325'), true);
  assert.equal(supportsUltracode('claude', '2.1.283'), false);
  assert.equal(supportsUltracode('codex', '0.169.0'), false, 'only Claude has it');

  // `claude --help` 2.1.325 lists (low, medium, high, xhigh, max): ultracode is not one.
  assert.ok(!THINKING_PROFILES.claude.levels.includes('ultracode'));
  assert.equal(effortArgument('claude', 'ultracode'), undefined);
  assert.equal(effortArgument('claude', 'xhigh'), 'xhigh');
  assert.equal(effortArgument('claude', 'bogus'), undefined);

  assert.deepEqual(ultracodeSettings('claude', 'ultracode', '2.1.325'), { ultracode: true });
  assert.equal(ultracodeSettings('claude', 'ultracode', '2.1.283'), undefined);
  assert.equal(ultracodeSettings('claude', 'high', '2.1.325'), undefined);
});

test('effortArgument drops the pseudo-levels that are not real levels', () => {
  for (const pseudo of ['off', 'on', 'auto', '', undefined]) {
    assert.equal(effortArgument('claude', pseudo), undefined);
  }
  assert.equal(effortArgument('claude', 'medium'), 'medium');
});

test('levelsFor prefers what the model reports and never guesses without a version', () => {
  assert.deepEqual(levelsFor('claude', '2.1.325', ['low', 'high']), { levels: ['low', 'high'], verified: true });
  assert.deepEqual(levelsFor('claude', '2.1.325'), { levels: THINKING_PROFILES.claude.levels, verified: true });
  assert.deepEqual(levelsFor('claude', '2.1.300'), { levels: THINKING_PROFILES.claude.levels, verified: false });
  assert.equal(levelsFor('claude', undefined), null, 'no version means unverified, not a guess');
});

test('the dto carries the pin and the ultracode availability', () => {
  const dto = thinkingProfileDto('claude', '2.1.325');
  assert.equal(dto.pinned_version, '2.1.325');
  assert.equal(dto.verified, true);
  assert.equal(dto.ultracode, true);
  assert.deepEqual(dto.levels, THINKING_PROFILES.claude.levels);

  const old = thinkingProfileDto('claude', '2.1.200');
  assert.equal(old.verified, false);
  assert.equal(old.ultracode, false);

  const codex = thinkingProfileDto('codex', '0.169.0');
  assert.equal(codex.ultracode, undefined, 'no ultracode concept outside Claude');
});
