/** TCP Reno 教学回放支持的事件类型。 */
export type EventType = 'ack' | 'dup_ack' | 'recovery_ack' | 'timeout';

/** 发送侧教学口径下的拥塞控制状态。 */
export type RenoPhase = 'slow_start' | 'congestion_avoidance' | 'fast_recovery';

/** 建议的重传动作（仅为建议，不真正发送任何报文）。 */
export type SuggestedAction = 'none' | 'fast_retransmit' | 'timeout_retransmit';

/** 单个输入事件。flightSize 仅在第三次重复确认与 timeout 时需要。 */
export interface RenoEventInput {
  type: EventType;
  flightSize?: number;
}

/** 一步计算后的完整状态与解释。 */
export interface RenoState {
  /** 拥塞窗口，单位为完整 MSS 段，可为小数。 */
  cwnd: number;
  /** 慢启动阈值（整段）。 */
  ssthresh: number;
  /** 当前缺口的连续重复确认计数。 */
  dupCount: number;
  phase: RenoPhase;
}

export interface RenoStep extends RenoState {
  seq: number;
  action: SuggestedAction;
  event: RenoEventInput;
  /** 本步计算前的状态，供核对。 */
  before: RenoState;
  explanation: Explanation;
}

export interface Explanation {
  rule: string;
  formula: string;
  detail: Record<string, number | string>;
}

/** 校验/状态类错误，携带稳定错误码。 */
export class RenoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly eventIndex?: number,
  ) {
    super(message);
    this.name = 'RenoError';
  }
}

/** 公开的批次长度与累计事件上限。 */
export const MAX_BATCH_EVENTS = 200;
export const MAX_TOTAL_EVENTS = 100_000;
