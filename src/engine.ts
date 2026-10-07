import {
  ACTION_FAST_RETRANSMIT,
  ACTION_NONE,
  ACTION_TIMEOUT_RETRANSMIT,
  ActionName,
  RawEvent,
  RenoState,
  RenoValidationError,
  StateName,
  TransitionResult,
} from "./types";

export { RenoValidationError } from "./types";
export type { RenoState, RawEvent, EventType, StateName } from "./types";

/**
 * 为规避浮点尾差（如 4.25 + 1/4.25），比较/输出保留 6 位小数。
 * 这是显示口径，内部增量仍按 Reno 公式逐条计算。
 */
export function round6(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

export function isPositiveFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

export function isPositiveInteger(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

const EVENT_TYPES = new Set(["ack", "dup_ack", "recovery_ack", "timeout"]);

export function validateInitial(
  cwnd: unknown,
  ssthresh: unknown,
): { cwnd: number; ssthresh: number } {
  if (!isPositiveFiniteNumber(cwnd)) {
    throw new RenoValidationError(
      "INVALID_CWND",
      "initialCwnd 必须为正数（单位 MSS，可为小数）",
    );
  }
  if (!isPositiveInteger(ssthresh)) {
    throw new RenoValidationError(
      "INVALID_SSTHRESH",
      "initialSsthresh 必须为正整数（完整 MSS 段）",
    );
  }
  return { cwnd, ssthresh };
}

/** 初态状态：cwnd < ssthresh 为慢启动，否则为拥塞避免。 */
export function stateForCwnd(cwnd: number, ssthresh: number): StateName {
  return cwnd < ssthresh ? "SLOW_START" : "CONGESTION_AVOIDANCE";
}

export function initialState(cwnd: number, ssthresh: number): RenoState {
  validateInitial(cwnd, ssthresh);
  return {
    cwnd: round6(cwnd),
    ssthresh,
    dupAcks: 0,
    state: stateForCwnd(cwnd, ssthresh),
  };
}

function validateEventType(type: unknown): asserts type is RawEvent["type"] {
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
    throw new RenoValidationError(
      "INVALID_EVENT_TYPE",
      `未知事件类型: ${String(type)}；允许 ack / dup_ack / recovery_ack / timeout`,
    );
  }
}

function requireFlightSize(ev: RawEvent): number {
  if (ev.flightSize === undefined || ev.flightSize === null) {
    throw new RenoValidationError(
      "FLIGHT_SIZE_REQUIRED",
      "第三次 dup_ack 与 timeout 必须显式提供当时 flightSize",
    );
  }
  if (!isPositiveInteger(ev.flightSize)) {
    throw new RenoValidationError(
      "INVALID_FLIGHT_SIZE",
      "flightSize 必须为正整数（完整 MSS 段），不能用 cwnd 代替",
    );
  }
  return ev.flightSize;
}

/** 教学口径：ssthresh = max(2, floor(flightSize / 2))。 */
export function halveFlightSize(flightSize: number): number {
  return Math.max(2, Math.floor(flightSize / 2));
}

/**
 * 纯函数：在 prev 状态上应用一个事件。
 * 所有合法性先于任何状态修改检查，非法事件原样抛出、不改状态。
 */
export function applyEvent(prev: RenoState, ev: RawEvent): TransitionResult {
  validateEventType(ev.type);

  // 恢复中只允许明确的 recovery_ack / timeout；普通 ack 为状态冲突。
  if (prev.state === "FAST_RECOVERY" && ev.type === "ack") {
    throw new RenoValidationError(
      "EVENT_STATE_CONFLICT",
      "快速恢复中不接受普通 ack，请使用 recovery_ack（未实现 NewReno 部分确认）",
    );
  }
  // 恢复外收到 recovery_ack 也是状态冲突。
  if (prev.state !== "FAST_RECOVERY" && ev.type === "recovery_ack") {
    throw new RenoValidationError(
      "EVENT_STATE_CONFLICT",
      "当前不在快速恢复中，recovery_ack 无对应恢复会话",
    );
  }

  const oldCwnd = prev.cwnd;
  const oldSsthresh = prev.ssthresh;
  const oldDup = prev.dupAcks;
  const explanation: string[] = [];
  let cwnd = oldCwnd;
  let ssthresh = oldSsthresh;
  let dupAcks = oldDup;
  let state: StateName = prev.state;
  let action: ActionName = ACTION_NONE;

  explanation.push(
    `事件 seq=${ev.seq} type=${ev.type}；前值 cwnd=${oldCwnd}, ssthresh=${oldSsthresh}, dupAcks=${oldDup}, state=${prev.state}`,
  );

  if (ev.type === "ack") {
    // 新的完整段确认，开启新一轮重复确认计数。
    if (oldCwnd < oldSsthresh) {
      cwnd = round6(oldCwnd + 1);
      explanation.push(`慢启动增量：cwnd = ${oldCwnd} + 1 = ${cwnd}`);
    } else {
      const inc = round6(1 / oldCwnd);
      cwnd = round6(oldCwnd + inc);
      explanation.push(
        `拥塞避免增量：cwnd = ${oldCwnd} + 1/${oldCwnd} = ${oldCwnd} + ${inc} = ${cwnd}`,
      );
    }
    dupAcks = 0;
    state = stateForCwnd(cwnd, ssthresh);
    explanation.push(`新确认清零 dupAcks；依据新窗口判定状态为 ${state}`);
  } else if (ev.type === "dup_ack") {
    if (prev.state === "FAST_RECOVERY") {
      // 恢复中的后续重复确认：每次窗口 +1（inflated），dupAcks 继续累计。
      cwnd = round6(oldCwnd + 1);
      dupAcks = oldDup + 1;
      explanation.push(
        `快速恢复中第 ${dupAcks} 次重复确认：cwnd = ${oldCwnd} + 1 = ${cwnd}`,
      );
    } else {
      const nextDup = oldDup + 1;
      if (nextDup < 3) {
        // 前两次：不改窗口。
        dupAcks = nextDup;
        explanation.push(
          `恢复外第 ${nextDup} 次重复确认（<3）：cwnd 保持 ${oldCwnd}`,
        );
      } else if (nextDup === 3) {
        const flightSize = requireFlightSize(ev);
        ssthresh = halveFlightSize(flightSize);
        cwnd = round6(ssthresh + 3);
        dupAcks = 3;
        state = "FAST_RECOVERY";
        action = ACTION_FAST_RETRANSMIT;
        explanation.push(
          `第 3 次重复确认：flightSize=${flightSize}，ssthresh = max(2, floor(${flightSize}/2)) = ${ssthresh}`,
        );
        explanation.push(
          `进入快速恢复：cwnd = ssthresh + 3 = ${ssthresh} + 3 = ${cwnd}`,
        );
        explanation.push("建议动作：对缺口段执行一次快速重传");
      } else {
        // 理论不可达：恢复外 dup 最多累到 2，第 3 次即进入恢复。
        throw new RenoValidationError(
          "EVENT_STATE_CONFLICT",
          "恢复外重复确认计数异常",
        );
      }
    }
  } else if (ev.type === "recovery_ack") {
    // 前置状态检查保证此时处于 FAST_RECOVERY。
    cwnd = oldSsthresh;
    dupAcks = 0;
    state = stateForCwnd(cwnd, ssthresh);
    explanation.push(
      `完整恢复确认：cwnd 缩回 ssthresh = ${oldSsthresh}，退出快速恢复，dupAcks 清零；状态 ${state}`,
    );
  } else {
    // timeout：任何状态下 cwnd=1，ssthresh 按 flightSize 折半，清空 dup。
    const flightSize = requireFlightSize(ev);
    ssthresh = halveFlightSize(flightSize);
    cwnd = 1;
    dupAcks = 0;
    state = "SLOW_START";
    action = ACTION_TIMEOUT_RETRANSMIT;
    explanation.push(
      `超时：flightSize=${flightSize}，ssthresh = max(2, floor(${flightSize}/2)) = ${ssthresh}`,
    );
    explanation.push("cwnd 强制降为 1，dupAcks 清零，进入慢启动，建议超时重传");
  }

  explanation.push(
    `结果 cwnd=${cwnd}, ssthresh=${ssthresh}, dupAcks=${dupAcks}, state=${state}, action=${action}`,
  );

  return { cwnd, ssthresh, dupAcks, state, action, explanation };
}

/** 依次应用整批事件；任何一条非法即抛出，交由存储层回滚（不产生半步结果）。 */
export function replay(
  start: RenoState,
  events: RawEvent[],
): TransitionResult[] {
  const out: TransitionResult[] = [];
  let cur = start;
  for (const ev of events) {
    const r = applyEvent(cur, ev);
    out.push(r);
    cur = { cwnd: r.cwnd, ssthresh: r.ssthresh, dupAcks: r.dupAcks, state: r.state };
  }
  return out;
}
