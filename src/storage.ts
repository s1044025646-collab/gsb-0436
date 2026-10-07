import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { MODEL_VARIANT, RawEvent, RenoState, RenoValidationError } from "./types";
import { applyEvent, initialState, validateInitial } from "./engine";

export const MAX_BATCH_EVENTS = 500;
export const MAX_TOTAL_EVENTS = 100000;

export interface ModelRow {
  id: string;
  initialCwnd: number;
  initialSsthresh: number;
  modelVariant: string;
  version: number;
  cwnd: number;
  ssthresh: number;
  dupAcks: number;
  state: string;
  createdAt: string;
}

export interface StepRow {
  seq: number;
  eventType: string;
  flightSize: number | null;
  cwnd: number;
  ssthresh: number;
  dupAcks: number;
  state: string;
  action: string;
  explanation: string;
  requestId: string;
}

export class StoreConflictError extends Error {
  constructor(
    public readonly code:
      | "VERSION_CONFLICT"
      | "DUPLICATE_REQUEST"
      | "MODEL_NOT_FOUND"
      | "BATCH_LIMIT"
      | "TOTAL_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        initial_cwnd REAL NOT NULL,
        initial_ssthresh INTEGER NOT NULL,
        model_variant TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        cwnd REAL NOT NULL,
        ssthresh INTEGER NOT NULL,
        dup_acks INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        model_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        from_version INTEGER NOT NULL,
        batch_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (model_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS steps (
        model_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        flight_size INTEGER,
        cwnd REAL NOT NULL,
        ssthresh INTEGER NOT NULL,
        dup_acks INTEGER NOT NULL,
        state TEXT NOT NULL,
        action TEXT NOT NULL,
        explanation TEXT NOT NULL,
        request_id TEXT NOT NULL,
        PRIMARY KEY (model_id, seq),
        FOREIGN KEY (model_id) REFERENCES models(id)
      );
    `);
  }

  createModel(
    id: string,
    initialCwnd: number,
    initialSsthresh: number,
  ): ModelRow {
    const v = validateInitial(initialCwnd, initialSsthresh);
    const s0 = initialState(v.cwnd, v.ssthresh);
    this.db
      .prepare(
        `INSERT INTO models
         (id, initial_cwnd, initial_ssthresh, model_variant, version, cwnd, ssthresh, dup_acks, state, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        s0.cwnd,
        v.ssthresh,
        MODEL_VARIANT,
        s0.cwnd,
        s0.ssthresh,
        s0.state,
        new Date().toISOString(),
      );
    return this.getModelOrThrow(id);
  }

  getModel(id: string): ModelRow | null {
    const row = this.db
      .prepare("SELECT * FROM models WHERE id = ?")
      .get(id) as
      | {
          id: string;
          initial_cwnd: number;
          initial_ssthresh: number;
          model_variant: string;
          version: number;
          cwnd: number;
          ssthresh: number;
          dup_acks: number;
          state: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      initialCwnd: row.initial_cwnd,
      initialSsthresh: row.initial_ssthresh,
      modelVariant: row.model_variant,
      version: row.version,
      cwnd: row.cwnd,
      ssthresh: row.ssthresh,
      dupAcks: row.dup_acks,
      state: row.state,
      createdAt: row.created_at,
    };
  }

  getModelOrThrow(id: string): ModelRow {
    const m = this.getModel(id);
    if (!m) throw new StoreConflictError("MODEL_NOT_FOUND", `模型不存在: ${id}`);
    return m;
  }

  /**
   * 原子提交一个事件批次。
   * - 批次在单事务内先完整计算，任何非法事件整体回滚，不留半步。
   * - expectedVersion 与当前版本不一致 -> VERSION_CONFLICT（含重复 requestId 的版本校验）。
   * - (modelId, requestId) 唯一 -> 重复请求幂等返回既有结果，不重复处理事件。
   */
  appendEvents(
    modelId: string,
    events: RawEvent[],
    requestId: string,
    expectedVersion: number,
  ): { model: ModelRow; steps: StepRow[]; deduplicated: boolean } {
    if (events.length === 0) {
      throw new RenoValidationError("INVALID_EVENT_TYPE", "事件批次不能为空");
    }
    if (events.length > MAX_BATCH_EVENTS) {
      throw new StoreConflictError(
        "BATCH_LIMIT",
        `单批最多 ${MAX_BATCH_EVENTS} 个事件，收到 ${events.length} 个`,
      );
    }

    const selectReq = this.db.prepare(
      "SELECT from_version, batch_size FROM requests WHERE model_id = ? AND request_id = ?",
    );
    const insReq = this.db.prepare(
      "INSERT INTO requests (model_id, request_id, from_version, batch_size, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insStep = this.db.prepare(
      `INSERT INTO steps
       (model_id, seq, event_type, flight_size, cwnd, ssthresh, dup_acks, state, action, explanation, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updModel = this.db.prepare(
      "UPDATE models SET version = ?, cwnd = ?, ssthresh = ?, dup_acks = ?, state = ? WHERE id = ?",
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const model = this.getModelOrThrow(modelId);

      const existing = selectReq.get(modelId, requestId) as
        | { from_version: number; batch_size: number }
        | undefined;
      if (existing) {
        if (existing.from_version !== expectedVersion) {
          throw new StoreConflictError(
            "VERSION_CONFLICT",
            `重复 requestId 但版本不匹配：请求版本 ${expectedVersion}，首次提交版本 ${existing.from_version}`,
          );
        }
        const dedupResult = {
          model,
          steps: this.getSteps(modelId, model.version - existing.batch_size + 1, model.version),
          deduplicated: true,
        };
        this.db.exec("COMMIT");
        return dedupResult;
      }

      if (model.version !== expectedVersion) {
        throw new StoreConflictError(
          "VERSION_CONFLICT",
          `版本冲突：期望 ${expectedVersion}，当前 ${model.version}`,
        );
      }
      if (model.version + events.length > MAX_TOTAL_EVENTS) {
        throw new StoreConflictError(
          "TOTAL_LIMIT",
          `累计事件上限 ${MAX_TOTAL_EVENTS}，当前 ${model.version}，本批 ${events.length}`,
        );
      }

      let cur: RenoState = {
        cwnd: model.cwnd,
        ssthresh: model.ssthresh,
        dupAcks: model.dupAcks,
        state: model.state as RenoState["state"],
      };
      const computed: Array<{ ev: RawEvent; r: ReturnType<typeof applyEvent> }> = [];
      events.forEach((ev, i) => {
        const ev2: RawEvent = { ...ev, seq: model.version + i + 1 };
        const r = applyEvent(cur, ev2);
        computed.push({ ev: ev2, r });
        cur = { cwnd: r.cwnd, ssthresh: r.ssthresh, dupAcks: r.dupAcks, state: r.state };
      });

      insReq.run(modelId, requestId, expectedVersion, events.length, new Date().toISOString());
      const steps: StepRow[] = [];
      computed.forEach(({ ev, r }) => {
        insStep.run(
          modelId,
          ev.seq,
          ev.type,
          ev.flightSize ?? null,
          r.cwnd,
          r.ssthresh,
          r.dupAcks,
          r.state,
          r.action,
          JSON.stringify(r.explanation),
          requestId,
        );
        steps.push({
          seq: ev.seq,
          eventType: ev.type,
          flightSize: ev.flightSize ?? null,
          cwnd: r.cwnd,
          ssthresh: r.ssthresh,
          dupAcks: r.dupAcks,
          state: r.state,
          action: r.action,
          explanation: JSON.stringify(r.explanation),
          requestId,
        });
      });

      const last = computed[computed.length - 1].r;
      updModel.run(
        model.version + events.length,
        last.cwnd,
        last.ssthresh,
        last.dupAcks,
        last.state,
        modelId,
      );

      const outModel = this.getModelOrThrow(modelId);
      this.db.exec("COMMIT");
      return { model: outModel, steps, deduplicated: false as const };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSteps(modelId: string, fromSeq?: number, toSeq?: number): StepRow[] {
    this.getModelOrThrow(modelId);
    const where = ["model_id = ?"];
    const params: unknown[] = [modelId];
    if (fromSeq !== undefined) {
      where.push("seq >= ?");
      params.push(fromSeq);
    }
    if (toSeq !== undefined) {
      where.push("seq <= ?");
      params.push(toSeq);
    }
    const rows = (this.db
      .prepare(
        `SELECT * FROM steps WHERE ${where.join(" AND ")} ORDER BY seq ASC`,
      )
      .all(...(params as never[])) as unknown) as Array<{
      seq: number;
      event_type: string;
      flight_size: number | null;
      cwnd: number;
      ssthresh: number;
      dup_acks: number;
      state: string;
      action: string;
      explanation: string;
      request_id: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      eventType: r.event_type,
      flightSize: r.flight_size,
      cwnd: r.cwnd,
      ssthresh: r.ssthresh,
      dupAcks: r.dup_acks,
      state: r.state,
      action: r.action,
      explanation: r.explanation,
      requestId: r.request_id,
    }));
  }

  /** 从初态完整回放：初态 + 全部已提交步骤（重启后等价）。 */
  replayAll(modelId: string): { model: ModelRow; steps: StepRow[] } {
    const model = this.getModelOrThrow(modelId);
    return { model, steps: this.getSteps(modelId) };
  }
}
