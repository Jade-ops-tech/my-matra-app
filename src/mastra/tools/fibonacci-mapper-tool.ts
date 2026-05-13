import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  candleSchema,
  orderCandles,
  type LiquiditySweepCandle,
} from './detect-liquidity-sweep-tool';

/** 简易 1-1 分型摆动高 */
function swingHighIndices(candles: LiquiditySweepCandle[], from: number, to: number): number[] {
  const out: number[] = [];
  const lo = Math.max(1, from);
  const hi = Math.min(to, candles.length - 2);
  for (let i = lo; i <= hi; i++) {
    const c = candles[i]!;
    if (c.high > candles[i - 1]!.high && c.high > candles[i + 1]!.high) out.push(i);
  }
  return out;
}

function swingLowIndices(candles: LiquiditySweepCandle[], from: number, to: number): number[] {
  const out: number[] = [];
  const lo = Math.max(1, from);
  const hi = Math.min(to, candles.length - 2);
  for (let i = lo; i <= hi; i++) {
    const c = candles[i]!;
    if (c.low < candles[i - 1]!.low && c.low < candles[i + 1]!.low) out.push(i);
  }
  return out;
}

function mssBearishAfterLowerHigh(
  sorted: LiquiditySweepCandle[],
  firstHighIdx: number,
  secondHighIdx: number,
): number {
  const pivots = swingLowIndices(sorted, firstHighIdx + 1, secondHighIdx - 1);
  let keyLevel: number;
  if (pivots.length > 0) {
    keyLevel = Math.min(...pivots.map((j) => sorted[j]!.low));
  } else {
    const slice = sorted.slice(firstHighIdx + 1, secondHighIdx);
    if (slice.length === 0) return -1;
    keyLevel = Math.min(...slice.map((c) => c.low));
  }
  for (let j = secondHighIdx + 1; j < sorted.length; j++) {
    if (sorted[j]!.close < keyLevel) return j;
  }
  return -1;
}

function mssBullishAfterHigherLow(
  sorted: LiquiditySweepCandle[],
  firstLowIdx: number,
  secondLowIdx: number,
): number {
  const pivots = swingHighIndices(sorted, firstLowIdx + 1, secondLowIdx - 1);
  let keyLevel: number;
  if (pivots.length > 0) {
    keyLevel = Math.max(...pivots.map((j) => sorted[j]!.high));
  } else {
    const slice = sorted.slice(firstLowIdx + 1, secondLowIdx);
    if (slice.length === 0) return -1;
    keyLevel = Math.max(...slice.map((c) => c.high));
  }
  for (let j = secondLowIdx + 1; j < sorted.length; j++) {
    if (sorted[j]!.close > keyLevel) return j;
  }
  return -1;
}

export type LatestMss = {
  kind: 'bearish' | 'bullish';
  mssIndex: number;
  failureSwingIndex: number;
};

/** 与 trackBlockStatusTool 一致的 MSS 扫描：取时间上最近的一次 MSS */
export function findLatestMss(sorted: LiquiditySweepCandle[]): LatestMss | null {
  let best: LatestMss | null = null;

  const sh = swingHighIndices(sorted, 1, sorted.length - 2);
  for (let a = 0; a < sh.length - 1; a++) {
    const i1 = sh[a]!;
    const i2 = sh[a + 1]!;
    if (sorted[i2]!.high >= sorted[i1]!.high) continue;
    const mssIdx = mssBearishAfterLowerHigh(sorted, i1, i2);
    if (mssIdx < 0) continue;
    if (!best || mssIdx > best.mssIndex) best = { kind: 'bearish', mssIndex: mssIdx, failureSwingIndex: i2 };
  }

  const sl = swingLowIndices(sorted, 1, sorted.length - 2);
  for (let a = 0; a < sl.length - 1; a++) {
    const i1 = sl[a]!;
    const i2 = sl[a + 1]!;
    if (sorted[i2]!.low <= sorted[i1]!.low) continue;
    const mssIdx = mssBullishAfterHigherLow(sorted, i1, i2);
    if (mssIdx < 0) continue;
    if (!best || mssIdx > best.mssIndex) best = { kind: 'bullish', mssIndex: mssIdx, failureSwingIndex: i2 };
  }

  return best;
}

