import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import {
  candleSchema,
  orderCandles,
  type LiquiditySweepCandle,
} from './detect-liquidity-sweep-tool';

/** 第一根 K 下影线在价格轴上的闭区间 [low, min(O,C)] */
function lowerShadowRange(c: LiquiditySweepCandle): [number, number] {
  const top = Math.min(c.open, c.close);
  return [c.low, top];
}

/** 第三根 K 上影线在价格轴上的闭区间 [max(O,C), high] */
function upperShadowRange(c: LiquiditySweepCandle): [number, number] {
  const bottom = Math.max(c.open, c.close);
  return [bottom, c.high];
}

function bodyRange(c: LiquiditySweepCandle): [number, number] {
  const lo = Math.min(c.open, c.close);
  const hi = Math.max(c.open, c.close);
  return [lo, hi];
}

export type FvgDirection = 'bullish' | 'bearish' | 'none';
export type InverseSource = 'standard' | 'implied' | 'none';

export type FvgEnhancedResult = {
  hasFVG: boolean;
  fvgZone: [number, number];
  direction: FvgDirection;
  hasImpliedFVG: boolean;
  impliedFvgZone: [number, number];
  impliedDirection: FvgDirection;
  isInverseFVG: boolean;
  inverseRelativeTo: InverseSource;
  inverseAtCandleIndex?: number;
};

/** 标准 FVG（影线定义）+ Implied（仅当无标准时：两实体不相交）+ Inverse（形态结束后 K 线收盘反向击穿整个缺口） */
export function analyzeFvgEnhanced(
  sorted: LiquiditySweepCandle[],
  formationEndIndex: number,
): FvgEnhancedResult {
  const empty: FvgEnhancedResult = {
    hasFVG: false,
    fvgZone: [0, 0],
    direction: 'none',
    hasImpliedFVG: false,
    impliedFvgZone: [0, 0],
    impliedDirection: 'none',
    isInverseFVG: false,
    inverseRelativeTo: 'none',
  };

  if (formationEndIndex < 2 || formationEndIndex >= sorted.length) {
    return empty;
  }

  const c1 = sorted[formationEndIndex - 2]!;
  const c3 = sorted[formationEndIndex]!;

  const [aLo, aHi] = lowerShadowRange(c1);
  const [bLo, bHi] = upperShadowRange(c3);

  let hasFVG = false;
  let fvgZone: [number, number] = [0, 0];
  let direction: FvgDirection = 'none';

  if (aHi < bLo) {
    hasFVG = true;
    fvgZone = [aHi, bLo];
    direction = 'bullish';
  } else if (bHi < aLo) {
    hasFVG = true;
    fvgZone = [bHi, aLo];
    direction = 'bearish';
  }

  let hasImpliedFVG = false;
  let impliedFvgZone: [number, number] = [0, 0];
  let impliedDirection: FvgDirection = 'none';

  if (!hasFVG) {
    const [b1Lo, b1Hi] = bodyRange(c1);
    const [b3Lo, b3Hi] = bodyRange(c3);
    if (b1Hi < b3Lo) {
      hasImpliedFVG = true;
      impliedFvgZone = [b1Hi, b3Lo];
      impliedDirection = 'bullish';
    } else if (b3Hi < b1Lo) {
      hasImpliedFVG = true;
      impliedFvgZone = [b3Hi, b1Lo];
      impliedDirection = 'bearish';
    }
  }

  const findInverse = (
    zone: [number, number],
    dir: 'bullish' | 'bearish',
  ): number | undefined => {
    const [low, high] = zone[0] <= zone[1] ? zone : [zone[1], zone[0]];
    for (let i = formationEndIndex + 1; i < sorted.length; i++) {
      const cl = sorted[i]!.close;
      if (dir === 'bullish' && cl < low) return i;
      if (dir === 'bearish' && cl > high) return i;
    }
    return undefined;
  };

  let isInverseFVG = false;
  let inverseRelativeTo: InverseSource = 'none';
  let inverseAtCandleIndex: number | undefined;

  if (hasFVG && direction !== 'none') {
    const inv = findInverse(fvgZone, direction);
    if (inv !== undefined) {
      isInverseFVG = true;
      inverseRelativeTo = 'standard';
      inverseAtCandleIndex = inv;
    }
  } else if (hasImpliedFVG && impliedDirection !== 'none') {
    const inv = findInverse(impliedFvgZone, impliedDirection);
    if (inv !== undefined) {
      isInverseFVG = true;
      inverseRelativeTo = 'implied';
      inverseAtCandleIndex = inv;
    }
  }

  const out: FvgEnhancedResult = {
    hasFVG,
    fvgZone,
    direction,
    hasImpliedFVG,
    impliedFvgZone,
    impliedDirection,
    isInverseFVG,
    inverseRelativeTo,
  };
  if (inverseAtCandleIndex !== undefined) out.inverseAtCandleIndex = inverseAtCandleIndex;
  return out;
}

