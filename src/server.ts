import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RenoStore } from './store.js';
import { MAX_BATCH_EVENTS, MAX_TOTAL_EVENTS, RenoError } from './types.js';

const DEFAULT_DB = resolve('data/reno.db');

interface ErrorBody {
  error: { code: string; message: string; eventIndex?: number };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof RenoError) {
    const status =
      err.code === 'MODEL_NOT_FOUND'
        || err.code === 'STEP_NOT_FOUND'
        ? 404
        : err.code === 'VERSION_CONFLICT' || err.code === 'REQUEST_ID_CONFLICT' || err.code === 'MODEL_EXISTS'
          ? 409
          : err.code === 'BATCH_TOO_LARGE' || err.code === 'EVENT_LIMIT_REACHED'
            ? 413
            : 400;
    const body: ErrorBody = {
      error: { code: err.code, message: err.message, ...(err.eventIndex !== undefined ? { eventIndex: err.eventIndex } : {}) },
    };
    send(res, status, body);
    return;
  }
  send(res, 500, { error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new RenoError('VALIDATION_ERROR', '请求体超过 2MB 上限');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RenoError('VALIDATION_ERROR', '请求体不是合法 JSON');
  }
}

/** 纯 HTTP/JSON API，无任何外部依赖。 */
export function createApp(store: RenoStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return send(res, 200, {
          ok: true,
          limits: { maxBatchEvents: MAX_BATCH_EVENTS, maxTotalEvents: MAX_TOTAL_EVENTS },
        });
      }

      if (method === 'POST' && path === '/models') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : randomUUID();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          throw new RenoError('VALIDATION_ERROR', 'id 只能包含字母、数字、下划线与连字符（1-64）');
        }
        const model = store.createModel(id, body.initialCwnd, body.initialSsthresh);
        return send(res, 201, {
          id: model.id,
          initialCwnd: model.initial_cwnd,
          initialSsthresh: model.initial_ssthresh,
          version: model.version,
          state: store.getCurrentState(model.id),
        });
      }

      const mModel = path.match(/^\/models\/([^/]+)$/);
      if (method === 'GET' && mModel) {
        const id = decodeURIComponent(mModel[1]);
        const model = store.getModel(id);
        if (!model) throw new RenoError('MODEL_NOT_FOUND', `模型不存在: ${id}`);
        return send(res, 200, {
          id: model.id,
          initialCwnd: model.initial_cwnd,
          initialSsthresh: model.initial_ssthresh,
          version: model.version,
          eventCount: model.event_count,
          createdAt: model.created_at,
          state: store.getCurrentState(id),
        });
      }

      const mEvents = path.match(/^\/models\/([^/]+)\/events$/);
      if (method === 'POST' && mEvents) {
        const id = decodeURIComponent(mEvents[1]);
        const body = await readJson(req);
        const expected =
          body.expectedVersion === undefined || body.expectedVersion === null ? null : Number(body.expectedVersion);
        const result = store.submitBatch(id, String(body.requestId ?? ''), expected, body.events ?? []);
        return send(res, result.deduplicated ? 200 : 201, {
          batchId: result.batchId,
          version: result.version,
          deduplicated: result.deduplicated,
          steps: result.steps,
        });
      }
      if (method === 'GET' && mEvents) {
        const id = decodeURIComponent(mEvents[1]);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '100'), 500);
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
          throw new RenoError('VALIDATION_ERROR', 'limit/offset 必须为非负整数（limit >= 1，<= 500）');
        }
        const steps = store.getSteps(id, { limit, offset });
        const model = store.getModel(id)!;
        return send(res, 200, {
          modelId: id,
          version: model.version,
          total: model.event_count,
          limit,
          offset,
          steps,
        });
      }

      const mReplay = path.match(/^\/models\/([^/]+)\/replay$/);
      if (method === 'GET' && mReplay) {
        const id = decodeURIComponent(mReplay[1]);
        const model = store.getModel(mReplay[1]);
        if (!model) throw new RenoError('MODEL_NOT_FOUND', `模型不存在: ${id}`);
        const all = store.getSteps(id);
        return send(res, 200, {
          modelId: id,
          initial: { cwnd: model.initial_cwnd, ssthresh: model.initial_ssthresh },
          steps: all,
        });
      }

      const mStep = path.match(/^\/models\/([^/]+)\/steps\/(\d+)$/);
      if (method === 'GET' && mStep) {
        const id = decodeURIComponent(mStep[1]);
        const seq = Number(mStep[2]);
        if (!store.getModel(id)) throw new RenoError('MODEL_NOT_FOUND', `模型不存在: ${id}`);
        const step = store.getStep(id, seq);
        if (!step) throw new RenoError('STEP_NOT_FOUND', `第 ${seq} 步不存在`);
        return send(res, 200, step);
      }

      const mExport = path.match(/^\/models\/([^/]+)\/export$/);
      if (method === 'GET' && mExport) {
        const id = decodeURIComponent(mExport[1]);
        return send(res, 200, store.export(id));
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${method} ${path}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

function listenFree(server: Server, preferred?: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const tryPort = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port === (preferred ?? 0)) {
          server.listen(0, '127.0.0.1');
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        resolvePort(Number((server.address() as { port: number }).port));
      });
    };
    tryPort(preferred ?? 0);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const dbArg = args.indexOf('--db');
  const port = portArg >= 0 ? Number(args[portArg + 1]) : (process.env.PORT ? Number(process.env.PORT) : undefined);
  const dbPath = dbArg >= 0 ? args[dbArg + 1] : process.env.RENO_DB ?? DEFAULT_DB;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error('端口必须为 0-65535 的整数（不传或传 0 表示自动选择空闲端口）');
    process.exit(2);
  }
  const store = new RenoStore(dbPath);
  const server = createApp(store);
  const actual = await listenFree(server, port);
  console.log(JSON.stringify({ status: 'listening', baseUrl: `http://127.0.0.1:${actual}`, db: dbPath }));
  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
