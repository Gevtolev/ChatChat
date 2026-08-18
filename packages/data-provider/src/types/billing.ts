// packages/data-provider/src/types/billing.ts
export type PlanCode = 'anonymous' | 'free' | 'trial' | 'pro_m' | 'pro_q' | 'pro_h';
export type CostTier = 'cheap' | 'mid' | 'expensive';
export type SubStatus = 'active' | 'trialing' | 'expired' | 'admin_granted';
export type PlanChangeSource = 'admin' | 'stripe' | 'system_default' | 'cli';

export type QuotaPeriod = 'lifetime' | 'daily';

/**
 * 每月发放的 tokenCredits。这是**内部计量单位**，与上游 Balance 一致：
 * 1 tokenCredit = 1e-6 美元的算力成本。
 *
 * 用户看到的「积分」是它除以 CREDIT_DISPLAY_DIVISOR 的结果 —— 例如
 * 12,000,000 tokenCredits（$12 成本）展示为 100 万积分。两者分开是因为
 * 扣费必须按真实成本走 `spendTokens`，而展示要对齐售价口径。
 */
export const CREDIT_DISPLAY_DIVISOR = 12;

export interface PlanConfig {
  code: PlanCode;
  name: string; // 用户可见名："Pro Monthly"
  monthly_price_cents: number; // 仅展示和未来 Stripe 映射
  allowed_cost_tiers: CostTier[];
  /** 每月发放的 tokenCredits，0 = 不发放。见 CREDIT_DISPLAY_DIVISOR。 */
  monthly_token_credits: number;
  /**
   * 终身消息条数上限，0 = 不限（由积分约束）。
   *
   * 只有匿名档用它：未登录访客的 3 条试用是**产品规则**而非计费额度 ——
   * 它必须在 DISABLE_BILLING_GATING 打开时依然生效，也不该占用积分账户
   * （匿名用户根本没有 Balance 记录）。付费档一律为 0，走积分。
   */
  lifetime_message_limit: number;
  features: {
    agents: boolean;
    image_gen: boolean;
    voice: boolean;
    web_search: boolean;
  };
}
