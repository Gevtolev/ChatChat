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
};
