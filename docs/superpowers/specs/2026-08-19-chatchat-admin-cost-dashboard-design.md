# ChatChat — 管理员成本看板

> **版本**: 0.1.0
> **创建日期**: 2026-08-19
> **状态**: Draft（待用户复审）
> **父 spec**: [2026-05-21-graupel-stage-5-launch.md](./2026-05-21-graupel-stage-5-launch.md)
> **前置依赖**: [2026-08-19-chatchat-billing-rate-correction-design.md](./2026-08-19-chatchat-billing-rate-correction-design.md)
> **预估**: 16-24 小时

---

## 一、目标

消除"对每用户成本零可见度"。

当前状态是固定价订阅 + 顶级模型 + 无成本观测。Board 评审将该风险表述为"卖出一份没有对冲的看跌期权"：单个重度用户的月成本可能超过其订阅费，而我们在收到月度账单前不会知情。

看板需回答两个问题：

1. **哪些用户在亏钱** —— 每用户成本 vs 其订阅费
2. **钱花在哪** —— 按模型、按用途（`title` / `message`）、按日趋势

**仅管理员可见，只读。** 不面向用户暴露任何成本数据。

---

## 二、数据源：`Transaction` 读时聚合

### 2.1 选择依据

`Transaction` 已是完备的成本记录，由 `spendTokens` 在每次生成后写入，且已积累 2026-05-26 至今的历史。

单条记录形态（生产实例实测）：

```
{ user, model: "x-ai/grok-4.3", context: "message", tokenType: "prompt",
  rate: 3, rawAmount: -387, tokenValue: -1161,
  inputTokens: -259, writeTokens: 0, readTokens: -128, createdAt }
```

`tokenValue` 单位为 tokenCredits，`1e6 tokenCredits = $1`，与 `Balance` 扣减口径完全一致。缓存三拆（input / write / read）亦已存在，取负值存储。

### 2.2 弃用 `UsageLog`

`UsageLog` schema 与 `recordUsage()` 方法均已实现但**零调用者**，且带 90 天 TTL。

不为其补写入点，理由：

- 补写入点只能从接入日起积累数据，2.5 个月历史作废
- 在生成热路径上增加一次写操作
- 成本计算逻辑需复制一份，两份数据可能对不上
- 90 天 TTL 无法支撑长期审计

**删除** `packages/data-schemas/src/{schema,models,methods,types}/usageLog.ts` 四个文件，并同步修改 `CLAUDE.md` 中"成本审计走 UsageLog"的表述。

保留一个从未通电的平行实现，会让后续维护者（含未来的自己）误以为存在两个成本数据源。

### 2.3 准确性依赖

`tokenValue` 的准确性取决于费率表。前置 spec 修正前，12 个生产模型中 7 个费率错误（最大偏差 20×），本看板必须在其之后实施，否则展示的是系统性错误的数字。

---

## 三、后端

### 3.1 位置

沿用现有 admin 模块的依赖注入模式（比照 `createAdminUsersHandlers`）：

```
packages/api/src/admin/usage.ts      聚合逻辑与 handler 工厂
api/server/routes/admin/usage.js     薄封装
api/server/index.js                  app.use('/api/admin/usage', routes.adminUsage)
```

鉴权复用现成机制，不新建：

```js
router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
```

### 3.2 单管道三结果

```
$match:  { createdAt: { $gte: from, $lte: to } }
$facet:
  byUser  → { _id: user, credits, calls, models: $addToSet }
  byModel → { _id: { model, context }, credits, inputTokens, writeTokens, readTokens, calls }
  byDay   → { _id: 日期字符串, credits }
```

使用 `$facet` 而非三次独立查询：三份结果共享同一 `$match`，分开发送会对同一批文档扫描三遍。项目规范明确要求合并顺序扫描。

**收入侧不用 `$lookup`**：`Transaction.user` 与 `Subscription.user_id` 字段名不同，且 beta 期用户数极少，单独查询订阅表后用 `Map` 合并更清晰。每用户月度收入取 `PLANS[plan_code].monthly_price_cents`。

