import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, StoreConflictError, MAX_BATCH_EVENTS } from "../src/storage";
import { RawEvent } from "../src/types";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reno-test-"));
  return path.join(dir, "test.db");
}

function ev(type: string, flightSize?: number): RawEvent {
  return { seq: 0, type: type as RawEvent["type"], ...(flightSize ? { flightSize } : {}) };
}

test("原子提交：非法事件整批回滚，不留半步", () => {
  const db = tmpDb();
  const store = new Store(db);
  store.createModel("m", 4, 4);
  assert.throws(() =>
    store.appendEvents(
      "m",
      [ev("ack"), ev("recovery_ack") /* 恢复外非法 */],
      "r1",
      0,
    ),
  );
  const m = store.getModelOrThrow("m");
  assert.equal(m.version, 0);
  assert.equal(m.cwnd, 4);
  assert.equal(store.getSteps("m").length, 0);
  // 请求记录也回滚，可用同一 requestId 重试
  const ok = store.appendEvents("m", [ev("ack")], "r1", 0);
  assert.equal(ok.model.version, 1);
  assert.equal(ok.model.cwnd, 4.25);
  store.close();
});

test("重复 requestId 幂等：不重复处理事件，返回既有结果", () => {
  const db = tmpDb();
  const store = new Store(db);
  store.createModel("m", 1, 10);
  const first = store.appendEvents("m", [ev("ack"), ev("ack")], "dup-req", 0);
  assert.equal(first.deduplicated, false);
  assert.equal(first.model.version, 2);
  const again = store.appendEvents("m", [ev("ack"), ev("ack")], "dup-req", 0);
  assert.equal(again.deduplicated, true);
  assert.equal(again.model.version, 2);
  assert.equal(store.getSteps("m").length, 2);
  // 同一 requestId 但版本不一致 -> 冲突
  assert.throws(
    () => store.appendEvents("m", [ev("ack")], "dup-req", 99),
    (e: Error) => e instanceof StoreConflictError && e.code === "VERSION_CONFLICT",
  );
  store.close();
});

test("旧版本提交冲突（乐观并发）", () => {
  const db = tmpDb();
  const store = new Store(db);
  store.createModel("m", 1, 10);
  store.appendEvents("m", [ev("ack")], "r1", 0);
  assert.throws(
    () => store.appendEvents("m", [ev("ack")], "r2", 0),
    (e: Error) => e instanceof StoreConflictError && e.code === "VERSION_CONFLICT",
  );
  store.close();
});

test("逐条提交 == 分批提交 == 重启后续交（结果一致）", () => {
  const db1 = tmpDb();
  let store = new Store(db1);
  store.createModel("m", 4, 4);
  const seq = [ev("ack"), ev("dup_ack"), ev("dup_ack"), ev("dup_ack", 8), ev("dup_ack"), ev("recovery_ack")];
  seq.forEach((e, i) => store.appendEvents("m", [e], `one-${i}`, i));
  const afterOneByOne = store.getSteps("m").map((s) => [s.cwnd, s.ssthresh, s.dupAcks, s.state]);
  store.close();

  const db2 = tmpDb();
  store = new Store(db2);
  store.createModel("m", 4, 4);
  store.appendEvents("m", seq.slice(0, 3), "b1", 0);
  store.appendEvents("m", seq.slice(3), "b2", 3);
  const afterBatch = store.getSteps("m").map((s) => [s.cwnd, s.ssthresh, s.dupAcks, s.state]);
  assert.deepEqual(afterBatch, afterOneByOne);
  const finalBefore = store.getModelOrThrow("m");
  store.close();

  // 重启：重新打开同一数据库，窗口与 dup 计数恢复，并可继续提交
  store = new Store(db2);
  const restored = store.getModelOrThrow("m");
  assert.equal(restored.version, finalBefore.version);
  assert.equal(restored.cwnd, finalBefore.cwnd);
  assert.equal(restored.dupAcks, finalBefore.dupAcks);
  assert.equal(restored.state, finalBefore.state);
  const r = store.appendEvents("m", [ev("timeout", 8)], "after-restart", restored.version);
  assert.equal(r.model.cwnd, 1);
  assert.equal(r.model.state, "SLOW_START");
  // 重启不是超时：恢复后状态来自提交历史
  assert.equal(store.getSteps("m")[0].cwnd, 4.25);
  store.close();
});

test("批次上限与历史分页", () => {
  const db = tmpDb();
  const store = new Store(db);
  store.createModel("m", 1, 1_000_000);
  assert.throws(
    () => store.appendEvents("m", new Array(MAX_BATCH_EVENTS + 1).fill(ev("ack")), "big", 0),
    (e: Error) => e instanceof StoreConflictError && e.code === "BATCH_LIMIT",
  );
  store.appendEvents("m", new Array(5).fill(ev("ack")), "p1", 0);
  const page1 = store.getSteps("m", undefined, undefined).slice(0, 2);
  assert.equal(page1.length, 2);
  assert.deepEqual(
    page1.map((s) => s.seq),
    [1, 2],
  );
  const seq3 = store.getSteps("m", 3, 3);
  assert.equal(seq3[0].cwnd, 4); // 慢启动：初值1，第3个新ack后为4
  const ex = JSON.parse(seq3[0].explanation) as string[];
  assert.ok(ex.some((line) => line.includes("慢启动")));
  store.close();
});

test("模型不存在返回 MODEL_NOT_FOUND", () => {
  const store = new Store(tmpDb());
  assert.throws(
    () => store.getModelOrThrow("ghost"),
    (e: Error) => e instanceof StoreConflictError && e.code === "MODEL_NOT_FOUND",
  );
  store.close();
});
