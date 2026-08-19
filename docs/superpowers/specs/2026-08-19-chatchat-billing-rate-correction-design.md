# ChatChat — 计费口径修正（模型费率表）

> **版本**: 0.1.0
> **创建日期**: 2026-08-19
> **状态**: Draft（待用户复审）
> **父 spec**: [2026-05-21-graupel-stage-3-plan-gating.md](./2026-05-21-graupel-stage-3-plan-gating.md)
> **预估**: 6-10 小时
> **优先级**: 最高 —— 这是一个正在影响真实用户扣费的缺陷，独立于任何新功能

---

## 一、问题

`librechat.yaml` 的 `modelSpecs` 共 28 个对用户开放的模型，其中 **16 个计费费率错误**。费率同时驱动 `Balance.tokenCredits` 扣减，因此这不是统计口径问题，而是**用户被按错误价格扣积分、我们按错误价格记录成本**。

以 2026-08-19 实测为准：生产版 `findMatchingPattern` 算法解析当前费率，OpenRouter 公开价目接口取真实费率。单位统一为**美元 / 百万 token**。

### 1.1 少扣 —— 我们在贴钱

这是最严重的一类。真实成本高于记录成本，差额不出现在任何账目里。

| 模型 | 当前扣费 | 真实成本 | 每百万 completion token 净亏 |
|---|---|---|---|
| **`gpt-5.4-pro`** | 5 / 30 | **30 / 180** | **$150.00** |
| `gpt-5.5` | 1.25 / 10 | 5 / 30 | $20.00 |
| `deepseek-v4-pro` | 0.28 / 0.42 | 1.32 / 3.96 | $3.54 |
| `kimi-k2.6` | 0.6 / 2.5 | 0.95 / 4 | $1.50 |
| `deepseek/deepseek-chat` | 0.28 / 0.42 | 0.2574 / 1.0287 | $0.61 |

`gpt-5.4-pro` 的真实单价是我们记录值的 6 倍。它是 modelSpecs 中对用户开放的模型之一。

这直接坐实了 Board 评审"卖出一份没有对冲的看跌期权"的判断，且比预想严重 —— 问题不在于"某个重度用户可能超支"，而在于**最贵的模型被系统性地按 1/6 成本记账**。相对结构也是错的：`gpt-5.4-pro` 与 `gpt-5.4` 真实价差 12 倍，当前表中仅 2 倍。

### 1.2 多扣 —— 用户吃亏

| 模型 | 当前扣费 | 真实成本 | 偏差 |
|---|---|---|---|
| `MiniMax-M3` | 6 / 6（兜底） | 0.3 / 1.2 | 20× / 5× |
| `gpt-5.4-nano` | 2.5 / 15 | 0.2 / 1.25 | 12.5× / 12× |
| `glm-5.2` | 6 / 6（兜底） | 0.966 / 3.036 | 6.21× / 1.98× |
| `glm-5-turbo` | 6 / 6（兜底） | 1.2 / 4 | 5× / 1.5× |
| `gemini-3-flash-preview` | 2 / 12 | 0.5 / 3 | 4× / 4× |
| `deepseek-v4-flash` | 0.28 / 0.42 | 0.0826 / 0.1652 | 3.39× / 2.54× |
| `gpt-5.4-mini` | 2.5 / 15 | 0.75 / 4.5 | 3.33× / 3.33× |
| `x-ai/grok-4.3` | 3 / 15 | 1.25 / 2.5 | 2.4× / 6× |
| `grok-4.20-beta-0309-reasoning` | 3 / 15 | 1.25 / 2.5 | 2.4× / 6× |
| `grok-4.20-beta-0309-non-reasoning` | 3 / 15 | 1.25 / 2.5 | 2.4× / 6× |
| `grok-4.20-multi-agent-beta-0309` | 3 / 15 | 1.25 / 2.5 | 2.4× / 6× |

### 1.3 正确的 11 个

全部 Claude 系列（opus 4-5/4-6/4-7/4-8、sonnet 4-6 及 thinking 变体、haiku 4-5）、`gemini-2.5-flash`、`gemini-2.5-flash-lite`、`gemini-3.1-pro-preview`、`gpt-5.4` 与上游表精确一致，无需改动。

`grok-4-1-fast-non-reasoning` 单列：OpenRouter 目录中无对应条目，保留上游 `grok-4-1-fast` 的 0.2 / 0.5，来源标注为上游表。

### 1.4 业务后果

- **少扣**：真实成本高于记录成本，成本看板会低估，告警不会触发
- **多扣**：用户月度积分被过快消耗，提前撞到"额度用尽"，beta 期表现为留存损失
- **两者叠加**：看板的总数既非高估也非低估，而是**方向随用户的模型选择而变**，无法通过统一系数校正

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

### 4.1 统一来源：OpenRouter 公开价目

`https://openrouter.ai/api/v1/models`，无需鉴权。字段 `pricing.prompt` / `pricing.completion`，单位为**美元 / token**，乘 `1e6` 转为本表单位。

