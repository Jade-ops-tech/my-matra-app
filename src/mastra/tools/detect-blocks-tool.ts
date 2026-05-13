import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  candleSchema,
  orderCandles,
  type LiquiditySweepCandle,
} from './detect-liquidity-sweep-tool';

type BlockKind = 'bullish_ob' | 'bearish_ob' | 'upper_rejection' | 'lower_rejection' | 'vacuum_gap';

type DetectedBlock = {
  kind: BlockKind;
  /** 在排序后 K 线数组中的索引（触发该形态的「主」K 线索引） */
  index: number;
  zone: [number, number];
};

function isBullish(c: LiquiditySweepCandle): boolean {
  return c.close > c.open;
}

function isBearish(c: LiquiditySweepCandle): boolean {
  return c.close < c.open;
}

/** 阳吞阴：当前阳线实体完全覆盖前一根阴线实体 */
function isBullishEngulfing(prev: LiquiditySweepCandle, cur: LiquiditySweepCandle): boolean {
  if (!isBearish(prev) || !isBullish(cur)) return false;
  return cur.open <= prev.close && cur.close >= prev.open;
}

/** 阴吞阳 */
function isBearishEngulfing(prev: LiquiditySweepCandle, cur: LiquiditySweepCandle): boolean {
  if (!isBullish(prev) || !isBearish(cur)) return false;
  return cur.open >= prev.close && cur.close <= prev.open;
}

function bodySize(c: LiquiditySweepCandle): number {
  return Math.abs(c.close - c.open);
}

function rangeSize(c: LiquiditySweepCandle): number {
  return Math.max(c.high - c.low, Number.EPSILON);
}

/** 中位实体长度（用于判定「强动能」） */
function medianBody(candles: LiquiditySweepCandle[]): number {
  const bodies = candles.map(bodySize).sort((a, b) => a - b);
  const mid = Math.floor(bodies.length / 2);
  if (bodies.length === 0) return 0;
  if (bodies.length % 2 === 1) return bodies[mid]!;
  return (bodies[mid - 1]! + bodies[mid]!) / 2;
}

function isStrongBullishMomentum(
  c: LiquiditySweepCandle,
  referenceBodies: LiquiditySweepCandle[],
  bodyMult: number,
  minBodyToRange: number,
): boolean {
  if (!isBullish(c)) return false;
  const med = medianBody(referenceBodies);
  const body = bodySize(c);
  if (med > 0 && body < bodyMult * med) return false;
  return body / rangeSize(c) >= minBodyToRange;
}

function isStrongBearishMomentum(
  c: LiquiditySweepCandle,
  referenceBodies: LiquiditySweepCandle[],
  bodyMult: number,
  minBodyToRange: number,
): boolean {
  if (!isBearish(c)) return false;
  const med = medianBody(referenceBodies);
  const body = bodySize(c);
  if (med > 0 && body < bodyMult * med) return false;
  return body / rangeSize(c) >= minBodyToRange;
}

/** 订单块：连续三根 K — 反向 K、与其构成完全吞噬的第二根、再后一根强动能；区块取第一根反向 K 的 [top, bottom] */
function detectOrderBlocks(
  sorted: LiquiditySweepCandle[],
  bodyMult: number,
  minBodyToRange: number,
): DetectedBlock[] {
  const out: DetectedBlock[] = [];
  if (sorted.length < 3) return out;

  for (let i = 0; i < sorted.length - 2; i++) {
    const c0 = sorted[i]!;
    const c1 = sorted[i + 1]!;
    const impulse = sorted[i + 2]!;
    const refWindow = sorted.slice(0, i + 2);

    if (isBullishEngulfing(c0, c1) && isStrongBullishMomentum(impulse, refWindow, bodyMult, minBodyToRange)) {
      const top = c0.high;
      const bottom = c0.low;
      out.push({ kind: 'bullish_ob', index: i, zone: [Math.max(top, bottom), Math.min(top, bottom)] });
    }
    if (isBearishEngulfing(c0, c1) && isStrongBearishMomentum(impulse, refWindow, bodyMult, minBodyToRange)) {
      const top = c0.high;
      const bottom = c0.low;
      out.push({ kind: 'bearish_ob', index: i, zone: [Math.max(top, bottom), Math.min(top, bottom)] });
    }
  }
  return out;
}

