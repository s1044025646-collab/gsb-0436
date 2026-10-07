import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialState, replay } from "../src/engine";
import { RawEvent, RenoState, RenoValidationError as RVE } from "../src/types";

function step(s: RenoState, ev: any) {
  return applyEvent(s, { seq: 0, ...ev });
}

test("题目主示例：4 -> 4.25 -> 阈值4窗口7 -> 8 -> 回4", () => {
  let s = initialState(4, 4);
  assert.equal(s.state, "CONGESTION_AVOIDANCE");

  let r = step(s, { type: "ack" });
  assert.equal(r.cwnd, 4.25);
  assert.equal(r.dupAcks, 0);
  assert.equal(r.state, "CONGESTION_AVOIDANCE");
  s = r;

  r = step(s, { type: "dup_ack" });
  assert.equal(r.cwnd, 4.25);
  assert.equal(r.dupAcks, 1);
  r = step(r, { type: "dup_ack" });
  assert.equal(r.cwnd, 4.25);
  assert.equal(r.dupAcks, 2);
  r = step(r, { type: "dup_ack", flightSize: 8 });
  assert.equal(r.ssthresh, 4);
  assert.equal(r.cwnd, 7);
  assert.equal(r.dupAcks, 3);
  assert.equal(r.state, "FAST_RECOVERY");
  assert.equal(r.action, "FAST_RETRANSMIT");
  s = r;

  r = step(s, { type: "dup_ack" });
  assert.equal(r.cwnd, 8);
  assert.equal(r.action, "NONE");
  assert.equal(r.state, "FAST_RECOVERY");

  r = step(r, { type: "recovery_ack" });
  assert.equal(r.cwnd, 4);
  assert.equal(r.dupAcks, 0);
  assert.equal(r.state, "CONGESTION_AVOIDANCE");
});

test("同 flightSize 超时：窗口降为 1、阈值折半、建议超时重传", () => {
  const r = step(initialState(4, 4), { type: "timeout", flightSize: 8 });
  assert.equal(r.cwnd, 1);
  assert.equal(r.ssthresh, 4);
  assert.equal(r.dupAcks, 0);
  assert.equal(r.state, "SLOW_START");
  assert.equal(r.action, "TIMEOUT_RETRANSMIT");
});

test("慢启动跨阈值：1->2->3 后按倒数增长并进入拥塞避免", () => {
  let s = initialState(1, 3);
  assert.equal(s.state, "SLOW_START");
  let r = step(s, { type: "ack" });
  assert.equal(r.cwnd, 2);
  assert.equal(r.state, "SLOW_START");
  r = step(r, { type: "ack" });
  assert.equal(r.cwnd, 3);
  assert.equal(r.state, "CONGESTION_AVOIDANCE");
  const ca = step(r, { type: "ack" });
  assert.ok(Math.abs(ca.cwnd - (3 + 1 / 3)) < 1e-6);
  assert.equal(ca.state, "CONGESTION_AVOIDANCE");
});

test("重复确认被新确认打断后重新计数", () => {
  let s = initialState(1, 10);
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack" });
  assert.equal(s.dupAcks, 2);
  s = step(s, { type: "ack" });
  assert.equal(s.dupAcks, 0);
  s = step(s, { type: "dup_ack" });
  assert.equal(s.dupAcks, 1);
  s = step(s, { type: "dup_ack" });
  assert.equal(s.dupAcks, 2);
  const r = step(s, { type: "dup_ack", flightSize: 10 });
  assert.equal(r.dupAcks, 3);
  assert.equal(r.action, "FAST_RETRANSMIT");
  assert.equal(r.ssthresh, 5);
  assert.equal(r.cwnd, 8);
});

test("快速恢复中超时：立即回到慢启动 cwnd=1", () => {
  let s = initialState(4, 4);
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack", flightSize: 20 });
  assert.equal(s.state, "FAST_RECOVERY");
  assert.equal(s.cwnd, 13);
  s = step(s, { type: "dup_ack" });
  assert.equal(s.cwnd, 14);
  const to = step(s, { type: "timeout", flightSize: 20 });
  assert.equal(to.state, "SLOW_START");
  assert.equal(to.cwnd, 1);
  assert.equal(to.ssthresh, 10);
  assert.equal(to.dupAcks, 0);
  assert.equal(to.action, "TIMEOUT_RETRANSMIT");
});

