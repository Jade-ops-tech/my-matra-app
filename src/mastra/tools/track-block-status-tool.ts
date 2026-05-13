import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  candleSchema,
  orderCandles,
  type LiquiditySweepCandle,
} from './detect-liquidity-sweep-tool';

const orderBlockRefSchema = z.object({
  kind: z.enum(['bullish_ob', 'bearish_ob']),
  top: z.number(),
  bottom: z.number(),
  /** 订单块在排序后 K 线数组中的锚点索引（与 detectBlocksTool 的 index 一致，用于只在成形之后追踪） */
  index: z.number().int().nonnegative(),
});

const breakerItemSchema = z.object({
  sourceKind: z.enum(['bullish_ob', 'bearish_ob']),
  formedAtIndex: z.number().int().nonnegative(),
  breakIndex: z.number().int().nonnegative(),
  mssIndex: z.number().int().nonnegative(),
  /** 破坏后角色：多头 OB 被下破+MSS 后作阻力；空头 OB 被上破+MSS 后作支撑 */
  flippedRole: z.enum(['resistance', 'support']),
  zone: z.tuple([z.number(), z.number()]).describe('[top, bottom]，与源 OB 同价区'),
});

const mitigationItemSchema = z.object({
  kind: z.enum(['bearish_after_failed_hh', 'bullish_after_failed_ll']),
  failureSwingIndex: z.number().int().nonnegative(),
  mssIndex: z.number().int().nonnegative(),
  zone: z.tuple([z.number(), z.number()]).describe('[top, bottom]，失败摆动所在 K 线区间'),
});

/** 简易 1-1 分型：摆动高/低 */
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

function normalizeZone(top: number, bottom: number): [number, number] {
  return [Math.max(top, bottom), Math.min(top, bottom)];
}

/** 多头 OB：收盘跌破下沿视为区块被突破 */
function findBullishObBreak(sorted: LiquiditySweepCandle[], obIdx: number, bottom: number): number {
  const start = Math.min(obIdx + 3, sorted.length - 1);
  for (let i = start; i < sorted.length; i++) {
    if (sorted[i]!.close < bottom) return i;
  }
  return -1;
}

/** 空头 OB：收盘突破上沿 */
function findBearishObBreak(sorted: LiquiditySweepCandle[], obIdx: number, top: number): number {
  const start = Math.min(obIdx + 3, sorted.length - 1);
  for (let i = start; i < sorted.length; i++) {
    if (sorted[i]!.close > top) return i;
  }
  return -1;
}

/**
 * 下破 MSS：在 break 之前、OB 之后的摆动低点中，取仍位于需求区上方的回撤低点的最小值作为结构低；
 * break 之后首次收盘低于该结构低视为 MSS。
 */
function findBearishMssAfter(
  sorted: LiquiditySweepCandle[],
  obIdx: number,
  breakIdx: number,
  zoneBottom: number,
): { mssIndex: number; keyLevel: number } | null {
  const pivots = swingLowIndices(sorted, obIdx + 1, breakIdx - 1);
  const lowsFromPivots = pivots.map((j) => sorted[j]!.low).filter((l) => l >= zoneBottom);
  let keyLevel: number;
  if (lowsFromPivots.length > 0) {
    keyLevel = Math.min(...lowsFromPivots);
  } else {
    const slice = sorted.slice(obIdx + 1, breakIdx);
    if (slice.length === 0) return null;
    keyLevel = Math.min(...slice.map((c) => c.low));
  }

  for (let j = breakIdx + 1; j < sorted.length; j++) {
    if (sorted[j]!.close < keyLevel) return { mssIndex: j, keyLevel };
  }
  return null;
}

/**
 * 上破 MSS：在 break 之前取位于供应区下方的反弹高点的最大值为结构高；之后首次收盘高于该水平。
 */
function findBullishMssAfter(
  sorted: LiquiditySweepCandle[],
  obIdx: number,
  breakIdx: number,
  zoneTop: number,
): { mssIndex: number; keyLevel: number } | null {
  const pivots = swingHighIndices(sorted, obIdx + 1, breakIdx - 1);
  const highsFromPivots = pivots.map((j) => sorted[j]!.high).filter((h) => h <= zoneTop);
  let keyLevel: number;
  if (highsFromPivots.length > 0) {
    keyLevel = Math.max(...highsFromPivots);
  } else {
    const slice = sorted.slice(obIdx + 1, breakIdx);
    if (slice.length === 0) return null;
    keyLevel = Math.max(...slice.map((c) => c.high));
  }

  for (let j = breakIdx + 1; j < sorted.length; j++) {
    if (sorted[j]!.close > keyLevel) return { mssIndex: j, keyLevel };
  }
  return null;
}

