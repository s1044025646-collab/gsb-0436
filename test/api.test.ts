import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../src/server";
import type { Server } from "node:http";
import type { Store } from "../src/storage";

let base: string;
let server: Server;
let store: Store;
let mid: string;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reno-api-"));
  const s = await createServer(path.join(dir, "api.db"));
  server = s.server;
  store = s.store;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
});

test("创建模型并查询当前状态", async () => {
  const r = await api("POST", "/api/models", { initialCwnd: 4, initialSsthresh: 4 });
  assert.equal(r.status, 201);
  assert.equal(r.json.cwnd, 4);
  assert.equal(r.json.version, 0);
  const g = await api("GET", `/api/models/${r.json.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.json.state, "CONGESTION_AVOIDANCE");
  mid = r.json.id;
});

test("提交批次并读取逐步计算依据", async () => {
  const r = await api("POST", `/api/models/${mid}/events`, {
    requestId: "api-r1",
    expectedVersion: 0,
    events: [{ type: "ack" }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.model.cwnd, 4.25);
  const step = await api("GET", `/api/models/${mid}/steps/1`);
  assert.equal(step.status, 200);
  assert.ok(Array.isArray(step.json.explanation));
  assert.ok(step.json.explanation.join("\n").includes("1/4"));
});

test("重复 requestId 幂等返回 200 且不增长版本", async () => {
  const r = await api("POST", `/api/models/${mid}/events`, {
    requestId: "api-r1",
    expectedVersion: 0,
    events: [{ type: "ack" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.deduplicated, true);
  assert.equal(r.json.model.version, 1);
});

test("旧版本提交返回 409 VERSION_CONFLICT", async () => {
  const r = await api("POST", `/api/models/${mid}/events`, {
    requestId: "api-stale",
    expectedVersion: 0,
    events: [{ type: "ack" }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "VERSION_CONFLICT");
});

test("非法事件 400 且状态回滚；恢复中 ack 400", async () => {
  let r = await api("POST", "/api/models", { initialCwnd: 4, initialSsthresh: 4 });
  const mid = r.json.id;
  r = await api("POST", `/api/models/${mid}/events`, {
    requestId: "bad1",
    expectedVersion: 0,
    events: [{ type: "recovery_ack" }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "EVENT_STATE_CONFLICT");
  const g = await api("GET", `/api/models/${mid}`);
  assert.equal(g.json.version, 0);
  assert.equal(g.json.cwnd, 4);

  // 进入快速恢复后普通 ack 冲突
  await api("POST", `/api/models/${mid}/events`, {
    requestId: "in1", expectedVersion: 0,
    events: [{ type: "dup_ack" }, { type: "dup_ack" }, { type: "dup_ack", flightSize: 8 }],
  });
  r = await api("POST", `/api/models/${mid}/events`, {
    requestId: "in2", expectedVersion: 3,
    events: [{ type: "ack" }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "EVENT_STATE_CONFLICT");
});

test("参数校验：缺 flightSize、坏 JSON、cwnd 非法", async () => {
  const c = await api("POST", "/api/models", { initialCwnd: -1, initialSsthresh: 4 });
  assert.equal(c.status, 400);
  assert.equal(c.json.error.code, "INVALID_CWND");
  const mid = (await api("POST", "/api/models", { initialCwnd: 1, initialSsthresh: 5 })).json.id;
  await api("POST", `/api/models/${mid}/events`, { requestId: "d1", expectedVersion: 0, events: [{ type: "dup_ack" }, { type: "dup_ack" }] });
  const noFs = await api("POST", `/api/models/${mid}/events`, {
    requestId: "d2", expectedVersion: 2, events: [{ type: "dup_ack" }],
  });
  assert.equal(noFs.status, 400);
  assert.equal(noFs.json.error.code, "FLIGHT_SIZE_REQUIRED");

  const res = await fetch(base + "/api/models", { method: "POST", body: "{not-json" });
  assert.equal(res.status, 400);
});

test("404：模型不存在、未知路径、缺失步骤", async () => {
  assert.equal((await api("GET", "/api/models/nope")).status, 404);
  assert.equal((await api("GET", "/api/whatever")).status, 404);
  const mid = (await api("POST", "/api/models", { initialCwnd: 1, initialSsthresh: 2 })).json.id;
  assert.equal((await api("GET", `/api/models/${mid}/steps/99`)).status, 404);
});

test("分页 steps 与完整 export、replay 一致性", async () => {
  const mid = (await api("POST", "/api/models", { initialCwnd: 1, initialSsthresh: 100 })).json.id;
  await api("POST", `/api/models/${mid}/events`, {
    requestId: "many", expectedVersion: 0,
    events: Array.from({ length: 6 }, () => ({ type: "ack" })),
  });
  const p1 = await api("GET", `/api/models/${mid}/steps?limit=2&offset=0`);
  assert.equal(p1.json.steps.length, 2);
  assert.equal(p1.json.total, 6);
  assert.equal(p1.json.hasMore, true);
  const p2 = await api("GET", `/api/models/${mid}/steps?limit=2&offset=4`);
  assert.equal(p2.json.hasMore, false);
  const ex = await api("GET", `/api/models/${mid}/export`);
  assert.equal(ex.json.format, "reno-replay-export-v1");
  assert.equal(ex.json.events.length, 6);
  assert.equal(ex.json.events[0].type, "ack");
  const rp = await api("GET", `/api/models/${mid}/replay`);
  assert.equal(rp.json.steps.length, 6);
  assert.equal(rp.json.steps[5].cwnd, 7);

  const limits = await api("GET", "/api/limits");
  assert.equal(limits.status, 200);
  assert.ok(limits.json.maxBatchEvents > 0);
});
