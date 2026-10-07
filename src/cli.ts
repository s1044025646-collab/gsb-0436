import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { RenoStore } from './store.js';
import { replay } from './engine.js';
import { MAX_BATCH_EVENTS, MAX_TOTAL_EVENTS, RenoError, RenoStep } from './types.js';

const DEFAULT_DB = resolve('data/reno.db');

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

const PHASE_CN: Record<string, string> = {
  slow_start: '慢启动',
  congestion_avoidance: '拥塞避免',
  fast_recovery: '快速恢复',
};

const ACTION_CN: Record<string, string> = {
  none: '—',
  fast_retransmit: '★建议快速重传(1段)',
  timeout_retransmit: '★建议超时重传',
};

function displayLen(s: string): number {
  let n = 0;
  for (const ch of s) n += /[⺀-鿿★]/.test(ch) ? 2 : 1;
  return n;
}

function renderTable(steps: RenoStep[]): string {
  const header = ['步骤', '事件', 'flight', '旧cwnd', '新cwnd', 'ssthresh', 'dup', '状态', '建议动作'];
  const rows = steps.map((s) => [
    String(s.seq),
    s.event.type,
    s.event.flightSize != null ? String(s.event.flightSize) : '—',
    fmt(s.before.cwnd),
    fmt(s.cwnd),
    fmt(s.ssthresh),
    String(s.dupCount),
    PHASE_CN[s.phase],
    ACTION_CN[s.action],
  ]);
  const widths = header.map((h, i) => Math.max(displayLen(h), ...rows.map((r) => displayLen(r[i]))));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] - (c.length - displayLen(c)), ' ')).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  return [line(header), sep, ...rows.map(line)].join('\n');
}

function explain(s: RenoStep): string {
  const d = Object.entries(s.explanation.detail)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? fmt(v) : v}`)
    .join(', ');
  return `[#${s.seq}] ${s.explanation.rule}\n        公式: ${s.explanation.formula}\n        取值: ${d}`;
}

function parseEvents(literal: string | undefined, file: string | undefined): unknown[] {
  const raw = literal ?? (file ? readFileSync(file, 'utf8') : undefined);
  if (raw === undefined) throw new RenoError('VALIDATION_ERROR', '需要 --events JSON 或 --file 文件');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RenoError('VALIDATION_ERROR', '事件 JSON 解析失败');
  }
  if (!Array.isArray(parsed)) throw new RenoError('VALIDATION_ERROR', '事件必须是 JSON 数组');
  return parsed;
}

function usage(): void {
  console.log(`TCP Reno 教学事件回放 CLI（只展示状态变化与重传建议，不发送报文）

用法:
  node dist/src/cli.js demo
      运行题目要求的教学演示（不落盘）
  node dist/src/cli.js simulate --cwnd 4 --ssthresh 4 --events '[{"type":"ack"}]'
      纯演算（不落盘），打印状态变化表
  node dist/src/cli.js create <modelId> --cwnd 4 --ssthresh 4 [--db data/reno.db]
  node dist/src/cli.js submit <modelId> --request-id r1 [--expected-version 0]
      --events '[{"type":"dup_ack","flightSize":8}]' [--db ...]
      原子提交一批事件；重复 requestId 不重复处理；版本不符冲突
  node dist/src/cli.js state <modelId> [--db ...]
  node dist/src/cli.js steps <modelId> [--limit 100] [--offset 0] [--explain <步骤>] [--db ...]
  node dist/src/cli.js replay <modelId> [--db ...]      从初态回放全部步骤
  node dist/src/cli.js export <modelId> [--db ...]      导出初态与原始事件 JSON
  node dist/src/cli.js limits                            查看批次与累计上限

上限: 单批 ${MAX_BATCH_EVENTS} 条，单模型累计 ${MAX_TOTAL_EVENTS} 条。`);
}

function numFlag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : undefined;
}
function strFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function runDemo(): void {
  console.log('=== 演示一：cwnd=4, ssthresh=4 的标准序列 ===');
  const steps = replay(4, 4, [
    { type: 'ack' },
    { type: 'dup_ack' },
    { type: 'dup_ack' },
    { type: 'dup_ack', flightSize: 8 },
    { type: 'dup_ack' },
    { type: 'recovery_ack' },
  ]);
  console.log(renderTable(steps));
  console.log('\n关键核对: 普通确认后 cwnd=4.25；第三次重复确认 flightSize=8 -> ssthresh=4, cwnd=7；再来一条 dup_ack -> cwnd=8；recovery_ack -> cwnd=4');
  steps.forEach((s) => console.log(explain(s)));

  console.log('\n=== 演示二：同样 flightSize=8 的超时 ===');
  const t = replay(4, 4, [{ type: 'timeout', flightSize: 8 }]);
  console.log(renderTable(t));
  console.log('\n关键核对: timeout -> ssthresh=max(2,floor(8/2))=4, cwnd=1, dup=0');
  t.forEach((s) => console.log(explain(s)));
}

