# ChatChat — 计费口径修正（模型费率表）

> **版本**: 0.1.0
> **创建日期**: 2026-08-19
> **状态**: Draft（待用户复审）
> **父 spec**: [2026-05-21-graupel-stage-3-plan-gating.md](./2026-05-21-graupel-stage-3-plan-gating.md)
> **预估**: 6-10 小时
> **优先级**: 最高 —— 这是一个正在影响真实用户扣费的缺陷，独立于任何新功能
> **后续 spec**: [计费闸门通电](./2026-08-19-chatchat-billing-enforcement-design.md) —— 本 spec 校准刻度，该 spec 装上保险丝。二者必须一起完成才构成成本上界

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

上表的模型 ID 取自**本地** `librechat.yaml`；生产用的是另一套拼写，且多出一个 `x-ai/grok-4.5`。见 §1.5。

### 1.3 正确的 11 个

全部 Claude 系列（opus 4-5/4-6/4-7/4-8、sonnet 4-6 及 thinking 变体、haiku 4-5）、`gemini-2.5-flash`、`gemini-2.5-flash-lite`、`gemini-3.1-pro-preview`、`gpt-5.4` 与上游表精确一致，无需改动。

`grok-4-1-fast-non-reasoning` 单列：OpenRouter 目录中无对应条目，保留上游 `grok-4-1-fast` 的 0.2 / 0.5，来源标注为上游表。

### 1.4 缓存命中费率

独立于上述基础费率，缓存命中的计费同样有缺陷。`cacheTokenValues` 现有 53 条，覆盖我们 25 个支持缓存的模型时：**8 个无条目、6 个条目错误。**

无条目时的行为已由真实交易数据证实。生产库中一条 grok 记录：

```
{ model: "x-ai/grok-4.3", rate: 3, rawAmount: -387,
  inputTokens: -259, writeTokens: 0, readTokens: -128 }
```

`rate` 是三类 token 的加权平均，此处恰好等于 input 费率 3，说明 128 个缓存读取 token **按 input 满价计费**。缓存读取的真实价格通常是 input 的 1/5 ~ 1/10（grok 6.25×、Claude Opus 10×），因此这些 token 被多收了 5-10 倍。

无条目的 8 个：`gemini-2.5-flash`、`gemini-3-flash-preview`、`gemini-2.5-flash-lite`、`x-ai/grok-4.3`、三个 `grok-4.20-*` 变体、`glm-5.2`、`glm-5-turbo`、`MiniMax-M3`。

条目错误的 6 个中，`gpt-5.5` 的 read 取 0.125 而真实为 0.5（**少收 4 倍**），`gpt-5.4-pro` / `-mini` / `-nano` 均错配至 `gpt-5.4` 的 2.5/0.25。

叠加效应示例，仍用上面那条真实记录：当前扣 `387 × 3 = 1161` credits；修正基础费率后为 `259×1.25 + 128×1.25 = 484`；再修正缓存费率后为 `259×1.25 + 128×0.2 = 349`。**缓存修正在基础修正之上再降 28%。**对话越长缓存占比越高，该比例还会上升。

### 1.5 生产配置与本地已分叉（实施中发现）

上述 §1.1–1.4 的模型清单取自**本地** `librechat.yaml`。该文件**不在 git 里**，实施过程中经 SSH 核对生产副本，发现两者已经分叉：

| | 本地 | 生产 |
|---|---|---|
| Grok 4.20 | `grok-4.20-beta-0309-reasoning` 等三个变体 | `x-ai/grok-4.20`、`x-ai/grok-4.20-multi-agent` |
| Grok 4.5 | 无 | `x-ai/grok-4.5`（本地没有这个模型） |
| GLM / Kimi / MiniMax / DeepSeek | 裸名 `glm-5.2` | 带前缀 `z-ai/glm-5.2` |
| modelSpecs 写法 | 块式 `preset:` 多行 | 行内流式 `preset: { ... }` |

