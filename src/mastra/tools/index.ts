import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export { weatherTool } from './weather-tool';
export { detectLiquiditySweepTool } from './detect-liquidity-sweep-tool';
export { calculateFVGTool } from './calculate-fvg-tool';
export { fetchCryptoNewsTool } from './fetch-crypto-news-tool';
export { detectBlocksTool } from './detect-blocks-tool';
export { trackBlockStatusTool } from './track-block-status-tool';
export { fibonacciMapperTool } from './fibonacci-mapper-tool';
export { fetchPdArrayContextTool } from './fetch-pd-array-context-tool';

export const fetchMarketStructure = createTool({
  id: 'fetch-market-structure',
  description:
    '获取特定标的在当前时间级别的流动性获取（Liquidity Sweep）和公允价值缺口（FVG）数据',
  inputSchema: z.object({
    symbol: z.string().describe('交易对名称，例如 BTC-USDT'),
    timeframe: z.enum(['15m', '1h', '4h', '1d']).describe('K线时间级别'),
  }),
  outputSchema: z.object({
    sweepDetected: z.boolean(),
    fvgZone: z.string(),
    trend: z.string(),
  }),
  execute: async ({ symbol, timeframe }) => {
    void symbol;
    void timeframe;
    return {
      sweepDetected: true,
      fvgZone: '62000-62500',
      trend: 'accumulation',
    };
  },
});
