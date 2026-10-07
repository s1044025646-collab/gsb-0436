import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RenoStore } from '../dist/src/store.js';
import { RenoError } from '../dist/src/types.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reno-test-'));
  dbPath = join(dir, 'reno.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('原子批次：非法事件整批回滚，窗口不会先改一半', () => {
  const store = new RenoStore(dbPath);
  store.createModel('m1', 4, 4);
  assert.throws(
    () =>
      store.submitBatch(
        'm1',
        'r-bad',
        null,
        [{ type: 'dup_ack' }, { type: 'dup_ack' }, { type: 'recovery_ack' }],
      ),
    (e: RenoError) => e.code === 'INVALID_STATE',
  );
  const s = store.getCurrentState('m1');
  assert.deepEqual(s, { cwnd: 4, ssthresh: 4, dupCount: 0, phase: 'congestion_avoidance' });
  assert.deepEqual(store.getSteps('m1'), []);
  store.close();
});

test('重复 requestId 不重复处理事件且原样返回；不同载荷冲突', () => {
  const store = new RenoStore(dbPath);
  store.createModel('m1', 4, 4);
  const payload = [{ type: 'ack' }];
  const r1 = store.submitBatch('m1', 'dup-r', null, payload);
  assert.equal(r1.deduplicated, false);
  const r2 = store.submitBatch('m1', 'dup-r', 1, payload);
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.version, 1);
  assert.deepEqual(r2.steps.map((x) => x.seq), [1]);
  const model = store.getModel('m1')!;
  assert.equal(model.event_count, 1);
  assert.equal(model.version, 1);
  assert.throws(
    () => store.submitBatch('m1', 'dup-r', null, [{ type: 'dup_ack' }]),
    (e: RenoError) => e.code === 'REQUEST_ID_CONFLICT',
  );
  store.close();
});

test('旧版本提交冲突（expectedVersion 过期）', () => {
  const store = new RenoStore(dbPath);
  store.createModel('m1', 2, 8);
  store.submitBatch('m1', 'r1', 0, [{ type: 'ack' }]);
  assert.throws(
    () => store.submitBatch('m1', 'r2', 0, [{ type: 'ack' }]),
    (e: RenoError) => e.code === 'VERSION_CONFLICT',
  );
  const r3 = store.submitBatch('m1', 'r3', 1, [{ type: 'ack' }]);
  assert.equal(r3.version, 2);
  store.close();
});

test('重启后恢复窗口与重复确认计数（重启不解释为超时）', () => {
  let store = new RenoStore(dbPath);
  store.createModel('m1', 4, 4);
  store.submitBatch('m1', 'r1', 0, [
    { type: 'dup_ack' },
    { type: 'dup_ack' },
    { type: 'dup_ack', flightSize: 8 },
  ]);
  store.close();
  assert.ok(existsSync(dbPath));

  store = new RenoStore(dbPath);
  const s = store.getCurrentState('m1');
  assert.deepEqual(s, { cwnd: 7, ssthresh: 4, dupCount: 3, phase: 'fast_recovery' });
  const cont = store.submitBatch('m1', 'r2', 1, [{ type: 'dup_ack' }, { type: 'recovery_ack' }]);
  assert.deepEqual(
    cont.steps.map((x) => ({ cwnd: x.cwnd, dup: x.dupCount, phase: x.phase })),
    [
      { cwnd: 8, dup: 4, phase: 'fast_recovery' },
      { cwnd: 4, dup: 0, phase: 'congestion_avoidance' },
    ],
  );
  store.close();
});

test('逐条提交、分批提交产生一致结果', () => {
  const events = [
    { type: 'ack' },
    { type: 'dup_ack' },
    { type: 'dup_ack' },
    { type: 'dup_ack', flightSize: 8 },
    { type: 'dup_ack' },
    { type: 'recovery_ack' },
  ];

  const a = new RenoStore(join(dir, 'a.db'));
  a.createModel('m', 4, 4);
  events.forEach((e, i) => a.submitBatch('m', `e${i}`, null, [e]));
  const tailA = a.getCurrentState('m');

  const b = new RenoStore(join(dir, 'b.db'));
  b.createModel('m', 4, 4);
  b.submitBatch('m', 'half1', 0, events.slice(0, 3));
  b.submitBatch('m', 'half2', 1, events.slice(3));
  const tailB = b.getCurrentState('m');

  const c = new RenoStore(join(dir, 'c.db'));
  c.createModel('m', 4, 4);
  c.submitBatch('m', 'all', 0, events);
  const tailC = c.getCurrentState('m');

  assert.deepEqual(tailA, tailB);
  assert.deepEqual(tailB, tailC);
  assert.deepEqual(a.getSteps('m').map((s) => s.cwnd), c.getSteps('m').map((s) => s.cwnd));
  a.close();
  b.close();
  c.close();
});

test('步骤分页与单步计算依据读取；原始事件保留', () => {
  const store = new RenoStore(dbPath);
  store.createModel('m1', 2, 8);
  store.submitBatch('m1', 'r1', 0, Array.from({ length: 5 }, () => ({ type: 'ack' })));
  const page1 = store.getSteps('m1', { limit: 2, offset: 0 });
  const page2 = store.getSteps('m1', { limit: 2, offset: 2 });
  assert.deepEqual(page1.map((s) => s.seq), [1, 2]);
  assert.deepEqual(page2.map((s) => s.seq), [3, 4]);
  const step3 = store.getStep('m1', 3)!;
  assert.equal(step3.explanation.formula, 'cwnd_new = cwnd_old + 1');
  assert.equal(step3.before.cwnd, 4);
  assert.equal(step3.cwnd, 5);
  const exported = store.export('m1');
  assert.equal(exported.events.length, 5);
  assert.deepEqual(exported.initial, { cwnd: 2, ssthresh: 8 });
  store.close();
});

test('批次长度与累计上限', () => {
  const store = new RenoStore(dbPath);
  store.createModel('m1', 2, 8);
  assert.throws(
    () => store.submitBatch('m1', 'big', 0, Array.from({ length: 201 }, () => ({ type: 'ack' }))),
    (e: RenoError) => e.code === 'BATCH_TOO_LARGE',
  );
  assert.throws(() => store.submitBatch('m1', 'empty', 0, []), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  store.close();
});

test('存储失败路径：只读/坏目录抛 STORAGE_ERROR 而非崩溃', () => {
  const blockedDir = join(dir, 'afile');
  writeFileSync(blockedDir, 'x');
  assert.throws(
    () => new RenoStore(join(blockedDir, 'reno.db')),
    (e: RenoError) => e.code === 'STORAGE_ERROR',
  );
});