export const calculateFVGTool = createTool({
  id: 'calculate-fvg',
  description:
    '根据连续 3 根 K 计算公允价值缺口（FVG）：标准 FVG 比较第 1 根下影区与第 3 根上影区；若无标准 FVG，则用第 1、3 根实体区间检测隐藏在影线内的 Implied FVG。若在形态之后仍有 K 线数据，则检测收盘是否反向击穿整块缺口以标记 Inverse FVG。',
  inputSchema: z.object({
    candles: z
      .array(candleSchema)
      .min(3)
      .describe(
        '按时间升序的 K 线；至少 3 根。默认可视「形态」为最后 3 根；若传入 formationEndIndex，则为以该下标为结束的三根形态',
      ),
    formationEndIndex: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe(
        '可选。三 K FVG 形态的「最后一根」在 candles 中的下标（0-based）；省略则为 len-1。Inverse 仅当该下标之后仍有 K 线时可判定',
      ),
  }),
  outputSchema: z.object({
    hasFVG: z.boolean(),
    fvgZone: z.tuple([z.number(), z.number()]).describe('[下界, 上界]；无标准 FVG 时为 [0,0]'),
    direction: z.enum(['bullish', 'bearish', 'none']).describe('标准 FVG 方向；无则为 none'),
    hasImpliedFVG: z.boolean(),
    impliedFvgZone: z
      .tuple([z.number(), z.number()])
      .describe('Implied FVG [下界,上界]；无则为 [0,0]（仅当无标准 FVG 时可能为 true）'),
    impliedDirection: z.enum(['bullish', 'bearish', 'none']),
    isInverseFVG: z.boolean().describe('是否在形态之后被收盘反向击穿整块缺口（IFVG）'),
    inverseRelativeTo: z
      .enum(['standard', 'implied', 'none'])
      .describe('Inverse 所针对的缺口类型'),
    inverseAtCandleIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('首次确认 Inverse 的 K 线在 candles 排序后数组中的下标'),
  }),
  execute: async ({ candles, formationEndIndex }) => {
    const ordered = orderCandles(candles);
    const end = formationEndIndex ?? ordered.length - 1;
    if (end < 2 || end >= ordered.length) {
      return {
        hasFVG: false,
        fvgZone: [0, 0],
        direction: 'none' as const,
        hasImpliedFVG: false,
        impliedFvgZone: [0, 0],
        impliedDirection: 'none' as const,
        isInverseFVG: false,
        inverseRelativeTo: 'none' as const,
      };
    }

    const r = analyzeFvgEnhanced(ordered, end);
    const base = {
      hasFVG: r.hasFVG,
      fvgZone: r.fvgZone,
      direction: r.direction,
      hasImpliedFVG: r.hasImpliedFVG,
      impliedFvgZone: r.impliedFvgZone,
      impliedDirection: r.impliedDirection,
      isInverseFVG: r.isInverseFVG,
      inverseRelativeTo: r.inverseRelativeTo,
    };
    if (r.inverseAtCandleIndex !== undefined) {
      return { ...base, inverseAtCandleIndex: r.inverseAtCandleIndex };
    }
    return base;
  },
});
