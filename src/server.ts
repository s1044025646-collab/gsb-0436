import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, MAX_BATCH_EVENTS, MAX_TOTAL_EVENTS } from "./storage";
import { RawEvent, RenoValidationError } from "./types";
import { MODEL_VARIANT } from "./types";

interface ApiError {
  error: { code: string; message: string };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new RenoValidationError("INVALID_EVENT_TYPE", "请求体过大（>1MB）"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RenoValidationError("INVALID_EVENT_TYPE", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validateEvents(input: unknown): RawEvent[] {
  if (!Array.isArray(input)) {
    throw new RenoValidationError("INVALID_EVENT_TYPE", "events 必须为数组");
  }
  return input.map((e, i) => {
    if (typeof e !== "object" || e === null) {
      throw new RenoValidationError(
        "INVALID_EVENT_TYPE",
        `events[${i}] 必须为对象 {type, flightSize?}`,
      );
    }
    const out: RawEvent = { seq: 0, type: e.type };
    if (e.flightSize !== undefined && e.flightSize !== null) {
      out.flightSize = e.flightSize;
    }
    return out;
  });
}

/** 找一个系统当前空闲的 TCP 端口（默认行为）。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(typeof addr === "object" && addr ? addr.port : 0)));
    });
    srv.on("error", reject);
  });
}

export async function createServer(
  dbPath: string,
  requestedPort?: number,
): Promise<{ server: http.Server; store: Store; port: number }> {
  const store = new Store(dbPath);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const p = url.pathname;
      const m = p.match(/^\/api\/models\/([^/]+)(?:\/(.+))?$/);
      const modelId = m?.[1];
      const sub = m?.[2];

      if (req.method === "POST" && p === "/api/models") {
        const body = await readJson(req);
        const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : randomUUID();
        const model = store.createModel(id, body.initialCwnd, body.initialSsthresh);
        send(res, 201, modelJson(model));
        return;
      }

      if (req.method === "GET" && p === "/api/limits") {
        send(res, 200, {
          maxBatchEvents: MAX_BATCH_EVENTS,
          maxTotalEvents: MAX_TOTAL_EVENTS,
          modelVariant: MODEL_VARIANT,
        });
        return;
      }

      if (!modelId) {
        send(res, 404, { error: { code: "NOT_FOUND", message: `未知路径: ${p}` } } satisfies ApiError);
        return;
      }

      if (req.method === "GET" && !sub) {
        send(res, 200, modelJson(store.getModelOrThrow(modelId)));
        return;
      }

      if (req.method === "POST" && sub === "events") {
        const body = await readJson(req);
        const requestId =
          typeof body.requestId === "string" && body.requestId.trim()
            ? body.requestId.trim()
            : randomUUID();
        if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
          throw new RenoValidationError(
            "INVALID_EVENT_TYPE",
            "expectedVersion 必须为非负整数（乐观并发版本）",
          );
        }
        const events = validateEvents(body.events);
        const result = store.appendEvents(modelId, events, requestId, body.expectedVersion);
        send(res, result.deduplicated ? 200 : 201, {
          requestId,
          deduplicated: result.deduplicated,
          model: modelJson(result.model),
          steps: result.steps.map(stepJson),
        });
        return;
      }

      if (req.method === "GET" && sub === "replay") {
        const { model, steps } = store.replayAll(modelId);
        send(res, 200, {
          model: modelJson(model),
          initial: { cwnd: model.initialCwnd, ssthresh: model.initialSsthresh },
          steps: steps.map(stepJson),
        });
        return;
      }

      if (req.method === "GET" && sub === "steps") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
        const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
        const all = store.getSteps(modelId);
        const page = all.slice(offset, offset + limit);
        send(res, 200, {
          total: all.length,
          limit,
          offset,
          hasMore: offset + page.length < all.length,
          steps: page.map(stepJson),
        });
        return;
      }

      if (req.method === "GET" && sub?.startsWith("steps/")) {
        const seq = parseInt(sub.split("/")[1], 10);
        if (!Number.isInteger(seq)) {
          throw new RenoValidationError("INVALID_EVENT_TYPE", "步骤序号必须为整数");
        }
        const step = store.getSteps(modelId, seq, seq)[0];
        if (!step) {
          send(res, 404, { error: { code: "STEP_NOT_FOUND", message: `步骤 ${seq} 不存在` } } satisfies ApiError);
          return;
        }
        send(res, 200, stepJson(step));
        return;
      }

      if (req.method === "GET" && sub === "export") {
        const { model, steps } = store.replayAll(modelId);
        send(res, 200, {
          format: "reno-replay-export-v1",
          exportedAt: new Date().toISOString(),
          model: modelJson(model),
          initial: { cwnd: model.initialCwnd, ssthresh: model.initialSsthresh },
          events: steps.map((s) => ({
            seq: s.seq,
            type: s.eventType,
            flightSize: s.flightSize,
            requestId: s.requestId,
          })),
          steps: steps.map(stepJson),
        });
        return;
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `未知路径: /api/models/${modelId}/${sub ?? ""}` } } satisfies ApiError);
    } catch (err) {
      handleError(res, err);
    }
  });

  const port = requestedPort ?? (await pickFreePort());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = (server.address() as net.AddressInfo).port;
  return { server, store, port: actual };
}

function handleError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof RenoValidationError) {
    send(res, 400, { error: { code: err.code, message: err.message } } satisfies ApiError);
    return;
  }
  const code = (err as { code?: string }).code;
  if (code === "VERSION_CONFLICT" || code === "DUPLICATE_REQUEST") {
    send(res, 409, { error: { code, message: (err as Error).message } } satisfies ApiError);
    return;
  }
  if (code === "MODEL_NOT_FOUND") {
    send(res, 404, { error: { code, message: (err as Error).message } } satisfies ApiError);
    return;
  }
  if (code === "BATCH_LIMIT" || code === "TOTAL_LIMIT") {
    send(res, 422, { error: { code, message: (err as Error).message } } satisfies ApiError);
    return;
  }
  send(res, 500, {
    error: { code: "INTERNAL_ERROR", message: (err as Error)?.message ?? String(err) },
  } satisfies ApiError);
}

function modelJson(m: Awaited<ReturnType<Store["getModel"]>> & object) {
  return {
    id: m.id,
    initialCwnd: m.initialCwnd,
    initialSsthresh: m.initialSsthresh,
    modelVariant: m.modelVariant,
    version: m.version,
    cwnd: m.cwnd,
    ssthresh: m.ssthresh,
    dupAcks: m.dupAcks,
    state: m.state,
    createdAt: m.createdAt,
  };
}

function stepJson(s: import("./storage").StepRow) {
  return {
    seq: s.seq,
    event: { type: s.eventType, flightSize: s.flightSize },
    cwnd: s.cwnd,
    ssthresh: s.ssthresh,
    dupAcks: s.dupAcks,
    state: s.state,
    action: s.action,
    explanation: JSON.parse(s.explanation) as string[],
  };
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "reno.db");
}
