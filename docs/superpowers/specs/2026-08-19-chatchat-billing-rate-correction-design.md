# ChatChat — 计费口径修正（模型费率表）

> **版本**: 0.1.0
> **创建日期**: 2026-08-19
> **状态**: Draft（待用户复审）
> **父 spec**: [2026-05-21-graupel-stage-3-plan-gating.md](./2026-05-21-graupel-stage-3-plan-gating.md)
> **预估**: 6-10 小时
> **优先级**: 最高 —— 这是一个正在影响真实用户扣费的缺陷，独立于任何新功能

---

## 一、问题

12 个生产模型中有 7 个的计费费率是错的。费率同时驱动 `Balance.tokenCredits` 扣减，因此这不是统计口径问题，而是**用户被按错误价格扣积分**。

以 2026-08-19 实测为准（生产版 `findMatchingPattern` 算法 + 当日 OpenRouter 公开价目）：

| 模型 | 当前计费费率 | 真实费率 | 偏差 |
|---|---|---|---|
| `minimax/minimax-m3` | 6 / 6（兜底） | 0.30 / 1.20 | 多扣 20× / 5× |
| `z-ai/glm-5.2` | 6 / 6（兜底） | 0.97 / 3.04 | 多扣 6.2× / 2× |
| `x-ai/grok-4.3` | 3 / 15 | 1.25 / 2.50 | 多扣 2.4× / 6× |
| `moonshotai/kimi-k2.6` | 2 / 5 | 0.95 / 4.00 | 多扣 2.1× / 1.25× |
| `deepseek/deepseek-chat` | 0.28 / 0.42 | 0.26 / 1.03 | **少扣 2.45×（completion）** |
| `gpt-5.4-mini` | 2.5 / 15 | 待核（见 §五） | 多扣，量级待定 |
| `gpt-5.4-nano` | 2.5 / 15 | 待核（见 §五） | 多扣，量级待定 |

单位统一为**美元 / 百万 token**，与上游 `tokenValues` 一致。

偏差方向不单一：多数模型多扣，`deepseek/deepseek-chat` 的 completion 少扣 —— 该模型每次调用我们都在贴钱。

### 1.1 业务后果

- **多扣**：用户月度积分被过快消耗，提前撞到"额度用尽"，beta 期直接表现为留存损失
- **少扣**：真实成本高于我们记录的成本，且不会出现在任何告警里
- **成本看板不可信**：看板若基于同一份费率，会同时高估和低估，方向随模型分布而变

---

## 二、根因

### 2.1 费率解析链路

```
recordCollectedUsage          packages/api/src/agents/usage.ts
  └→ spendTokens / spendStructuredTokens
      └→ calculateTokenValue  packages/data-schemas/src/methods/transaction.ts:87
           txn.rate       = getMultiplier({ model, tokenType, endpointTokenConfig })
           txn.tokenValue = rawAmount × rate
              ├→ [分支 1] endpointTokenConfig 存在 → 用它，缺失模型落 defaultRate
              └→ [分支 2] 否则 getValueKey(model) → findMatchingPattern → tokenValues
                                                  → 匹配不到落 defaultRate = 6
```

### 2.2 为什么分支 1 从不生效

`endpointTokenConfig` 由 `processModelData()` 从供应商 `/models` 响应的 `pricing` 字段生成，缓存在 `tokenConfigCache`。它被两道门挡住：

1. **`FetchTokenConfig` 白名单**（`packages/data-provider/src/config.ts:1700`）只有 `openrouter`、`helicone` 两项，且按**端点名字**匹配。我们 8 个 custom 端点中只有一个名为 `OpenRouter`；名为 `xAI` 的端点即使 `baseURL` 指向 `openrouter.ai` 也匹配不上。
2. **全部 8 个端点均配置 `fetch: false`**，从不调用 `/models`。

即便打开 `fetch`，gptsapi 侧也走不通 —— 2026-08-19 实测 `https://api.gptsapi.net/v1/models` 仅返回 `{created, id, object, order_by}`，无 `pricing` 字段，`inputSchema.safeParse` 必然失败。

