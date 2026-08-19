# ChatChat — PostHog 产品埋点

> **版本**: 0.1.0
> **创建日期**: 2026-08-19
> **状态**: Draft（待用户复审）
> **父 spec**: [2026-05-21-graupel-stage-5-launch.md](./2026-05-21-graupel-stage-5-launch.md)
> **预估**: 4-8 小时

---

## 一、目标

在 invite-only beta 开启前建立最小可用的产品行为观测，使后续产品决策基于数据而非推测。

**首要验证目标**：ChatChat 的定位是 "One subscription. All top AI models."。该定位成立的前提是**用户确实会在多个模型间切换**。若数据显示用户长期只用单一模型，定位需要修正。此判断无法通过推理得出，只能通过观测。

次要目标：注册 → 首条消息的激活率、次日留存、升级入口有效性。

---

## 二、决策与理由

| 决策 | 取值 | 理由 |
|---|---|---|
| 部署形态 | PostHog Cloud **EU** | 数据存法兰克福，若有欧盟用户则 GDPR 默认合规，无需跨境传输协议。免费额度 100 万 events/月，beta 用量约 1-2 万。零运维。自建需 ClickHouse + Kafka + Redis + Postgres，官方建议 4 核 16G，与单人 10h/周的投入不匹配。 |
| 用户标识 | 不可逆哈希 | 无法定位到自然人，GDPR 下可依"正当利益"处理，**不需要 cookie 同意弹窗** —— beta 期不给新用户增加摩擦。代价是排查异常时需拿哈希回查自有数据库。 |
| 内容字段 | 一律不发 | 聊天内容、会话标题、文件名均不上报。无例外。 |
| autocapture | **关闭** | PostHog 默认会上报点击元素的 DOM 上下文（innerText、placeholder、aria-label）。在聊天产品中这些可能携带会话信息。只发手写事件。 |
| 会话回放 | **关闭** | 会录制用户输入。beta 期若确需排查特定卡点再定向开启，并配 `maskAllInputs`。 |
| 埋点位置 | 前端 + 后端双端 | 见 §三。 |

---

## 三、双端分工

**前端发用户旅程，后端发业务事实。**

单独任一端都有对方无法弥补的盲区：

- **仅前端**：广告拦截器会拦截 10-20% 的事件，且前端不掌握真实模型标识与 token 数。最关键的"多模型切换"指标会系统性偏低。
- **仅后端**：完全可靠，但看不到"访问官网未注册即离开"。转化漏斗最上层缺失。

两端使用同一 `distinct_id`（同一哈希算法），PostHog 侧自动合并为单条用户时间线，无需额外对齐工作。

若必须削减，削为**仅后端** —— 核心定位验证依赖后端事实，那部分不能出错；漏斗可后补。

---

## 四、匿名身份

```
distinct_id = HMAC-SHA256(user._id, POSTHOG_ID_SALT) 的前 32 个十六进制字符
```

使用 HMAC 而非裸 SHA256：MongoDB ObjectId 空间小且结构化（时间戳 + 机器标识 + 计数器），裸哈希理论上可被枚举反推。加盐后即使 PostHog 侧数据泄露也无法还原至用户表。

**`POSTHOG_ID_SALT` 一经设定不可更改。** 更改会导致全部历史用户断裂为两个不同个体，留存与漏斗数据失真且不可修复。该约束需写入 `.env.example` 注释。

盐值缺失时视为埋点未配置，走 §六 的 no-op 路径，**不得**回退到无盐哈希。

---

## 五、事件清单

| 事件 | 端 | 属性 | 回答的问题 |
|---|---|---|---|
| `$pageview` | 前端 | path | 漏斗最上层 |
| `signup_completed` | 后端 | method (`google` \| `github` \| `magic` \| `local`) | 注册转化、各渠道占比 |
| `message_sent` | 后端 | model, plan, endpoint, is_first_message | **多模型切换验证**、激活率 |
| `model_switched` | 前端 | from_model, to_model | 切换是主动选择还是被动触发 |
| `plan_changed` | 后端 | from, to, source | 升级路径 |
| `quota_exhausted` | 后端 | plan, credits_at_block | 额度设定是否合理 |
| `upgrade_cta_clicked` | 前端 | location | 哪个升级入口有效 |

