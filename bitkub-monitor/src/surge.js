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
    // 시계가 뒤로 돌아갔으면(NTP 보정 등) 구간 계산이 어긋나므로 기록을 비우고 새로 쌓는다.
    if (points.length && t < points[points.length - 1].t) points.length = 0;
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
   * - 직전 알림이 있고 대기 시간 안이거나, 모든 규칙의 저점이 직전 알림보다 앞에 있으면(같은 상승의 연장)
   *   직전 알림 가격보다 (가장 작은 규칙 %)만큼 더 올랐을 때만 "추가 상승"으로 다시 알린다.
   * - 직전 알림 뒤에 생긴, 직전 알림 저점보다 그만큼 더 낮은 저점에서 다시 오르면 새 급등으로 본다.
   */
  accept(event) {
    const last = this.lastAlert.get(event.base);
    const lowP = Math.min(...event.hits.map((h) => h.low.p));
    let repeat = false;
    if (last) {
      const coolingDown = event.t - last.t < this.cooldownMs;
      const sameSurge = event.hits.every((h) => h.low.t <= last.t);
      const newLeg = event.hits.every((h) => h.low.t > last.t) && lowP < last.low * (1 - this.minPct / 100);
      repeat = (coolingDown || sameSurge) && !newLeg;
      if (repeat && event.price < last.p * (1 + this.minPct / 100)) return false;
    }
    event.repeat = repeat;
    this.lastAlert.set(event.base, { t: event.t, p: event.price, low: lowP });
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