`librechat.yaml` 里的 `endpointConfig.tokenConfig` 属性同样不可用：全代码库仅在 `custom/initialize.ts:140` 出现一次，作用是**禁用缓存查找**，没有任何位置从它读取价格；`config.ts` 的 zod schema 也未定义该字段。

**结论：不存在纯配置的修正路径。**

### 2.3 为什么分支 2 出错

`tokenValues` 是上游硬编码的**原厂标价表**，按模型 ID 做子串匹配。两类失效：

- **缺条目** → 落 `defaultRate = 6`（GLM、MiniMax）
- **错配到较短前缀** → `gpt-5.4-mini` 命中 `gpt-5.4`，`x-ai/grok-4.3` 命中 `grok-4`

且即使匹配正确，它记的也是**原厂标价**，而我们付费对象是 gptsapi 与 OpenRouter。

---

## 三、方案

### 3.1 扩展 `tokenValues`

`tokenValues` 本身即为可组合结构（`packages/data-schemas/src/methods/tx.ts:105`）：

```ts
export const tokenValues: Record<string, { prompt: number; completion: number }> = Object.assign(
  { /* 上游数百条 */ },
  bedrockValues,
);
```

新增第三个来源：

```ts
  bedrockValues,
  chatchatValues,   // ← 唯一的上游文件改动，一行
);
```

全部数据置于新文件 `packages/data-schemas/src/methods/chatchat.ts`。这是能达成的最小分歧：上游文件一行 diff，后续价格变更完全不触碰上游文件。

**缓存费率不在本次范围内**，理由见 §7.2。

### 3.2 正确性依据

生产版 `findMatchingPattern`（`packages/api/src/utils/tokens.ts:425`）为**最长匹配 + 精确匹配短路**：

```ts
if (lowerKey.length > bestLength && lowerModelName.includes(lowerKey)) {
  if (lowerKey.length === lowerModelName.length) return key;   // 精确匹配立即返回
  bestMatch = key; bestLength = lowerKey.length;
}
```

我们写入**精确 model ID**，长度必然不小于上游任何前缀条目，因此确定性胜出，且不依赖对象键顺序 —— 上游未来增删条目不会改变结果。

该性质必须有测试固定（§六）。

### 3.3 为什么不选其他路径

| 路径 | 否决理由 |
|---|---|
| 端点改 `fetch: true` | 仅对名为 `openrouter` 的单个端点生效，8 个端点覆盖 1 个；且会引入全量模型列表与启动期外部依赖两个风险 |
| 启动时自行种 `tokenConfigCache` | 同样被 `FetchTokenConfig` 白名单挡住，7/8 端点无效 |
| 在成本看板读取时套用独立价格表 | 只修正看板数字，不修正真实扣费，缺陷继续存在 |
| 直接改上游 `tokenValues` 字面量 | 制造大面积上游分歧，每次同步都要人工合并 |

---

## 四、价格来源与时效

### 4.1 OpenRouter 侧（5 个模型）

来源：`https://openrouter.ai/api/v1/models` 公开接口，无需鉴权。字段 `pricing.prompt` / `pricing.completion`，单位为**美元 / token**，乘 `1e6` 转为本表单位。

2026-08-19 实测值：

| 模型 | prompt | completion | cache_read | cache_write |
|---|---|---|---|---|
| `deepseek/deepseek-chat` | 0.2574 | 1.0287 | 未提供 | 未提供 |
| `x-ai/grok-4.3` | 1.2500 | 2.5000 | 0.2000 | 未提供 |
| `moonshotai/kimi-k2.6` | 0.9500 | 4.0000 | 0.1600 | 未提供 |
| `z-ai/glm-5.2` | 0.9660 | 3.0360 | 0.1932 | 未提供 |
| `minimax/minimax-m3` | 0.3000 | 1.2000 | 0.0600 | 未提供 |

`cache_write` 一列全部缺失（OpenRouter 全站 415 个模型中仅 72 个提供该字段），因此缓存费率无法从此来源完整获取。见 §7.2。

