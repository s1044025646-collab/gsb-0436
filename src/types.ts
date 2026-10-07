/**
 * TCP Reno 发送侧拥塞控制状态机（教学简化版）。
 * 单位：完整 MSS 段；cwnd 允许小数，ssthresh / flightSize 为整段。
 */

export type StateName = "SLOW_START" | "CONGESTION_AVOIDANCE" | "FAST_RECOVERY";

export type EventType = "ack" | "dup_ack" | "recovery_ack" | "timeout";

/** 模型口径：阈值折半公式。本题固定为 max(2, floor(flightSize / 2))。 */
export const MODEL_VARIANT = "reno-mss-teaching-v1";

export const ACTION_NONE = "NONE";
export const ACTION_FAST_RETRANSMIT = "FAST_RETRANSMIT";
export const ACTION_TIMEOUT_RETRANSMIT = "TIMEOUT_RETRANSMIT";
export type ActionName =
  | typeof ACTION_NONE
  | typeof ACTION_FAST_RETRANSMIT
  | typeof ACTION_TIMEOUT_RETRANSMIT;

/** 一次转移发生前的输入状态。 */
export interface RenoState {
  cwnd: number;
  ssthresh: number;
  dupAcks: number;
  state: StateName;
}

export interface RawEvent {
  seq: number;
  type: EventType;
  /** 第三次 dup_ack 或 timeout 时由用户显式提供（整段）；其他事件忽略。 */
  flightSize?: number;
}

export interface TransitionResult extends RenoState {
  /** 本步建议动作（仅在本步首次触发）。 */
  action: ActionName;
  /** 人类可读的逐步计算依据，前后值均可核对。 */
  explanation: string[];
}

export type RenoErrorCode =
  | "INVALID_CWND"
  | "INVALID_SSTHRESH"
  | "INVALID_FLIGHT_SIZE"
  | "INVALID_EVENT_TYPE"
  | "EVENT_STATE_CONFLICT"
  | "FLIGHT_SIZE_REQUIRED";

export class RenoValidationError extends Error {
  constructor(
    public readonly code: RenoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RenoValidationError";
  }
}
