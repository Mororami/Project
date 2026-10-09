import { formatDuration, formatPct, formatPrice, formatTime } from './format.js';
import { log as defaultLog } from './log.js';
import { buildSnapshot } from './market.js';
import { REPORT_SELECTOR } from './config.js';
import { formatReport, formatStartMessage, formatSurgeMessage } from './messages.js';
import { fetchBithumbMarkets, fetchBithumbTickers } from './sources/bithumb.js';
import { fetchBitkubSymbols, fetchBitkubTickers } from './sources/bitkub.js';
import { fetchThbKrw } from './sources/fx.js';
import { SurgeDetector } from './surge.js';

const META_REFRESH_MS = 60 * 60_000;
const RECENT_ALERTS = 10;
// setTimeout이 받을 수 있는 최대 지연
const MAX_TIMER_MS = 2 ** 31 - 1;

export const defaultSources = {
  bitkubTickers: fetchBitkubTickers,
  bitkubSymbols: fetchBitkubSymbols,
  bithumbMarkets: fetchBithumbMarkets,
  bithumbTickers: fetchBithumbTickers,
  thbKrw: fetchThbKrw,
};

/**
 * 주기적으로 시세·환율을 모아 스냅샷을 갱신하고, 급등·정기 시세를 Telegram으로 보낸다.
 * 대시보드는 publicSnapshot()을 읽는다.
 */
export class Monitor {
  constructor(config, { telegram, sources = defaultSources, log = defaultLog }) {
    this.config = config;
    this.telegram = telegram;
    this.sources = sources;
    this.log = log;
    this.detector = new SurgeDetector(config.surge);
    this.bitkub = new Map();
    this.bithumb = new Map();
    this.bitkubSymbols = new Map();
    this.bithumbMarkets = new Map();
    // Bithumb가 시세를 거절한 마켓. 마켓 목록을 새로 받을 때 비운다.
    this.bithumbSkipped = new Set();
    this.fx = null;
    this.snapshot = null;
    this.recentAlerts = [];
    this.status = {};
    this.timers = new Map();
    this.stopped = false;
    // 알림은 순서대로 보내되, 시세 조회를 막지 않는다.
    this.sendQueue = Promise.resolve();
  }

  /** 첫 데이터를 모은다. 실패한 소스는 다음 주기에 다시 시도한다. */
  async prime() {
    await Promise.all([this.refreshMeta(), this.refreshFx()]);
    await this.tick();
  }

