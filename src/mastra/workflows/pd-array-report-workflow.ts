import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { wecomDeliveryStep } from './steps/wecom-delivery';
import { fetchKlines } from './utils/technical-analysis';
import { filterNearestPdBlocks, runPdArrayScanner } from './utils/pd-array-pipeline';

const klineSchema = z.object({
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  time: z.number(),
});

const fetchStepOutput = z.object({
  symbol: z.string(),
  interval: z.string(),
  klines: z.array(klineSchema),
  latestPrice: z.number(),
});

const fetchKlinesStep = createStep({
  id: 'pd-fetch-klines',
  description: 'Step 1：从币安永续拉取 150–200 根 K 线（可配置周期，默认 150）',
  inputSchema: z.object({
    symbol: z.string().describe('如 BTC-USDT'),
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
      .describe('拉取根数，默认 150，范围 150–200'),
  }),
  outputSchema: fetchStepOutput,
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Input data not found');
    // 运行时未必合并 Zod .default()；undefined 时用 4h + 150 根
    const interval = inputData.interval ?? '4h';
    const limit = inputData.limit ?? 150;
    const klines = await fetchKlines(inputData.symbol, { interval, limit });
    const ordered = [...klines].sort((a, b) => a.time - b.time);
    const latestPrice = ordered[ordered.length - 1]!.close;
    return {
      symbol: inputData.symbol,
      interval,
      klines: ordered,
      latestPrice,
    };
  },
});

const rawPoolSchema = z.object({
  blocks: z.object({
    orderBlocks: z.array(z.unknown()),
    rejectionBlocks: z.array(z.unknown()),
    vacuumBlocks: z.array(z.unknown()),
  }),
  track: z.object({
    breakerBlocks: z.array(z.unknown()),
    mitigationBlocks: z.array(z.unknown()),
    orderBlockTrack: z.array(z.unknown()),
  }),
  fib: z.object({
    mssDetected: z.boolean(),
    mssKind: z.enum(['bearish', 'bullish', 'none']),
    mssIndex: z.number().optional(),
    failureSwingIndex: z.number().optional(),
    priorHighestHigh: z.number(),
    igniteClose: z.number(),
    leg: z.number(),
    levels: z.array(z.object({ ratio: z.number(), price: z.number() })),
  }),
  fvgFormations: z.array(z.unknown()),
  latestFvg: z.unknown(),
  sweep: z.unknown(),
});

const scanStepOutput = fetchStepOutput.extend({
  rawPool: rawPoolSchema,
});

const scannerStep = createStep({
  id: 'pd-scanner-pool',
  description: 'Step 2：并行运行 OB / FVG / Breaker / MSS+斐波那契 / Sweep 等扫描，形成原始数据池',
  inputSchema: fetchStepOutput,
  outputSchema: scanStepOutput,
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Fetch output missing');
    const rawPool = await runPdArrayScanner(inputData.klines);
    return { ...inputData, rawPool };
  },
});

const filterStepOutput = scanStepOutput.extend({
  formattedTop3Zh: z.string(),
  top3Json: z.string(),
});

const filterStep = createStep({
  id: 'pd-logic-filter',
  description: 'Step 3：按与现价绝对距离排序，截取最近 3 个区块并格式化为中文上下文',
  inputSchema: scanStepOutput,
  outputSchema: filterStepOutput,
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Scanner output missing');
    const { top3, formattedZh } = filterNearestPdBlocks(inputData.rawPool, inputData.latestPrice, 3);
    return {
      ...inputData,
      formattedTop3Zh: formattedZh,
      top3Json: JSON.stringify(top3, null, 2),
    };
  },
});

const decisionStep = createStep({
  id: 'pd-decision-agent',
  description: 'Step 4：ICT/威科夫决策大脑生成 Markdown 交易计划',
  inputSchema: filterStepOutput,
  outputSchema: z.object({
    report: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Filter output missing');
    // getAgent() 按 Mastra 注册键查找（如 ictPdArrayAnalyst），不是 Agent.id；用 id 请用 getAgentById
    const agent = mastra?.getAgentById('ict-pd-array-analyst');
    if (!agent) throw new Error('Agent id ict-pd-array-analyst not found');

    const fib = inputData.rawPool.fib;
    const sweep = inputData.rawPool.sweep;
    const latestFvg = inputData.rawPool.latestFvg;

    const userPayload = `
## 输入数据（已由程序客观生成，不得臆造数值）

**标的:** ${inputData.symbol}
**周期:** ${inputData.interval}
**当前价格:** ${inputData.latestPrice}

**流动性扫单 (Sweep):** ${JSON.stringify(sweep)}
**最近一根三 K 形态 FVG 摘要:** ${JSON.stringify(latestFvg)}
**斐波那契映射 (fibonacciMapper 同源):** ${JSON.stringify(fib)}

**精选 3 区块（已按与现价距离排序）:**
${inputData.formattedTop3Zh}

**精选 3 结构化 JSON（便于你引用区间边界）:**
${inputData.top3Json}

---

请严格按照系统指令三步法输出最终 Markdown 报告。
`;
    const response = await agent.generate([
      {
        role: 'user',
        content: userPayload,
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

const pdArrayReportFlow = createWorkflow({
  id: 'ict-pd-array-report',
  inputSchema: z.object({
    symbol: z.string().describe('交易对，如 BTC-USDT'),
    interval: z.enum(['15m', '30m', '1h', '2h', '4h', '1d']).optional().default('4h'),
    limit: z.number().int().min(150).max(200).optional().default(150),
  }),
  outputSchema: z.object({
    report: z.string(),
    wecom: z.object({
      attempted: z.boolean(),
      success: z.boolean(),
      errcode: z.number().optional(),
      errmsg: z.string().optional(),
      skippedReason: z.string().optional(),
      msgtype: z.enum(['markdown', 'text', 'none']).optional(),
    }),
  }),
})
  .then(fetchKlinesStep)
  .then(scannerStep)
  .then(filterStep)
  .then(decisionStep)
  .then(wecomDeliveryStep);

pdArrayReportFlow.commit();

export { pdArrayReportFlow };