/** 更低高点后：两高点之间回撤结构低被收盘跌破 → 空头 MSS */
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

/** 更高低点后：两低点之间反弹结构高被收盘突破 → 多头 MSS */
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

type MitigationKind = 'bearish_after_failed_hh' | 'bullish_after_failed_ll';

function detectMitigationBlocks(
  sorted: LiquiditySweepCandle[],
  maxResults: number,
): { kind: MitigationKind; failureSwingIndex: number; mssIndex: number; zone: [number, number] }[] {
  const out: {
    kind: MitigationKind;
    failureSwingIndex: number;
    mssIndex: number;
    zone: [number, number];
  }[] = [];

  const sh = swingHighIndices(sorted, 1, sorted.length - 2);
  const sl = swingLowIndices(sorted, 1, sorted.length - 2);

  // 未能创新高：最近两个摆动高点后高 < 前高，随后下破结构低
  for (let a = 0; a < sh.length - 1; a++) {
    const i1 = sh[a]!;
    const i2 = sh[a + 1]!;
    if (sorted[i2]!.high >= sorted[i1]!.high) continue;

    const mssIdx = mssBearishAfterLowerHigh(sorted, i1, i2);
    if (mssIdx < 0) continue;

    const c = sorted[i2]!;
    out.push({
      kind: 'bearish_after_failed_hh',
      failureSwingIndex: i2,
      mssIndex: mssIdx,
      zone: normalizeZone(c.high, c.low),
    });
  }

  // 未能创新低：最近两个摆动低点后低 > 前低，随后上破结构高
  for (let a = 0; a < sl.length - 1; a++) {
    const i1 = sl[a]!;
    const i2 = sl[a + 1]!;
    if (sorted[i2]!.low <= sorted[i1]!.low) continue;

    const mssIdx = mssBullishAfterHigherLow(sorted, i1, i2);
    if (mssIdx < 0) continue;

    const c = sorted[i2]!;
    out.push({
      kind: 'bullish_after_failed_ll',
      failureSwingIndex: i2,
      mssIndex: mssIdx,
      zone: normalizeZone(c.high, c.low),
    });
  }

  const dedup = new Map<string, (typeof out)[number]>();
  for (const row of out) {
    const key = `${row.kind}:${row.failureSwingIndex}`;
    const prev = dedup.get(key);
    if (!prev || row.mssIndex > prev.mssIndex) dedup.set(key, row);
  }
  const unique = [...dedup.values()];
  unique.sort((x, y) => y.mssIndex - x.mssIndex);
  return unique.slice(0, maxResults);
}

export type OrderBlockRef = z.infer<typeof orderBlockRefSchema>;