const EXT_NEG_MULTIPLIERS = [1, 2, 2.5, 4] as const;
const EXT_NEG_LABELS = [-1, -2, -2.5, -4] as const;

export type FibConsensusLevels = {
  ratio: number;
  price: number;
}[];

/** 共识映射：0=前期最高，1=起爆收盘；负号扩展位 = 起爆 - m*(最高-起爆)，m∈{1,2,2.5,4} 对应标签 -1,-2,-2.5,-4 */
export function fibLevelsFromHighToIgnite(priorHighestHigh: number, igniteClose: number): FibConsensusLevels {
  const leg = priorHighestHigh - igniteClose;
  const rows: FibConsensusLevels = [
    { ratio: 0, price: priorHighestHigh },
    { ratio: 1, price: igniteClose },
  ];
  for (let k = 0; k < EXT_NEG_MULTIPLIERS.length; k++) {
    const m = EXT_NEG_MULTIPLIERS[k]!;
    const label = EXT_NEG_LABELS[k]!;
    rows.push({ ratio: label, price: igniteClose - m * leg });
  }
  return rows;
}

const levelRowSchema = z.object({
  ratio: z.number(),
  price: z.number(),
});

export type FibonacciMapperResult = {
  mssDetected: boolean;
  mssKind: 'bearish' | 'bullish' | 'none';
  mssIndex?: number;
  failureSwingIndex?: number;
  priorHighestHigh: number;
  igniteClose: number;
  leg: number;
  levels: FibConsensusLevels;
};

/** Workflow 并行扫描用，与 fibonacciMapperTool 输出一致 */
export function analyzeFibonacciMapper(sorted: LiquiditySweepCandle[]): FibonacciMapperResult {
  const mss = findLatestMss(sorted);

  if (!mss) {
    return {
      mssDetected: false,
      mssKind: 'none',
      priorHighestHigh: 0,
      igniteClose: 0,
      leg: 0,
      levels: [],
    };
  }

  let peak = -Infinity;
  for (let i = 0; i <= mss.mssIndex; i++) {
    peak = Math.max(peak, sorted[i]!.high);
  }
  const ignite = sorted[mss.mssIndex]!.close;
  const leg = peak - ignite;
  const levels = fibLevelsFromHighToIgnite(peak, ignite);

  return {
    mssDetected: true,
    mssKind: mss.kind,
    mssIndex: mss.mssIndex,
    failureSwingIndex: mss.failureSwingIndex,
    priorHighestHigh: peak,
    igniteClose: ignite,
    leg,
    levels,
  };
}

export const fibonacciMapperTool = createTool({
  id: 'fibonacci-mapper',
  description:
    '斐波那契共识映射：在 K 线序列上自动寻找最近一次的 MSS（与 trackBlockStatusTool 一致的 LH/HL + 结构突破规则）。若存在 MSS，取 [0..MSS] 区间内最高价作为锚点「0」，MSS 当根收盘价为「1」起爆点；扩展位 -1、-2、-2.5、-4 对应价格 = 起爆 - m×(最高-起爆)，m 分别为 1、2、2.5、4（沿最高→起爆方向继续延伸）。',
  inputSchema: z.object({
    candles: z
      .array(candleSchema)
      .min(8)
      .describe('按时间升序的 K 线；需足够长度以稳定分型'),
  }),
  outputSchema: z.object({
    mssDetected: z.boolean(),
    mssKind: z.enum(['bearish', 'bullish', 'none']),
    mssIndex: z.number().int().nonnegative().optional(),
    failureSwingIndex: z.number().int().nonnegative().optional(),
    /** 自序列起点至 MSS 根（含）内的最高价，作为斐波 0 锚 */
    priorHighestHigh: z.number(),
    /** MSS 当根收盘价，作为斐波 1（起爆） */
    igniteClose: z.number(),
    /** leg = priorHighestHigh - igniteClose，用于扩展 */
    leg: z.number(),
    levels: z
      .array(levelRowSchema)
      .describe('仅当 mssDetected 时为 6 条：ratio 0, 1, -1, -2, -2.5, -4；否则为空'),
  }),
  execute: async ({ candles }) => analyzeFibonacciMapper(orderCandles(candles)),
});
