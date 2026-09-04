// packages/data-provider/src/types/billing.ts
export type PlanCode = 'anonymous' | 'free' | 'trial' | 'plus' | 'pro' | 'max' | 'beta';
export type CostTier = 'cheap' | 'mid' | 'expensive';
export type SubStatus = 'active' | 'trialing' | 'expired' | 'admin_granted';
export type PlanChangeSource = 'admin' | 'stripe' | 'system_default' | 'cli';

export type QuotaPeriod = 'lifetime' | 'daily';

/**
 * 每月发放的 tokenCredits。这是**内部计量单位**，与上游 Balance 一致：
 * 1 tokenCredit = 1e-6 美元的算力成本。
 *
 * 用户看到的「积分」是它除以 CREDIT_DISPLAY_DIVISOR 的结果。两者分开是因为
 * 扣费必须按真实成本走 `spendTokens`，而展示要对齐售价口径。
 *
 * 除数由**入门档的锚点**决定，不是随便取的：$29.9 的 Plus 展示为 100 万积分，
 * 而按 50% 毛利它的成本是 $14.95，所以 14,950,000 / 1,000,000 = 14.95。
 *
 * 换过一次（原为 12）。12 对应的是旧 pro_m 在 60% 毛利下的 $12 成本 —— 同样
 * 锚在「$29.9 = 100 万积分」，但毛利是 60% 而非 50%。两个数只能满足一个，选了
 * 毛利：除数纯粹是展示常量，当时全仓无人消费，改它的代价是零。
 */
export const CREDIT_DISPLAY_DIVISOR = 14.95;

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

/** 看板一律用 tokenCredits（微美元，1 tokenCredit = $1e-6）作为金额单位，
 *  只在渲染时除以 1e6。混用美元/分是这类报表最常见的缺陷来源。 */
export interface AdminUsageUserRow {
  user_id: string;
  /** 用户已删除但交易仍在时为 null，UI 退化显示 ID */
  email: string | null;
  /** 原始 plan_code；null 表示无 Subscription 记录（隐式 free 档） */
  plan_code: string | null;
  /** false = plan_code 不在 PLANS 中。此时 revenue_credits 记 0 并需在 UI 标注，
   *  不可静默当作免费档 —— 那会把数据异常伪装成正常的低毛利用户。 */
  plan_recognized: boolean;
  cost_credits: number;
  /** 已按订阅周期折算到 30 天，见 §Task 4 */
  revenue_credits: number;
  margin_credits: number;
  calls: number;
  model_count: number;
}

export interface AdminUsageModelRow {
  model: string;
  /** 'message' | 'title' | 'summarization' | 'subagent' | ... */
  context: string;
  cost_credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}

export interface AdminUsageDayRow {
  /** 'YYYY-MM-DD'，UTC */
  day: string;
  cost_credits: number;
}

export interface AdminUsageParams {
  /** ISO 8601 */
  from: string;
  to: string;
}

export interface AdminUsageResponse {
  from: string;
  to: string;
  users: AdminUsageUserRow[];
  models: AdminUsageModelRow[];
  days: AdminUsageDayRow[];
}

/**
 * What the signed-in user's plan allows and how much allowance is left.
 *
 * Served by `GET /api/billing/entitlements`. Lives here rather than in
 * `@librechat/api` because the client is the reason it exists — the model
 * picker and the allowance display both read it, and a second definition on
 * that side would be free to drift from the one the gate enforces.
 */
export interface TEntitlements {
  plan: {
    code: PlanCode;
    name: string;
    allowedCostTiers: CostTier[];
    features: PlanConfig['features'];
  };
  /**
   * Null for plans that grant no credits — the anonymous tier, capped by
   * message count instead. Zero would render as an exhausted allowance rather
   * than an absent one.
   */
  credits: {
    remaining: number;
    granted: number;
    /** Sent rather than hard-coded client-side so the two cannot drift. */
    displayDivisor: number;
  } | null;
  /** ISO 8601, when the current allowance resets. */
  periodEnd: string | null;
  /**
   * Spec names this plan cannot reach, for greying them out in the picker.
   *
   * Absent means "not computed" and must be read as "lock nothing": guessing
   * from a partial answer would hide models the user is entitled to.
   */
  lockedModelSpecs?: string[];
}