该接口收录全部 27 个可映射模型（含经 gptsapi 路由的 OpenAI / Anthropic / Google 系列），因此**两侧使用同一来源**，无需分别处理。对 gptsapi 路由的模型，此值为原厂标价，作为成本上界使用 —— 中转商定价不高于原厂标价，故方向保守。

### 4.2 修正值全表（2026-08-19 取数）

```ts
export const chatchatValues = {
  'gemini-3-flash-preview':           { prompt: 0.5,    completion: 3      },
  'gpt-5.5':                          { prompt: 5,      completion: 30     },
  'gpt-5.4-pro':                      { prompt: 30,     completion: 180    },
  'gpt-5.4-mini':                     { prompt: 0.75,   completion: 4.5    },
  'gpt-5.4-nano':                     { prompt: 0.2,    completion: 1.25   },
  'x-ai/grok-4.3':                    { prompt: 1.25,   completion: 2.5    },
  'grok-4.20-beta-0309-reasoning':     { prompt: 1.25,   completion: 2.5    },
  'grok-4.20-beta-0309-non-reasoning': { prompt: 1.25,   completion: 2.5    },
  'grok-4.20-multi-agent-beta-0309':   { prompt: 1.25,   completion: 2.5    },
  'deepseek-v4-pro':                  { prompt: 1.32,   completion: 3.96   },
  'deepseek-v4-flash':                { prompt: 0.0826, completion: 0.1652 },
  'glm-5.2':                          { prompt: 0.966,  completion: 3.036  },
  'glm-5-turbo':                      { prompt: 1.2,    completion: 4      },
  'kimi-k2.6':                        { prompt: 0.95,   completion: 4      },
  'MiniMax-M3':                       { prompt: 0.3,    completion: 1.2    },
  'deepseek/deepseek-chat':           { prompt: 0.2574, completion: 1.0287 },
};
```

三个 `grok-4.20-*` 变体映射至 OpenRouter 的 `x-ai/grok-4.20`（multi-agent 变体映射至 `x-ai/grok-4.20-multi-agent`，其定价与基础版相同）。

`cache_write` 字段全站 415 个模型中仅 72 个提供，我们的模型均未提供，因此缓存费率不在本次范围（见 §7.2）。

### 4.3 时效维护

新增脚本 `config/check-model-prices.js`：拉取 OpenRouter 实时价目，与 `chatchatValues` 逐项比对，输出偏差报告，只读不写。

这是路线选择的直接代价 —— 手工表会过期。脚本把"过期"从静默失效变成一条可主动运行的检查。**不设定时任务**，beta 期人工按需运行即可。

---

## 五、依赖用户核实的事项

全部 27 个可映射模型的单价均已从 OpenRouter 取得，**本 spec 的实施不依赖任何待核数据**。

唯一仍待核实的是：gptsapi 是否按其少报的 token 数出账（见 [2026-08-17-gptsapi-usage-underreporting.md](../research/2026-08-17-gptsapi-usage-underreporting.md)）。该问题与本 spec 正交 —— 本 spec 修正**单价**，该问题影响**token 计数**，两者独立且都会影响最终成本。

---

## 六、测试

置于 `packages/data-schemas/src/methods/chatchat.spec.ts`。

**必测项**：

1. **精确匹配优先** —— 对 16 个受影响模型逐一断言 `getValueKey()` 返回我们的精确条目，而非上游前缀条目
2. **不回归** —— 断言 §1.3 中 11 个当前正确的模型解析结果不变（防止新条目意外成为它们的更长匹配）
3. **无兜底** —— 断言 `modelSpecs` 全部 28 个模型均不落 `defaultRate`
4. **单位一致** —— 断言 `chatchatValues` 全部条目为正数且在合理量级（0.01 ~ 200），拦截"忘记乘 1e6"这类错误
5. **完整性** —— 断言 `chatchatValues` 的键集合是 `modelSpecs` 中 model 值的子集，防止表中残留已下线模型

第 2 项尤其重要：新增一个较长的键可能改变某个上游模型的匹配结果。测试需以 `librechat.yaml` 的 `modelSpecs` 为数据源，而非硬编码模型列表 —— 新增模型时测试应自动覆盖。

---

## 七、范围

### 7.1 在范围内

- `packages/data-schemas/src/methods/chatchat.ts`（新增）
- `packages/data-schemas/src/methods/tx.ts`（一行：`tokenValues` 的 `Object.assign` 追加 `chatchatValues` 参数）
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

**用户可感知的行为变化**：积分消耗速度按模型分化 —— 11 个多扣的模型变慢（最多 20 倍），5 个少扣的模型变快（`gpt-5.4-pro` 快 6 倍）。beta 期用户量小且尚未收费，影响可控，但需在发布说明中记录变更日期。

**`gpt-5.4-pro` 的额度影响需单独评估**：修正后该模型消耗积分的速度是修正前的 6 倍，按 §一的真实单价，Pro 月度额度用于该模型时可支撑的对话轮次将显著下降。这是把真实成本暴露出来的必然结果，但可能需要重新审视是否应向非最高档 plan 开放该模型 —— 该决策不在本 spec 范围内，但应在实施后立即基于修正后的数据重新评估。

**回滚**：还原 `tx.ts` 那一行即可完全回退，无数据迁移、无 schema 变更。