  async start() {
    await this.prime();
    this.repeat('meta', META_REFRESH_MS, () => this.refreshMeta());
    this.repeat('fx', this.config.fx.refreshMs, () => this.refreshFx());
    this.repeat('tick', this.config.pollIntervalMs, () => this.tick());
    this.scheduleReport();
    const warnings = this.startupWarnings();
    for (const w of warnings) this.log.warn(w);
    await this.notify(formatStartMessage(this.config, warnings), '시작 알림');
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 작업이 끝난 뒤 다음 실행을 예약해 겹쳐 실행되지 않게 한다. */
  repeat(name, intervalMs, fn) {
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        this.log.error(`${name}: ${err.message}`);
      }
      if (!this.stopped) this.timers.set(name, setTimeout(run, intervalMs));
    };
    this.timers.set(name, setTimeout(run, intervalMs));
  }

  markOk(source, at = Date.now()) {
    this.status[source] = { ok: true, lastOkAt: at, error: null };
  }

  markError(source, err) {
    const prev = this.status[source];
    if (prev?.ok !== false) this.log.warn(`${source}: ${err.message}`);
    this.status[source] = { ok: false, lastOkAt: prev?.lastOkAt ?? null, error: err.message };
  }

  async refreshMeta() {
    const [symbols, markets] = await Promise.allSettled([this.sources.bitkubSymbols(), this.sources.bithumbMarkets()]);
    if (symbols.status === 'fulfilled') {
      this.bitkubSymbols = symbols.value;
      this.markOk('bitkubSymbols');
    } else {
      this.markError('bitkubSymbols', symbols.reason);
    }
    if (markets.status === 'fulfilled') {
      this.bithumbMarkets = markets.value;
      this.bithumbSkipped.clear();
      this.markOk('bithumbMarkets');
    } else {
      this.markError('bithumbMarkets', markets.reason);
    }
  }

  async refreshFx() {
    const { fixedRate, providers } = this.config.fx;
    if (fixedRate) {
      this.fx = { rate: fixedRate, at: Date.now(), source: 'fixed', sourceLabel: '고정 환율 (FX_THB_KRW)' };
      this.markOk('fx');
      return;
    }
    try {
      this.fx = await this.sources.thbKrw(providers);
      this.markOk('fx');
    } catch (err) {
      // 마지막으로 받은 환율을 계속 쓴다. 메시지와 대시보드에는 갱신 실패로 표시된다.
      this.markError('fx', err);
    }
  }

  async tick() {
    const now = Date.now();
    // 목록을 아직 못 받았으면 한 시간 주기를 기다리지 않고 매 주기 다시 시도한다.
    if (!this.bithumbMarkets.size || !this.bitkubSymbols.size) await this.refreshMeta();

    const bkPromise = this.sources.bitkubTickers();
    // Bitkub 목록에 있는 코인만 Bithumb에 요청한다. 코인 목록도 이전 시세도 없는 첫 주기에는
    // Bitkub 시세를 먼저 받아 겹치는 마켓을 알아낸다 (코인 목록 조회가 실패해도 Bithumb 요청이 비지 않게).
    const known = new Set([...this.bitkubSymbols.keys(), ...this.bitkub.keys()]);
    if (!known.size) {
      const [first] = await Promise.allSettled([bkPromise]);
      if (first.status === 'fulfilled') for (const b of first.value.keys()) known.add(b);
    }
    // Bithumb가 거절한 마켓은 목록을 새로 받을 때까지 뺀다.
    const bases = [...this.bithumbMarkets.keys()].filter((b) => known.has(b) && !this.bithumbSkipped.has(b));
    const onSkip = (market, why) => {
      this.bithumbSkipped.add(market.replace(/^KRW-/, ''));
      this.log.warn(`Bithumb ${market} 제외 (다음 마켓 목록 갱신까지): ${why}`);
    };
    const [bk, bh] = await Promise.allSettled([
      bkPromise,
      bases.length
        ? this.sources.bithumbTickers(bases, { onSkip })
        : Promise.reject(new Error(this.bithumbMarkets.size ? 'Bitkub과 겹치는 Bithumb 마켓이 없습니다' : 'Bithumb 마켓 목록이 없습니다')),
    ]);

    if (bk.status === 'fulfilled') {
      this.bitkub = bk.value;
      this.markOk('bitkub', now);
    } else {
      this.markError('bitkub', bk.reason);
    }
    if (bh.status === 'fulfilled') {
      this.bithumb = bh.value;
      this.markOk('bithumb', now);
    } else {
      this.markError('bithumb', bh.reason);
    }

    // 김프는 두 거래소 시세 중 오래된 쪽만큼만 최신이다. 실패한 주기에는 갱신 시각을 앞으로 당기지 않는다.
    const okAt = (s) => this.status[s]?.lastOkAt ?? 0;
    const pricesAt = Math.min(okAt('bitkub'), okAt('bithumb')) || now;
    this.snapshot = buildSnapshot({
      bitkub: this.bitkub,
      bithumb: this.bithumb,
      bitkubSymbols: this.bitkubSymbols,
      bithumbMarkets: this.bithumbMarkets,
      fx: this.fx,
      options: this.config.market,
      now: pricesAt,
    });

    if (bk.status === 'fulfilled') this.detectSurges(now);
  }

  detectSurges(now) {
    const { rules, watchlist, minVolumeThb } = this.config.surge;
    if (!rules.length) return;

    const events = [];
    for (const [base, t] of this.bitkub) {
      if (watchlist.length && !watchlist.includes(base)) continue;
      // 호가 중간값으로 판정해 매수·매도 호가 사이를 오가는 체결가 튐을 거른다. 호가가 없으면 체결가.
      const price = t.bid > 0 && t.ask >= t.bid ? (t.bid + t.ask) / 2 : t.last;
      // 거래가 적은 코인도 가격 기록은 남겨 두고, 알림만 거른다.
      const event = this.detector.update(base, price, now);
      if (event && t.volumeThb >= minVolumeThb && this.detector.accept(event)) events.push(event);
    }
    this.detector.prune(now);
    if (!events.length) return;

    const best = (e) => Math.max(...e.hits.map((h) => h.risePct));
    events.sort((a, b) => best(b) - best(a));
    const rowsByBase = new Map(this.snapshot.rows.map((r) => [r.base, r]));

    // 메시지와 같은 순서(상승률 높은 순)로 맨 앞에 넣는다.
    const batch = events.map((e) => {
      const row = rowsByBase.get(e.base);
      return {
        t: e.t,
        base: e.base,
        name: row?.nameKo ?? row?.nameEn ?? this.bitkubSymbols.get(e.base)?.name ?? null,
        price: e.price,
        priceKrw: this.fx ? e.price * this.fx.rate : null,
        repeat: e.repeat,
        hits: e.hits.map((h) => ({ label: h.rule.label, risePct: h.risePct, lowPrice: h.low.p, lowAt: h.low.t })),
        premiumPct: row?.premiumPct ?? null,
      };
    });
    this.recentAlerts.unshift(...batch);
    this.recentAlerts.length = Math.min(this.recentAlerts.length, RECENT_ALERTS);

    const summary = events.map((e) => `${e.base} ${formatPct(best(e))}`).join(', ');
    this.log.info(`급등 감지: ${summary}`);
    const message = formatSurgeMessage(events, {
      tickers: this.bitkub,
      rowsByBase,
      names: this.bitkubSymbols,
      fx: this.fx,
      status: this.status,
      now,
    });
    // 전송을 기다리지 않는다. notify()가 순서를 지키고 결과를 기록하므로 시세 조회가 밀리지 않는다.
    this.notify(message, '급등 알림');
  }

  /** 정기 시세를 현지 시계 기준 간격의 배수에 맞춰 보낸다 (60분 → 매시 정각, 1440분 → 매일 0시). */
  scheduleReport() {
    const intervalMs = this.config.report.intervalMin * 60_000;
    if (!intervalMs || this.stopped) return;
    const offsetMs = new Date().getTimezoneOffset() * 60_000;
    const next = Math.ceil((Date.now() + 1000 - offsetMs) / intervalMs) * intervalMs + offsetMs;
    const wait = Math.min(next - Date.now(), MAX_TIMER_MS);
    this.timers.set('report', setTimeout(async () => {
      // 타이머 한도에 걸려 일찍 깨어났으면 다시 예약만 한다.
      if (Date.now() < next - 1000) {
        this.scheduleReport();
        return;
      }
      await this.sendReport();
      this.scheduleReport();
    }, wait));
    this.log.info(`다음 정기 시세: ${formatTime(next, { date: true })} (${formatDuration(intervalMs)} 간격)`);
  }

  async sendReport(title) {
    if (!this.snapshot || !this.bitkub.size) {
      this.log.warn('정기 시세: 아직 수집된 시세가 없어 건너뜁니다');
      return;
    }
    const message = formatReport(this.snapshot, {
      tickers: this.bitkub,
      symbols: this.reportSymbols(),
      names: this.bitkubSymbols,
      title,
      status: this.status,
      now: Date.now(),
    });
    await this.notify(message, '정기 시세');
  }

  /** REPORT_SYMBOLS의 all · common · top:N 을 현재 시세 기준 코인 목록으로 푼다. */
  reportSymbols() {
    const out = [];
    const seen = new Set();
    const add = (b) => {
      if (!seen.has(b)) {
        seen.add(b);
        out.push(b);
      }
    };
    const byVolume = [...this.bitkub].sort((a, b) => b[1].volumeThb - a[1].volumeThb).map(([b]) => b);
    for (const s of this.config.report.symbols) {
      const top = s.match(/^TOP:(\d+)$/);
      if (s === 'ALL') byVolume.forEach(add);
      else if (s === 'COMMON') for (const r of this.snapshot?.rows ?? []) add(r.base);
      else if (top) byVolume.slice(0, Number(top[1])).forEach(add);
      else add(s);
    }
    return out;
  }

  /** 시작 직후, 설정이 실제 시세와 맞지 않아 알림이 조용히 빠질 만한 점을 찾는다. */
  startupWarnings() {
    const { watchlist, minVolumeThb, rules } = this.config.surge;
    const out = [];
    if (!this.bitkub.size) return out; // 첫 Bitkub 조회가 실패했으면 확인할 수 없다
    const named = [...new Set([...watchlist, ...this.config.report.symbols.filter((s) => !REPORT_SELECTOR.test(s))])];
    const missing = named.filter((b) => !this.bitkub.has(b));
    if (missing.length) out.push(`Bitkub THB 마켓에 없는 심볼: ${missing.join(', ')}`);
    if (rules.length && watchlist.length) {
      const thin = watchlist.filter((b) => this.bitkub.has(b) && this.bitkub.get(b).volumeThb < minVolumeThb);
      if (thin.length) {
        out.push(`24h 거래대금 ฿${formatPrice(minVolumeThb)} 미만이라 급등 알림에서 제외: ${thin.join(', ')} (SURGE_MIN_VOLUME_THB를 낮추면 알림)`);
      }
      if (watchlist.every((b) => !this.bitkub.has(b) || this.bitkub.get(b).volumeThb < minVolumeThb)) {
        out.push('WATCHLIST 코인이 모두 제외되어 급등 알림이 사실상 꺼져 있습니다');
      }
    }
    return out;
  }

  /** 알림을 순서대로 보낸다. 기다리지 않아도 되며, 결과는 status.telegram과 로그에 남는다. */
  notify(html, kind) {
    const run = () => this.deliver(html, kind);
    this.sendQueue = this.sendQueue.then(run, run);
    return this.sendQueue;
  }

  async deliver(html, kind) {
    if (!this.telegram?.enabled) {
      this.log.info(`[Telegram 미설정 - ${kind}]\n${html.replace(/<[^>]+>/g, '')}`);
      return;
    }
    try {
      await this.telegram.send(html);
      this.markOk('telegram');
      this.log.info(`${kind} 전송 완료`);
    } catch (err) {
      this.status.telegram = { ok: false, lastOkAt: this.status.telegram?.lastOkAt ?? null, error: err.message };
      this.log.error(`${kind} 전송 실패: ${err.message}`);
    }
  }

  /** 보내는 중인 알림이 모두 끝날 때까지 기다린다 (테스트·종료용). */
  flushNotifications() {
    return this.sendQueue;
  }

  /** 상태 점검(/healthz)용. Bitkub 시세가 오래 끊기면 실패로 본다. */
  health(now = Date.now()) {
    const staleMs = Math.max(60_000, this.config.pollIntervalMs * 4);
    const bk = this.status.bitkub;
    const ok = Boolean(this.snapshot && bk?.lastOkAt && now - bk.lastOkAt <= staleMs);
    return { ok, updatedAt: this.snapshot?.updatedAt ?? null, status: this.status };
  }

  /** 대시보드 API 응답 */
  publicSnapshot() {
    if (!this.snapshot) return null;
    const { market, surge, pollIntervalMs } = this.config;
    return {
      ...this.snapshot,
      // 보는 쪽 시계가 어긋나도 경과 시간을 맞출 수 있게 서버 시각을 함께 준다.
      serverNow: Date.now(),
      status: this.status,
      recentAlerts: this.recentAlerts,
      options: {
        pollIntervalMs,
        outlierPct: market.outlierPct,
        lowLiquidityThb: market.lowLiquidityThb,
        lowLiquidityKrw: market.lowLiquidityKrw,
        surgeRules: surge.rules.map((r) => `${r.label} +${r.pct}%`),
      },
    };
  }
}
