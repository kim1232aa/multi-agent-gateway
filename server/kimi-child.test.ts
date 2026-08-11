import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnKimiServer } from './kimi-child.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('force-kills an owned Kimi child that ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-child-'));
  const fakeKimi = join(root, 'kimi');
  await writeFile(fakeKimi, '#!/bin/sh\ntrap "" TERM\nprintf "Kimi server: http://127.0.0.1/#token=test-token\\n"\nwhile :; do sleep 1; done\n');
  await chmod(fakeKimi, 0o755);

  const child = await spawnKimiServer({ bin: fakeKimi, port: 59931 });
  try {
    await child.close();
    for (let attempt = 0; attempt < 20 && child.process.signalCode === null; attempt += 1) {
      await delay(25);
    }
    assert.equal(child.process.signalCode, 'SIGKILL');
  } finally {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  }
});
