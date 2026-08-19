# ChatChat — 计费闸门通电

> **版本**: 0.1.0
> **创建日期**: 2026-08-19
> **状态**: Draft（待用户复审）
> **前置依赖**: [2026-08-19-chatchat-billing-rate-correction-design.md](./2026-08-19-chatchat-billing-rate-correction-design.md)
> **预估**: 10-16 小时
> **优先级**: 最高（与费率修正并列，且必须在其之后）

---

## 一、目标

让**每用户每月成本存在上界，且该上界低于订阅价**。

这是"不会亏钱"的可操作定义。不是每一笔都算准 —— 那做不到，供应商报数、中转商差价、价格漂移都会引入误差。能做到的是：**最坏情况被锁死在积分发放量上，与用户如何使用无关。**

pro_m 发放 11,996,000 credits ≈ $12 成本，售价 $29.99。上界成立时，名义毛利 60%，即使费率整体低估 2 倍仍在盈亏平衡之上。

**当前该上界完全不存在。**

---

## 二、现状：仪表在转，闸门未接

### 2.1 余额从不扣减

`createTransaction`（`packages/data-schemas/src/methods/transaction.ts:314`）：

```js
await transaction.save();
if (!balance?.enabled) {
  return;                    // ← 到此为止，余额一分不动
}
const incrementValue = transaction.tokenValue;
await updateBalance({ user: transaction.user, incrementValue });
```

`librechat.yaml` 中**没有 `balance:` 配置块**，`balanceSchema` 的 `enabled` 默认为 `false`。因此每一笔生成都写了 Transaction，但 `Balance.tokenCredits` 从未被扣减。

生产实例可直接观察到该状态：`transactions` 90 条，`balances` 0 条。

### 2.2 门控因此永远不触发

`checkBillingAccess`（`packages/api/src/billing/gating.ts`）挂在 `api/app/clients/BaseClient.js:572`，`AgentClient extends BaseClient`，路径是通的。但它的积分判断是：

```js
if (plan.monthly_token_credits > 0) {
  const credits = (await deps.getBalanceCredits(userId)) ?? 0;
  if (credits <= 0) { /* 拒绝 */ }
}
```

余额永不下降，该条件就永远不成立。**门装好了，但秤坏了，所以门永远不关。**

叠加 `DISABLE_BILLING_GATING`（`gating.ts:53` 的测试期逃生开关）——生产取值需在 Coolify 上确认，见 §六。

### 2.3 图像生成完全不计费、不门控

`packages/api/src/images/` 下全部文件零计费调用。`service.ts:83` 留有 `TODO(gating): checkBillingAccess(featureFlag: 'image_gen')`，即门控也未接。

生产配置开放 Nano Banana Pro 与 GPT Image 2，单张成本远高于一次文本对话。这是一整类不出现在任何账目里、也不受任何限制的成本。

### 2.4 兜底限流关闭

`.env`：`LIMIT_MESSAGE_USER=false`。仅 `MESSAGE_IP_MAX=40` 按 IP 限制，同一用户更换网络即可绕过。

---

## 三、方案

四项改动，缺一不可 —— 任何一项缺失，上界都不成立。

### 3.1 开启余额扣减

`librechat.yaml` 新增：

```yaml
balance:
  enabled: true
  startBalance: 200000      # free 档发放量，兜底给未经 applyPlanChange 的用户
  autoRefillEnabled: false  # 见下方说明，不可设为 true
```

**`autoRefillEnabled` 必须为 `false`。** 这不是保守选择，而是正确性要求。

`createSetBalanceConfig`（`packages/api/src/middleware/balance.ts:79`）挂在**全部登录路径**上 —— 本地登录（`auth.js:49`）、OAuth 回调（`oauth.js:59` 与 `:83`）、管理员登录（`admin/auth.js` 三处）。逻辑为：

```js
if (userRecord?.autoRefillEnabled !== config.autoRefillEnabled) {
  // 用全局配置覆盖用户记录的 refill 字段
}
```

