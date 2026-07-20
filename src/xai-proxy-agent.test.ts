import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { xaiFetchDispatcher, getXaiDispatcher, isXaiRegionGatedModel } from './providers/xai-proxy-agent.js';

test('only grok-4.5 is treated as region-gated', () => {
  assert.equal(isXaiRegionGatedModel('grok-4.5'), true);
  assert.equal(isXaiRegionGatedModel('GROK-4.5'), true);
  assert.equal(isXaiRegionGatedModel('grok-4.3'), false);
  assert.equal(isXaiRegionGatedModel('grok-imagine-video'), false);
  assert.equal(isXaiRegionGatedModel(undefined), false);
});

test('xaiFetchDispatcher returns empty for non-gated models even when proxy set', () => {
  const prev = config.xaiProxyUrl;
  config.xaiProxyUrl = 'http://user:***@127.0.0.1:7428/';
  assert.deepEqual(xaiFetchDispatcher('grok-4.3'), {});
  assert.deepEqual(xaiFetchDispatcher(undefined), {});
  config.xaiProxyUrl = prev;
});

test('xaiFetchDispatcher returns empty for grok-4.5 when no proxy configured', () => {
  const prev = config.xaiProxyUrl;
  config.xaiProxyUrl = '';
  assert.deepEqual(xaiFetchDispatcher('grok-4.5'), {});
  config.xaiProxyUrl = prev;
});

test('xaiFetchDispatcher routes grok-4.5 through a cached dispatcher when proxy set', async () => {
  const prev = config.xaiProxyUrl;
  config.xaiProxyUrl = 'http://user:***@127.0.0.1:7428/';
  const out = xaiFetchDispatcher('grok-4.5');
  assert.ok(out.dispatcher, 'dispatcher should be present for grok-4.5');
  assert.equal(getXaiDispatcher(), out.dispatcher);
  const first = out.dispatcher;
  config.xaiProxyUrl = 'http://user:***@127.0.0.1:9999/';
  const second = getXaiDispatcher();
  assert.notEqual(second, first);
  await first!.close().catch(() => {});
  await second!.close().catch(() => {});
  config.xaiProxyUrl = prev;
});