/** 前序显著高/低：lookback 根内（不含当前）的最高/最低 */
function significantHigh(sorted: LiquiditySweepCandle[], i: number, lookback: number): number {
  const start = Math.max(0, i - lookback);
  let m = -Infinity;
  for (let j = start; j < i; j++) m = Math.max(m, sorted[j]!.high);
  return m;
}

function significantLow(sorted: LiquiditySweepCandle[], i: number, lookback: number): number {
  const start = Math.max(0, i - lookback);
  let m = Infinity;
  for (let j = start; j < i; j++) m = Math.min(m, sorted[j]!.low);
  return m;
}

/** 拒绝块：极长影线 + 影线端刺穿前期显著高/低；区块取影线区间 [top, bottom] */
function detectRejectionBlocks(
  sorted: LiquiditySweepCandle[],
  lookback: number,
  wickToRangeMin: number,
  pierceEps: number,
): DetectedBlock[] {
  const out: DetectedBlock[] = [];
  const start = Math.max(1, lookback);
  for (let i = start; i < sorted.length; i++) {
    const c = sorted[i]!;
    const rng = rangeSize(c);
    const ocTop = Math.max(c.open, c.close);
    const ocBottom = Math.min(c.open, c.close);
    const upperWick = c.high - ocTop;
    const lowerWick = ocBottom - c.low;

    const sigHi = significantHigh(sorted, i, lookback);
    const sigLo = significantLow(sorted, i, lookback);

    if (upperWick / rng >= wickToRangeMin && c.high > sigHi + pierceEps * rng) {
      out.push({
        kind: 'upper_rejection',
        index: i,
        zone: [c.high, ocTop],
      });
    }
    if (lowerWick / rng >= wickToRangeMin && c.low < sigLo - pierceEps * rng) {
      out.push({
        kind: 'lower_rejection',
        index: i,
        zone: [ocBottom, c.low],
      });
    }
  }
  return out;
}

/** 真空块：相邻 K 收盘到开盘的大幅跳空；区间为缺口 [top, bottom] */
function detectVacuumBlocks(
  sorted: LiquiditySweepCandle[],
  minGapPercent: number,
): DetectedBlock[] {
  const out: DetectedBlock[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const ref = Math.max(Math.abs(prev.close), Number.EPSILON);
    const gap = cur.open - prev.close;
    const pct = Math.abs(gap) / ref;
    if (pct < minGapPercent) continue;
    const top = Math.max(prev.close, cur.open);
    const bottom = Math.min(prev.close, cur.open);
    out.push({ kind: 'vacuum_gap', index: i, zone: [top, bottom] });
  }
  return out;
}

const blockItemSchema = z.object({
  kind: z.enum(['bullish_ob', 'bearish_ob', 'upper_rejection', 'lower_rejection', 'vacuum_gap']),
  index: z.number().int().nonnegative(),
  top: z.number(),
  bottom: z.number(),
});

export type BlockScanItem = z.infer<typeof blockItemSchema>;

export type ScanDetectBlocksParams = Partial<{
  lookback: number;
  strongBodyMultiplier: number;
  minBodyToRangeRatio: number;
  wickToRangeMin: number;
  pierceEpsilon: number;
  minGapPercent: number;
  maxResultsPerKind: number;
}>;