test("阈值下限 max(2, ...)：flightSize=2/3 时 ssthresh=2", () => {
  assert.equal(step(initialState(1, 1), { type: "timeout", flightSize: 2 }).ssthresh, 2);
  let s = initialState(2, 5);
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack", flightSize: 3 });
  assert.equal(s.ssthresh, 2);
  assert.equal(s.cwnd, 5);
});

test("状态冲突：恢复中普通 ack、恢复外 recovery_ack", () => {
  let s = initialState(4, 4);
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack", flightSize: 8 });
  assert.throws(() => step(s, { type: "ack" }), (e: RVE) => e.code === "EVENT_STATE_CONFLICT");
  assert.throws(
    () => step(initialState(1, 5), { type: "recovery_ack" }),
    (e: RVE) => e.code === "EVENT_STATE_CONFLICT",
  );
});

test("校验错误不改状态（无半步），第3次 dup/timeout 必须给正整数 flightSize", () => {
  const s0 = initialState(4, 4);
  assert.throws(() => step(s0, { type: "nope" }), RVE);
  let s = initialState(4, 4);
  s = step(s, { type: "dup_ack" });
  s = step(s, { type: "dup_ack" });
  assert.throws(() => step(s, { type: "dup_ack" }), (e: RVE) => e.code === "FLIGHT_SIZE_REQUIRED");
  assert.throws(() => step(s, { type: "dup_ack", flightSize: 2.5 }), (e: RVE) => e.code === "INVALID_FLIGHT_SIZE");
  assert.throws(() => step(initialState(4, 4), { type: "timeout" }), (e: RVE) => e.code === "FLIGHT_SIZE_REQUIRED");
  assert.throws(() => initialState(-1, 4), (e: RVE) => e.code === "INVALID_CWND");
  assert.throws(() => initialState(4, 2.2), RVE);
  assert.equal(s.dupAcks, 2);
  assert.equal(s.cwnd, 4);
});

test("独立状态转移表逐行核对", () => {
  const events = [
    { type: "ack" },
    { type: "dup_ack" },
    { type: "dup_ack" },
    { type: "dup_ack", flightSize: 8 },
    { type: "dup_ack" },
    { type: "recovery_ack" },
  ] as RawEvent[];
  const rows = replay(initialState(4, 4), events.map((e, i) => ({ ...e, seq: i + 1 })));
  const expected = [
    { cwnd: 4.25, ssthresh: 4, dupAcks: 0, state: "CONGESTION_AVOIDANCE", action: "NONE" },
    { cwnd: 4.25, ssthresh: 4, dupAcks: 1, state: "CONGESTION_AVOIDANCE", action: "NONE" },
    { cwnd: 4.25, ssthresh: 4, dupAcks: 2, state: "CONGESTION_AVOIDANCE", action: "NONE" },
    { cwnd: 7, ssthresh: 4, dupAcks: 3, state: "FAST_RECOVERY", action: "FAST_RETRANSMIT" },
    { cwnd: 8, ssthresh: 4, dupAcks: 4, state: "FAST_RECOVERY", action: "NONE" },
    { cwnd: 4, ssthresh: 4, dupAcks: 0, state: "CONGESTION_AVOIDANCE", action: "NONE" },
  ];
  rows.forEach((r, i) => {
    assert.equal(r.cwnd, expected[i].cwnd, `step ${i + 1} cwnd`);
    assert.equal(r.ssthresh, expected[i].ssthresh, `step ${i + 1} ssthresh`);
    assert.equal(r.dupAcks, expected[i].dupAcks, `step ${i + 1} dup`);
    assert.equal(r.state, expected[i].state, `step ${i + 1} state`);
    assert.equal(r.action, expected[i].action, `step ${i + 1} action`);
    assert.ok(r.explanation.length >= 2);
  });
});