带前缀的那些靠子串匹配歪打正着（`z-ai/glm-5.2` 含 `glm-5.2`），但 **grok 系列三个模型匹配不上**，落回 `grok-4` 的 3/15：

| 生产模型 | 若按本地清单建表则计费 | 真实 |
|---|---|---|
| `x-ai/grok-4.20` | 3 / 15 | 1.25 / 2.5 |
| `x-ai/grok-4.20-multi-agent` | 3 / 15 | 1.25 / 2.5 |
| `x-ai/grok-4.5` | 3 / 15 | 2 / 6 |

**由此确立键的命名规则：使用不带供应商前缀的最短模型族名**（`grok-4.20` 而非 `x-ai/grok-4.20`）。子串匹配下裸键对两种拼写都生效，这是唯一能抗配置漂移的写法。

唯一例外是 `deepseek/deepseek-chat` 保留前缀 —— 裸 `deepseek-chat` 会与上游同名键碰撞，把所有 DeepSeek 变体一起改价。

### 1.6 业务后果

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

`cacheTokenValues`（`tx.ts:285`）是纯对象字面量，**不要包进 `Object.assign`** —— 那样 prettier 会重排全部 60 个条目的缩进，把 5 行语义改动变成 124 行文本 diff，每次上游同步都要人工处理。改为定义之后合并：

```ts
Object.assign(cacheTokenValues, chatchatCacheValues);
```

语义等价（我们的键覆盖同名上游键），但 `tx.ts` 的最终 diff 是 **8 行纯新增、零删除**，是这个方案能达到的最小上游足迹。

### 3.2 正确性依据

生产版 `findMatchingPattern`（`packages/api/src/utils/tokens.ts:425`）为**最长匹配 + 精确匹配短路**：

```ts
if (lowerKey.length > bestLength && lowerModelName.includes(lowerKey)) {
  if (lowerKey.length === lowerModelName.length) return key;   // 精确匹配立即返回
  bestMatch = key; bestLength = lowerKey.length;
}
```

我们写入的键长度必然大于上游那些更短的前缀条目（`grok-4.20` 长于 `grok-4`），因此确定性胜出，且不依赖对象键顺序 —— 上游未来增删条目不会改变结果。

