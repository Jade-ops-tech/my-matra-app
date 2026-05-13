import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { detectFVG, detectSweep, fetchKlines } from './utils/technical-analysis';

const marketContextSchema = z.object({
  symbol: z.string(),
  sweepResult: z.object({
    isSweep: z.boolean(),
    sweepPrice: z.number(),
  }),
  fvgResult: z.object({
    hasFVG: z.boolean(),
    fvgZone: z.tuple([z.number(), z.number()]),
    direction: z.enum(['bullish', 'bearish', 'none']),
    hasImpliedFVG: z.boolean(),
    impliedFvgZone: z.tuple([z.number(), z.number()]),
    impliedDirection: z.enum(['bullish', 'bearish', 'none']),
    isInverseFVG: z.boolean(),
    inverseRelativeTo: z.enum(['standard', 'implied', 'none']),
    inverseAtCandleIndex: z.number().int().nonnegative().optional(),
  }),
  latestPrice: z.number(),
});

const fetchMarketContextStep = createStep({
  id: 'fetch-context',
  description: '拉取 K 线并计算 Liquidity Sweep 与 FVG 客观结构',
  inputSchema: z.object({
    symbol: z.string().describe('交易对，如 BTC-USDT 或 ETHUSDT'),
  }),
  outputSchema: marketContextSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data not found');
    }
    const klines = await fetchKlines(inputData.symbol);
    const sweepResult = detectSweep(klines);
    const fvgResult = detectFVG(klines);
    const ordered = [...klines].sort((a, b) => a.time - b.time);
    const latestPrice = ordered[ordered.length - 1].close;
    return {
      symbol: inputData.symbol,
      sweepResult,
      fvgResult,
      latestPrice,
    };
  },
});

const agentAnalysisStep = createStep({
  id: 'agent-analysis',
  description: '由 wyckoffAnalyst 结合结构数据输出威科夫阶段研判',
  inputSchema: marketContextSchema,
  outputSchema: z.object({
    report: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const data = inputData;
    if (!data) {
      throw new Error('Market context not found');
    }
    const agent = mastra?.getAgent('wyckoffAnalyst');
    if (!agent) {
      throw new Error('Agent wyckoffAnalyst not found');
    }
    const prompt = `
标的: ${data.symbol}
当前价格: ${data.latestPrice}
流动性清算状态: ${JSON.stringify(data.sweepResult)}
FVG缺口状态: ${JSON.stringify(data.fvgResult)}

请结合以上客观结构，输出威科夫阶段的分析报告。
`;
    const response = await agent.generate([
      {
        role: 'user',
        content: prompt,
      },
    ]);
    const report =
      typeof response.text === 'string'
        ? response.text
        : Array.isArray(response.text)
          ? response.text.join('')
          : String(response.text ?? '');
    return { report };
  },
});

const cryptoAnalysisFlow = createWorkflow({
  id: 'ict-wyckoff-scanner',
  inputSchema: z.object({
    symbol: z.string().describe('交易对，如 BTC-USDT'),
  }),
  outputSchema: z.object({
    report: z.string(),
  }),
})
  .then(fetchMarketContextStep)
  .then(agentAnalysisStep);

cryptoAnalysisFlow.commit();

export { cryptoAnalysisFlow };
