import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyEvent, initialState, validateInitial } from './engine.js';
import {
  MAX_BATCH_EVENTS,
  MAX_TOTAL_EVENTS,
  RenoError,
  RenoEventInput,
  RenoPhase,
  RenoStep,
  SuggestedAction,
} from './types.js';

export interface ModelRow {
  id: string;
  initial_cwnd: number;
  initial_ssthresh: number;
  version: number;
  event_count: number;
  created_at: string;
}

export interface CurrentState {
  cwnd: number;
  ssthresh: number;
  dupCount: number;
  phase: RenoPhase;
}

interface StepRow {
  seq: number;
  batch_id: number;
  event_type: string;
  event_flight_size: number | null;
  cwnd: number;
  ssthresh: number;
  dup_count: number;
  phase: RenoPhase;
  action: SuggestedAction;
  before_cwnd: number;
  before_ssthresh: number;
  before_dup_count: number;
  before_phase: RenoPhase;
  explanation: string;
}

export interface BatchResult {
  batchId: number;
  version: number;
  steps: RenoStep[];
  deduplicated: boolean;
}

/** SQLite 持久层：初态、模型口径、原始事件、动作建议与状态版本全部落盘。 */
export class RenoStore {
  private db: DatabaseSync;

  constructor(dbPathOrDb: string | DatabaseSync) {
    if (typeof dbPathOrDb === 'string') {
      try {
        mkdirSync(dirname(dbPathOrDb), { recursive: true });
        this.db = new DatabaseSync(dbPathOrDb);
      } catch (err) {
        throw new RenoError('STORAGE_ERROR', `数据库打开失败: ${(err as Error).message}`);
      }
    } else {
      this.db = dbPathOrDb;
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
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
        initial_ssthresh REAL NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL REFERENCES models(id),
        request_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        new_version INTEGER NOT NULL,
        start_seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (model_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        model_id TEXT NOT NULL REFERENCES models(id),
        seq INTEGER NOT NULL,
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        event_type TEXT NOT NULL,
        event_flight_size INTEGER,
        cwnd REAL NOT NULL,
        ssthresh REAL NOT NULL,
        dup_count INTEGER NOT NULL,
        phase TEXT NOT NULL,
        action TEXT NOT NULL,
        before_cwnd REAL NOT NULL,
        before_ssthresh REAL NOT NULL,
        before_dup_count INTEGER NOT NULL,
        before_phase TEXT NOT NULL,
        explanation TEXT NOT NULL,
        PRIMARY KEY (model_id, seq)
      );
    `);
  }

  createModel(id: string, cwnd: number, ssthresh: number): ModelRow {
    const v = validateInitial(cwnd, ssthresh);
    try {
      this.db
        .prepare(
          'INSERT INTO models (id, initial_cwnd, initial_ssthresh) VALUES (?, ?, ?)',
        )
        .run(id, v.cwnd, v.ssthresh);
    } catch (err) {
      if ((err as Error).message?.includes('UNIQUE')) {
        throw new RenoError('MODEL_EXISTS', `模型已存在: ${id}`);
      }
      throw new RenoError('STORAGE_ERROR', `存储失败: ${(err as Error).message}`);
    }
    return this.getModel(id)!;
  }

  getModel(id: string): ModelRow | null {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
    return row ?? null;
  }

  private requireModel(id: string): ModelRow {
    const m = this.getModel(id);
    if (!m) throw new RenoError('MODEL_NOT_FOUND', `模型不存在: ${id}`);
    return m;
  }

  getCurrentState(modelId: string): CurrentState {
    this.requireModel(modelId);
    const last = this.db
      .prepare('SELECT * FROM events WHERE model_id = ? ORDER BY seq DESC LIMIT 1')
      .get(modelId) as StepRow | undefined;
    if (!last) {
      const m = this.getModel(modelId)!;
      return initialState(m.initial_cwnd, m.initial_ssthresh);
    }
    return { cwnd: last.cwnd, ssthresh: last.ssthresh, dupCount: last.dup_count, phase: last.phase };
  }

  /**
   * 原子提交一个事件批次：
   * - expectedVersion 与当前版本不符 -> VERSION_CONFLICT（旧版本提交需冲突）
   * - requestId 已出现且载荷一致 -> 原样返回既有结果（deduplicated=true），不重复处理事件
   * - requestId 已出现但载荷不同 -> REQUEST_ID_CONFLICT
   * - 批次内任一事件非法 -> 整体回滚，窗口不会先改一半
   */
  submitBatch(modelId: string, requestId: string, expectedVersion: number | null, events: unknown[]): BatchResult {
    const model = this.requireModel(modelId);
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      throw new RenoError('VALIDATION_ERROR', 'requestId 必须为非空字符串（长度不超过 128）');
    }
    if (!Array.isArray(events)) {
      throw new RenoError('VALIDATION_ERROR', 'events 必须为数组');
    }
    if (events.length === 0) {
      throw new RenoError('VALIDATION_ERROR', '批次不能为空');
    }
    if (events.length > MAX_BATCH_EVENTS) {
      throw new RenoError('BATCH_TOO_LARGE', `单批事件不得超过 ${MAX_BATCH_EVENTS} 条，当前 ${events.length} 条`);
    }
    if (model.event_count + events.length > MAX_TOTAL_EVENTS) {
      throw new RenoError(
        'EVENT_LIMIT_REACHED',
        `累计事件不得超过 ${MAX_TOTAL_EVENTS} 条（当前 ${model.event_count}，本批 ${events.length}）`,
      );
    }

    const payloadJson = JSON.stringify(events);
    const dup = this.db
      .prepare('SELECT * FROM batches WHERE model_id = ? AND request_id = ?')
      .get(modelId, requestId) as
      | { id: number; base_version: number; new_version: number; start_seq: number; payload_json: string }
      | undefined;
    if (dup) {
      if (dup.payload_json !== payloadJson) {
        throw new RenoError('REQUEST_ID_CONFLICT', `requestId ${requestId} 已用于不同的事件载荷`);
      }
      return {
        batchId: dup.id,
        version: dup.new_version,
        steps: this.getSteps(modelId, { afterSeq: dup.start_seq - 1 }),
        deduplicated: true,
      };
    }

    if (expectedVersion !== null && expectedVersion !== model.version) {
      throw new RenoError(
        'VERSION_CONFLICT',
        `版本冲突：期望基于版本 ${expectedVersion}，当前版本为 ${model.version}`,
      );
    }

    const state = this.getCurrentState(modelId);
    const planned: RenoStep[] = [];
    // 先在事务外完成全部演算（任何非法事件直接抛错，未写任何数据）。
    let cur = state;
    events.forEach((raw, i) => {
      const step = applyEvent(cur, raw, model.event_count + i + 1, i);
      planned.push(step);
      cur = { cwnd: step.cwnd, ssthresh: step.ssthresh, dupCount: step.dupCount, phase: step.phase };
    });

    const insertBatch = this.db.prepare(
      'INSERT INTO batches (model_id, request_id, base_version, new_version, start_seq, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertEvent = this.db.prepare(`
      INSERT INTO events (
        model_id, seq, batch_id, event_type, event_flight_size,
        cwnd, ssthresh, dup_count, phase, action,
        before_cwnd, before_ssthresh, before_dup_count, before_phase, explanation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateModel = this.db.prepare(
      'UPDATE models SET version = ?, event_count = ? WHERE id = ? AND version = ?',
    );

    const tx = this.db.exec.bind(this.db);
    tx('BEGIN IMMEDIATE');
    try {
      const info = insertBatch.run(
        modelId,
        requestId,
        model.version,
        model.version + 1,
        model.event_count + 1,
        payloadJson,
      );
      const batchId = Number(info.lastInsertRowid);
      for (const s of planned) {
        insertEvent.run(
          modelId,
          s.seq,
          batchId,
          s.event.type,
          (s.event as RenoEventInput).flightSize ?? null,
          s.cwnd,
          s.ssthresh,
          s.dupCount,
          s.phase,
          s.action,
          s.before.cwnd,
          s.before.ssthresh,
          s.before.dupCount,
          s.before.phase,
          JSON.stringify(s.explanation),
        );
      }
      const upd = updateModel.run(model.version + 1, model.event_count + planned.length, modelId, model.version);
      if (Number(upd.changes) !== 1) {
        throw new RenoError('VERSION_CONFLICT', '并发提交导致版本冲突，本批次已回滚');
      }
      tx('COMMIT');
    } catch (err) {
      try {
        tx('ROLLBACK');
      } catch {
        /* ignore */
      }
      if (err instanceof RenoError) throw err;
      throw new RenoError('STORAGE_ERROR', `存储失败，批次已回滚: ${(err as Error).message}`);
    }

    return {
      batchId: Number(
        (this.db.prepare('SELECT id FROM batches WHERE model_id = ? AND request_id = ?').get(modelId, requestId) as { id: bigint }).id,
      ),
      version: model.version + 1,
      steps: planned,
      deduplicated: false,
    };
  }

  private rowToStep(r: StepRow): RenoStep {
    return {
      seq: r.seq,
      event: { type: r.event_type as RenoEventInput['type'], ...(r.event_flight_size != null ? { flightSize: r.event_flight_size } : {}) },
      cwnd: r.cwnd,
      ssthresh: r.ssthresh,
      dupCount: r.dup_count,
      phase: r.phase,
      action: r.action,
      before: {
        cwnd: r.before_cwnd,
        ssthresh: r.before_ssthresh,
        dupCount: r.before_dup_count,
        phase: r.before_phase,
      },
      explanation: JSON.parse(r.explanation),
    };
  }

  getSteps(modelId: string, opts: { afterSeq?: number; limit?: number; offset?: number } = {}): RenoStep[] {
    this.requireModel(modelId);
    const limit = opts.limit ?? MAX_TOTAL_EVENTS;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE model_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ? OFFSET ?`,
      )
      .all(modelId, opts.afterSeq ?? 0, limit, offset) as unknown as StepRow[];
    return rows.map((r) => this.rowToStep(r));
  }

  getStep(modelId: string, seq: number): RenoStep | null {
    this.requireModel(modelId);
    const r = this.db
      .prepare('SELECT * FROM events WHERE model_id = ? AND seq = ?')
      .get(modelId, seq) as StepRow | undefined;
    return r ? this.rowToStep(r) : null;
  }

  /** 导出模型初态与全部原始事件（保留原始事件供复核）。 */
  export(modelId: string): { model: ModelRow; initial: { cwnd: number; ssthresh: number }; events: RenoEventInput[] } {
    const model = this.requireModel(modelId);
    const rows = this.db
      .prepare('SELECT event_type, event_flight_size FROM events WHERE model_id = ? ORDER BY seq ASC')
      .all(modelId) as { event_type: string; event_flight_size: number | null }[];
    return {
      model,
      initial: { cwnd: model.initial_cwnd, ssthresh: model.initial_ssthresh },
      events: rows.map((r) => ({
        type: r.event_type as RenoEventInput['type'],
        ...(r.event_flight_size != null ? { flightSize: r.event_flight_size } : {}),
      })),
    };
  }

  listBatches(modelId: string): { id: number; requestId: string; baseVersion: number; newVersion: number }[] {
    this.requireModel(modelId);
    const rows = this.db
      .prepare('SELECT id, request_id, base_version, new_version FROM batches WHERE model_id = ? ORDER BY id ASC')
      .all(modelId) as { id: number; request_id: string; base_version: number; new_version: number }[];
    return rows.map((r) => ({ id: r.id, requestId: r.request_id, baseVersion: r.base_version, newVersion: r.new_version }));
  }
}