export function scanTrackBlockStatus(
  sorted: LiquiditySweepCandle[],
  orderBlocks: OrderBlockRef[],
  maxMitigationResults = 5,
): {
  breakerBlocks: z.infer<typeof breakerItemSchema>[];
  mitigationBlocks: z.infer<typeof mitigationItemSchema>[];
  orderBlockTrack: {
    formedAtIndex: number;
    kind: 'bullish_ob' | 'bearish_ob';
    status: 'intact' | 'broken_only' | 'breaker';
    breakIndex?: number;
    mssIndex?: number;
  }[];
} {
  const breakers: z.infer<typeof breakerItemSchema>[] = [];
  const orderBlockTrack: {
    formedAtIndex: number;
    kind: 'bullish_ob' | 'bearish_ob';
    status: 'intact' | 'broken_only' | 'breaker';
    breakIndex?: number;
    mssIndex?: number;
  }[] = [];

  for (const ob of orderBlocks) {
    const zoneTop = Math.max(ob.top, ob.bottom);
    const zoneBottom = Math.min(ob.top, ob.bottom);

    if (ob.kind === 'bullish_ob') {
      const breakIdx = findBullishObBreak(sorted, ob.index, zoneBottom);
      if (breakIdx < 0) {
        orderBlockTrack.push({
          formedAtIndex: ob.index,
          kind: ob.kind,
          status: 'intact',
        });
        continue;
      }
      const mss = findBearishMssAfter(sorted, ob.index, breakIdx, zoneBottom);
      if (!mss) {
        orderBlockTrack.push({
          formedAtIndex: ob.index,
          kind: ob.kind,
          status: 'broken_only',
          breakIndex: breakIdx,
        });
        continue;
      }
      breakers.push({
        sourceKind: 'bullish_ob',
        formedAtIndex: ob.index,
        breakIndex: breakIdx,
        mssIndex: mss.mssIndex,
        flippedRole: 'resistance',
        zone: normalizeZone(zoneTop, zoneBottom),
      });
      orderBlockTrack.push({
        formedAtIndex: ob.index,
        kind: ob.kind,
        status: 'breaker',
        breakIndex: breakIdx,
        mssIndex: mss.mssIndex,
      });
    } else {
      const breakIdx = findBearishObBreak(sorted, ob.index, zoneTop);
      if (breakIdx < 0) {
        orderBlockTrack.push({
          formedAtIndex: ob.index,
          kind: ob.kind,
          status: 'intact',
        });
        continue;
      }
      const mss = findBullishMssAfter(sorted, ob.index, breakIdx, zoneTop);
      if (!mss) {
        orderBlockTrack.push({
          formedAtIndex: ob.index,
          kind: ob.kind,
          status: 'broken_only',
          breakIndex: breakIdx,
        });
        continue;
      }
      breakers.push({
        sourceKind: 'bearish_ob',
        formedAtIndex: ob.index,
        breakIndex: breakIdx,
        mssIndex: mss.mssIndex,
        flippedRole: 'support',
        zone: normalizeZone(zoneTop, zoneBottom),
      });
      orderBlockTrack.push({
        formedAtIndex: ob.index,
        kind: ob.kind,
        status: 'breaker',
        breakIndex: breakIdx,
        mssIndex: mss.mssIndex,
      });
    }
  }

  const mitRaw = detectMitigationBlocks(sorted, maxMitigationResults);
  const mitigationBlocks: z.infer<typeof mitigationItemSchema>[] = mitRaw.map((m) => ({
    kind: m.kind,
    failureSwingIndex: m.failureSwingIndex,
    mssIndex: m.mssIndex,
    zone: m.zone,
  }));

  return {
    breakerBlocks: breakers,
    mitigationBlocks,
    orderBlockTrack,
  };
}

export const trackBlockStatusTool = createTool({
  id: 'track-block-status',
  description:
    '追踪历史订单块是否演化为 Breaker（先被有效突破，再出现 MSS 结构转换，支撑/阻力角色翻转），并扫描 Mitigation（未创出新高/新低后出现 MSS 的补仓/缓解区）。需传入与 detectBlocksTool 一致的 K 线序及 OB 的 kind/top/bottom/index。',
  inputSchema: z.object({
    candles: z
      .array(candleSchema)
      .min(8)
      .describe('完整 K 线序列（time 升序或已按时间升序，最后一根为最近）'),
    orderBlocks: z
      .array(orderBlockRefSchema)
      .describe('待追踪的有效 OB 列表，通常来自 detectBlocksTool.orderBlocks'),
    maxMitigationResults: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(5)
      .describe('Mitigation 扫描最多返回条数（按最近 MSS 排序）'),
  }),
  outputSchema: z.object({
    breakerBlocks: z.array(breakerItemSchema),
    mitigationBlocks: z.array(mitigationItemSchema),
    /** 与输入 OB 一一对应的追踪摘要 */
    orderBlockTrack: z.array(
      z.object({
        formedAtIndex: z.number().int().nonnegative(),
        kind: z.enum(['bullish_ob', 'bearish_ob']),
        status: z.enum(['intact', 'broken_only', 'breaker']),
        breakIndex: z.number().int().optional(),
        mssIndex: z.number().int().optional(),
      }),
    ),
  }),
  execute: async ({ candles, orderBlocks, maxMitigationResults }) =>
    scanTrackBlockStatus(orderCandles(candles), orderBlocks, maxMitigationResults),
});
