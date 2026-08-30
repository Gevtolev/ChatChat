// packages/api/src/billing/plans.ts
import type { PlanCode, PlanConfig } from 'librechat-data-provider';

export const PLANS: Record<PlanCode, PlanConfig> = {
  anonymous: {
    code: 'anonymous',
    name: 'Anonymous',
    monthly_price_cents: 0,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    // 匿名访客不发积分：其试用是产品规则，用条数而非额度表达
    monthly_token_credits: 0,
    lifetime_message_limit: 3,
    features: { agents: false, image_gen: false, voice: true, web_search: false },
  },
  free: {
    code: 'free',
    name: 'Free',
    monthly_price_cents: 0,
    allowed_cost_tiers: ['cheap'],
    monthly_token_credits: 200_000, // 占位：约 $0.2 成本的试用额度
    lifetime_message_limit: 0,
    features: { agents: false, image_gen: false, voice: false, web_search: false },
  },
  trial: {
    code: 'trial',
    name: 'Trial',
    monthly_price_cents: 100,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 400_000, // 占位：$1 档按 60% 毛利
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  pro_m: {
    code: 'pro_m',
    name: 'Pro Monthly',
    monthly_price_cents: 2999,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 11_996_000, // 占位：按 60% 毛利，待 Opus 用量核实后校准
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  pro_q: {
    code: 'pro_q',
    name: 'Pro Quarterly',
    monthly_price_cents: 7999,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 10_665_333, // 占位：按 60% 毛利，待 Opus 用量核实后校准
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  pro_h: {
    code: 'pro_h',
    name: 'Pro Half-Year',
    monthly_price_cents: 14999,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 9_999_333, // 占位：按 60% 毛利，待 Opus 用量核实后校准
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  /**
   * 内测专用，不对外销售，只能由管理员/CLI 授予。
   *
   * 额度刻意高于所有付费档（pro_m 是 11,996,000 = 约 $12）：内测的目的是让人
   * 放开用并给出反馈，而不是在第三天撞墙。$50 的参照是那个真实重度用户 18 天
   * 烧掉的 $51 —— 大致相当于一个月的高强度使用。
   *
   * `monthly_price_cents: 0` 意味着成本看板会把这些用户算成 100% 亏损。这是
   * 对的：内测确实没有收入，把它记成别的会污染毛利数据。
   */
  beta: {
    code: 'beta',
    name: 'Beta Tester',
    monthly_price_cents: 0,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 50_000_000,
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
};
