import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { fetchKlines } from '../workflows/utils/technical-analysis';
import { filterNearestPdBlocks, runPdArrayScanner } from '../workflows/utils/pd-array-pipeline';

/**
 * 供「ICT PD Array 决策大脑」在 Studio 单独对话时使用：数据源与 ict-pd-array-report 工作流 Step1–3 一致
 *（币安 fapi/v1/klines + 同一套扫描与最近 3 区块过滤）。
 */
export const fetchPdArrayContextTool = createTool({
  id: 'fetch-pd-array-context',
  description:
    '从币安 U 本位永续接口 GET /fapi/v1/klines 拉取 K 线，并执行 OB/FVG/Breaker/MSS/斐波那契等扫描，输出距现价最近的 3 个 PD Array 中文摘要及 JSON。若用户在对话中未粘贴工作流结果、只给出交易对与周期，必须先调用本工具再写报告，禁止编造 OHLC。',
  inputSchema: z.object({
    symbol: z.string().describe('交易对，如 BTC-USDT、SOLUSDT'),
    interval: z
      .enum(['15m', '30m', '1h', '2h', '4h', '1d'])
      .optional()
      .default('4h')
      .describe('K 线周期'),
    limit: z
      .number()
      .int()
      .min(150)
      .max(200)
      .optional()
      .default(150)
      .describe('根数，默认 150'),
  }),
  outputSchema: z.object({
    dataSource: z.literal('binance_fapi_v1_klines'),
    symbol: z.string(),
    interval: z.string(),
    limit: z.number(),
    klinesCount: z.number(),
    latestPrice: z.number(),
    sweep: z.unknown(),
    latestFvg: z.unknown(),
    fib: z.unknown(),
    formattedTop3Zh: z.string(),
    top3Json: z.string(),
  }),
  execute: async (input) => {
    const interval = input.interval ?? '4h';
    const limit = input.limit ?? 150;
    const klines = await fetchKlines(input.symbol, {
      interval,
      limit,
      market: 'usdm_futures',
    });
    const ordered = [...klines].sort((a, b) => a.time - b.time);
    const latestPrice = ordered[ordered.length - 1]!.close;
    const rawPool = await runPdArrayScanner(ordered);
    const { top3, formattedZh } = filterNearestPdBlocks(rawPool, latestPrice, 3);

    return {
      dataSource: 'binance_fapi_v1_klines' as const,
      symbol: input.symbol.trim(),
      interval,
      limit,
      klinesCount: ordered.length,
      latestPrice,
      sweep: rawPool.sweep,
      latestFvg: rawPool.latestFvg,
      fib: rawPool.fib,
      formattedTop3Zh: formattedZh,
      top3Json: JSON.stringify(top3, null, 2),
    };
  },
});