### 4.2 gptsapi 侧

gptsapi 不公开价目 API。取值规则，按可信度降序：

1. **gptsapi 账单控制台实测单价** —— 最准，但需人工核对（见 §五）
2. **原厂公开标价** —— 作为上界代用值。gptsapi 作为中转商定价不高于原厂标价，故此值会略微**高估**我们的成本，方向保守（宁可以为更贵）

每个条目在源码中以注释标注来源与取数日期。

### 4.3 时效维护

新增脚本 `config/check-model-prices.js`：拉取 OpenRouter 实时价目，与 `chatchatValues` 逐项比对，输出偏差报告，只读不写。

这是路线选择的直接代价 —— 手工表会过期。脚本把"过期"从静默失效变成一条可主动运行的检查。**不设定时任务**，beta 期人工按需运行即可。

---

## 五、依赖用户核实的事项

`gpt-5.4-mini` / `gpt-5.4-nano` 的真实单价需从 gptsapi 账单控制台确认。在此之前按 §4.2 规则 2 取原厂标价上界。

同时待核：gptsapi 是否按其少报的 token 数出账（见 [2026-08-17-gptsapi-usage-underreporting.md](../research/2026-08-17-gptsapi-usage-underreporting.md)）。该问题与本 spec 正交 —— 本 spec 修正**单价**，该问题影响**token 计数**，两者独立且都会影响最终成本。

---

## 六、测试

置于 `packages/data-schemas/src/methods/chatchat.spec.ts`。

**必测项**：

1. **精确匹配优先** —— 对 7 个受影响模型逐一断言 `getValueKey()` 返回我们的精确条目，而非上游前缀条目
2. **不回归** —— 断言未被我们覆盖的上游模型解析结果不变（防止新条目意外成为某个上游模型的更长匹配）
3. **无兜底** —— 断言全部 12 个生产模型均不落 `defaultRate`
4. **单位一致** —— 断言 `chatchatValues` 全部条目为正数且在合理量级（0.001 ~ 200），拦截"忘记乘 1e6"这类错误
第 2 项尤其重要：新增一个较长的键可能改变某个上游模型的匹配结果。测试需覆盖 `modelSpecs` 中全部 37 个条目。

---

## 七、范围

### 7.1 在范围内

- `packages/data-schemas/src/methods/chatchat.ts`（新增）
- `packages/data-schemas/src/methods/tx.ts`（一行：`Object.assign` 追加参数，`cacheTokenValues` 同理）
- `config/check-model-prices.js`（新增，只读比对脚本）
- 上述测试

### 7.2 不在范围内

- **历史交易数据修正**。费率在写入时固化，现存 90 条记录（合计约 $0.40）保持原值。该量级下重算无意义，但成本看板需标注口径变更日期，否则趋势图会将其误读为用量变化。
- **缓存费率（`cacheTokenValues`）**。两个原因：其一，该常量是纯对象字面量而非 `Object.assign`，扩展它需要额外改动上游结构；其二更关键 —— 它要求 `{ write, read }` 成对取值，而我们 5 个 OpenRouter 模型**均未提供 `input_cache_write`**（`deepseek/deepseek-chat` 连 `input_cache_read` 也没有）。只填 `read` 会使 `write` 取到错误值，比现状更糟。待价格来源确定后单独处理。
- **`modelPricing.ts` 的去留**。该文件（含 `MODEL_PRICING` / `estimateCost`）目前零调用者，仅有自身 spec 引用。本次不动，单独决策。
- **gptsapi token 少报问题**。见 §五。
- **`balance.enabled`**。保持现状 `false`，本 spec 不改变其取值。

---

## 八、上线风险

**用户可感知的行为变化**：修正后用户积分消耗速度改变 —— 多数模型变慢（多扣被修正），DeepSeek 变快（少扣被修正）。beta 期用户量小且尚未收费，影响可控，但需在发布说明中记录变更日期。

**回滚**：还原 `tx.ts` 那一行即可完全回退，无数据迁移、无 schema 变更。