而我们的 `grantMonthlyCredits` 按 plan 写入 `refillAmount`（pro_m 是 11,996,000，free 是 200,000）。若全局配置启用 auto-refill，**每一次登录**（含 OAuth）都会把按 plan 的发放量覆盖成全局的单一值，所有档位的用户最终拿到同样的月度额度 —— 付费用户被降到 free 档的量，付费与免费的差别消失。

设为 `false` 时 `isAutoRefillConfigValid` 为假，函数在触碰 refill 字段前提前返回，per-plan 设置得以保留。月度续发完全由 `grantMonthlyCredits` 写入的 Balance 自身 refill 机制负责。

`startBalance` 无此问题：`buildUpdateFields` 仅在 `!userRecord || tokenCredits == null` 时写入，不会覆盖已有余额。

### 3.2 补齐 Balance 记录

开启扣减后，无 Balance 记录的用户会被 `getBalanceCredits` 判为 0 而立即拒绝。两类用户需要覆盖：

| 用户类型 | 现状 | 处理 |
|---|---|---|
| 有 `Subscription` 记录 | 走过 `applyPlanChange`，但在扣减开启前可能未生成 Balance | 现有 `config/backfill-plan-credits.js` 已覆盖 |
| **隐式 free 用户** | 使用 `SYSTEM_DEFAULT_FREE_SUBSCRIPTION`（内存常量，从不持久化），因此**没有 Subscription 记录**，现有 backfill 脚本查不到 | **需扩展脚本** |

第二类是当前 backfill 脚本的盲区 —— 它以 `Subscription.find()` 为起点。扩展为：以 `User` 集合为起点，有订阅的按其 plan 发放，无订阅的按 free 档发放。保持幂等（已有 Balance 者跳过）。

`startBalance: 200000` 覆盖全部登录路径（含 OAuth），可防止用户被锁死在门外。但它是**单一全局值，不区分档位** —— 一个尚无 Balance 记录的 pro_m 用户登录时会拿到 200,000 而非 11,996,000。因此它只是防锁死的安全网，**发放正确金额仍依赖 backfill 与 `applyPlanChange`**，且 backfill 必须先于开启扣减执行（见 §八）。

### 3.3 图像生成计费与门控

**门控**：落实 `service.ts:83` 的 TODO，接入 `checkBillingAccess`。

**计费**：图像按张计价，非按 token。`Transaction` 的 `tokenType` 枚举已含 `'credits'`（`schema/transaction.ts:38`），上游 `checkBalance.ts:132` 即用该类型做定额扣减，直接复用，无需扩展 schema。

**定价**：单张成本从配置读取，不硬编码。初始取值需注意两点：

- `google/gemini-3-pro-image` 在 OpenRouter 有 `image_output` 字段，但其单位（每张 / 每 token）未经确认，不能直接采用
- `openai/gpt-image-2` **不在 OpenRouter 目录中**，无公开来源

因此初始值取供应商公布的每张价格，**并按保守方向上浮** —— 图像计费的首要目的是让这类成本**被计入且受限**，而非精确。高估会让用户的图像额度偏紧，低估会让整个上界失效；两者代价不对称。精确定价待有真实用量后再校准。

### 3.4 关闭逃生开关并启用兜底限流

- `DISABLE_BILLING_GATING` 置为 `false`（或移除）
- `LIMIT_MESSAGE_USER=true`，`MESSAGE_USER_MAX` 设为一个远高于正常使用、但能拦住失控脚本的值

限流是**第二道防线**，不替代积分上界：积分按成本计量，限流按次数计量，后者拦不住"少量请求消耗巨额 token"。它的作用是在积分体系本身出故障时兜底。

---

## 四、上界推导

四项全部落地后：

```
每用户每月最大成本
  = 积分发放量（按 plan）
  = pro_m: 11,996,000 credits × $1e-6 = $12.00
  < 订阅价 $29.99
```

成立的前提，逐条对应上文：

| 前提 | 由谁保证 |
|---|---|
| 费率反映真实成本 | 前置 spec（费率修正） |
| 每笔消耗都扣减余额 | §3.1 |
| 每个用户都有余额记录 | §3.2 |
| 所有花钱路径都计费 | §3.3（图像）+ 现有文本路径 |
| 余额归零真的拦截 | §3.4 |

