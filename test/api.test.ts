import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../dist/src/server.js';
import { RenoStore } from '../dist/src/store.js';
import { Server } from 'node:http';

let base: string;
let server: Server;

before(async () => {
  const store = new RenoStore(':memory:');
  server = createApp(store);
  await new Promise<void>((resolveFn) => server.listen(0, '127.0.0.1', () => resolveFn()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(
  async () =>
    new Promise<void>((resolveFn) => {
      server.close(() => resolveFn());
    }),
);

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('API 全链路与错误码', async () => {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.limits.maxBatchEvents, 200);

  const created = await api('POST', '/models', { id: 'demo', initialCwnd: 4, initialSsthresh: 4 });
  assert.equal(created.status, 201);
  assert.equal(created.json.version, 0);

  const bad = await api('POST', '/models', { id: 'bad', initialCwnd: -1, initialSsthresh: 4 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'VALIDATION_ERROR');

  const dupModel = await api('POST', '/models', { id: 'demo', initialCwnd: 4, initialSsthresh: 4 });
  assert.equal(dupModel.status, 409);
  assert.equal(dupModel.json.error.code, 'MODEL_EXISTS');

  const r1 = await api('POST', '/models/demo/events', {
    requestId: 'req-1',
    expectedVersion: 0,
    events: [
      { type: 'ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack', flightSize: 8 },
      { type: 'dup_ack' },
      { type: 'recovery_ack' },
    ],
  });
  assert.equal(r1.status, 201);
  assert.deepEqual(
    r1.json.steps.map((s: any) => s.cwnd),
    [4.25, 4.25, 4.25, 7, 8, 4],
  );

  const replay = await api('GET', '/models/demo/replay');
  assert.equal(replay.json.steps.length, 6);

  const page = await api('GET', '/models/demo/events?limit=2&offset=2');
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.steps.map((s: any) => s.seq), [3, 4]);

  const step4 = await api('GET', '/models/demo/steps/4');
  assert.equal(step4.status, 200);
  assert.equal(step4.json.action, 'fast_retransmit');
  assert.equal(step4.json.explanation.detail.ssthresh_new, 4);

  const missing = await api('GET', '/models/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'MODEL_NOT_FOUND');

  const stepMissing = await api('GET', '/models/demo/steps/99');
  assert.equal(stepMissing.status, 404);
  assert.equal(stepMissing.json.error.code, 'STEP_NOT_FOUND');
});

test('幂等重放、版本冲突与非法批次回滚（HTTP）', async () => {
  await api('POST', '/models', { id: 'idem', initialCwnd: 2, initialSsthresh: 8 });

  const payload = { requestId: 'id1', expectedVersion: 0, events: [{ type: 'ack' }] };
  const first = await api('POST', '/models/idem/events', payload);
  assert.equal(first.status, 201);
  const again = await api('POST', '/models/idem/events', payload);
  assert.equal(again.status, 200);
  assert.equal(again.json.deduplicated, true);

  const conflict = await api('POST', '/models/idem/events', {
    requestId: 'id2',
    expectedVersion: 0,
    events: [{ type: 'ack' }],
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'VERSION_CONFLICT');

  const badBatch = await api('POST', '/models/idem/events', {
    requestId: 'id3',
    expectedVersion: 1,
    events: [{ type: 'ack' }, { type: 'recovery_ack' }],
  });
  assert.equal(badBatch.status, 400);
  assert.equal(badBatch.json.error.code, 'INVALID_STATE');
  assert.equal(badBatch.json.error.eventIndex, 1);

  const state = await api('GET', '/models/idem');
  assert.equal(state.json.version, 1);
  assert.equal(state.json.eventCount, 1);

  const exportRes = await api('GET', '/models/idem/export');
  assert.equal(exportRes.status, 200);
  assert.deepEqual(exportRes.json.events, [{ type: 'ack' }]);
});



