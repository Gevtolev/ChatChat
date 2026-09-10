# 法务页面：事实基础与待办

`/terms` 和 `/privacy` 的内容不是从模板套出来的，每一条事实性陈述都对着运行中的系统核过。本文件记录**核了什么、结论是什么**，以及**哪些条款目前是弱的**。

改这两个页面之前先读这里；改产品行为时如果碰到下表里的任何一项，页面要同步改。

- 页面：`client/src/components/Legal/{Terms,Privacy}.tsx`
- 路由：`client/src/routes/index.tsx`，`/terms` 与 `/privacy`，公开、不在任何 auth layout 内
- 入口：登录页与聊天页页脚。**外部 URL 未配置时回落到这两个内部路由** —— 上游只在 `interface.privacyPolicy.externalUrl` 存在时才显示链接，而那份配置在 git 之外，生产上根本没有 `interface.privacyPolicy` 块，结果就是一个即将开放注册的产品在登录页找不到条款入口

---

## 一、核过的事实（2026-09-08，对生产容器）

| 陈述 | 核实方式 | 结论 |
|---|---|---|
| 只能用 Google 注册 | `ALLOW_REGISTRATION=false` + `ALLOW_SOCIAL_LOGIN=true`，无 `EMAIL_SERVICE` | 成立，页面只写 Google |
| 匿名访客 7 天后消失 | `user.ts` 的 `expires: 604800`；`AnonymousController` 用 `disableTTL=false` 建号 | 成立 |
| 匿名试用 3 条 | `PLANS.anonymous.lifetime_message_limit = 3` | 成立 |
| 文件存 Cloudflare R2 | `AWS_ENDPOINT_URL=…r2.cloudflarestorage.com` | 成立 |
| 数据库 MongoDB Atlas、服务器在美国 | `MONGO_URI`；主机 Hostinger，出口 Boston/US | 成立 |
| **对话没有自动过期** | 生产 `librechat.yaml` 无 retention 配置 | 成立 —— 页面如实写「留到你自己删」，**不要**写成 30 天 |
| 删号会删干净 | `deleteUserController` 删对话/消息/文件/余额/交易/计费记录 | 成立（2026-09-08 PR #60 才补上计费两张表） |
| 无广告追踪 | 无 `analyticsGtmId`，无任何广告 SDK | 成立 |
| 错误上报 / 产品埋点 | Sentry + PostHog 已接入（2026-09-10），只发不可逆哈希 + 属性白名单，**绝不发对话内容**；无密钥时彻底 no-op | 成立，页面已如实列为子处理者 |
| 额度不滚存、买断额度不过期 | `packages/api/src/billing/`，`refreshMonthlyGrant` 覆盖式 `$set` | 成立 |
| 无自助付款 | 无 Stripe，`applyPlanChange` 只由 admin/CLI 触发 | 成立 |

## 二、**没有**做到、页面因此如实说明的事

### 供应商训练 opt-out —— 未实现

stage-4 spec §188 写的是「默认配置应禁用供应商训练」。**代码里没有。** `zdrEnabled` 只出现在 SDK 的已知键名列表里（`packages/api/src/endpoints/openai/llm.ts:44`），从未被赋值；也没有任何地方传 `data_policy` 之类的参数。

所以 privacy 页写的是「我们目前不发送供应商侧的 do-not-train / zero-retention 指令」，而不是一句让人安心但不成立的承诺。**这是上线前值得补的一个工单** —— OpenRouter 支持按请求设置，补上之后回来改这一段。

### 子处理者用泛指而非点名

Claude / GPT / Gemini 的流量全部经过 **gptsapi（第三方中转商）**，Grok / DeepSeek / GLM / Kimi / MiniMax 经过 OpenRouter。页面按泛指写成「the API infrastructure providers through which we reach them」，模型厂商逐一点名，中转商不点名。

**这是有意识的取舍，2026-09-08 由项目所有者决定。** 需要知道它的代价：GDPR 第 28 条要求子处理者具体化，泛指严格讲不满足；而且我们和 gptsapi 没有 DPA。一旦真的有欧盟用户、或者有人正式追问，这一段要重写。

---

## 三、待填占位符

页面顶部有醒目的未完成横幅（`incomplete` prop），文中占位符是琥珀色高亮的等宽文本。**开放公开注册前必须全部填掉并去掉横幅。**

| 占位符 | 出现处 | 需要什么 |
|---|---|---|
| `[LEGAL_ENTITY]` | 两个页面 | 运营主体名称 |
| `[JURISDICTION]` | 两个页面 | 注册地 + 适用法律 |
| `[PRIVACY_CONTACT_EMAIL]` | privacy | 隐私事务联系邮箱 |
| `[LEGAL_CONTACT_EMAIL]` | terms | 条款事务联系邮箱 |
| `[LIABILITY_FLOOR]` | terms §10 | 责任上限的下限金额 |

GDPR 章节按「面向全球用户、包含欧盟」的安全假设写。选定管辖地后，消费者权利例外和争议解决条款要按当地法律复核。

## 四、法务 review 记录

| 日期 | 谁 | 结论 |
|---|---|---|
| 2026-09-08 | 自审（工程侧） | 事实陈述与代码逐条对齐；法律措辞未经专业审阅 |

**尚未经过任何法律专业人士审阅。** spec 的风险表建议花 $200-500 找 TermsFeed 或当地律师过一遍，开放公开注册前应当做。
