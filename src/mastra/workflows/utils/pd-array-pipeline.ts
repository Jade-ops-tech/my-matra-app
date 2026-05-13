import { analyzeFvgEnhanced } from '../../tools/calculate-fvg-tool';
import { orderCandles, type LiquiditySweepCandle } from '../../tools/detect-liquidity-sweep-tool';
import { scanDetectBlocks } from '../../tools/detect-blocks-tool';
import { analyzeFibonacciMapper, type FibonacciMapperResult } from '../../tools/fibonacci-mapper-tool';
import { scanTrackBlockStatus, type OrderBlockRef } from '../../tools/track-block-status-tool';
import type { Kline } from './technical-analysis';
import { detectFVG, detectSweep, type FvgResult, type SweepResult } from './technical-analysis';

export type FvgFormationRow = {
  formationEndIndex: number;
  zone: [number, number];
  direction: 'bullish' | 'bearish' | 'none';
  isInverseFVG: boolean;
};

export type RawScannerPool = {
  blocks: ReturnType<typeof scanDetectBlocks>;
  track: ReturnType<typeof scanTrackBlockStatus>;
  fib: FibonacciMapperResult;
  fvgFormations: FvgFormationRow[];
  latestFvg: FvgResult;
  sweep: SweepResult;
};

/** 价格到闭区间的最短距离（落在区间内为 0） */
export function distanceToZone(price: number, bottom: number, top: number): number {
  const lo = Math.min(bottom, top);
  const hi = Math.max(bottom, top);
  if (price >= lo && price <= hi) return 0;
  return Math.min(Math.abs(price - lo), Math.abs(price - hi));
}

export function klinesToCandles(klines: Kline[]): LiquiditySweepCandle[] {
  return klines.map((k) => ({
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    time: k.time,
  }));
}

function collectStandardFvgs(sorted: LiquiditySweepCandle[], max = 40): FvgFormationRow[] {
  const out: FvgFormationRow[] = [];
  for (let e = 2; e < sorted.length; e++) {
    const r = analyzeFvgEnhanced(sorted, e);
    if (!r.hasFVG || r.direction === 'none') continue;
    const lo = Math.min(r.fvgZone[0], r.fvgZone[1]);
    const hi = Math.max(r.fvgZone[0], r.fvgZone[1]);
    out.push({
      formationEndIndex: e,
      zone: [lo, hi],
      direction: r.direction,
      isInverseFVG: r.isInverseFVG,
    });
  }
  return out.slice(-max);
}

/** Step 2：并行式扫描（单线程 Promise.all 聚合），产出原始 PD 池 */
export async function runPdArrayScanner(klines: Kline[]): Promise<RawScannerPool> {
  const sortedK = [...klines].sort((a, b) => a.time - b.time);
  const candles = klinesToCandles(sortedK);
  const ordered = orderCandles(candles);

  const [blocks, latestFvg, sweep] = await Promise.all([
    Promise.resolve(scanDetectBlocks(ordered, { maxResultsPerKind: 50 })),
    Promise.resolve(detectFVG(sortedK)),
    Promise.resolve(detectSweep(sortedK)),
  ]);

  const obRefs: OrderBlockRef[] = blocks.orderBlocks.map((o) => ({
    kind: o.kind,
    top: o.top,
    bottom: o.bottom,
    index: o.index,
  }));

  const [track, fib, fvgFormations] = await Promise.all([
    Promise.resolve(scanTrackBlockStatus(ordered, obRefs, 25)),
    Promise.resolve(analyzeFibonacciMapper(ordered)),
    Promise.resolve(collectStandardFvgs(ordered, 40)),
  ]);

  return { blocks, track, fib, fvgFormations, latestFvg, sweep };
}

export type FilteredPdBlock = {
  rank: number;
  category: string;
  top: number;
  bottom: number;
  distanceToPrice: number;
  narrativeZh: string;
};

function zoneNarrative(label: string, bottom: number, top: number, tail: string): string {
  const lo = Math.min(bottom, top);
  const hi = Math.max(bottom, top);
  return `${label}：价格区间约 ${lo.toFixed(4)} – ${hi.toFixed(4)}。${tail}`;
}

