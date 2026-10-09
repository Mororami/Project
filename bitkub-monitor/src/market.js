/**
 * 김치 프리미엄(%) = (Bithumb 원화 가격 / (Bitkub THB 가격 × THB→KRW 환율) − 1) × 100
 * 양수면 한국(Bithumb)이 비싸고, 음수(역프)면 태국(Bitkub)이 비싸다.
 */
export function premiumPct(krwPrice, thbPrice, thbKrw) {
  if (!(krwPrice > 0 && thbPrice > 0 && thbKrw > 0)) return null;
  return (krwPrice / (thbPrice * thbKrw) - 1) * 100;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Bitkub·Bithumb 시세와 환율을 합쳐 두 거래소에 모두 있는 코인의 비교 스냅샷을 만든다.
 * - outlier: |김프|가 outlierPct 이상. 같은 티커의 다른 코인이거나 입출금 중단일 가능성이 커서 요약 통계에서 뺀다.
 * - lowLiquidity: Bitkub 24시간 거래대금이 lowLiquidityThb 미만이거나 Bithumb 24시간 거래대금이 lowLiquidityKrw 미만.
 *   마지막 체결가가 오래됐을 수 있어 요약 통계에서 뺀다.
 * - halted: Bitkub에서 매수나 매도가 정지된 코인. 요약 통계에서 뺀다.
 * - bitkubOnly: Bithumb에 KRW 마켓이 없어 비교하지 못한 Bitkub 코인 (마켓은 있는데 시세를 못 받은 코인은 어디에도 넣지 않는다).
 */
export function buildSnapshot({ bitkub, bithumb, bitkubSymbols, bithumbMarkets, fx, options, now = Date.now() }) {
  const rate = fx?.rate ?? null;
  const rows = [];
  const bitkubOnly = [];
  // Bithumb 시세를 아예 못 받은 상태에서는 "Bithumb에 없는 코인"을 가릴 수 없다.
  const bithumbKnown = bithumb.size > 0 && bithumbMarkets.size > 0;
  for (const [base, bk] of bitkub) {
    const bh = bithumb.get(base);
    if (!bh) {
      if (bithumbKnown && !bithumbMarkets.has(base)) bitkubOnly.push(base);
      continue;
    }
    const market = bithumbMarkets.get(base);
    const premium = premiumPct(bh.last, bk.last, rate);
    rows.push({
      base,
      nameKo: market?.nameKo ?? null,
      nameEn: market?.nameEn ?? bitkubSymbols.get(base)?.name ?? null,
      warning: market?.warning ?? null,
      halted: bitkubSymbols.get(base)?.halted === true,
      bitkub: bk,
      bithumb: bh,
      krwFromThb: rate ? bk.last * rate : null,
      premiumPct: premium,
      lowLiquidity: bk.volumeThb < options.lowLiquidityThb || bh.volumeKrw < (options.lowLiquidityKrw ?? 0),
      outlier: premium != null && Math.abs(premium) >= options.outlierPct,
    });
  }
  rows.sort((a, b) => b.bithumb.volumeKrw - a.bithumb.volumeKrw);

  const usdtBk = bitkub.get('USDT');
  const usdtBh = bithumb.get('USDT');
  return {
    updatedAt: now,
    fx,
    // 스테이블코인으로 본 환율. 은행 환율과의 차이가 곧 USDT 프리미엄이다.
    usdtCrossRate: usdtBk && usdtBh ? usdtBh.last / usdtBk.last : null,
    rows,
    bitkubCount: bitkub.size,
    bitkubOnly,
    summary: summarize(rows),
  };
}

/** 이상치·저유동성·거래정지 코인을 뺀 요약 */
export function summarize(rows) {
  const valid = rows.filter((r) => r.premiumPct != null && !r.outlier && !r.lowLiquidity && !r.halted);
  const pick = (base) => rows.find((r) => r.base === base)?.premiumPct ?? null;
  return {
    count: rows.length,
    used: valid.length,
    outliers: rows.filter((r) => r.outlier).length,
    medianPct: median(valid.map((r) => r.premiumPct)),
    btcPct: pick('BTC'),
    usdtPct: pick('USDT'),
    above: valid.filter((r) => r.premiumPct > 0).length,
    below: valid.filter((r) => r.premiumPct < 0).length,
  };
}
