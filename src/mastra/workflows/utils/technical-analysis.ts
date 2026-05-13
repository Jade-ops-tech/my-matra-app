import { analyzeFvgEnhanced } from '../../tools/calculate-fvg-tool';

/** K 线（与工具侧 OHLC 一致，带时间用于排序） */
export type Kline = {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
};

export type SweepResult = { isSweep: boolean; sweepPrice: number };
export type FvgResult = {
  hasFVG: boolean;
  fvgZone: [number, number];
  direction: 'bullish' | 'bearish' | 'none';
  hasImpliedFVG: boolean;
  impliedFvgZone: [number, number];
  impliedDirection: 'bullish' | 'bearish' | 'none';
  isInverseFVG: boolean;
  inverseRelativeTo: 'standard' | 'implied' | 'none';
  inverseAtCandleIndex?: number;
};

/** 将 BTC-USDT / btc_usdt 等规范为 Binance symbol，如 BTCUSDT */
export function normalizeBinanceSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/[-_\s]/g, '');
  if (s.endsWith('USDT') || s.endsWith('USDC') || s.endsWith('BUSD')) return s;
  return `${s}USDT`;
}

export type FetchKlinesOptions = {
  /** Binance K 线周期，如 15m、1h、4h、1d */
  interval?: string;
  limit?: number;
  /**
   * 默认 `usdm_futures`：U 本位永续 `GET /fapi/v1/klines`（示例：`.../klines?symbol=SOLUSDT&interval=4h&limit=150`）。
   * `spot` 为现货 `GET /api/v3/klines`。
   */
  market?: 'usdm_futures' | 'spot';
};

/** 从 Binance 拉取 K 线（公开接口，无需 Key）。默认 USDT 永续；limit 默认 150，最大 1000 */
export async function fetchKlines(symbol: string, options: FetchKlinesOptions | number = 150): Promise<Kline[]> {
  const opts: FetchKlinesOptions = typeof options === 'number' ? { limit: options } : (options ?? {});
  const interval = opts.interval ?? '1h';
  const limit = Math.min(Math.max(opts.limit ?? 150, 10), 1000);
  const market = opts.market ?? 'usdm_futures';
  const sym = normalizeBinanceSymbol(symbol);
  const base =
    market === 'spot'
      ? 'https://api.binance.com/api/v3/klines'
      : 'https://fapi.binance.com/fapi/v1/klines';
  const url = `${base}?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fetchKlines (${market}) failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error('fetchKlines: invalid response shape');
  }
  return raw.map((row) => {
    const r = row as (string | number)[];
    return {
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      time: Number(r[0]),
    };
  });
}

function orderKlinesAscending(klines: Kline[]): Kline[] {
  return [...klines].sort((a, b) => a.time - b.time);
}

/** 与 detectLiquiditySweepTool 一致：前低为除最后一根外最低价；最后一根下刺前低且收盘收回 */
export function detectSweep(klines: Kline[]): SweepResult {
  const sorted = orderKlinesAscending(klines);
  if (sorted.length < 2) {
    return { isSweep: false, sweepPrice: 0 };
  }
  const before = sorted.slice(0, -1);
  const current = sorted[sorted.length - 1];
  const pol = Math.min(...before.map((c) => c.low));
  const isSweep = current.low < pol && current.close > pol;
  return { isSweep, sweepPrice: isSweep ? pol : 0 };
}

/** 与 calculateFVGTool 一致：形态为时间序最后 3 根；含 Implied / Inverse（后续 K 线存在时） */
export function detectFVG(klines: Kline[]): FvgResult {
  const sorted = orderKlinesAscending(klines);
  if (sorted.length < 3) {
    return {
      hasFVG: false,
      fvgZone: [0, 0],
      direction: 'none',
      hasImpliedFVG: false,
      impliedFvgZone: [0, 0],
      impliedDirection: 'none',
      isInverseFVG: false,
      inverseRelativeTo: 'none',
    };
  }
  const end = sorted.length - 1;
  const r = analyzeFvgEnhanced(sorted, end);
  const base: FvgResult = {
    hasFVG: r.hasFVG,
    fvgZone: r.fvgZone,
    direction: r.direction,
    hasImpliedFVG: r.hasImpliedFVG,
    impliedFvgZone: r.impliedFvgZone,
    impliedDirection: r.impliedDirection,
    isInverseFVG: r.isInverseFVG,
    inverseRelativeTo: r.inverseRelativeTo,
  };
  if (r.inverseAtCandleIndex !== undefined) base.inverseAtCandleIndex = r.inverseAtCandleIndex;
  return base;
}