键本身取**不带供应商前缀的最短模型族名**，理由见 §1.5：这样一个键同时覆盖 `grok-4.20` 与 `x-ai/grok-4.20` 两种拼写，不受配置漂移影响。

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
  'gemini-3-flash-preview': { prompt: 0.5, completion: 3 },
  'gpt-5.5': { prompt: 5, completion: 30 },
  'gpt-5.4-pro': { prompt: 30, completion: 180 },
  'gpt-5.4-mini': { prompt: 0.75, completion: 4.5 },
  'gpt-5.4-nano': { prompt: 0.2, completion: 1.25 },
  'grok-4.3': { prompt: 1.25, completion: 2.5 },
  'grok-4.5': { prompt: 2, completion: 6 },
  'grok-4.20': { prompt: 1.25, completion: 2.5 },
  'grok-4.20-multi-agent': { prompt: 1.25, completion: 2.5 },
  /** Multi-provider on OpenRouter, so the catalogue price tracks whichever
   *  provider is currently default — observed moving 1.32/3.96 → 1.44/2.88
   *  within an hour. Expect `check-model-prices` to flag this one periodically;
   *  the drift is routing, not a vendor price change. */
  'deepseek-v4-pro': { prompt: 1.44, completion: 2.88 },
  'deepseek-v4-flash': { prompt: 0.0826, completion: 0.1652 },
  'glm-5.2': { prompt: 0.966, completion: 3.036 },
  'glm-5-turbo': { prompt: 1.2, completion: 4 },
  'kimi-k2.6': { prompt: 0.95, completion: 4 },
  'MiniMax-M3': { prompt: 0.3, completion: 1.2 },
  'deepseek/deepseek-chat': { prompt: 0.2574, completion: 1.0287 },
};
```

三个 `grok-4.20-*` 变体映射至 OpenRouter 的 `x-ai/grok-4.20`（multi-agent 变体映射至 `x-ai/grok-4.20-multi-agent`，其定价与基础版相同）。

### 4.3 缓存费率（`chatchatCacheValues`）

27 个模型中 25 个提供 `input_cache_read`。缺失的两个（`gpt-5.4-pro`、`deepseek/deepseek-chat`）不支持缓存，**不设条目** —— 无条目时缓存 token 按 input 满价计费，对不支持缓存的模型这正是正确行为。

**`write` 取值规则**：不能一律采用 OpenRouter 的 `input_cache_write`。实测各家比值：

| 供应商 | write / prompt 比值 | 判定 |
|---|---|---|
| Anthropic（opus / sonnet / haiku） | 1.250 / 1.250 / 1.250 | 稳定倍率，**是真正的写入价** |
| Google（4 个 Gemini） | 0.278 / 0.188 / 0.167 / 0.833 | 比值散乱，且三个模型共用绝对值 0.0833 —— 这是**按时长计的存储价**，非每 token 写入倍率 |

因此：

- **Anthropic** → 采用 OpenRouter 的 `input_cache_write`（6 个模型，均为 1.25× input）
- **其余全部** → `write` 取该模型的 input 价。这些供应商使用隐式缓存，缓存创建的 token 本就按普通 input 计费；取 input 价而非 0，可保证万一 `writeTokens` 被上报也不会被免费计入

完整取值见 §4.4。

### 4.4 修正值全表（缓存部分，2026-08-19 取数）

Anthropic 六个模型的缓存费率上游**已经正确**（实测与 OpenRouter 完全一致），不纳入覆盖表 —— 覆盖它们只会凭空制造分歧。

**缓存覆盖与费率覆盖是两件独立的事。** `gemini-2.5-flash` 与 `gemini-2.5-flash-lite` 的基础费率上游本就正确，但二者**没有缓存条目**，缓存读取因此按 input 满价计（0.3 / 0.1），而真实值为 0.03 / 0.01 —— 多收 10 倍。它们必须进缓存表，尽管不在费率表里。

```ts
export const chatchatCacheValues = {
  /** Base rates for these two are already correct upstream, but neither has a
   *  cache entry, so cached reads were billing at the full input rate — 10x
   *  their real cost. Cache coverage is independent of base-rate coverage. */
  'gemini-2.5-flash': { write: 0.3, read: 0.03 },
  'gemini-2.5-flash-lite': { write: 0.1, read: 0.01 },

  'gemini-3-flash-preview': { write: 0.5, read: 0.05 },
  'gpt-5.5': { write: 5, read: 0.5 },
  'gpt-5.4-mini': { write: 0.75, read: 0.075 },
  'gpt-5.4-nano': { write: 0.2, read: 0.02 },
  'grok-4.3': { write: 1.25, read: 0.2 },
  'grok-4.5': { write: 2, read: 0.3 },
  'grok-4.20': { write: 1.25, read: 0.2 },
  'grok-4.20-multi-agent': { write: 1.25, read: 0.2 },
  'deepseek-v4-pro': { write: 1.44, read: 0.1215 },
  'deepseek-v4-flash': { write: 0.0826, read: 0.0165 },
  'glm-5.2': { write: 0.966, read: 0.1932 },
  'glm-5-turbo': { write: 1.2, read: 0.24 },
  'kimi-k2.6': { write: 0.95, read: 0.16 },
  'MiniMax-M3': { write: 0.3, read: 0.06 },
};
```

### 4.5 时效维护

新增脚本 `config/check-model-prices.js`：拉取 OpenRouter 实时价目，与 `chatchatValues` 及 `chatchatCacheValues` 逐项比对，输出偏差报告，只读不写。同时报告 `modelSpecs` 中存在但两表均未覆盖的模型 —— 新增模型时最容易漏的就是这一步。

这是路线选择的直接代价 —— 手工表会过期。脚本把"过期"从静默失效变成一条可主动运行的检查。**不设定时任务**，beta 期人工按需运行即可。

两点必须写进脚本输出，否则它给的是虚假的安心：

**其一，脚本读的是本地 `librechat.yaml`，而生产副本会分叉（见 §1.5）。** 本地跑通不证明生产被覆盖。

**其二，OpenRouter 的模型级 `pricing` 反映的是当前默认供应商，会随路由变动。** 实测 `deepseek/deepseek-v4-pro` 在一小时内从 1.32/3.96 变为 1.44/2.88；同期抽查的 21 个模型中仅此一例，所以波动局限于多供应商模型而非普遍现象。这类告警是路由变化不是厂商调价，需人工判断而非自动跟随。

---

## 五、依赖用户核实的事项

全部 27 个可映射模型的单价均已从 OpenRouter 取得，**本 spec 的实施不依赖任何待核数据**。

唯一仍待核实的是：gptsapi 是否按其少报的 token 数出账（见 [2026-08-17-gptsapi-usage-underreporting.md](../research/2026-08-17-gptsapi-usage-underreporting.md)）。该问题与本 spec 正交 —— 本 spec 修正**单价**，该问题影响**token 计数**，两者独立且都会影响最终成本。

---

## 六、测试

置于 `packages/data-schemas/src/methods/chatchat.spec.ts`。

### 6.0 先决条件：修正测试辅助函数

`packages/data-schemas/src/methods/test-helpers.ts` 中内联的 `findMatchingPattern` 与生产版**算法不同** —— 它是"反序取首个匹配"，胜出者取决于键的插入顺序；生产版是"最长匹配 + 精确短路"，胜出者取决于键长度。

data-schemas 不能反向依赖 `packages/api`，内联是必要的，但这份副本已经漂移。用它写的测试会以生产永远不会重现的理由通过或失败 —— §3.2 的正确性论证恰恰建立在长度优先之上，用错误算法验证等于没验证。

**必须先将其修正为与生产逐字等价**，再写本 spec 的任何测试。修正后既有 211 个 tx 测试全部通过，无回归。

### 6.1 必测项

1. **精确匹配优先** —— 对 16 个受影响模型逐一断言 `getValueKey()` 返回我们的精确条目，而非上游前缀条目
2. **不回归** —— 断言 §1.3 中 11 个当前正确的模型解析结果不变（防止新条目意外成为它们的更长匹配）
3. **无兜底** —— 断言覆盖表中每个模型的 prompt 与 completion 费率不同时等于 `defaultRate`
4. **单位一致** —— 断言 `chatchatValues` 全部条目为正数且在合理量级（0.01 ~ 200），拦截"忘记乘 1e6"这类错误
5. **缓存覆盖完整** —— 断言 `chatchatValues` 中每个模型（除显式声明不支持缓存者）都有缓存条目。**该断言必须是单向包含而非集合相等**：缓存表可以合法地包含费率表中没有的模型，因为一个模型可以基础费率正确却缺缓存条目 —— `gemini-2.5-flash` 与 `-lite` 正是此例。写成相等会把两件独立的事绑死，恰好掩盖这一类缺陷
6. **缓存费率生效** —— 断言 `getCacheMultiplier()` 对每个条目返回我们的值；断言 `read ≤ input` 与 `write ≥ read`（拦截字段写反）
7. **不支持缓存的模型返回 null** —— 断言 `gpt-5.4-pro` / `deepseek/deepseek-chat` 的 `getCacheMultiplier()` 返回 `null`。这不是缺口：`calculateStructuredTokenValue` 以 `?? inputMultiplier` 承接 `null`，缓存 token 因此按该模型自身的 input 费率计 —— 对不支持缓存的模型这正是正确金额，且 input 费率变动时自动跟随。显式写一个等于 input 价的条目反而会重复数据并腐化

第 2 项尤其重要：新增一个较长的键可能改变某个上游模型的匹配结果。

**测试不读 `librechat.yaml`。** data-schemas 未声明 `js-yaml` 依赖，为一个测试引入它不划算。断言全部从两张表自身推导，因此新增模型无需改测试；而"`modelSpecs` 中存在但两表未覆盖"这类跨文件一致性检查交给 §4.5 的脚本 —— 它运行在根 workspace，yaml 与网络都可用。

### 6.2 上游测试的必要改动

`tx.spec.ts` 中两处 DeepSeek 断言会失败，因为它们固定了 `deepseek/deepseek-chat` 与裸 `deepseek-chat` 同价，而我们刻意改变了该模型的费率。将 `deepseek/deepseek-chat` 从这两处的变体列表中移除并注明原因即可 —— 其余变体仍走上游条目，测试的原意得以保留。

这是本 spec 唯一触及上游测试的地方。固定错误定价的断言，在定价被修正时本就应当变更。

---

## 七、范围

### 7.1 在范围内

- `packages/data-schemas/src/methods/chatchat.ts`（新增）
- `packages/data-schemas/src/methods/tx.ts`（`tokenValues` 的 `Object.assign` 追加 `chatchatValues`；`cacheTokenValues` 由对象字面量包成 `Object.assign({ ... }, chatchatCacheValues)`；一行 import）
- `packages/data-schemas/src/methods/test-helpers.ts`（修正 `findMatchingPattern`，见 §6.0）
- `packages/data-schemas/src/methods/index.ts` 与 `src/index.ts`（导出新表，供检查脚本使用）
- `packages/data-schemas/src/methods/tx.spec.ts`（两处 DeepSeek 断言，见 §6.2）
- `package.json`（`check-model-prices` 脚本入口）
- `config/check-model-prices.js`（新增，只读比对脚本）
- 上述测试

### 7.2 不在范围内

- **历史交易数据修正**。费率在写入时固化，现存 90 条记录（合计约 $0.40）保持原值。该量级下重算无意义，但成本看板需标注口径变更日期，否则趋势图会将其误读为用量变化。
- **Gemini 的缓存存储费**。OpenRouter 的 `input_cache_write` 对 Gemini 是按时长计的存储价（见 §4.3），无法映射到 `cacheTokenValues` 的每 token 模型。该成本不计入，会略微低估 Gemini 的真实开销 —— 但仅在显式创建缓存时产生，而我们目前不使用 Gemini 的显式缓存 API。
- **`modelPricing.ts` 的去留**。该文件（含 `MODEL_PRICING` / `estimateCost`）目前零调用者，仅有自身 spec 引用。本次不动，单独决策。
- **gptsapi token 少报问题**。见 §五。
- **`balance.enabled`**。保持现状 `false`，本 spec 不改变其取值。

---

## 八、上线风险

**用户可感知的行为变化**：积分消耗速度按模型分化 —— 11 个多扣的模型变慢（最多 20 倍），5 个少扣的模型变快（`gpt-5.4-pro` 快 6 倍）。beta 期用户量小且尚未收费，影响可控，但需在发布说明中记录变更日期。

**`gpt-5.4-pro` 的额度影响需单独评估**：修正后该模型消耗积分的速度是修正前的 6 倍，按 §一的真实单价，Pro 月度额度用于该模型时可支撑的对话轮次将显著下降。这是把真实成本暴露出来的必然结果，但可能需要重新审视是否应向非最高档 plan 开放该模型 —— 该决策不在本 spec 范围内，但应在实施后立即基于修正后的数据重新评估。

**回滚**：还原 `tx.ts` 那一行即可完全回退，无数据迁移、无 schema 变更。
