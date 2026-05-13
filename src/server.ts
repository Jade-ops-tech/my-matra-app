import 'dotenv/config';

import express from 'express';

import { mastra } from './mastra/index.js';

/**
 * HTTP 入口：异步触发 Mastra 工作流（立即返回，不阻塞等待 LLM）。
 * 工作流须从已注册的 Mastra 实例获取；调用链为 createRun → startAsync。
 *
 * 说明：`cryptoAnalysisFlow`（id: ict-wyckoff-scanner）当前输入 schema 仅有 `symbol`；
 * `timeframe` 由接口接收便于前端统一传参，尚未接入该工作流。企微推送请使用工作流 `pdArrayReportFlow`。
 */
const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

app.post('/api/analyze', async (req, res) => {
  const { symbol, timeframe } = req.body as { symbol?: string; timeframe?: string };

  if (!symbol || !timeframe) {
    return res.status(400).json({ error: '参数缺失: 需要 symbol 和 timeframe' });
  }

  try {
    const workflow = mastra.getWorkflow('cryptoAnalysisFlow');

    void (async () => {
      try {
        const run = await workflow.createRun();
        const { runId } = await run.startAsync({
          inputData: { symbol },
        });
        console.log('[api/analyze] cryptoAnalysisFlow 后台已启动', { runId, symbol, timeframe });
      } catch (err) {
        console.error('[api/analyze] 工作流执行异常:', err);
      }
    })();

    res.json({
      success: true,
      message: `🤖 已唤醒大脑！正在对 ${symbol} (${timeframe}) 进行 ICT/威科夫结构分析，请稍后查看工作流结果或日志。`,
    });
  } catch (error) {
    console.error('[api/analyze]', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 交易大脑 HTTP 已启动，监听端口: ${PORT}（POST /api/analyze）`);
});
