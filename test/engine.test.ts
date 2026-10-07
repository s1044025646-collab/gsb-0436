import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialState, replay } from '../dist/src/engine.js';
import { RenoError } from '../dist/src/types.js';

/**
 * 独立状态转移表：不依赖最终单个数字，逐步核对
 * (初态, 事件) => { cwnd, ssthresh, dup, phase, action }。
 */
const TABLE: Array<{
  name: string;
  init: [number, number];
  events: Array<Record<string, unknown>>;
  expect: Array<{ cwnd: number; ssthresh: number; dup: number; phase: string; action?: string }>;
}> = [
  {
    name: '题目主例：4.25 -> 阈值4窗口7 -> 8 -> 回4',
    init: [4, 4],
    events: [
      { type: 'ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack', flightSize: 8 },
      { type: 'dup_ack' },
      { type: 'recovery_ack' },
    ],
    expect: [
      { cwnd: 4.25, ssthresh: 4, dup: 0, phase: 'congestion_avoidance' },
      { cwnd: 4.25, ssthresh: 4, dup: 1, phase: 'congestion_avoidance' },
      { cwnd: 4.25, ssthresh: 4, dup: 2, phase: 'congestion_avoidance' },
      { cwnd: 7, ssthresh: 4, dup: 3, phase: 'fast_recovery', action: 'fast_retransmit' },
      { cwnd: 8, ssthresh: 4, dup: 4, phase: 'fast_recovery' },
      { cwnd: 4, ssthresh: 4, dup: 0, phase: 'congestion_avoidance' },
    ],
  },
  {
    name: '慢启动跨阈值：2/4 加一到 3 仍慢启动，到 4 转拥塞避免',
    init: [2, 4],
    events: [{ type: 'ack' }, { type: 'ack' }, { type: 'ack' }],
    expect: [
      { cwnd: 3, ssthresh: 4, dup: 0, phase: 'slow_start' },
      { cwnd: 4, ssthresh: 4, dup: 0, phase: 'congestion_avoidance' },
      { cwnd: 4.25, ssthresh: 4, dup: 0, phase: 'congestion_avoidance' },
    ],
  },
  {
    name: '重复确认被新普通确认打断，计数归零后重新累计',
    init: [4, 8],
    events: [
      { type: 'dup_ack' },
      { type: 'dup_ack' },
      { type: 'ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack', flightSize: 10 },
    ],
    expect: [
      { cwnd: 4, ssthresh: 8, dup: 1, phase: 'slow_start' },
      { cwnd: 4, ssthresh: 8, dup: 2, phase: 'slow_start' },
      { cwnd: 5, ssthresh: 8, dup: 0, phase: 'slow_start' },
      { cwnd: 5, ssthresh: 8, dup: 1, phase: 'slow_start' },
      { cwnd: 5, ssthresh: 8, dup: 2, phase: 'slow_start' },
      { cwnd: 8, ssthresh: 5, dup: 3, phase: 'fast_recovery', action: 'fast_retransmit' },
    ],
  },
  {
    name: '快速恢复中超时：窗口降1、阈值折半、退出恢复',
    init: [4, 4],
    events: [
      { type: 'dup_ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack', flightSize: 8 },
      { type: 'timeout', flightSize: 6 },
    ],
    expect: [
      { cwnd: 4, ssthresh: 4, dup: 1, phase: 'congestion_avoidance' },
      { cwnd: 4, ssthresh: 4, dup: 2, phase: 'congestion_avoidance' },
      { cwnd: 7, ssthresh: 4, dup: 3, phase: 'fast_recovery', action: 'fast_retransmit' },
      { cwnd: 1, ssthresh: 3, dup: 0, phase: 'slow_start', action: 'timeout_retransmit' },
    ],
  },
  {
    name: 'flightSize 很小（3）时阈值下限为 2',
    init: [4, 4],
    events: [{ type: 'timeout', flightSize: 3 }],
    expect: [{ cwnd: 1, ssthresh: 2, dup: 0, phase: 'slow_start', action: 'timeout_retransmit' }],
  },
  {
    name: '恢复后 cwnd==ssthresh 进入拥塞避免而非慢启动',
    init: [8, 8],
    events: [
      { type: 'dup_ack' },
      { type: 'dup_ack' },
      { type: 'dup_ack', flightSize: 20 },
      { type: 'recovery_ack' },
    ],
    expect: [
      { cwnd: 8, ssthresh: 8, dup: 1, phase: 'congestion_avoidance' },
      { cwnd: 8, ssthresh: 8, dup: 2, phase: 'congestion_avoidance' },
      { cwnd: 13, ssthresh: 10, dup: 3, phase: 'fast_recovery', action: 'fast_retransmit' },
      { cwnd: 10, ssthresh: 10, dup: 0, phase: 'congestion_avoidance' },
    ],
  },
];

