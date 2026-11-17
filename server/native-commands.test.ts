import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyForms,
  classifyCommand,
  listClaudeCommands,
  listCodexCommands,
  listDshCommands,
  listPiCommands,
  withForm,
  COMMAND_PINS,
} from './native-commands.js';
import type { NativeCommand } from './types.js';

const cmd = (over: Partial<NativeCommand> = {}): NativeCommand => ({
  name: 'demo',
  description: 'demo',
  kind: 'prompt',
  ...over,
});

test('classifyCommand reads who handles a command, not just its name', () => {
  const gateway = new Set(['compact']);
  assert.equal(classifyCommand(cmd({ kind: 'client' }), gateway), 'client');
  assert.equal(classifyCommand(cmd({ name: 'compact' }), gateway), 'gateway');
  assert.equal(classifyCommand(cmd({ terminalOnly: true }), gateway), 'terminal');
  assert.equal(classifyCommand(cmd({ source: 'extension' }), gateway), 'cli');
  assert.equal(classifyCommand(cmd({ builtin: true }), gateway), 'cli');
  assert.equal(classifyCommand(cmd({ path: '/x/SKILL.md' }), gateway), 'cli');
  // A row from the CLI's own handshake catalog is the CLI's to run, not ours to guess.
  assert.equal(classifyCommand(cmd(), gateway), 'cli');
});

test('withForm pins the catalog to a CLI version and only verifies a real match', () => {
  const pinned = withForm(cmd(), 'cli', 'claude');
  assert.equal(pinned.form, 'cli');
  assert.equal(pinned.pinnedVersion, COMMAND_PINS.claude);
  assert.equal(pinned.verified, undefined, 'no actual version means unverified, not verified');

  assert.equal(withForm(cmd(), 'cli', 'claude', '2.1.325').verified, true);
  assert.equal(withForm(cmd(), 'cli', 'claude', '2.1.325.1').verified, true);
  assert.equal(withForm(cmd(), 'cli', 'claude', '2.1.300').verified, false);
});

test('withForm never overwrites a form a source already decided', () => {
  assert.equal(withForm(cmd({ form: 'terminal' }), 'cli', 'pi').form, 'terminal');
});

test('applyForms labels every row and leaves the input untouched', () => {
  const input = [cmd({ name: 'new', kind: 'client' }), cmd({ name: 'compact' }), cmd({ name: 'x', source: 'extension' })];
  const out = applyForms(input, new Set(['compact']), 'codex');
  assert.deepEqual(out.map((c) => c.form), ['client', 'gateway', 'cli']);
  assert.equal(input[0]!.form, undefined);
});

test('real catalogs carry forms; terminal-only rows stay out of the web catalog', () => {
  const codex = listCodexCommands([]);
  assert.equal(codex.find((c) => c.name === 'new')?.form, 'client');
  assert.equal(codex.find((c) => c.name === 'compact')?.form, 'gateway');

  const dsh = listDshCommands([]);
  assert.equal(dsh.find((c) => c.name === 'new')?.form, 'client');

  const pi = listPiCommands([]);
  assert.equal(pi.find((c) => c.name === 'new')?.form, 'client');

  const claude = listClaudeCommands(
    [
      { name: 'doctor', description: 'Check install health', terminalOnly: true },
      { name: 'compact', description: 'Compact' },
    ],
    ['doctor'],
  );
  assert.equal(claude.find((c) => c.name === 'doctor')?.form, 'terminal');
  assert.equal(claude.find((c) => c.name === 'compact')?.form, 'cli');
  // color 走网关的 apply_flag_settings(官方 control 通道),不再是终端独占;
  // fast 同样改为网关命令。
  assert.equal(claude.find((c) => c.name === 'color')?.form, 'gateway');
  assert.equal(claude.find((c) => c.name === 'fast')?.form, 'gateway');
  // CLI 目录若把实现过的命令标成 terminalOnly,网关实现优先。
  const overridden = listClaudeCommands([{ name: 'fast', description: 'Toggle fast mode', terminalOnly: true }], ['fast']);
  assert.equal(overridden.find((c) => c.name === 'fast')?.form, 'gateway');
  assert.ok(claude.every((c) => c.pinnedVersion === COMMAND_PINS.claude));
});
