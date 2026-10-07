import {
  Explanation,
  RenoError,
  RenoEventInput,
  RenoPhase,
  RenoState,
  RenoStep,
  SuggestedAction,
} from './types.js';

/** 浮点口径：增量为 1/cwnd，结果保留 6 位小数后避免 0.30000000000000004 类噪声。 */
export function round6(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

function isPosNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function isPosInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

const VALID_TYPES = new Set(['ack', 'dup_ack', 'recovery_ack', 'timeout']);

/** 校验初态；非法时抛 VALIDATION_ERROR，不产生任何状态变更。 */
export function validateInitial(cwnd: unknown, ssthresh: unknown): { cwnd: number; ssthresh: number } {
  if (!isPosNum(cwnd)) {
    throw new RenoError('VALIDATION_ERROR', '初始拥塞窗口 cwnd 必须为正数（以完整 MSS 段为单位）');
  }
  if (!isPosNum(ssthresh)) {
    throw new RenoError('VALIDATION_ERROR', '慢启动阈值 ssthresh 必须为正数（以完整 MSS 段为单位）');
  }
  return { cwnd: round6(cwnd as number), ssthresh: round6(ssthresh as number) };
}

function phaseFor(cwnd: number, ssthresh: number, inRecovery: boolean): RenoPhase {
  if (inRecovery) return 'fast_recovery';
  return cwnd < ssthresh ? 'slow_start' : 'congestion_avoidance';
}

function validateEvent(ev: unknown, index: number): RenoEventInput {
  if (ev === null || typeof ev !== 'object') {
    throw new RenoError('VALIDATION_ERROR', '事件必须是对象', index);
  }
  const e = ev as Record<string, unknown>;
  if (!VALID_TYPES.has(e.type as string)) {
    throw new RenoError(
      'VALIDATION_ERROR',
      `不支持的事件类型: ${String(e.type)}（允许 ack / dup_ack / recovery_ack / timeout）`,
      index,
    );
  }
  const out: RenoEventInput = { type: e.type as RenoEventInput['type'] };
  if (e.flightSize !== undefined && e.flightSize !== null) {
    if (!isPosInt(e.flightSize)) {
      throw new RenoError('VALIDATION_ERROR', 'flightSize 必须为正整数（完整 MSS 段数）', index);
    }
    out.flightSize = e.flightSize;
  }
  return out;
}

/**
 * 纯函数状态机：给定旧状态与事件，返回一步计算结果。
 * 任何非法输入/状态错误都抛错且不修改传入状态（调用方负责不提交）。
 */
export function applyEvent(prev: RenoState, rawEvent: unknown, seq: number, eventIndex = seq - 1): RenoStep {
  const event = validateEvent(rawEvent, eventIndex);
  const inRecovery = prev.phase === 'fast_recovery';
  const before: RenoState = { ...prev };

  let cwnd = prev.cwnd;
  let ssthresh = prev.ssthresh;
  let dupCount = prev.dupCount;
  let phase = prev.phase;
  let action: SuggestedAction = 'none';
  let explanation: Explanation;

  switch (event.type) {
    case 'ack': {
      if (inRecovery) {
        throw new RenoError(
          'INVALID_STATE',
          '快速恢复中不接受普通 ack，请使用明确的 recovery_ack 表示已覆盖本次恢复全部未确认数据',
          eventIndex,
        );
      }
      if (cwnd < ssthresh) {
        const newCwnd = round6(cwnd + 1);
        explanation = {
          rule: '慢启动：旧窗口小于阈值，普通确认使窗口加一',
          formula: 'cwnd_new = cwnd_old + 1',
          detail: { cwnd_old: cwnd, ssthresh, cwnd_new: newCwnd, dup_count_reset: 0 },
        };
        cwnd = newCwnd;
      } else {
        const inc = round6(1 / cwnd);
        const newCwnd = round6(cwnd + inc);
        explanation = {
          rule: '拥塞避免：旧窗口不小于阈值，普通确认使窗口增加旧窗口的倒数',
          formula: 'cwnd_new = cwnd_old + 1 / cwnd_old',
          detail: { cwnd_old: cwnd, ssthresh, increment: inc, cwnd_new: newCwnd, dup_count_reset: 0 },
        };
        cwnd = newCwnd;
      }
      dupCount = 0;
      phase = phaseFor(cwnd, ssthresh, false);
      break;
    }

    case 'dup_ack': {
      if (inRecovery) {
        // 快速恢复中的后续重复确认：窗口再膨胀一，重复计数继续累加，不再做第三次初始化。
        const newCwnd = round6(cwnd + 1);
        dupCount += 1;
        explanation = {
          rule: '快速恢复中：更多重复确认使窗口每收到一个增加一（可发送数据膨胀）',
          formula: 'cwnd_new = cwnd_old + 1',
          detail: { cwnd_old: cwnd, ssthresh, cwnd_new: newCwnd, dup_count: dupCount },
        };
        cwnd = newCwnd;
      } else {
        dupCount += 1;
        if (dupCount < 3) {
          explanation = {
            rule: `第 ${dupCount} 次重复确认：尚未达到三次，窗口与阈值不变`,
            formula: 'cwnd_new = cwnd_old; ssthresh_new = ssthresh_old',
            detail: { cwnd_old: cwnd, ssthresh, dup_count: dupCount },
          };
        } else if (dupCount === 3) {
          if (!isPosInt(event.flightSize)) {
            throw new RenoError(
              'VALIDATION_ERROR',
              '第三次重复确认必须显式提供当时的 flightSize（正整数），不能用拥塞窗口代替',
              eventIndex,
            );
          }
          const newSsthresh = Math.max(2, Math.floor(event.flightSize / 2));
          const newCwnd = round6(newSsthresh + 3);
          action = 'fast_retransmit';
          explanation = {
            rule: '第三次重复确认：阈值按 max(2, floor(flightSize/2)) 折半，进入快速恢复并建议一次快速重传',
            formula: 'ssthresh_new = max(2, floor(flightSize / 2)); cwnd_new = ssthresh_new + 3',
            detail: {
              flightSize: event.flightSize,
              ssthresh_old: ssthresh,
              ssthresh_new: newSsthresh,
              cwnd_new: newCwnd,
              dup_count: 3,
            },
          };
          ssthresh = newSsthresh;
          cwnd = newCwnd;
          phase = 'fast_recovery';
        } else {
          // dupCount > 3 且不在恢复中：正常口径不会发生（第三次即进入恢复）。
          throw new RenoError('INVALID_STATE', '重复确认计数超过三次但不在快速恢复中，状态不一致', eventIndex);
        }
      }
      break;
    }

    case 'recovery_ack': {
      if (!inRecovery) {
        throw new RenoError('INVALID_STATE', '恢复外收到 recovery_ack：当前不在快速恢复状态', eventIndex);
      }
      const newCwnd = round6(ssthresh);
      dupCount = 0;
      phase = phaseFor(newCwnd, ssthresh, false);
      explanation = {
        rule: '恢复确认：已覆盖本次恢复全部未确认数据，窗口回到阈值并退出快速恢复',
        formula: 'cwnd_new = ssthresh; dup_count = 0',
        detail: { cwnd_old: cwnd, ssthresh, cwnd_new: newCwnd, dup_count_reset: 0 },
      };
      cwnd = newCwnd;
      break;
    }

    case 'timeout': {
      if (!isPosInt(event.flightSize)) {
        throw new RenoError(
          'VALIDATION_ERROR',
          'timeout 必须显式提供当时的 flightSize（正整数），不能用拥塞窗口代替',
          eventIndex,
        );
      }
      const newSsthresh = Math.max(2, Math.floor(event.flightSize / 2));
      const newCwnd = 1;
      action = 'timeout_retransmit';
      explanation = {
        rule: '超时：任何状态下阈值按 max(2, floor(flightSize/2)) 折半，窗口降为一，清空重复计数并建议超时重传',
        formula: 'ssthresh_new = max(2, floor(flightSize / 2)); cwnd_new = 1; dup_count = 0',
        detail: {
          flightSize: event.flightSize,
          ssthresh_old: ssthresh,
          ssthresh_new: newSsthresh,
          cwnd_old: cwnd,
          cwnd_new: 1,
          dup_count_reset: 0,
        },
      };
      ssthresh = newSsthresh;
      cwnd = newCwnd;
      dupCount = 0;
      phase = 'slow_start';
      break;
    }
  }

  const after: RenoState = { cwnd, ssthresh, dupCount, phase };
  return { seq, event, before, ...after, action, explanation };
}

export function initialState(cwnd: number, ssthresh: number): RenoState {
  return {
    cwnd: round6(cwnd),
    ssthresh: round6(ssthresh),
    dupCount: 0,
    phase: phaseFor(cwnd, ssthresh, false),
  };
}

/** 批量演算（不落盘），供测试与演示复用；首条非法事件即整体失败，不会返回半成品。 */
export function replay(initialCwnd: number, initialSsthresh: number, events: unknown[]): RenoStep[] {
  const { cwnd, ssthresh } = validateInitial(initialCwnd, initialSsthresh);
  let state = initialState(cwnd, ssthresh);
  const steps: RenoStep[] = [];
  events.forEach((raw, i) => {
    const step = applyEvent(state, raw, i + 1);
    steps.push(step);
    state = { cwnd: step.cwnd, ssthresh: step.ssthresh, dupCount: step.dupCount, phase: step.phase };
  });
  return steps;
}