test('状态转移表逐行核对', () => {
  for (const row of TABLE) {
    const steps = replay(row.init[0], row.init[1], row.events);
    assert.equal(steps.length, row.expect.length, `${row.name}: 步数`);
    steps.forEach((s, i) => {
      const e = row.expect[i];
      assert.deepEqual(
        { cwnd: s.cwnd, ssthresh: s.ssthresh, dup: s.dupCount, phase: s.phase, action: s.action },
        { cwnd: e.cwnd, ssthresh: e.ssthresh, dup: e.dup, phase: e.phase, action: e.action ?? 'none' },
        `${row.name} 第 ${i + 1} 步`,
      );
      assert.deepEqual(
        { cwnd: s.before.cwnd, ssthresh: s.before.ssthresh, dup: s.before.dupCount, phase: s.before.phase },
        i === 0
          ? (() => {
              const st = initialState(row.init[0], row.init[1]);
              return { cwnd: st.cwnd, ssthresh: st.ssthresh, dup: st.dupCount, phase: st.phase };
            })()
          : {
              cwnd: row.expect[i - 1].cwnd,
              ssthresh: row.expect[i - 1].ssthresh,
              dup: row.expect[i - 1].dup,
              phase: row.expect[i - 1].phase,
            },
        `${row.name} 第 ${i + 1} 步 before 与上一步一致`,
      );
    });
  }
});

test('非法状态错误：恢复中普通 ack、恢复外 recovery_ack、第三次 dup_ack 缺 flightSize', () => {
  let st = initialState(4, 4);
  const feed = (ev: Record<string, unknown>) => {
    const s = applyEvent(st, ev, st.dupCount + 1);
    st = { cwnd: s.cwnd, ssthresh: s.ssthresh, dupCount: s.dupCount, phase: s.phase };
  };
  feed({ type: 'dup_ack' });
  feed({ type: 'dup_ack' });
  feed({ type: 'dup_ack', flightSize: 8 });
  assert.throws(() => applyEvent(st, { type: 'ack' }, 4), (e) => (e as RenoError).code === 'INVALID_STATE');

  const st2 = initialState(2, 8);
  assert.throws(() => applyEvent(st2, { type: 'recovery_ack' }, 1), (e) => (e as RenoError).code === 'INVALID_STATE');

  let st3 = initialState(4, 4);
  const d1 = applyEvent(st3, { type: 'dup_ack' }, 1);
  st3 = { cwnd: d1.cwnd, ssthresh: d1.ssthresh, dupCount: d1.dupCount, phase: d1.phase };
  const d2 = applyEvent(st3, { type: 'dup_ack' }, 2);
  st3 = { cwnd: d2.cwnd, ssthresh: d2.ssthresh, dupCount: d2.dupCount, phase: d2.phase };
  assert.throws(() => applyEvent(st3, { type: 'dup_ack' }, 3), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => applyEvent(st3, { type: 'timeout' }, 3), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => applyEvent(st3, { type: 'timeout', flightSize: 2.5 }, 3), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
});

test('参数严格校验：初态、事件类型、flightSize 范围', () => {
  assert.throws(() => replay(0, 4, []), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => replay(4, -1, []), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => replay(4, 4, [{ type: 'nack' }]), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => replay(4, 4, [{ type: 'dup_ack', flightSize: 0 }]), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => replay(4, 4, [{ type: 'dup_ack', flightSize: 1.5 }]), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
  assert.throws(() => replay(4, 4, ['not-an-object']), (e) => (e as RenoError).code === 'VALIDATION_ERROR');
});

test('非法事件位于批次中间时不返回任何半成品', () => {
  assert.throws(
    () => replay(4, 4, [{ type: 'ack' }, { type: 'recovery_ack' }, { type: 'ack' }]),
    (e: RenoError) => e.code === 'INVALID_STATE' && e.eventIndex === 1,
  );
});


