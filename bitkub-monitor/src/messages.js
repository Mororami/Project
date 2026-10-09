import { escapeHtml as esc, formatAgo, formatCompact, formatKrwCompact, formatPct, formatPrice } from './format.js';

// 메시지에는 절대 시각을 넣지 않는다. Telegram이 받는 사람의 시간대로 수신 시각을 보여 준다.

function coinTitle(base, row, names) {
  const name = row?.nameKo ?? row?.nameEn ?? names?.get(base)?.name;
  return `<b>${esc(base)}</b>${name ? ` ${esc(name)}` : ''}`;
}

function thbWithKrw(thb, fx) {
  return `฿${formatPrice(thb)}${fx ? ` ≈ ₩${formatPrice(thb * fx.rate)}` : ''}`;
}

/** 경과 시간: "45초 전", "4분 전", "3시간 전", "2일 전" */
function formatAge(ms) {
  if (ms < 3_600_000) return formatAgo(ms);
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}시간 전`;
  return `${Math.round(ms / 86_400_000)}일 전`;
}

/** 소스 갱신이 실패한 상태면 어느 때 값인지 덧붙인다. 정상이면 빈 문자열. */
function staleNote(status, key, now) {
  const s = status?.[key];
  if (!s || s.ok !== false) return '';
  return s.lastOkAt ? ` (갱신 실패, ${formatAge(now - s.lastOkAt)} 값)` : ' (갱신 실패)';
}

function fxLine(fx, status, now) {
  if (!fx) return '환율 정보 없음 (원화 환산 생략)';
  return `환율 1 THB = ${fx.rate.toFixed(2)} KRW (${esc(fx.sourceLabel)})${staleNote(status, 'fx', now)}`;
}

/** 같은 주기에 감지된 급등을 메시지 하나로 묶는다. */
export function formatSurgeMessage(events, { tickers, rowsByBase, names, fx, status = {}, now }) {
  const head = `<b>[급등 알림]${events.length > 1 ? ` ${events.length}종목` : ''}</b>`;
  const blocks = events.map((e) => {
    const row = rowsByBase.get(e.base);
    const ticker = tickers.get(e.base);
    // 가장 긴 구간의 저점이 가장 낮다.
    const low = e.hits[e.hits.length - 1].low;
    const lines = [
      `${coinTitle(e.base, row, names)}${e.repeat ? ' (추가 상승)' : ''}`,
      e.hits.map((h) => `${h.rule.label} 저점 대비 <b>${formatPct(h.risePct)}</b>`).join(' · '),
      `현재 ${thbWithKrw(e.price, fx)}`,
      `저점 ฿${formatPrice(low.p)} (${formatAgo(now - low.t)})`,
    ];
    if (ticker) {
      const volume = fx ? `₩${formatKrwCompact(ticker.volumeThb * fx.rate)}` : `฿${formatCompact(ticker.volumeThb)}`;
      lines.push(`24h ${formatPct(ticker.changePct)} · 거래대금 ${volume}`);
    }
    if (row) {
      lines.push(
        `빗썸 ₩${formatPrice(row.bithumb.last)}${row.premiumPct != null ? ` · 김프 ${formatPct(row.premiumPct)}` : ''}${staleNote(status, 'bithumb', now)}`,
      );
    }
    return lines.join('\n');
  });
  const footer = fx && status.fx?.ok === false ? [fxLine(fx, status, now)] : [];
  return [head, ...blocks, ...footer].join('\n\n');
}

/** 정기 시세 메시지 */
export function formatReport(snapshot, { tickers, symbols, names, title = '[시세] Bitkub', status = {}, now = Date.now() }) {
  const { fx, summary } = snapshot;
  const rowsByBase = new Map(snapshot.rows.map((r) => [r.base, r]));
  const header = [`<b>${esc(title)}</b>`];
  if (status.bitkub?.ok === false) header.push(`경고: Bitkub 시세${staleNote(status, 'bitkub', now)}`);
  header.push(fxLine(fx, status, now));
  if (summary.medianPct != null) {
    header.push(
      `김프 중앙값 ${formatPct(summary.medianPct)} (이상치·저유동성 제외) · BTC ${formatPct(summary.btcPct)} · USDT ${formatPct(summary.usdtPct)}`,
    );
  }

  const blocks = symbols.map((base) => {
    const t = tickers.get(base);
    if (!t) return `<b>${esc(base)}</b> Bitkub THB 마켓에 없음`;
    const row = rowsByBase.get(base);
    const second = [`24h ${formatPct(t.changePct)}`];
    if (row) {
      second.push(
        `빗썸 ₩${formatPrice(row.bithumb.last)}${row.premiumPct != null ? ` (김프 ${formatPct(row.premiumPct)})` : ''}${staleNote(status, 'bithumb', now)}`,
      );
    }
    return `${coinTitle(base, row, names)} ${thbWithKrw(t.last, fx)}\n${second.join(' · ')}`;
  });

  return [header.join('\n'), ...blocks].join('\n\n');
}

/** 시작 알림: 현재 적용 중인 설정과, 설정이 시세와 맞지 않는 점을 요약한다. */
export function formatStartMessage(config, warnings = []) {
  const { surge, report } = config;
  const lines = ['<b>[시작] Bitkub 시세 모니터</b>'];
  if (surge.rules.length) {
    const rules = surge.rules.map((r) => `${r.label} +${r.pct}%`).join(' · ');
    lines.push(`급등 규칙: ${esc(rules)} (재알림 대기 ${Math.round(surge.cooldownMs / 60_000)}분)`);
    const target = surge.watchlist.length ? esc(surge.watchlist.join(', ')) : 'Bitkub THB 마켓 전체';
    lines.push(`대상: ${target} (24h 거래대금 ฿${formatPrice(surge.minVolumeThb)} 이상)`);
  } else {
    lines.push('급등 알림: 꺼짐');
  }
  lines.push(
    report.intervalMin > 0
      ? `정기 시세: ${report.intervalMin}분마다 ${esc(report.symbols.join(', '))}`
      : '정기 시세: 꺼짐',
  );
  for (const w of warnings) lines.push(`경고: ${esc(w)}`);
  return lines.join('\n');
}
