/**
 * 코인별 최근 가격을 기억해 두고 "구간 저점 대비 상승률"로 급등을 판정한다.
 * 규칙 { windowMs, pct }: 최근 windowMs 동안의 최저가보다 pct% 이상 오르면 해당.
 */
export class SurgeDetector {
  constructor({ rules, cooldownMs }) {
    this.rules = rules;
    this.cooldownMs = cooldownMs;
    this.maxWindowMs = Math.max(0, ...rules.map((r) => r.windowMs));
    this.minPct = Math.min(...rules.map((r) => r.pct));
    this.history = new Map();
    this.lastAlert = new Map();
  }

  /**
   * 가격을 기록하고, 만족한 규칙이 있으면 { base, price, t, hits }를 돌려준다.
   * 재알림 대기(cooldown)는 여기서 따지지 않는다. accept()에서 판단한다.
   */
  update(base, price, t) {
    let points = this.history.get(base);
    if (!points) this.history.set(base, (points = []));
    while (points.length && points[0].t < t - this.maxWindowMs) points.shift();

    const hits = [];
    for (const rule of this.rules) {
      let low = null;
      for (const pt of points) {
        if (pt.t >= t - rule.windowMs && (!low || pt.p < low.p)) low = pt;
      }
      if (low && price >= low.p * (1 + rule.pct / 100)) {
        hits.push({ rule, low, risePct: (price / low.p - 1) * 100 });
      }
    }
    points.push({ t, p: price });
    return hits.length ? { base, price, t, hits } : null;
  }

  /**
   * 알림을 보낼지 결정하고, 보낸다면 이력에 남긴다.
   * 대기 시간 안이라도 직전 알림 가격보다 (가장 작은 규칙 %)만큼 더 오르면 추가 상승으로 다시 알린다.
   */
  accept(event) {
    const last = this.lastAlert.get(event.base);
    const coolingDown = last && event.t - last.t < this.cooldownMs;
    if (coolingDown && event.price < last.p * (1 + this.minPct / 100)) return false;
    event.repeat = Boolean(coolingDown);
    this.lastAlert.set(event.base, { t: event.t, p: event.price });
    return true;
  }

  /** 오랫동안 시세가 들어오지 않은 코인(상장폐지 등)의 기록을 지운다. */
  prune(now) {
    for (const [base, points] of this.history) {
      if (!points.length || points[points.length - 1].t < now - this.maxWindowMs) this.history.delete(base);
    }
    for (const [base, last] of this.lastAlert) {
      if (last.t < now - Math.max(this.cooldownMs, this.maxWindowMs)) this.lastAlert.delete(base);
    }
  }
}