function openStore(rest: string[]): RenoStore {
  return new RenoStore(strFlag(rest, '--db') ?? DEFAULT_DB);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'demo':
        return runDemo();
      case 'limits':
        return console.log(JSON.stringify({ maxBatchEvents: MAX_BATCH_EVENTS, maxTotalEvents: MAX_TOTAL_EVENTS }));
      case 'simulate': {
        const cwnd = numFlag(rest, '--cwnd');
        const ssthresh = numFlag(rest, '--ssthresh');
        if (cwnd === undefined || ssthresh === undefined) {
          throw new RenoError('VALIDATION_ERROR', '需要 --cwnd 与 --ssthresh');
        }
        const steps = replay(cwnd, ssthresh, parseEvents(strFlag(rest, '--events'), strFlag(rest, '--file')));
        console.log(renderTable(steps));
        return;
      }
      case 'create': {
        const id = rest.find((a) => !a.startsWith('--'));
        const cwnd = numFlag(rest, '--cwnd');
        const ssthresh = numFlag(rest, '--ssthresh');
        if (!id || cwnd === undefined || ssthresh === undefined) {
          throw new RenoError('VALIDATION_ERROR', '用法: create <modelId> --cwnd N --ssthresh N');
        }
        const store = openStore(rest);
        const m = store.createModel(id, cwnd, ssthresh);
        console.log(JSON.stringify({ id: m.id, initialCwnd: m.initial_cwnd, initialSsthresh: m.initial_ssthresh, version: m.version }));
        store.close();
        return;
      }
      case 'submit': {
        const id = rest.find((a) => !a.startsWith('-'));
        if (!id) throw new RenoError('VALIDATION_ERROR', '缺少 modelId');
        const requestId = strFlag(rest, '--request-id');
        if (!requestId) throw new RenoError('VALIDATION_ERROR', 'submit 需要 --request-id');
        const ev = strFlag(rest, '--expected-version');
        const store = openStore(rest);
        const r = store.submitBatch(
          id,
          requestId,
          ev === undefined ? null : Number(ev),
          parseEvents(strFlag(rest, '--events'), strFlag(rest, '--file')),
        );
        console.log(renderTable(r.steps));
        console.log(`\nbatchId=${r.batchId} version=${r.version}${r.deduplicated ? ' (重复 requestId，未重复处理事件)' : ''}`);
        store.close();
        return;
      }
      case 'state': {
        const id = rest.find((a) => !a.startsWith('-'));
        if (!id) throw new RenoError('VALIDATION_ERROR', '缺少 modelId');
        const store = openStore(rest);
        console.log(JSON.stringify(store.getCurrentState(id), null, 2));
        store.close();
        return;
      }
      case 'steps':
      case 'replay': {
        const id = rest.find((a) => !a.startsWith('-'));
        if (!id) throw new RenoError('VALIDATION_ERROR', '缺少 modelId');
        const store = openStore(rest);
        const steps =
          cmd === 'replay'
            ? store.getSteps(id)
            : store.getSteps(id, {
                limit: numFlag(rest, '--limit') ?? 100,
                offset: numFlag(rest, '--offset') ?? 0,
              });
        console.log(renderTable(steps));
        const ex = strFlag(rest, '--explain');
        if (ex) {
          const s = steps.find((x) => String(x.seq) === ex);
          if (!s) throw new RenoError('STEP_NOT_FOUND', `当前页没有第 ${ex} 步，可用 --limit/--offset 翻页`);
          console.log('\n' + explain(s));
        }
        store.close();
        return;
      }
      case 'export': {
        const id = rest.find((a) => !a.startsWith('-'));
        if (!id) throw new RenoError('VALIDATION_ERROR', '缺少 modelId');
        const store = openStore(rest);
        console.log(JSON.stringify(store.export(id), null, 2));
        store.close();
        return;
      }
      default:
        usage();
        if (cmd && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof RenoError) {
      console.error(
        `错误 [${err.code}]${err.eventIndex !== undefined ? `（批次内第 ${err.eventIndex} 个事件，整批已回滚）` : ''}: ${err.message}`,
      );
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();
