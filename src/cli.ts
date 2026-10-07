import { Store, MAX_BATCH_EVENTS, MAX_TOTAL_EVENTS } from "./storage";
import { RawEvent } from "./types";
import { defaultDbPath } from "./server";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  if (process.argv[i].includes("=")) return process.argv[i].split("=").slice(1).join("=");
  return process.argv[i + 1];
}

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function parseEvent(token: string): RawEvent {
  const [type, flight] = token.split(":");
  if (!["ack", "dup_ack", "recovery_ack", "timeout"].includes(type)) {
    throw new Error(`非法事件 '${token}'，格式为 type[:flightSize]`);
  }
  const ev: RawEvent = { seq: 0, type: type as RawEvent["type"] };
  if (flight !== undefined) {
    const n = Number(flight);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`flightSize 必须为正整数: ${flight}`);
    ev.flightSize = n;
  }
  return ev;
}

const ACTION_TEXT: Record<string, string> = {
  NONE: "-",
  FAST_RETRANSMIT: "⚠ 快速重传（建议）",
  TIMEOUT_RETRANSMIT: "⚠ 超时重传（建议）",
};

function printTable(steps: Array<Record<string, string | number>>): void {
  if (steps.length === 0) {
    console.log("（无步骤）");
    return;
  }
  const cols = Object.keys(steps[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...steps.map((s) => String(s[c]).length)),
  );
  const line = (s: Record<string, string | number>) =>
    "| " + cols.map((c, i) => String(s[c]).padEnd(widths[i])).join(" | ") + " |";
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  steps.forEach((s) => console.log(line(s)));
}

async function main(): Promise<void> {
  const dbPath = arg("db", defaultDbPath())!;
  const store = new Store(dbPath);
  const cmd = process.argv[2];
  try {
    if (cmd === "create") {
      const cwnd = Number(arg("cwnd"));
      const ssthresh = Number(arg("ssthresh"));
      const id = arg("id") ?? cryptoRandom();
      const m = store.createModel(id, cwnd, ssthresh);
      console.log(`已创建模型 ${m.id}（version=${m.version}, cwnd=${fmt(m.cwnd)}, ssthresh=${m.ssthresh}, state=${m.state}）`);
    } else if (cmd === "state") {
      const m = store.getModelOrThrow(requireModel());
      console.log(JSON.stringify(
        {
          id: m.id, version: m.version, cwnd: fmt(m.cwnd), ssthresh: m.ssthresh,
          dupAcks: m.dupAcks, state: m.state, modelVariant: m.modelVariant,
        },
        null,
        2,
      ));
    } else if (cmd === "events") {
      const sub = process.argv[3];
      if (sub !== "submit") throw new Error("用法: events submit --model ID --version N --req RID <ack|dup_ack[:F]|recovery_ack|timeout ...>");
      const modelId = requireModel();
      const version = Number(arg("version"));
      const req = arg("req") ?? cryptoRandom();
      const flagsWithValue = new Set(["--model", "--version", "--req", "--db"]);
      const tokens: string[] = [];
      for (let i = 4; i < process.argv.length; i++) {
        const t = process.argv[i];
        if (t.includes("=")) continue; // --name=value 形式
        if (flagsWithValue.has(t)) {
          i++; // 跳过该标志的值
          continue;
        }
        if (t.startsWith("--")) continue;
        tokens.push(t);
      }
      const events = tokens;
      const parsed = events.map(parseEvent);
      if (parsed.length === 0) throw new Error("未提供事件，或事件数量为 0（单批上限 " + MAX_BATCH_EVENTS + "）");
      const r = store.appendEvents(modelId, parsed, req, version);
      console.log(r.deduplicated ? `请求 ${req} 已处理过，返回幂等结果（未重复处理事件）` : `批次已提交（${parsed.length} 个事件）`);
      printSteps(r.steps);
      console.log(`当前 version=${r.model.version} cwnd=${fmt(r.model.cwnd)} ssthresh=${r.model.ssthresh} dupAcks=${r.model.dupAcks} state=${r.model.state}`);
    } else if (cmd === "step") {
      const seq = Number(process.argv[3]);
      const s = store.getSteps(requireModel(), seq, seq)[0];
      if (!s) throw new Error(`步骤 ${seq} 不存在`);
      console.log(JSON.stringify({ ...s, explanation: JSON.parse(s.explanation) }, null, 2));
    } else if (cmd === "steps") {
      const limit = Number(arg("limit", "50"));
      const offset = Number(arg("offset", "0"));
      printSteps(store.getSteps(requireModel()).slice(offset, offset + limit));
    } else if (cmd === "replay" || cmd === "export") {
      const { model, steps } = store.replayAll(requireModel());
      if (cmd === "export") {
        console.log(JSON.stringify({
          format: "reno-replay-export-v1",
          initial: { cwnd: model.initialCwnd, ssthresh: model.initialSsthresh },
          events: steps.map((s) => ({ seq: s.seq, type: s.eventType, flightSize: s.flightSize })),
          steps: steps.map((s) => ({ ...s, explanation: JSON.parse(s.explanation) })),
        }, null, 2));
      } else {
        console.log(`初态 cwnd=${fmt(model.initialCwnd)} ssthresh=${model.initialSsthresh}`);
        printSteps(steps);
      }
    } else if (cmd === "demo") {
      await runDemo(store);
    } else if (cmd === "limits") {
      console.log(JSON.stringify({ maxBatchEvents: MAX_BATCH_EVENTS, maxTotalEvents: MAX_TOTAL_EVENTS }, null, 2));
    } else {
      console.log(usage());
    }
  } finally {
    store.close();
  }
}

