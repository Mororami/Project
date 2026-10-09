import { formatDuration, formatPct, formatTime } from './format.js';
import { log as defaultLog } from './log.js';
import { buildSnapshot } from './market.js';
import { formatReport, formatStartMessage, formatSurgeMessage } from './messages.js';
import { fetchBithumbMarkets, fetchBithumbTickers } from './sources/bithumb.js';
import { fetchBitkubSymbols, fetchBitkubTickers } from './sources/bitkub.js';
import { fetchThbKrw } from './sources/fx.js';
import { SurgeDetector } from './surge.js';

const META_REFRESH_MS = 60 * 60_000;
const RECENT_ALERTS = 10;

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
    this.fx = null;
    this.snapshot = null;
    this.recentAlerts = [];
    this.status = {};
    this.timers = new Map();
    this.stopped = false;
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
    await this.notify(formatStartMessage(this.config), '시작 알림');
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
    if (symbols.status === 'fulfilled') this.bitkubSymbols = symbols.value;
    else this.log.warn(`Bitkub 코인 목록: ${symbols.reason.message}`);
    if (markets.status === 'fulfilled') {
      this.bithumbMarkets = markets.value;
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
      // 마지막으로 받은 환율을 계속 쓴다.
      this.markError('fx', err);
    }
  }

  async tick() {
    const now = Date.now();
    if (!this.bithumbMarkets.size) await this.refreshMeta();

    // Bitkub 목록에 있는 코인만 Bithumb에 요청한다.
    const bases = [...this.bithumbMarkets.keys()].filter((b) => this.bitkubSymbols.has(b) || this.bitkub.has(b));
    const [bk, bh] = await Promise.allSettled([
      this.sources.bitkubTickers(),
      bases.length
        ? this.sources.bithumbTickers(bases, { onSkip: (m, why) => this.log.warn(`Bithumb ${m} 제외: ${why}`) })
        : Promise.reject(new Error('Bithumb 마켓 목록이 없습니다')),
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

    this.snapshot = buildSnapshot({
      bitkub: this.bitkub,
      bithumb: this.bithumb,
      bitkubSymbols: this.bitkubSymbols,
      bithumbMarkets: this.bithumbMarkets,
      fx: this.fx,
      options: this.config.market,
      now,
    });

    if (bk.status === 'fulfilled') await this.detectSurges(now);
  }

  async detectSurges(now) {
    const { rules, watchlist, minVolumeThb } = this.config.surge;
    if (!rules.length) return;

    const events = [];
    for (const [base, t] of this.bitkub) {
      if (watchlist.length && !watchlist.includes(base)) continue;
      // 거래가 적은 코인도 가격 기록은 남겨 두고, 알림만 거른다.
      const event = this.detector.update(base, t.last, now);
      if (event && t.volumeThb >= minVolumeThb && this.detector.accept(event)) events.push(event);
    }
    this.detector.prune(now);
    if (!events.length) return;

    const best = (e) => Math.max(...e.hits.map((h) => h.risePct));
    events.sort((a, b) => best(b) - best(a));
    const rowsByBase = new Map(this.snapshot.rows.map((r) => [r.base, r]));

    for (const e of events) {
      const row = rowsByBase.get(e.base);
      this.recentAlerts.unshift({
        t: e.t,
        base: e.base,
        name: row?.nameKo ?? row?.nameEn ?? this.bitkubSymbols.get(e.base)?.name ?? null,
        price: e.price,
        priceKrw: this.fx ? e.price * this.fx.rate : null,
        repeat: e.repeat,
        hits: e.hits.map((h) => ({ label: h.rule.label, risePct: h.risePct, lowPrice: h.low.p, lowAt: h.low.t })),
        premiumPct: row?.premiumPct ?? null,
      });
    }
    this.recentAlerts.length = Math.min(this.recentAlerts.length, RECENT_ALERTS);

    const summary = events.map((e) => `${e.base} ${formatPct(best(e))}`).join(', ');
    this.log.info(`급등 감지: ${summary}`);
    const message = formatSurgeMessage(events, {
      tickers: this.bitkub,
      rowsByBase,
      names: this.bitkubSymbols,
      fx: this.fx,
      now,
    });
    await this.notify(message, '급등 알림');
  }

  /** 정기 시세를 시계 기준(예: 60분 → 매시 정각)에 맞춰 보낸다. */
  scheduleReport() {
    const intervalMs = this.config.report.intervalMin * 60_000;
    if (!intervalMs || this.stopped) return;
    const next = Math.ceil((Date.now() + 1000) / intervalMs) * intervalMs;
    this.timers.set('report', setTimeout(async () => {
      await this.sendReport();
      this.scheduleReport();
    }, next - Date.now()));
    this.log.info(`다음 정기 시세: ${formatTime(next, { date: true })} (${formatDuration(intervalMs)} 간격)`);
  }

  async sendReport(title) {
    if (!this.snapshot || !this.bitkub.size) {
      this.log.warn('정기 시세: 아직 수집된 시세가 없어 건너뜁니다');
      return;
    }
    const message = formatReport(this.snapshot, {
      tickers: this.bitkub,
      symbols: this.config.report.symbols,
      names: this.bitkubSymbols,
      title,
    });
    await this.notify(message, '정기 시세');
  }

  async notify(html, kind) {
    if (!this.telegram?.enabled) {
      this.log.info(`[Telegram 미설정 - ${kind}]\n${html.replace(/<[^>]+>/g, '')}`);
      return;
    }
    try {
      await this.telegram.send(html);
      this.log.info(`${kind} 전송 완료`);
    } catch (err) {
      this.log.error(`${kind} 전송 실패: ${err.message}`);
    }
  }

  /** 대시보드 API 응답 */
  publicSnapshot() {
    if (!this.snapshot) return null;
    const { market, surge, pollIntervalMs } = this.config;
    return {
      ...this.snapshot,
      status: this.status,
      recentAlerts: this.recentAlerts,
      options: {
        pollIntervalMs,
        outlierPct: market.outlierPct,
        lowLiquidityThb: market.lowLiquidityThb,
        surgeRules: surge.rules.map((r) => `${r.label} +${r.pct}%`),
      },
    };
  }
}
