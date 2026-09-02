import assert from 'node:assert/strict';
import test from 'node:test';
import { isKimiApiPath, isKimiWsPath } from './kimi-proxy.js';

test('treats /api/v1 and /api/v2 REST paths as Kimi API routes, but not the WS endpoint', () => {
  assert.equal(isKimiApiPath('/api/v1/sessions'), true);
  assert.equal(isKimiApiPath('/api/v2/sessions?limit=3'), true);
  assert.equal(isKimiApiPath('/api/v2'), true);
  assert.equal(isKimiApiPath('/api/v1/ws'), false);
  assert.equal(isKimiWsPath('/api/v1/ws'), true);
  assert.equal(isKimiApiPath('/assets/index.js'), false);
  assert.equal(isKimiApiPath('/v1/remote'), true);
  assert.equal(isKimiApiPath('/v1/remote/devices'), true);
  assert.equal(isKimiApiPath('/v1/remote/devices?limit=3'), true);
  assert.equal(isKimiApiPath('/v1/remotely'), false);
});