function printSteps(steps: import("./storage").StepRow[]): void {
  printTable(steps.map((s) => ({
    seq: s.seq,
    event: s.flightSize ? `${s.eventType}(${s.flightSize})` : s.eventType,
    cwnd: fmt(s.cwnd),
    ssthresh: s.ssthresh,
    dup: s.dupAcks,
    state: s.state,
    action: ACTION_TEXT[s.action] ?? s.action,
  })));
}

function requireModel(): string {
  const id = arg("model");
  if (!id) throw new Error("需要 --model <模型ID>");
  return id;
}

function cryptoRandom(): string {
  return require("node:crypto").randomUUID();
}

async function runDemo(store: Store): Promise<void> {
  console.log("== 演示 A：cwnd=4, ssthresh=4 ==");
  const a = store.createModel(cryptoRandom(), 4, 4);
  let r = store.appendEvents(a.id, [{ seq: 0, type: "ack" }], "a1", 0);
  console.log(`普通 ack 后 cwnd=${fmt(r.model.cwnd)}（应为 4.25）`);
  store.appendEvents(a.id, [{ seq: 0, type: "dup_ack" }, { seq: 0, type: "dup_ack" }], "a2", 1);
  r = store.appendEvents(a.id, [{ seq: 0, type: "dup_ack", flightSize: 8 }], "a3", 3);
  console.log(`第 3 次 dup_ack(flightSize=8)：ssthresh=${r.model.ssthresh}（应 4），cwnd=${fmt(r.model.cwnd)}（应 7），action=${r.steps[0].action}`);
  r = store.appendEvents(a.id, [{ seq: 0, type: "dup_ack" }], "a4", 4);
  console.log(`再来一个 dup_ack：cwnd=${fmt(r.model.cwnd)}（应 8）`);
  r = store.appendEvents(a.id, [{ seq: 0, type: "recovery_ack" }], "a5", 5);
  console.log(`recovery_ack：cwnd=${fmt(r.model.cwnd)}（应 4），state=${r.model.state}`);
  printSteps(store.getSteps(a.id));

  console.log("\n== 演示 B：同 flightSize 的超时 ==");
  const b = store.createModel(cryptoRandom(), 4, 4);
  r = store.appendEvents(b.id, [{ seq: 0, type: "timeout", flightSize: 8 }], "b1", 0);
  console.log(`timeout(flightSize=8)：cwnd=${fmt(r.model.cwnd)}（应 1），ssthresh=${r.model.ssthresh}（应 4），action=${r.steps[0].action}，state=${r.model.state}`);
}

function usage(): string {
  return [
    "TCP Reno 事件回放 CLI（只输出建议，不发送报文）",
    "  reno create --cwnd 4 --ssthresh 4 [--id ID] [--db data/reno.db]",
    "  reno state --model ID",
    "  reno events submit --model ID --version 0 --req RID ack dup_ack dup_ack:8 recovery_ack timeout:8",
    "  reno step N --model ID            查看第 N 步计算依据",
    "  reno steps --model ID [--offset 0 --limit 50]",
    "  reno replay --model ID            从初态回放状态变化表",
    "  reno export --model ID            导出 JSON（原始事件+步骤）",
    "  reno limits                       批次/累计上限与模型口径",
    "  reno demo                         内置教学演示",
  ].join("\n");
}

main().catch((err) => {
  console.error(`错误[${err.code ?? "CLI_ERROR"}]: ${err.message}`);
  process.exit(1);
});