### 4.1 上界之外的残余风险

上界成立后仍有三项误差，它们影响上界的**精确位置**，不影响其**存在性**：

1. **gptsapi 少报 token**（Opus system 部分 126-195×，见 [research 文档](../research/2026-08-17-gptsapi-usage-underreporting.md)）—— 若其按真实用量出账而只报少报值，差额由我们承担。这是唯一可能击穿上界的风险，需账单核对确认。
2. **原厂标价 ≠ gptsapi 实付价** —— 15 个经 gptsapi 路由的模型使用原厂标价。中转商加价则我们低估，折扣则高估。
3. **价格漂移** —— 费率表为 2026-08-19 快照，`config/check-model-prices.js` 提供主动检查但需人工运行。

60% 名义毛利为这三项提供缓冲。

---

## 五、测试

- **扣减生效** —— `mongodb-memory-server` 真库，断言一次 `spendTokens` 后 `Balance.tokenCredits` 按 `tokenValue` 下降
- **归零拦截** —— 断言余额为 0 或负时 `checkBillingAccess` 抛 `upgrade_required_quota`
- **无记录视为 0** —— 断言无 Balance 记录的用户被拒，而非放行
- **refill 不被覆盖**（关键回归）—— 模拟 pro_m 用户经 `setBalanceConfig` 中间件，断言其 `refillAmount` 仍为 11,996,000 而非全局值。本地与 OAuth 两条路径各测一次，因为该中间件在两处均有挂载
- **startBalance 不覆盖已有余额** —— 断言已有 Balance 的用户经该中间件后余额不变
- **backfill 幂等** —— 连续运行两次，第二次全部报告为跳过
- **backfill 覆盖隐式 free 用户** —— 无 Subscription 记录的用户也获得 free 档发放
- **图像计费** —— 断言生成一张图后产生 `tokenType: 'credits'` 交易且余额下降
- **图像门控** —— 断言余额不足时图像生成被拒

---

## 六、依赖用户确认的事项

1. **生产 `DISABLE_BILLING_GATING` 的实际取值** —— 本地 `.env` 未设置，`.env.example` 注释为 `false`，但生产配置在 Coolify 上加密存储，需登录确认。若已为 `true`，§3.4 即为将其翻转；若本就未设置，则该项无需改动。
2. **两个图像模型的每张真实成本** —— 见 §3.3，无公开 API 来源。

---

## 七、范围

### 7.1 在范围内

`librechat.yaml` 的 `balance:` 块；`config/backfill-plan-credits.js` 扩展；`packages/api/src/images/service.ts` 的门控与计费；`.env` 两个开关；上述测试。

### 7.2 不在范围内

- **前端额度展示**（`QuotaBar` / `UpgradeModal`）。用户看到余额是必要的产品体验，但属于 stage 3 未完成部分，与"止血"正交，单独推进。
- **积分发放量的重新标定**。当前六档发放量按 60% 毛利设定，前置 spec 修正费率后该假设需重新验证 —— 但需要真实用量分布，应在成本看板上线后进行。
- **`gpt-5.4-pro` 是否应向非最高档开放**。定价决策，见前置 spec §八。
- **Stripe 与自助升级**。stage 6。

---

## 八、上线顺序与回滚

**必须按序执行，中间状态会拒绝所有用户：**

1. 费率修正上线（前置 spec）
2. 运行扩展后的 backfill（`--dry` 先行，确认覆盖全部用户）
3. 开启 `balance.enabled`
4. 关闭 `DISABLE_BILLING_GATING`
5. 图像计费与门控
6. 启用 `LIMIT_MESSAGE_USER`

第 2 步先于第 3 步是硬约束：先开扣减再补记录，会有一段时间内全部用户因无 Balance 记录被拒。

**回滚**：任一步骤均可独立回退。最快的整体回滚是将 `DISABLE_BILLING_GATING` 置回 `true` —— 该开关绕过全部积分判断，可在不重启的情况下恢复服务（需确认 Coolify 环境变量是否热加载）。