/** Step 3：按与现价距离排序，取最近 3 个，并生成中文说明 */
export function filterNearestPdBlocks(
  pool: RawScannerPool,
  latestPrice: number,
  take = 3,
): { top3: FilteredPdBlock[]; formattedZh: string } {
  type Cand = Omit<FilteredPdBlock, 'rank'>;
  const cands: Cand[] = [];

  const mssIdx = pool.fib.mssDetected ? pool.fib.mssIndex : undefined;

  for (const ob of pool.blocks.orderBlocks) {
    const top = Math.max(ob.top, ob.bottom);
    const bottom = Math.min(ob.top, ob.bottom);
    const nearMss =
      mssIdx !== undefined && Math.abs(ob.index - mssIdx) <= 6 ? '与最近 MSS 时间轴邻近（±6 根内），可视为高概率 OB 共识候选。' : '';
    const engulf = '检测逻辑含「完全吞噬」（阳吞阴/阴吞阳）且第三根为强动能；若你同时观察到更低周期 MSS，可升格为多周期共振 OB。';
    cands.push({
      category: ob.kind === 'bullish_ob' ? '多头订单块 OB' : '空头订单块 OB',
      top,
      bottom,
      distanceToPrice: distanceToZone(latestPrice, bottom, top),
      narrativeZh: zoneNarrative(
        ob.kind === 'bullish_ob' ? '多头 OB' : '空头 OB',
        bottom,
        top,
        `${engulf}${nearMss ? ` ${nearMss}` : ''}`,
      ),
    });
  }

  for (const r of pool.blocks.rejectionBlocks) {
    const top = Math.max(r.top, r.bottom);
    const bottom = Math.min(r.top, r.bottom);
    const side = r.kind === 'upper_rejection' ? '上影拒绝块' : '下影拒绝块';
    cands.push({
      category: `拒绝块 (${side})`,
      top,
      bottom,
      distanceToPrice: distanceToZone(latestPrice, bottom, top),
      narrativeZh: zoneNarrative(
        side,
        bottom,
        top,
        '极长影线且影线端刺穿前期显著高/低；常用于外部流动性扫单叙事。',
      ),
    });
  }

  for (const v of pool.blocks.vacuumBlocks) {
    const top = Math.max(v.top, v.bottom);
    const bottom = Math.min(v.top, v.bottom);
    cands.push({
      category: '真空块 (跳空缺口)',
      top,
      bottom,
      distanceToPrice: distanceToZone(latestPrice, bottom, top),
      narrativeZh: zoneNarrative('真空块', bottom, top, '相邻 K 线开盘相对前收出现显著跳空，可作 HTF 缺口/失衡参考。'),
    });
  }

  for (const b of pool.track.breakerBlocks) {
    const zt = b.zone[0];
    const zb = b.zone[1];
    const top = Math.max(zt, zb);
    const bottom = Math.min(zt, zb);
    cands.push({
      category: `破坏块 Breaker（${b.flippedRole === 'support' ? '阻力→支撑' : '支撑→阻力'}）`,
      top,
      bottom,
      distanceToPrice: distanceToZone(latestPrice, bottom, top),
      narrativeZh: zoneNarrative(
        'Breaker Block',
        bottom,
        top,
        '原 OB 被有效突破后伴随 MSS，角色翻转；用于回踩/假突破风控叙事。',
      ),
    });
  }

  for (const m of pool.track.mitigationBlocks) {
    const zt = m.zone[0];
    const zb = m.zone[1];
    const top = Math.max(zt, zb);
    const bottom = Math.min(zt, zb);
    cands.push({
      category: '补仓块 Mitigation（失败摆动 + MSS）',
      top,
      bottom,
      distanceToPrice: distanceToZone(latestPrice, bottom, top),
      narrativeZh: zoneNarrative('Mitigation', bottom, top, '未能刷新前高/前低后出现结构转换的缓解区。'),
    });
  }

  for (const f of pool.fvgFormations) {
    const [a, b] = f.zone;
    const top = Math.max(a, b);
    const bottom = Math.min(a, b);
    const fill = f.isInverseFVG ? '已被标记为 Inverse / 反向击穿路径，谨慎当作「未回补」裸缺口。' : '当前样本内未标记为 Inverse，可讨论为未回补 FVG 候选。';
    cands.push({
      category: `FVG（${f.direction === 'bullish' ? '多头' : '空头'}缺口，收盘于索引 ${f.formationEndIndex}）`,
      top,
      bottom,
      distanceToPrice: distanceToZone(latestPrice, bottom, top),
      narrativeZh: zoneNarrative('公允价值缺口 FVG', bottom, top, fill),
    });
  }

  cands.sort((x, y) => x.distanceToPrice - y.distanceToPrice);
  const top3: FilteredPdBlock[] = cands.slice(0, take).map((c, i) => ({ rank: i + 1, ...c }));

  const formattedZh =
    top3.length === 0
      ? '（在当前样本中未合并到可用区块，请检查 K 线数量或放宽扫描参数。）'
      : top3
          .map(
            (t) =>
              `【精选 ${t.rank} | ${t.category}】与现价最短距离约 ${t.distanceToPrice.toFixed(4)}（区间内为 0）。\n- ${t.narrativeZh}`,
          )
          .join('\n\n');

  return { top3, formattedZh };
}