### 3.3 不新增索引

`Transaction` 现有索引为 `user` / `model` / `conversationId` / `tenantId`，无 `createdAt`。日期范围查询将全表扫描。

在 10 万行量级下扫描耗时为毫秒级。为此向上游 schema 引入分歧，是在解决一个尚不存在的问题。单表超过百万行时再评估。

### 3.4 周期口径

时间范围由调用方传入，前端提供三个预设：**本月 / 近 30 天 / 全部**。

默认"近 30 天"而非自然月：订阅周期锚点因用户而异，滚动 30 天与月度订阅费可比，且对刚开始大量消耗的用户响应更及时。

---

## 四、前端

### 4.1 路由

`/admin/usage`，挂载于 `Root` 之下，继承既有鉴权与会话处理。前端角色判断仅为 UX，真正的守卫在后端。

### 4.2 组件

```
client/src/components/Admin/Usage/
  UsagePanel.tsx        容器 + 时间范围选择
  UserMarginTable.tsx   每用户毛利表（复用 packages/client 的 DataTable）
  CostBreakdown.tsx     按模型 × 用途
  Trend.tsx             日趋势
  index.ts
```

数据层按项目规范：`client/src/data-provider/Admin/queries.ts` → 端点入 `api-endpoints.ts` → 服务入 `data-service.ts` → 类型入 `types/queries.ts`。

### 4.3 不引入图表库

项目当前无任何图表依赖。为一个单人使用的内部页面引入 recharts（打包体积数百 KB）不划算。`Trend.tsx` 使用内联 SVG 折线，约 30 行。

### 4.4 本地化

文案仍使用 `useLocalize()`，新增 key 至 `client/src/locales/en/translation.json`。

该页面仅管理员可见，加翻译确有冗余，但项目规范为"所有用户可见文案"，不为此开例外。成本约十余个 key。

---

## 五、错误处理

三个真实边界：

| 情形 | 处理 |
|---|---|
| 用户已删除但交易仍在 | 显示用户 ID，不崩溃 |
| 未知 `plan_code` | 收入按 0 计并在 UI 标注异常，**不静默当作免费档** |
| 区间内无数据 | 空状态，非加载态 |

第二项尤其重要：静默当作免费档会把数据异常伪装成正常的低毛利用户。

### 5.1 口径变更标注

前置 spec 的费率修正在**写入时**固化，历史交易保持原费率。看板需在趋势图上标注费率修正日期，否则该日前后的成本跳变会被误读为用量变化。

---

## 六、测试

- **聚合管道** —— `mongodb-memory-server` 灌入真实形状的 transactions + subscriptions，断言算出的数值。真实数据库、真实管道，符合项目 real-logic-over-mocks 原则。
- **边界** —— §五三种情形各一例
- **鉴权** —— 断言非管理员请求被拒
- **前端** —— 加载 / 成功 / 错误 / 空四态

聚合测试的种子数据直接照 §2.1 的真实记录形态构造，包含负值 token 与缓存三拆字段。

---

## 七、范围

### 7.1 在范围内

§三、§四列出的文件；`UsageLog` 四文件删除；`CLAUDE.md` 相应表述修改。

### 7.2 不在范围内

- **写操作**（降级 / 封禁 / 调整额度）。写路径需要确认、审计、回滚一整套设计，而 20-50 人规模下发现异常后手工处理完全来得及。先把只读部分做对。
- **告警 / 通知**。看板需人工查看。自动告警待观测到真实成本分布后再定阈值。
- **导出 CSV**。无需求即不做。
- **`modelPricing.ts` 的去留**。该文件零调用者，本 spec 不依赖它，单独决策。
- **供应商账单对账**。看板展示的是我们**记录**的成本，与供应商**实际开票**金额的差异属另一议题（见前置 spec §五）。