/** 供 Workflow / 并行扫描复用，与 detectBlocksTool 默认参数一致（可将 maxResultsPerKind 调大以填满原始池） */
export function scanDetectBlocks(
  candles: LiquiditySweepCandle[],
  params?: ScanDetectBlocksParams,
): { orderBlocks: BlockScanItem[]; rejectionBlocks: BlockScanItem[]; vacuumBlocks: BlockScanItem[] } {
  const lookback = params?.lookback ?? 20;
  const strongBodyMultiplier = params?.strongBodyMultiplier ?? 1.35;
  const minBodyToRangeRatio = params?.minBodyToRangeRatio ?? 0.55;
  const wickToRangeMin = params?.wickToRangeMin ?? 0.5;
  const pierceEpsilon = params?.pierceEpsilon ?? 0.0001;
  const minGapPercent = params?.minGapPercent ?? 0.003;
  const maxResultsPerKind = params?.maxResultsPerKind ?? 10;

  const sorted = orderCandles(candles);
  const obs = detectOrderBlocks(sorted, strongBodyMultiplier, minBodyToRangeRatio);
  const rejs = detectRejectionBlocks(sorted, lookback, wickToRangeMin, pierceEpsilon);
  const vacs = detectVacuumBlocks(sorted, minGapPercent);

  const toItems = (blocks: DetectedBlock[]) =>
    blocks
      .slice(-maxResultsPerKind)
      .reverse()
      .map((b) => ({
        kind: b.kind,
        index: b.index,
        top: b.zone[0],
        bottom: b.zone[1],
      }));

  const obOnly = obs.filter((b) => b.kind === 'bullish_ob' || b.kind === 'bearish_ob');
  const rejOnly = rejs.filter((b) => b.kind === 'upper_rejection' || b.kind === 'lower_rejection');
  const vacOnly = vacs.filter((b) => b.kind === 'vacuum_gap');

  return {
    orderBlocks: toItems(obOnly),
    rejectionBlocks: toItems(rejOnly),
    vacuumBlocks: toItems(vacOnly),
  };
}

export const detectBlocksTool = createTool({
  id: 'detect-blocks',
  description:
    '订单块与形态扫描：① 订单块(OB)——强动能前一根反向 K 线，且前两根满足阳吞阴/阴吞阳完全吞噬，区块为反向 K 线 [top,bottom]；② 拒绝块——极长上/下影线且刺穿前期显著高/低；③ 真空块——相邻 K 线开盘相对前收的大幅跳空缺口区间。',
  inputSchema: z.object({
    candles: z
      .array(candleSchema)
      .min(3)
      .describe('K 线；若均含 time 则按 time 升序，否则视为已按时间升序（最后一根为最近）'),
    lookback: z
      .number()
      .int()
      .min(3)
      .max(200)
      .optional()
      .default(20)
      .describe('拒绝块：判定「前期显著高/低」的回看根数'),
    strongBodyMultiplier: z
      .number()
      .positive()
      .optional()
      .default(1.35)
      .describe('订单块：强动能 K 实体相对历史中位实体的最小倍数'),
    minBodyToRangeRatio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.55)
      .describe('订单块：强动能 K 的实体占全长最小比例'),
    wickToRangeMin: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.5)
      .describe('拒绝块：影线占全长最小比例（极长影线）'),
    pierceEpsilon: z
      .number()
      .min(0)
      .max(0.05)
      .optional()
      .default(0.0001)
      .describe('刺穿显著高/低时，超出幅度至少为该 K 全长的倍数'),
    minGapPercent: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.003)
      .describe('真空块：|open - prevClose| / |prevClose| 的最小比例（如 0.003=0.3%）'),
    maxResultsPerKind: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe('每一类最多返回的条数（从最近历史向前取）'),
  }),
  outputSchema: z.object({
    orderBlocks: z.array(blockItemSchema),
    rejectionBlocks: z.array(blockItemSchema),
    vacuumBlocks: z.array(blockItemSchema),
  }),
  execute: async (input) =>
    scanDetectBlocks(input.candles, {
      lookback: input.lookback,
      strongBodyMultiplier: input.strongBodyMultiplier,
      minBodyToRangeRatio: input.minBodyToRangeRatio,
      wickToRangeMin: input.wickToRangeMin,
      pierceEpsilon: input.pierceEpsilon,
      minGapPercent: input.minGapPercent,
      maxResultsPerKind: input.maxResultsPerKind,
    }),
});
