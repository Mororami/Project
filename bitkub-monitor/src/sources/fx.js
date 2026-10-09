import { fetchJson } from '../http.js';

// THB→KRW가 이 범위를 벗어나면 응답 필드를 잘못 읽은 것으로 보고 버린다.
const SANE_RANGE = [10, 100];

export const FX_PROVIDERS = {
  // 하나은행 고시 매매기준율. 국내 김프 계산에서 흔히 쓰는 기준이다.
  naver: {
    label: '하나은행 고시',
    async fetch() {
      const res = await fetchJson(
        'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_THBKRW',
      );
      const r = res?.result;
      return { rate: Number(String(r?.closePrice ?? '').replace(/,/g, '')), at: Date.parse(r?.localTradedAt) };
    },
  },
  yahoo: {
    label: 'Yahoo Finance',
    async fetch() {
      const res = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/THBKRW=X?interval=1m&range=1d');
      const meta = res?.chart?.result?.[0]?.meta;
      return { rate: Number(meta?.regularMarketPrice), at: Number(meta?.regularMarketTime) * 1000 };
    },
  },
  // 하루 한 번 갱신되는 무료 API. 위 두 곳이 모두 실패할 때의 대비용이다.
  erapi: {
    label: 'ExchangeRate-API (일 1회)',
    async fetch() {
      const res = await fetchJson('https://open.er-api.com/v6/latest/THB');
      return { rate: Number(res?.rates?.KRW), at: Number(res?.time_last_update_unix) * 1000 };
    },
  },
};

/** providers 순서대로 시도해 처음 성공한 THB→KRW 환율을 돌려준다. */
export async function fetchThbKrw(providers) {
  const errors = [];
  for (const id of providers) {
    try {
      const { rate, at } = await FX_PROVIDERS[id].fetch();
      if (!(rate >= SANE_RANGE[0] && rate <= SANE_RANGE[1])) throw new Error(`비정상 환율 값 ${rate}`);
      return { rate, at: Number.isFinite(at) ? at : Date.now(), source: id, sourceLabel: FX_PROVIDERS[id].label };
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
    }
  }
  throw new Error(`환율 조회 실패 (${errors.join(' / ')})`);
}
