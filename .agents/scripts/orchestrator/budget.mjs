// budget.mjs — 任务预算账本（自 orchestrator.mjs 迁出为独立模块：单测可直接 import
// 驱动 account/wall 定时器路径，不必经 CLI 子进程）。
// 硬熔断（trip）语义不变：超限只在 spawn 返回后落 blocked，配合 onTrip 杀在跑进程树。
// 低油量软告警（2026-11 航中安全线）：token/wall 过 80% 各触发一次 emit——软告警只
// 留痕 + 提示收尾，绝不降低硬熔断阈值（熔断不可关闭红线不变）。

/**
 * 任务预算账本。card.meta.budget: { max_tokens, max_wall_minutes }（queue.validateCard
 * 已回落默认值）。emit 仅用于低油量软告警事件（{kind:'tokens'|'wall', pct, tokens_in?}），
 * 由调用方决定留痕与通知方式；硬熔断仍走 onTrip 回调 + tripped 轮询。
 */
export class Budget {
  constructor(card, emit = () => {}) {
    this.maxTokens = card.meta.budget.max_tokens;
    this.maxWallMs = card.meta.budget.max_wall_minutes * 60_000;
    this.emit = emit;
    this.committed = 0; // 已完结 worker 会话的用量合计
    this.sessionMax = 0; // 当前会话内峰值（stream-json 的 usage 是会话累计值）
    this.tokens = 0; // committed + sessionMax，只读视图
    this.started = Date.now();
    this.tripReason = null;
    this.lowFuel = { tokens: false, wall: false }; // 低水位标志位：各触发一次，防重复
    this.wallTimer = setTimeout(() => this.trip('max_wall_minutes', `${card.meta.budget.max_wall_minutes} 分钟 wall-clock 到期`), this.maxWallMs);
    this.wallTimer.unref?.();
    // 软告警定时器：wall 过 80% 触发一次（与硬熔断定时器独立；软告警不降熔断）
    if (this.maxWallMs > 0) {
      this.wallFuelTimer = setTimeout(() => {
        if (this.lowFuel.wall || this.tripReason) return;
        this.lowFuel.wall = true;
        this.emit({ kind: 'wall', pct: 80 });
      }, Math.floor(this.maxWallMs * 0.8));
      this.wallFuelTimer.unref?.();
    }
  }

  /** 新 worker 会话开始：上一会话用量入账 committed（原实现用全局 Math.max，
   *  fixup 多会话互相覆盖漏计——实测 300k+100k 两会话只记 300k）。 */
  beginSession() {
    this.committed += this.sessionMax;
    this.sessionMax = 0;
    this.tokens = this.committed;
  }

  account(tokensIn, tokensOut) {
    this.sessionMax = Math.max(this.sessionMax, tokensIn + tokensOut);
    this.tokens = this.committed + this.sessionMax;
    this.checkLowFuel();
    if (this.tokens > this.maxTokens) this.trip('max_tokens', `累计 ${this.tokens} / 上限 ${this.maxTokens} tokens`);
  }

  /** token 低水位检查：过 80% 触发一次。用交叉相乘整数比较（tokens*5 ≥ max*4），
   *  规避 0.8 二进制浮点误差——6000/7500 恰好 80% 时 `tokens >= max*0.8` 会因
   *  6000 >= 6000.0000000001 为假而漏报。 */
  checkLowFuel() {
    if (this.lowFuel.tokens || !(this.maxTokens > 0)) return;
    if (this.tokens * 5 >= this.maxTokens * 4) {
      this.lowFuel.tokens = true;
      this.emit({ kind: 'tokens', pct: Math.round((this.tokens / this.maxTokens) * 100), tokens_in: this.tokens });
    }
  }

  trip(reason, detail) {
    if (!this.tripReason) {
      this.tripReason = { reason, detail };
      clearTimeout(this.wallTimer);
      clearTimeout(this.wallFuelTimer);
      // 看门狗：trip 即杀当前在跑的 worker/reviewer 进程树——熔断只在 spawn
      // 返回后检查，而 spawn 只有进程退出才 resolve（zcode 无 max-turns、网络
      // 挂死时 claude 也可能长时间不返回）；不主动杀，wall-clock 熔断形同虚设。
      this.onTrip?.();
    }
  }

  get tripped() {
    return this.tripReason !== null;
  }
}
