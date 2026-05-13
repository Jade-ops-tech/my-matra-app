import 'dotenv/config';

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

/** 企业微信 text：content 最长 2048 字节；手机端刻意压短 */
const WECOM_TEXT_HARD_MAX = 2040;
/** 行动计划推送目标上限（UTF-8 字节），超出则截断 */
const ACTION_PLAN_PUSH_MAX_BYTES = 1100;

/** 去掉易触发 93017 / 解析异常的不可见控制符（保留 \t \n \r） */
function sanitizeWecomText(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n')
    .trim();
}

function truncateUtf8(text: string, maxBytes: number, ellipsis = '\n…(已截断，详见 Studio)'): string {
  const cleaned = sanitizeWecomText(text);
  const buf = Buffer.from(cleaned, 'utf8');
  if (buf.length <= maxBytes) return cleaned;
  let ell = ellipsis;
  let ellBytes = Buffer.byteLength(ell, 'utf8');
  let budget = maxBytes - ellBytes;
  if (budget < 24) {
    ell = '\n…';
    ellBytes = Buffer.byteLength(ell, 'utf8');
    budget = maxBytes - ellBytes;
  }
  let cut = Math.max(0, budget);
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')}${ell}`;
}

/** 去 Markdown 痕迹，压成适合短信式阅读的纯文本 */
function markdownishToCompactPlain(block: string): string {
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    let t = line.trim();
    if (!t) continue;
    if (/^[-*_]{3,}$/.test(t)) continue;
    t = t.replace(/^#{1,6}\s+/, '');
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/\*([^*]+)\*/g, '$1');
    t = t.replace(/`([^`]+)`/g, '$1');
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/^[-*]\s+/, '· ');
    t = t.replace(/^(\d+)\.\s+/, '$1. ');
    out.push(t.trim());
  }
  return out.join('\n');
}

const HEADING_LINE_RE = /^(\#{1,6})\s+(.+)$/;

/**
 * 仅取「行动计划」小节（含该标题行），遇到同级或更高级 Markdown 标题则结束。
 * 匹配标题中含「行动计划」或 Actionable Plan（不区分大小写）。
 */
function extractActionPlanSection(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_LINE_RE);
    if (!m) continue;
    const level = m[1]!.length;
    const titleText = m[2]!.replace(/[*`]/g, '').trim();
    if (/行动计划/i.test(titleText) || /Actionable\s*Plan/i.test(titleText)) {
      startIdx = i;
      startLevel = level;
      break;
    }
  }

  if (startIdx < 0) return null;

  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > startIdx) {
      const hm = line.match(HEADING_LINE_RE);
      if (hm && hm[1]!.length <= startLevel) break;
    }
    out.push(line);
  }

  const block = out.join('\n').trim();
  return block.length > 0 ? block : null;
}

async function postWecom(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<{ errcode?: number; errmsg?: string }> {
  const body = JSON.stringify(payload);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return (await response.json()) as { errcode?: number; errmsg?: string };
}

/**
 * 将 Agent 报告中「行动计划」小节以纯文本推送到企业微信群机器人（不含前文；内容做精简与截断）。
 * - 配置：`.env` 中 `WECOM_WEBHOOK_URL`（完整 URL，含 key）。
 * - 勿在浏览器里直接打开 Webhook 地址测试：GET 无 JSON 体会返回 errcode 93017。
 * @see https://developer.work.weixin.qq.com/document/path/91770
 */
export const wecomDeliveryStep = createStep({
  id: 'pd-delivery-wecom',
  description: 'Step 5：仅推送精简纯文本「行动计划」到企业微信（text）',
  inputSchema: z.object({
    report: z.string(),
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
  execute: async ({ inputData }) => {
    const report = inputData?.report ?? '';
    if (!report.trim()) {
      return {
        report,
        wecom: {
          attempted: false,
          success: false,
          skippedReason: 'empty_report',
          msgtype: 'none',
        },
      };
    }

    const webhookUrl = process.env.WECOM_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      console.warn('[wecom] 未设置 WECOM_WEBHOOK_URL，跳过推送（请在项目根 .env 写入完整 Webhook URL）');
      return {
        report,
        wecom: {
          attempted: false,
          success: false,
          skippedReason: 'missing_WECOM_WEBHOOK_URL',
          msgtype: 'none',
        },
      };
    }

    const actionBlock = extractActionPlanSection(report);
    const rawPush =
      actionBlock ??
      '【提示】报告中未找到含「行动计划」或 Actionable Plan 的标题，请到 Studio 查看工作流完整报告。';

    if (!actionBlock) {
      console.warn('[wecom] 未解析到「行动计划」小节，推送占位说明（完整报告仍在工作流输出 report 中）');
    }

    const compactPlain = markdownishToCompactPlain(rawPush);
    const textContent = truncateUtf8(compactPlain, Math.min(ACTION_PLAN_PUSH_MAX_BYTES, WECOM_TEXT_HARD_MAX));

    try {
      const result = await postWecom(webhookUrl, {
        msgtype: 'text',
        text: { content: textContent },
      });

      const errcode = result.errcode ?? -1;
      const msgtype: 'markdown' | 'text' = 'text';

      const success = errcode === 0;
      if (!success) {
        console.error('[wecom] 推送失败:', result);
      } else {
        console.info('[wecom] 推送成功', { msgtype });
      }

      return {
        report,
        wecom: {
          attempted: true,
          success,
          errcode,
          errmsg: result.errmsg,
          msgtype,
        },
      };
    } catch (e) {
      console.error('[wecom] 请求异常:', e);
      return {
        report,
        wecom: {
          attempted: true,
          success: false,
          errmsg: e instanceof Error ? e.message : String(e),
          msgtype: 'none',
        },
      };
    }
  },
});