共 7 个。刻意维持在低位 —— 埋点的典型失败模式是一次埋数十个然后一个都不看。这 7 个直接对应 §一的观测目标加转化漏斗。运行一个月后按实际查看频率增删。

`is_first_message` 作为属性而非独立事件：注册 → 首条消息的激活率是 beta 期最应关注的单一指标，做成属性可避免在 PostHog 中编写跨事件关联查询。

### 5.1 发射位置

- `message_sent` 发于**请求终态**（`api/server/controllers/agents/request.js`），不在 `recordCollectedUsage` 中发射 —— 后者按模型分组多次调用（message / summarization / subagent），会造成重复计数。
- `plan_changed` 替换 `packages/api/src/billing/applyPlanChange.ts:183` 现有的 `TODO(stage5)` 标记。
- `quota_exhausted` 发于 `packages/api/src/billing/gating.ts` 抛出 `upgrade_required_quota` 处。

---

## 六、组件划分

```
packages/api/src/telemetry/
  client.ts      后端 PostHog 单例（懒加载）
  identity.ts    userId → 匿名哈希
  events.ts      类型化事件发射器
  index.ts

api/server/routes/config.js                    +posthogKey / posthogHost
packages/data-provider/src/config.ts           TStartupConfig 增加两字段
api/server/controllers/agents/request.js       调用 events.messageSent()
packages/api/src/billing/applyPlanChange.ts    替换 TODO(stage5)
packages/api/src/billing/gating.ts             调用 events.quotaExhausted()

client/src/telemetry/
  init.ts        posthog-js 初始化
  events.ts      前端事件，与后端共用事件名常量
client/src/hooks/Config/useAppStartup.ts       初始化入口（比照现有 GTM 处理，:90）
```

`events.ts` 是**唯一**允许直接接触 PostHog client 的模块。调用方仅见 `events.messageSent({ model, plan, ... })` 形式的签名。这样更换供应商或引入采样时只需改动一个文件，且事件名不会散落各处产生拼写分歧。

事件名常量置于 `packages/data-provider`，前后端共用，避免两端拼写漂移。

### 6.1 密钥下发

前端密钥经 `/api/config` 运行时下发，比照现有 `analyticsGtmId`（`config.ts:1326` / `useAppStartup.ts:90`）。

不使用 Vite 构建期环境变量：镜像构建一次多环境部署，构建期注入会导致更换密钥必须重新构建镜像。

---

## 七、两条硬约束

**未配置密钥时必须是彻底的 no-op。** `client.ts` 在 `POSTHOG_KEY` 或 `POSTHOG_ID_SALT` 缺失时返回空实现，不抛错、不打印警告刷屏。本地开发、CI、以及任何未配置该功能的部署都不应被埋点干扰。

**发送必须 fire-and-forget 且吞掉全部异常。** 后端使用 `posthog.capture()`（同步入队、后台批量发送），不使用 `captureImmediate()`。PostHog 服务不可用或网络超时时，用户的对话请求不受任何影响。

这两条共同构成同一原则：**埋点绝不能成为故障源。**

---

## 八、测试

遵循项目"real logic over mocks / spies over mocks"原则：

- `identity.ts` —— 断言同一 userId 恒定产出同一哈希；不同盐产出不同哈希；盐缺失时不产出哈希
- `events.ts` —— 用 spy 断言给定输入下 `client.capture` 被以预期参数调用，不替换 PostHog 内部逻辑
- `client.ts` —— 断言无 key 时全部方法可安全调用且不抛异常；断言 capture 抛异常时调用方不受影响
- 事件属性 —— 断言不含任何内容字段（正向断言属性白名单，而非反向排查）

最后一项用属性白名单而非黑名单：新增属性时默认被拦截，而非默认放行。

---

## 九、范围

### 9.1 在范围内

§六列出的全部文件、7 个事件、`.env.example` 三个新变量及其注释。

### 9.2 不在范围内

- **Sentry 错误监控** —— 同属 stage 5 可观测性，但与产品分析正交，单独推进
- **会话回放** —— 见 §二
- **Feature flags / A-B 实验** —— PostHog 支持但 beta 期无使用场景
- **PostHog 反向代理** —— 用于规避广告拦截，beta 期不值得增加基础设施
- **数据删除请求处理流程** —— 匿名哈希方案下无个人数据可删，无需该流程
