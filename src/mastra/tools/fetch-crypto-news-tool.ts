import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

type CryptoCompareNewsItem = {
  title?: string;
  body?: string;
  url?: string;
  published_on?: number;
  source_info?: { name?: string };
};

type CryptoCompareNewsResponse = {
  Data?: CryptoCompareNewsItem[];
  Message?: string;
};

export const fetchCryptoNewsTool = createTool({
  id: 'fetch-crypto-news',
  description:
    '拉取近期加密/宏观相关英文快讯摘要（CryptoCompare 公开接口），用于辅助判断情绪与事件面；失败时返回空列表与错误说明。',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).default(8).describe('返回条数上限'),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        source: z.string(),
        url: z.string(),
        publishedOn: z.number().optional(),
      }),
    ),
    error: z.string().optional(),
  }),
  execute: async ({ limit }) => {
    const url = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN';
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'mastra-wyckoff-agent/1.0' },
      });
      if (!res.ok) {
        return { items: [], error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as CryptoCompareNewsResponse;
      const data = json.Data ?? [];
      const items = data.slice(0, limit).map((row) => ({
        title: row.title ?? '',
        source: row.source_info?.name ?? 'unknown',
        url: row.url ?? '',
        publishedOn: row.published_on,
      }));
      return { items, error: json.Message && json.Message !== 'News list successfully returned' ? json.Message : undefined };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { items: [], error: msg };
    }
  },
});
