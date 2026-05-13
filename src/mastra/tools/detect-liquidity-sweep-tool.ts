import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const candleSchema = z.object({
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  time: z.union([z.string(), z.number()]).optional().describe('可选时间戳或 ISO 字符串，用于排序'),
});

export type LiquiditySweepCandle = z.infer<typeof candleSchema>;

function sortCandlesAscending(candles: LiquiditySweepCandle[]): LiquiditySweepCandle[] {
  return [...candles].sort((a, b) => {
    if (a.time === undefined || b.time === undefined) return 0;
    const ta = typeof a.time === 'number' ? a.time : Date.parse(String(a.time));
    const tb = typeof b.time === 'number' ? b.time : Date.parse(String(b.time));
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });
}

/** 若每根 K 都有 time 则按时间升序；否则假定传入顺序即为时间升序（最后一根为当前 K） */
export function orderCandles(candles: LiquiditySweepCandle[]): LiquiditySweepCandle[] {
  const allHaveTime = candles.every((c) => c.time !== undefined);
  if (!allHaveTime) return [...candles];
  return sortCandlesAscending(candles);
}

/** 前低：当前被检测 K 线之前所有 K 线中的最低价（Previous Old Low） */
function previousOldLow(candlesBeforeCurrent: LiquiditySweepCandle[]): number {
  return Math.min(...candlesBeforeCurrent.map((c) => c.low));
}

export const detectLiquiditySweepTool = createTool({
  id: 'detect-liquidity-sweep',
  description:
    '根据 K 线数组探测流动性获取（Liquidity Sweep）：用前低（当前 K 之前所有 K 的最低价）作参照，判断最新一根 K 是否下刺破前低且收盘价收回至前低之上。',
  inputSchema: z.object({
    candles: z
      .array(candleSchema)
      .min(2)
      .describe(
        'K 线数据。若每根都带 time 则按 time 升序；否则视为已按时间升序传入，且最后一根为待检测的「当前」K 线',
      ),
  }),
  outputSchema: z.object({
    isSweep: z.boolean(),
    sweepPrice: z.number().describe('发生扫单时取被扫的前低价位；未发生时为 0'),
  }),
  execute: async ({ candles }) => {
    const sorted = orderCandles(candles);
    const before = sorted.slice(0, -1);
    const current = sorted[sorted.length - 1];
    const pol = previousOldLow(before);

    const pierced = current.low < pol;
    const reclaimed = current.close > pol;
    const isSweep = pierced && reclaimed;

    return {
      isSweep,
      sweepPrice: isSweep ? pol : 0,
    };
  },
});
