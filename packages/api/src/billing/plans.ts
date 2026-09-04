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
  /**
   * 三个付费档只有额度不同 —— 模型档位和功能全部开放，用户按用量选，不按
   * 功能选。这是刻意的：功能差异化要维护三条产品线，而在还没验证付费意愿
   * 之前，那是把复杂度花在没被证实的假设上。要改也容易，`allowed_cost_tiers`
   * 和 `features` 本来就是逐档配置的。
   *
   * 额度由**用户看到的整数积分**倒推，而不是由售价直接乘出来：展示口径是
   * `CREDIT_DISPLAY_DIVISOR = 14.95`，锚点是「Plus = 100 万积分」。
   *
   *   Plus  100 万 × 14.95 = 14,950,000  → 成本 $14.95，毛利 50.0%
   *   Pro   200 万 × 14.95 = 29,900,000  → 成本 $29.90，毛利 50.1%
   *   Max   350 万 × 14.95 = 52,325,000  → 成本 $52.33，毛利 47.6%
   *
   * Max 是 350 万而不是 300 万，因为 $99.9 是 $29.9 的 3.34 倍：给 300 万的话
   * 最贵的档每美元买到的积分（30,030）反而**少于**最便宜的档（33,445），阶梯
   * 是倒的，没有人有理由升上去。350 万让它略优（35,035），代价是毛利从 50%
   * 降到 47.6%。
   *
   * Pro 保持 200 万这个整数，每美元 33,389 与 Plus 的 33,445 几乎持平。计量型
   * 产品按同一费率卖更多容量是常见做法，而且毛利可预测在这里格外重要 ——
   * 见下方关于 Opus 少报用量的说明。
   *
   * 取代了旧的 pro_m/pro_q/pro_h —— 那三个是同一产品的月/季/半年付，按 60%
   * 毛利定的额度。换档时生产库里这三个 code 一条记录都没有，无需迁移。
   *
   * 「50% 毛利」是按我们**记账的**成本算的，而记账依赖 gptsapi 上报的用量。
   * Opus 系列的 system token 少报 126-195 倍尚未定性，所以 Claude 重度用户
   * 的真实毛利低于这里的 50%。等账单核对完要回来校准。
   */
  plus: {
    code: 'plus',
    name: 'Plus',
    monthly_price_cents: 2990,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 14_950_000,
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    monthly_price_cents: 5990,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 29_900_000,
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  max: {
    code: 'max',
    name: 'Max',
    monthly_price_cents: 9990,
    allowed_cost_tiers: ['cheap', 'mid', 'expensive'],
    monthly_token_credits: 52_325_000,
    lifetime_message_limit: 0,
    features: { agents: true, image_gen: true, voice: true, web_search: true },
  },
  /**
   * 内测专用，不对外销售，只能由管理员/CLI 授予。
   *
   * $50 的参照是那个真实重度用户 18 天烧掉的 $51 —— 大致相当于一个月的高强度
   * 使用。内测的目的是让人放开用并给出反馈，而不是在第三天撞墙。
   *
   * 定档时它远高于所有付费档（当时最高的 pro_m 是 11,996,000 ≈ $12）。现在
   * 它**低于** Max（52,325,000）—— 内测用户拿到的比最贵的付费档还少一点。
   *
   * 保持不动，因为上面那个 $50 的依据是绝对用量（一个月高强度使用），不是
   * 「比最高档更高」；而且付费档的额度是从售价倒推的，它跟内测该给多少本来
   * 就是两件事。但这个数**不会自己跟着付费档涨**：哪天想让内测明显宽松于
   * Max，得主动抬。
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
