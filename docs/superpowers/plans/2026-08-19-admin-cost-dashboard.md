# 管理员成本看板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给管理员一个只读页面，回答"哪些用户在亏钱"和"钱花在哪"。

**Architecture:** 从既有的 `Transaction` 集合读时聚合（单条 `$facet` 管道出三份结果），在 `packages/api` 层与 `Subscription` 合并算毛利，经 `/api/admin/usage` 下发，前端 `/admin/usage` 渲染。不新增写入路径，不新增索引，不引图表库。

**Tech Stack:** MongoDB aggregation、TypeScript、Express、React、React Query、`@librechat/client` 的 `DataTable`

**Spec:** [docs/superpowers/specs/2026-08-19-chatchat-admin-cost-dashboard-design.md](../specs/2026-08-19-chatchat-admin-cost-dashboard-design.md)

## Global Constraints

- **所有新后端代码用 TypeScript，放 `packages/api`**；`/api` 只放调用它的薄 JS 包装。
- **数据库查询放 `packages/data-schemas`**，`packages/api` 不直接 import mongoose 模型。
- **禁止 `any`**，避免 `unknown` 与 `Record<string, unknown>`；类型优先复用 `packages/data-provider` 已有定义。
- **金额单位全程用 tokenCredits（微美元）**：1 tokenCredit = $1e-6。禁止在管道或 handler 里换算成美元或分 —— 只在前端展示时除以 1e6。混用单位是这类看板最常见的缺陷来源。
- **文件名单词优先**（`usage.ts` 而非 `adminUsage.ts`），多词时用单词目录分组。
- **前端所有可见文案走 `useLocalize()`**，只改 `client/src/locales/en/translation.json`。
- **测试用真实依赖**：Mongo 用 `mongodb-memory-server`，不 mock 查询。
- **本机跑测试必须加前缀**（否则 mongodb-memory-server 起不来）：
  `LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 npx jest <pattern> --maxWorkers=4`
- **不要用管道遮蔽退出码**：`npx tsc ... > /tmp/x.log 2>&1; echo $?`，不要 `npx tsc | head`。
- 所有 TypeScript / ESLint 告警必须清零。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/data-schemas/src/methods/usage.ts` | 唯一持有聚合管道的地方。输入时间区间，输出三份原始分组结果，不做任何业务换算 |
| `packages/data-schemas/src/methods/usage.spec.ts` | 用真实内存 Mongo 灌数据验证管道 |
| `packages/data-provider/src/types/billing.ts`（改） | 看板的请求/响应类型，前后端共用 |
| `packages/data-provider/src/api-endpoints.ts`（改） | `/api/admin/usage` 端点 |
| `packages/data-provider/src/data-service.ts`（改） | `getAdminUsage()` |
| `packages/data-provider/src/keys.ts`（改） | `QueryKeys.adminUsage` |
| `packages/api/src/admin/usage.ts` | 业务层：合并订阅与用户信息、按周期折算收入、算毛利。不碰 mongoose |
| `packages/api/src/admin/usage.spec.ts` | 纯函数式测试，注入假 deps |
| `api/server/routes/admin/usage.js` | 薄包装 + 能力守卫 |
| `client/src/data-provider/Admin/queries.ts` | `useAdminUsageQuery` |
| `client/src/components/Admin/Usage/Trend.tsx` | 内联 SVG 折线，无第三方依赖 |
| `client/src/components/Admin/Usage/CostBreakdown.tsx` | 按模型 × 用途的表 |
| `client/src/components/Admin/Usage/UserMarginTable.tsx` | 每用户毛利表 |
| `client/src/components/Admin/Usage/UsagePanel.tsx` | 容器 + 时间范围选择 |

删除：`packages/data-schemas/src/{schema,models,methods,types}/usageLog.ts`。

---

### Task 1: 删除从未通电的 UsageLog

`UsageLog` 的 schema、model、`recordUsage()` 方法齐全，但**零调用者**，且带 90 天 TTL。看板改从 `Transaction` 聚合（那里有 2.5 个月真实历史），保留一个平行实现会让后来者以为存在两个成本数据源。

**Files:**
- Delete: `packages/data-schemas/src/schema/usageLog.ts`
- Delete: `packages/data-schemas/src/models/usageLog.ts`
- Delete: `packages/data-schemas/src/methods/usageLog.ts`
- Delete: `packages/data-schemas/src/types/usageLog.ts`
- Modify: `packages/data-schemas/src/methods/index.ts`
- Modify: `packages/data-schemas/src/models/index.ts`
- Modify: `packages/data-schemas/src/types/index.ts`
- Modify: `packages/data-schemas/src/methods/billing.spec.ts`（删两个 describe 块与相关 import/setup）
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 无
- Produces: 无（纯删除）。后续任务不得引用 `UsageLog` / `recordUsage` / `IUsageLog`。

**注意误报**：`api/server/controllers/agents/errors.js` 与 `api/server/services/Threads` 里的 `recordUsage` 是**完全不同的函数**（会话线程用量），`packages/api/src/agents/activityLabels/__tests__/runtime.spec.ts` 里的是局部 jest mock。这三处**不要动**。

- [ ] **Step 1: 确认真实引用范围**

```bash
cd /data/lidongyu/projects/LibreChat
grep -rn "UsageLog\|IUsageLog\|createUsageLogMethods" --include=*.ts packages/data-schemas/src | grep -v dist
```

预期：只出现在 4 个 `usageLog.ts` 文件、3 个 index、以及 `billing.spec.ts`。

- [ ] **Step 2: 删除四个文件**

```bash
cd /data/lidongyu/projects/LibreChat
rm packages/data-schemas/src/schema/usageLog.ts \
   packages/data-schemas/src/models/usageLog.ts \
   packages/data-schemas/src/methods/usageLog.ts \
   packages/data-schemas/src/types/usageLog.ts
```

- [ ] **Step 3: 摘掉三个 index 里的导出**

在 `packages/data-schemas/src/methods/index.ts` 中删除这三处：
- `import { createUsageLogMethods, type UsageLogMethods } from './usageLog';`
- `AllMethods` 交叉类型里的 `UsageLogMethods &`
- `createMethods` 返回对象里的 `...createUsageLogMethods(mongoose),`

在 `packages/data-schemas/src/models/index.ts` 中删除 `usageLog` 的 import 与 `UsageLog: ...` 注册行。

在 `packages/data-schemas/src/types/index.ts` 中删除 `export * from './usageLog';`。

- [ ] **Step 4: 剥离 billing.spec.ts 中的 UsageLog 测试**

删除以下内容，其余保持不动：
- 顶部 `import type { IUsageLog } from '~/types/usageLog';`
- 顶部 `import { createUsageLogMethods } from './usageLog';`
- `let UsageLog: mongoose.Model<IUsageLog>;` 与 `let usageLogMethods: ...;` 两行声明
- `beforeAll` 中给这两个变量赋值的语句
- `describe('UsageLog', ...)` 整块（schema 测试）
- `describe('UsageLogMethods', ...)` 整块（方法测试）

- [ ] **Step 5: 更新 CLAUDE.md**

把 `- **Cost auditing via `UsageLog`** (per `user_id × model_id × day`). Internal only; never exposed to users.` 改为：

```markdown
- **Cost auditing aggregates `Transaction` at read time** (per user × model × day). Internal only; never exposed to users. There is deliberately no second cost table — `Transaction` is written by `spendTokens` on every generation and is the single source.
```

同时在"New schemas"那行的清单里删掉 `UsageLog`。

- [ ] **Step 6: 类型检查与全量测试**

```bash
cd /data/lidongyu/projects/LibreChat/packages/data-schemas
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -5 /tmp/tsc.log
LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 \
  npx jest --silent --maxWorkers=4 > /tmp/jest.log 2>&1; echo "jest EXIT=$?"
grep -E "^Tests:|^Test Suites:" /tmp/jest.log
```

预期：tsc EXIT=0；jest EXIT=0；测试数比删除前少 `UsageLog` 那两块的用例数，其余全绿。

- [ ] **Step 7: 确认下游 workspace 未被波及**

```bash
cd /data/lidongyu/projects/LibreChat
grep -rn "UsageLog\|IUsageLog" --include=*.ts --include=*.js api packages/api client 2>/dev/null | grep -v node_modules | grep -v dist
```

预期：无输出（`recordUsage` 的三处误报不含 `UsageLog` 字样，不会出现在这里）。

- [ ] **Step 8: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "🗑️ chore(billing): drop UsageLog, a cost table nothing ever wrote to

Schema, model and recordUsage() were all in place but had zero callers,
and the table carried a 90-day TTL that could not support auditing anyway.
The dashboard aggregates Transaction instead, which spendTokens writes on
every generation and which already holds 2.5 months of history.

Keeping a parallel implementation that never carried data invites the next
reader to believe there are two cost sources."
```

---

### Task 2: 聚合管道（data-schemas）

单条 `$facet` 管道出三份结果，共享同一次 `$match`，避免对同一批文档扫三遍。此层**只做分组求和，不做任何业务换算** —— 收入、毛利、周期折算都属业务层。

**Files:**
- Create: `packages/data-schemas/src/methods/usage.ts`
- Create: `packages/data-schemas/src/methods/usage.spec.ts`
- Modify: `packages/data-schemas/src/methods/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:

```ts
export interface UsageByUser {
  user_id: string;
  credits: number;   // tokenCredits，正数
  calls: number;
  models: string[];
}
export interface UsageByModel {
  model: string;
  context: string;   // 'message' | 'title' | 'summarization' | ...
  credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}
export interface UsageByDay {
  day: string;       // 'YYYY-MM-DD'（UTC）
  credits: number;
}
export interface UsageAggregate {
  byUser: UsageByUser[];
  byModel: UsageByModel[];
  byDay: UsageByDay[];
}
export function createUsageMethods(mongoose: typeof import('mongoose')): {
  aggregateUsage: (args: { from: Date; to: Date }) => Promise<UsageAggregate>;
};
```

- [ ] **Step 1: 写失败的测试**

创建 `packages/data-schemas/src/methods/usage.spec.ts`：

```ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createUsageMethods } from './usage';

let mongoServer: MongoMemoryServer;
let usageMethods: ReturnType<typeof createUsageMethods>;

const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();

/** Transactions store spends as negatives; the pipeline must return positives. */
async function seed() {
  const Transaction = mongoose.models.Transaction;
  await Transaction.create([
    {
      user: USER_A,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 0.966,
      rawAmount: -387,
      tokenValue: -1161,
      inputTokens: -259,
      writeTokens: 0,
      readTokens: -128,
      createdAt: new Date('2026-08-10T05:00:00Z'),
    },
    {
      user: USER_A,
      tokenType: 'completion',
      model: 'glm-5.2',
      context: 'message',
      rate: 3.036,
      rawAmount: -100,
      tokenValue: -303,
      createdAt: new Date('2026-08-10T06:00:00Z'),
    },
    {
      user: USER_A,
      tokenType: 'prompt',
      model: 'kimi-k2.6',
      context: 'title',
      rate: 0.95,
      rawAmount: -50,
      tokenValue: -47,
      createdAt: new Date('2026-08-11T01:00:00Z'),
    },
    {
      user: USER_B,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 0.966,
      rawAmount: -10,
      tokenValue: -9,
      createdAt: new Date('2026-08-11T02:00:00Z'),
    },
    {
      user: USER_B,
      tokenType: 'prompt',
      model: 'glm-5.2',
      context: 'message',
      rate: 0.966,
      rawAmount: -999,
      tokenValue: -999,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    },
  ]);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  usageMethods = createUsageMethods(mongoose);
  await seed();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const RANGE = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-31T23:59:59Z') };

describe('aggregateUsage', () => {
  it('sums spend per user as a positive number', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const a = result.byUser.find((row) => row.user_id === USER_A.toString());
    expect(a).toBeDefined();
    expect(a?.credits).toBe(1161 + 303 + 47);
    expect(a?.calls).toBe(3);
  });

  it('excludes documents outside the range', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const b = result.byUser.find((row) => row.user_id === USER_B.toString());
    /** The July document must not be counted. */
    expect(b?.credits).toBe(9);
    expect(b?.calls).toBe(1);
  });

  it('sorts users by spend descending', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    expect(result.byUser[0].user_id).toBe(USER_A.toString());
  });

  it('lists the distinct models a user touched', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const a = result.byUser.find((row) => row.user_id === USER_A.toString());
    expect(a?.models.sort()).toEqual(['glm-5.2', 'kimi-k2.6']);
  });

  it('splits models by context so titling is visible separately', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const titleRow = result.byModel.find((row) => row.context === 'title');
    expect(titleRow?.model).toBe('kimi-k2.6');
    expect(titleRow?.credits).toBe(47);
  });

  it('returns cache token counts as positives', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    const row = result.byModel.find((r) => r.model === 'glm-5.2' && r.context === 'message');
    expect(row?.input_tokens).toBe(259);
    expect(row?.read_tokens).toBe(128);
    expect(row?.write_tokens).toBe(0);
  });

  it('groups by UTC day, ascending', async () => {
    const result = await usageMethods.aggregateUsage(RANGE);
    expect(result.byDay.map((d) => d.day)).toEqual(['2026-08-10', '2026-08-11']);
    expect(result.byDay[0].credits).toBe(1161 + 303);
  });

  it('returns empty arrays rather than throwing when nothing matches', async () => {
    const result = await usageMethods.aggregateUsage({
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2020-01-02T00:00:00Z'),
    });
    expect(result).toEqual({ byUser: [], byModel: [], byDay: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /data/lidongyu/projects/LibreChat/packages/data-schemas
LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 \
  npx jest usage.spec --maxWorkers=2 2>&1 | tail -8
```

预期：FAIL，`Cannot find module './usage'`。

- [ ] **Step 3: 写实现**

创建 `packages/data-schemas/src/methods/usage.ts`：

```ts
import type { Model, PipelineStage } from 'mongoose';
import type { ITransaction } from '~/types/transaction';

export interface UsageByUser {
  user_id: string;
  credits: number;
  calls: number;
  models: string[];
}

export interface UsageByModel {
  model: string;
  context: string;
  credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}

export interface UsageByDay {
  day: string;
  credits: number;
}

export interface UsageAggregate {
  byUser: UsageByUser[];
  byModel: UsageByModel[];
  byDay: UsageByDay[];
}

interface RawUserRow {
  _id: unknown;
  credits: number;
  calls: number;
  models: (string | null)[];
}

interface RawModelRow {
  _id: { model: string | null; context: string | null };
  credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}

interface RawDayRow {
  _id: string;
  credits: number;
}

/** Spends are stored negative; every sum is taken through $abs so callers never
 *  have to remember the sign convention. */
const absField = (field: string) => ({ $abs: { $ifNull: [field, 0] } });

export function createUsageMethods(mongoose: typeof import('mongoose')) {
  /**
   * Aggregates Transaction spend over a date range into three views in a single
   * round trip. A `$facet` is used rather than three queries because all three
   * share one `$match` — separate queries would scan the same documents thrice.
   */
  async function aggregateUsage(args: { from: Date; to: Date }): Promise<UsageAggregate> {
    const Transaction = mongoose.models.Transaction as Model<ITransaction>;

    const pipeline: PipelineStage[] = [
      { $match: { createdAt: { $gte: args.from, $lte: args.to } } },
      {
        $facet: {
          byUser: [
            {
              $group: {
                _id: '$user',
                credits: { $sum: absField('$tokenValue') },
                calls: { $sum: 1 },
                models: { $addToSet: '$model' },
              },
            },
            { $sort: { credits: -1 } },
          ],
          byModel: [
            {
              $group: {
                _id: { model: '$model', context: '$context' },
                credits: { $sum: absField('$tokenValue') },
                calls: { $sum: 1 },
                input_tokens: { $sum: absField('$inputTokens') },
                write_tokens: { $sum: absField('$writeTokens') },
                read_tokens: { $sum: absField('$readTokens') },
              },
            },
            { $sort: { credits: -1 } },
          ],
          byDay: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                credits: { $sum: absField('$tokenValue') },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ];

    const [facet] = await Transaction.aggregate<{
      byUser: RawUserRow[];
      byModel: RawModelRow[];
      byDay: RawDayRow[];
    }>(pipeline);

    return {
      byUser: (facet?.byUser ?? []).map((row) => ({
        user_id: String(row._id),
        credits: row.credits,
        calls: row.calls,
        models: row.models.filter((model): model is string => typeof model === 'string'),
      })),
      byModel: (facet?.byModel ?? []).map((row) => ({
        model: row._id.model ?? 'unknown',
        context: row._id.context ?? 'unknown',
        credits: row.credits,
        calls: row.calls,
        input_tokens: row.input_tokens,
        write_tokens: row.write_tokens,
        read_tokens: row.read_tokens,
      })),
      byDay: (facet?.byDay ?? []).map((row) => ({ day: row._id, credits: row.credits })),
    };
  }

  return { aggregateUsage };
}

export type UsageMethods = ReturnType<typeof createUsageMethods>;
```

- [ ] **Step 4: 挂进 methods 入口**

在 `packages/data-schemas/src/methods/index.ts`：

1. 加 import：`import { createUsageMethods, type UsageMethods } from './usage';`
2. `AllMethods` 交叉类型里加 `UsageMethods &`
3. `createMethods` 返回对象里加 `...createUsageMethods(mongoose),`
4. 文件末尾加导出，供 handler 层复用类型：
   `export type { UsageAggregate, UsageByUser, UsageByModel, UsageByDay } from './usage';`

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /data/lidongyu/projects/LibreChat/packages/data-schemas
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -5 /tmp/tsc.log
LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 \
  npx jest usage.spec --maxWorkers=2 > /tmp/jest.log 2>&1; echo "jest EXIT=$?"
grep -E "^Tests:" /tmp/jest.log
```

预期：tsc EXIT=0；8 个用例全通过。

- [ ] **Step 6: 全量回归 + 提交**

```bash
cd /data/lidongyu/projects/LibreChat/packages/data-schemas
LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 \
  npx jest --silent --maxWorkers=4 > /tmp/all.log 2>&1; echo "jest EXIT=$?"
grep -E "^Tests:|^Test Suites:" /tmp/all.log
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "📊 feat(admin): aggregate Transaction spend into per-user, per-model, per-day views

One \$facet pipeline rather than three queries: all three views share the
same date \$match, so separate queries would scan the same documents three
times over.

Spends are stored as negatives. Every sum goes through \$abs here so no
caller downstream has to remember that convention, and cache token counts
come back positive alongside them.

No business arithmetic in this layer — revenue, margin and period
proration belong to packages/api, which has the plan catalogue."
```

---

### Task 3: 共享类型与接线（data-provider）

前后端共用的请求/响应契约。放在既有的 `types/billing.ts`（`src/index.ts` 已有 `export * from './types/billing'`，无需改入口）。

**Files:**
- Modify: `packages/data-provider/src/types/billing.ts`
- Modify: `packages/data-provider/src/api-endpoints.ts`
- Modify: `packages/data-provider/src/data-service.ts`
- Modify: `packages/data-provider/src/keys.ts`

**Interfaces:**
- Consumes: `PlanCode`（同文件已有）
- Produces：下列类型与 `dataService.getAdminUsage`，Task 4/5/6 全部依赖它们。

- [ ] **Step 1: 加类型**

追加到 `packages/data-provider/src/types/billing.ts` 末尾：

```ts
/** 看板一律用 tokenCredits（微美元，1 tokenCredit = $1e-6）作为金额单位，
 *  只在渲染时除以 1e6。混用美元/分是这类报表最常见的缺陷来源。 */
export interface AdminUsageUserRow {
  user_id: string;
  /** 用户已删除但交易仍在时为 null，UI 退化显示 ID */
  email: string | null;
  /** 原始 plan_code；null 表示无 Subscription 记录（隐式 free 档） */
  plan_code: string | null;
  /** false = plan_code 不在 PLANS 中。此时 revenue_credits 记 0 并需在 UI 标注，
   *  不可静默当作免费档 —— 那会把数据异常伪装成正常的低毛利用户。 */
  plan_recognized: boolean;
  cost_credits: number;
  /** 已按订阅周期折算到 30 天，见 §Task 4 */
  revenue_credits: number;
  margin_credits: number;
  calls: number;
  model_count: number;
}

export interface AdminUsageModelRow {
  model: string;
  /** 'message' | 'title' | 'summarization' | 'subagent' | ... */
  context: string;
  cost_credits: number;
  calls: number;
  input_tokens: number;
  write_tokens: number;
  read_tokens: number;
}

export interface AdminUsageDayRow {
  /** 'YYYY-MM-DD'，UTC */
  day: string;
  cost_credits: number;
}

export interface AdminUsageParams {
  /** ISO 8601 */
  from: string;
  to: string;
}

export interface AdminUsageResponse {
  from: string;
  to: string;
  users: AdminUsageUserRow[];
  models: AdminUsageModelRow[];
  days: AdminUsageDayRow[];
}
```

- [ ] **Step 2: 加端点**

在 `packages/data-provider/src/api-endpoints.ts` 的 `adminRoles` 附近追加：

```ts
export const adminUsage = () => `${BASE_URL}/api/admin/usage`;
```

- [ ] **Step 3: 加 data-service 方法**

在 `packages/data-provider/src/data-service.ts` 的 `/* Roles */` 区块之前追加：

```ts
/* Admin usage */
export function getAdminUsage(params: t.AdminUsageParams): Promise<t.AdminUsageResponse> {
  const query = new URLSearchParams({ from: params.from, to: params.to });
  return request.get(`${endpoints.adminUsage()}?${query.toString()}`);
}
```

`URLSearchParams` 天然完成编码，无需再 `encodeURIComponent`。

若该文件未以 `t` 为别名 import 类型，沿用文件顶部既有的类型 import 写法引入这两个类型。

- [ ] **Step 4: 加 QueryKey**

在 `packages/data-provider/src/keys.ts` 的 `QueryKeys` 枚举末尾追加：

```ts
  adminUsage = 'adminUsage',
```

- [ ] **Step 5: 构建并类型检查**

```bash
cd /data/lidongyu/projects/LibreChat
npm run build:data-provider > /tmp/dp.log 2>&1; echo "build EXIT=$?"; tail -5 /tmp/dp.log
```

预期：EXIT=0。

- [ ] **Step 6: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "🔌 feat(admin): shared contract for the usage dashboard

Amounts travel as tokenCredits end to end — one integer unit, converted to
dollars only at render. Reporting bugs in this shape almost always trace to
a value that was cents in one layer and micro-dollars in the next.

plan_recognized is separate from plan_code on purpose: an unknown plan must
show as an anomaly rather than silently score as a free user with thin
margin."
```

---

### Task 4: 业务层 handler（packages/api）

把聚合结果与订阅、用户信息合并，按周期折算收入，算毛利。这一层**不碰 mongoose** —— 所有数据经 `deps` 注入，与 `createAdminUsersHandlers` 同构。

**关于收入折算**：`PlanConfig.monthly_price_cents` 的名字有误导 —— `pro_q` 存的是 7999（90 天总价），`pro_h` 存 14999（180 天）。直接当月收入会把季付用户高估 3 倍。因此按 `PERIOD_DAYS` 折算到 30 天：`月收入 = price_cents × 30 / period_days`。

**Files:**
- Create: `packages/api/src/admin/usage.ts`
- Create: `packages/api/src/admin/usage.spec.ts`
- Modify: `packages/api/src/billing/applyPlanChange.ts`（导出 `PERIOD_DAYS`）
- Modify: `packages/api/src/index.ts`（导出 handler 工厂）

**Interfaces:**
- Consumes: `UsageAggregate`（Task 2）、`AdminUsageResponse` 等（Task 3）
- Produces:

```ts
export interface AdminUsageDeps {
  aggregateUsage: (args: { from: Date; to: Date }) => Promise<UsageAggregate>;
  findActiveSubscriptions: (
    userIds: string[],
  ) => Promise<Array<{ user_id: string; plan_code: string }>>;
  findUserEmails: (userIds: string[]) => Promise<Array<{ _id: string; email: string | null }>>;
}
export function createAdminUsageHandlers(deps: AdminUsageDeps): {
  getUsage: (req: ServerRequest, res: Response) => Promise<void>;
};
```

- [ ] **Step 1: 导出 PERIOD_DAYS**

在 `packages/api/src/billing/applyPlanChange.ts` 中把

```ts
const PERIOD_DAYS: Record<PlanCode, number> = {
```

改为

```ts
/** 各档订阅周期天数。成本看板用它把周期总价折算成 30 天口径的收入。 */
export const PERIOD_DAYS: Record<PlanCode, number> = {
```

- [ ] **Step 2: 写失败的测试**

创建 `packages/api/src/admin/usage.spec.ts`：

```ts
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminUsageHandlers } from './usage';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const EMPTY = { byUser: [], byModel: [], byDay: [] };

function makeDeps(overrides: Partial<Parameters<typeof createAdminUsageHandlers>[0]> = {}) {
  return {
    aggregateUsage: jest.fn().mockResolvedValue(EMPTY),
    findActiveSubscriptions: jest.fn().mockResolvedValue([]),
    findUserEmails: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const req = (query: Record<string, string>) => ({ query }) as unknown as ServerRequest;

describe('getUsage — request validation', () => {
  it('rejects a missing range', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(req({}), res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unparseable date', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(
      req({ from: 'not-a-date', to: '2026-08-31T00:00:00Z' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an inverted range', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(
      req({ from: '2026-08-31T00:00:00Z', to: '2026-08-01T00:00:00Z' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});

const RANGE = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' };

describe('getUsage — margin', () => {
  it('prorates a quarterly plan to a 30-day figure', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u1', credits: 1_000_000, calls: 3, models: ['glm-5.2'] }],
        byModel: [],
        byDay: [],
      }),
      findActiveSubscriptions: jest.fn().mockResolvedValue([{ user_id: 'u1', plan_code: 'pro_q' }]),
      findUserEmails: jest.fn().mockResolvedValue([{ _id: 'u1', email: 'a@example.com' }]),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: Array<Record<string, unknown>> }).users[0];
    /** 7999 cents over 90 days -> 2666.33 cents per 30 days -> 26_663_333 credits */
    expect(row.revenue_credits).toBe(Math.round((7999 * 30) / 90) * 10_000);
    expect(row.margin_credits).toBe((row.revenue_credits as number) - 1_000_000);
  });

  it('treats a user with no subscription as the implicit free plan', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u2', credits: 500, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
      findUserEmails: jest.fn().mockResolvedValue([{ _id: 'u2', email: 'b@example.com' }]),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: Array<Record<string, unknown>> }).users[0];
    expect(row.plan_code).toBeNull();
    expect(row.plan_recognized).toBe(true);
    expect(row.revenue_credits).toBe(0);
  });

  it('flags an unknown plan instead of scoring it as free', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u3', credits: 10, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
      findActiveSubscriptions: jest
        .fn()
        .mockResolvedValue([{ user_id: 'u3', plan_code: 'legacy_gold' }]),
      findUserEmails: jest.fn().mockResolvedValue([{ _id: 'u3', email: 'c@example.com' }]),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: Array<Record<string, unknown>> }).users[0];
    expect(row.plan_recognized).toBe(false);
    expect(row.revenue_credits).toBe(0);
  });

  it('keeps a deleted user visible with a null email', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'ghost', credits: 42, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const row = (res.body as { users: Array<Record<string, unknown>> }).users[0];
    expect(row.user_id).toBe('ghost');
    expect(row.email).toBeNull();
    expect(row.cost_credits).toBe(42);
  });

  it('looks up only the users that actually spent', async () => {
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({
        byUser: [{ user_id: 'u1', credits: 1, calls: 1, models: [] }],
        byModel: [],
        byDay: [],
      }),
    });
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), mockRes());
    expect(deps.findUserEmails).toHaveBeenCalledWith(['u1']);
    expect(deps.findActiveSubscriptions).toHaveBeenCalledWith(['u1']);
  });

  it('passes model and day views through untouched', async () => {
    const models = [
      {
        model: 'glm-5.2',
        context: 'title',
        credits: 47,
        calls: 1,
        input_tokens: 10,
        write_tokens: 0,
        read_tokens: 2,
      },
    ];
    const days = [{ day: '2026-08-10', credits: 1464 }];
    const deps = makeDeps({
      aggregateUsage: jest.fn().mockResolvedValue({ byUser: [], byModel: models, byDay: days }),
    });
    const res = mockRes();
    await createAdminUsageHandlers(deps).getUsage(req(RANGE), res);

    const body = res.body as { models: unknown[]; days: unknown[] };
    /** The aggregate's `credits` is renamed to `cost_credits` and does not
     *  survive alongside it — spreading the input row here would wrongly assert
     *  both keys are present. */
    expect(body.models).toEqual([
      {
        model: 'glm-5.2',
        context: 'title',
        cost_credits: 47,
        calls: 1,
        input_tokens: 10,
        write_tokens: 0,
        read_tokens: 2,
      },
    ]);
    expect(body.days).toEqual([{ day: '2026-08-10', cost_credits: 1464 }]);
  });

  it('returns empty arrays for a range with no traffic', async () => {
    const res = mockRes();
    await createAdminUsageHandlers(makeDeps()).getUsage(req(RANGE), res);
    /** The handler echoes the range through Date#toISOString, which appends
     *  milliseconds — compare against the normalised form, not the input. */
    expect(res.body).toEqual({
      from: new Date(RANGE.from).toISOString(),
      to: new Date(RANGE.to).toISOString(),
      users: [],
      models: [],
      days: [],
    });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /data/lidongyu/projects/LibreChat/packages/api
npx jest src/admin/usage.spec --maxWorkers=2 2>&1 | tail -6
```

预期：FAIL，`Cannot find module './usage'`。

- [ ] **Step 4: 写实现**

创建 `packages/api/src/admin/usage.ts`：

```ts
import { logger } from '@librechat/data-schemas';
import type { UsageAggregate } from '@librechat/data-schemas';
import type {
  AdminUsageUserRow,
  AdminUsageResponse,
  PlanCode,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { PERIOD_DAYS } from '~/billing/applyPlanChange';
import { PLANS } from '~/billing/plans';

/** 1 cent = 10 000 tokenCredits (a tokenCredit is one micro-dollar). */
const CREDITS_PER_CENT = 10_000;

/** 收入一律折算到 30 天口径。`monthly_price_cents` 的名字有误导：pro_q 存的是
 *  90 天总价、pro_h 是 180 天总价，直接相比会把季付用户的收入高估三倍。 */
function monthlyRevenueCredits(planCode: string): number | null {
  const plan = PLANS[planCode as PlanCode];
  if (plan === undefined) {
    return null;
  }
  const periodDays = PERIOD_DAYS[planCode as PlanCode];
  return Math.round((plan.monthly_price_cents * 30) / periodDays) * CREDITS_PER_CENT;
}

export interface AdminUsageDeps {
  aggregateUsage: (args: { from: Date; to: Date }) => Promise<UsageAggregate>;
  findActiveSubscriptions: (
    userIds: string[],
  ) => Promise<Array<{ user_id: string; plan_code: string }>>;
  findUserEmails: (userIds: string[]) => Promise<Array<{ _id: string; email: string | null }>>;
}

function parseRange(query: ServerRequest['query']): { from: Date; to: Date } | null {
  const rawFrom = query.from;
  const rawTo = query.to;
  if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') {
    return null;
  }
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return null;
  }
  return { from, to };
}

export function createAdminUsageHandlers(deps: AdminUsageDeps) {
  async function getUsage(req: ServerRequest, res: Response): Promise<void> {
    const range = parseRange(req.query);
    if (range === null) {
      res.status(400).json({ error: 'from and to must be valid ISO dates with from <= to' });
      return;
    }

    try {
      const aggregate = await deps.aggregateUsage(range);
      const userIds = aggregate.byUser.map((row) => row.user_id);

      /** Both lookups are keyed off the same id list and neither depends on the
       *  other, so they run together rather than in sequence. */
      const [subscriptions, users] = await Promise.all([
        userIds.length > 0 ? deps.findActiveSubscriptions(userIds) : Promise.resolve([]),
        userIds.length > 0 ? deps.findUserEmails(userIds) : Promise.resolve([]),
      ]);

      const planByUser = new Map(subscriptions.map((sub) => [sub.user_id, sub.plan_code]));
      const emailByUser = new Map(users.map((user) => [user._id, user.email]));

      const rows: AdminUsageUserRow[] = aggregate.byUser.map((row) => {
        const planCode = planByUser.get(row.user_id) ?? null;
        /** No subscription record means the implicit free plan, which grants no
         *  revenue — that is a known state, not an anomaly. */
        const revenue = planCode === null ? 0 : monthlyRevenueCredits(planCode);
        const recognized = revenue !== null;
        const revenueCredits = revenue ?? 0;

        return {
          user_id: row.user_id,
          email: emailByUser.get(row.user_id) ?? null,
          plan_code: planCode,
          plan_recognized: recognized,
          cost_credits: row.credits,
          revenue_credits: revenueCredits,
          margin_credits: revenueCredits - row.credits,
          calls: row.calls,
          model_count: row.models.length,
        };
      });

      const payload: AdminUsageResponse = {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        users: rows,
        models: aggregate.byModel.map((row) => ({
          model: row.model,
          context: row.context,
          cost_credits: row.credits,
          calls: row.calls,
          input_tokens: row.input_tokens,
          write_tokens: row.write_tokens,
          read_tokens: row.read_tokens,
        })),
        days: aggregate.byDay.map((row) => ({ day: row.day, cost_credits: row.credits })),
      };

      res.status(200).json(payload);
    } catch (error) {
      logger.error('[admin/usage] aggregation failed', error);
      res.status(500).json({ error: 'Failed to aggregate usage' });
    }
  }

  return { getUsage };
}
```

- [ ] **Step 5: 从包入口导出**

在 `packages/api/src/index.ts` 中，比照既有 admin 导出的写法追加：

```ts
export { createAdminUsageHandlers } from './admin/usage';
export type { AdminUsageDeps } from './admin/usage';
```

若该文件是 `export * from './admin'` 形式，则改为在 `packages/api/src/admin/index.ts` 中追加 `export * from './usage';`。先 `grep -n "admin" packages/api/src/index.ts` 确认再改。

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /data/lidongyu/projects/LibreChat/packages/api
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -5 /tmp/tsc.log
npx jest src/admin/usage.spec --maxWorkers=2 > /tmp/jest.log 2>&1; echo "jest EXIT=$?"
grep -E "^Tests:" /tmp/jest.log
```

预期：tsc EXIT=0；10 个用例全通过。

- [ ] **Step 7: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "💵 feat(admin): merge spend with subscriptions into per-user margin

Revenue is prorated to a 30-day figure before comparison. PlanConfig calls
the field monthly_price_cents, but pro_q holds 7999 for a 90-day period and
pro_h 14999 for 180 — comparing those directly would credit a quarterly
subscriber with three months of revenue against one month of cost.

An unrecognised plan_code scores zero revenue and sets plan_recognized
false rather than falling through to the free plan, so a data anomaly
surfaces as one instead of hiding as a thin-margin user. A user deleted
while their transactions remain still gets a row, with a null email."
```

---

### Task 5: 批量订阅查询 + Express 路由

既有的 `getActiveSubscriptionRecord` 只收单个 userId，看板要一次查几十个 —— 逐个查会变成 N 次往返。先补批量方法，再把路由接起来。

`findUserEmails` 不需要新方法：既有的 `findUsers(filter, fields, options)` 足够。

**Files:**
- Modify: `packages/data-schemas/src/methods/subscription.ts`
- Modify: `packages/data-schemas/src/methods/billing.spec.ts`（加批量查询的用例）
- Create: `api/server/routes/admin/usage.js`
- Modify: `api/server/routes/index.js`
- Modify: `api/server/index.js`

**Interfaces:**
- Consumes: `createAdminUsageHandlers`（Task 4）、`aggregateUsage`（Task 2）
- Produces: `GET /api/admin/usage?from=<iso>&to=<iso>` → `AdminUsageResponse`；需 `ACCESS_ADMIN` 能力

- [ ] **Step 1: 写批量查询的失败测试**

在 `packages/data-schemas/src/methods/billing.spec.ts` 的 `describe('SubscriptionMethods', ...)` 块内追加：

```ts
    it('findActiveSubscriptions returns one row per user, entitled statuses only', async () => {
      const userA = new mongoose.Types.ObjectId();
      const userB = new mongoose.Types.ObjectId();
      const userC = new mongoose.Types.ObjectId();
      const now = new Date();
      await Subscription.create([
        {
          user_id: userA,
          plan_code: 'pro_m',
          status: 'active',
          source: 'admin',
          current_period_start: now,
          current_period_end: now,
        },
        {
          user_id: userB,
          plan_code: 'trial',
          status: 'trialing',
          source: 'admin',
          current_period_start: now,
          current_period_end: now,
        },
        {
          user_id: userC,
          plan_code: 'pro_h',
          status: 'expired',
          source: 'admin',
          current_period_start: now,
          current_period_end: now,
        },
      ]);

      const rows = await subscriptionMethods.findActiveSubscriptions([
        userA.toString(),
        userB.toString(),
        userC.toString(),
      ]);

      const byUser = new Map(rows.map((row) => [row.user_id, row.plan_code]));
      expect(byUser.get(userA.toString())).toBe('pro_m');
      expect(byUser.get(userB.toString())).toBe('trial');
      /** An expired subscription grants nothing, so it must not appear. */
      expect(byUser.has(userC.toString())).toBe(false);
    });

    it('findActiveSubscriptions returns an empty array for an empty id list', async () => {
      expect(await subscriptionMethods.findActiveSubscriptions([])).toEqual([]);
    });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /data/lidongyu/projects/LibreChat/packages/data-schemas
LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 \
  npx jest billing.spec -t findActiveSubscriptions --maxWorkers=2 2>&1 | tail -6
```

预期：FAIL，`findActiveSubscriptions is not a function`。

- [ ] **Step 3: 实现批量查询**

在 `packages/data-schemas/src/methods/subscription.ts` 的 `createSubscriptionMethods` 内追加，并加进返回对象：

```ts
  /**
   * Current plan for each of the given users, in one round trip.
   *
   * Users with no entitled subscription are simply absent from the result —
   * callers treat that as the implicit free plan rather than as an error.
   */
  async function findActiveSubscriptions(
    userIds: string[],
  ): Promise<Array<{ user_id: string; plan_code: string }>> {
    if (userIds.length === 0) {
      return [];
    }
    const Subscription = mongoose.models.Subscription as Model<ISubscription>;
    const docs = await Subscription.find({
      user_id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) },
      status: { $in: ['active', 'trialing', 'admin_granted'] },
    })
      .select('user_id plan_code')
      .lean();

    return docs.map((doc) => ({
      user_id: String(doc.user_id),
      plan_code: doc.plan_code,
    }));
  }
```

若文件顶部尚未 import `Model` 或 `ISubscription`，按既有写法补上。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /data/lidongyu/projects/LibreChat/packages/data-schemas
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -3 /tmp/tsc.log
LD_LIBRARY_PATH=$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu MONGOMS_VERSION=4.4.18 \
  npx jest billing.spec --maxWorkers=2 > /tmp/j.log 2>&1; echo "jest EXIT=$?"
grep -E "^Tests:" /tmp/j.log
cd /data/lidongyu/projects/LibreChat && npx turbo run build --filter=@librechat/data-schemas --force > /tmp/b.log 2>&1; echo "build EXIT=$?"
```

- [ ] **Step 5: 写路由**

创建 `api/server/routes/admin/usage.js`：

```js
const express = require('express');
const { createAdminUsageHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const handlers = createAdminUsageHandlers({
  aggregateUsage: db.aggregateUsage,
  findActiveSubscriptions: db.findActiveSubscriptions,
  /** Cost rows are keyed by user id; only the email is needed to label them. */
  findUserEmails: async (userIds) => {
    const users = await db.findUsers({ _id: { $in: userIds } }, '_id email');
    return users.map((user) => ({ _id: String(user._id), email: user.email ?? null }));
  },
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', handlers.getUsage);

module.exports = router;
```

- [ ] **Step 6: 注册路由**

在 `api/server/routes/index.js`：
1. 在其他 `adminX` import 旁加 `const adminUsage = require('./admin/usage');`
2. 在导出对象里加 `adminUsage,`

在 `api/server/index.js` 的 admin 挂载区加：

```js
  app.use('/api/admin/usage', routes.adminUsage);
```

放在 `app.use('/api/admin/roles', ...)` 之后即可；`/api/admin` 是 `adminAuth`，路径不冲突。

- [ ] **Step 7: 手工验证鉴权与查询**

启动后端后：

```bash
cd /data/lidongyu/projects/LibreChat
# 未认证必须被拒
curl -s -o /dev/null -w "unauth → %{http_code}\n" \
  "http://localhost:3080/api/admin/usage?from=2026-08-01T00:00:00Z&to=2026-08-31T00:00:00Z"
# 参数缺失必须 400（带上有效 admin JWT）
curl -s -o /dev/null -w "no-range → %{http_code}\n" \
  -H "Authorization: Bearer $ADMIN_JWT" "http://localhost:3080/api/admin/usage"
```

预期：未认证 401；缺参数 400。

- [ ] **Step 8: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "🔐 feat(admin): expose GET /api/admin/usage behind ACCESS_ADMIN

findActiveSubscriptions is new because the existing lookup takes one user
id at a time; the dashboard needs dozens at once and would otherwise make
one round trip per row.

Users with no entitled subscription are absent from the result rather than
erroring — callers read that as the implicit free plan. Emails come from
the existing findUsers, so no new user query was needed."
```

---

### Task 6: 前端取数 hook

**Files:**
- Create: `client/src/data-provider/Admin/queries.ts`
- Create: `client/src/data-provider/Admin/index.ts`
- Modify: `client/src/data-provider/index.ts`

**Interfaces:**
- Consumes: `dataService.getAdminUsage`、`QueryKeys.adminUsage`、`AdminUsageResponse`（Task 3）
- Produces: `useAdminUsageQuery(params, config?) → QueryObserverResult<AdminUsageResponse>`

- [ ] **Step 1: 写 hook**

创建 `client/src/data-provider/Admin/queries.ts`：

```ts
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type { AdminUsageParams, AdminUsageResponse } from 'librechat-data-provider';

/**
 * Admin-only cost aggregate for a date range.
 *
 * Not refetched on window focus: the underlying aggregation scans a date range
 * of transactions, and the numbers do not move meaningfully between tab
 * switches. The range is part of the key, so switching presets refetches.
 */
export const useAdminUsageQuery = (
  params: AdminUsageParams,
  config?: UseQueryOptions<AdminUsageResponse>,
): QueryObserverResult<AdminUsageResponse> => {
  return useQuery<AdminUsageResponse>(
    [QueryKeys.adminUsage, params.from, params.to],
    () => dataService.getAdminUsage(params),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};
```

- [ ] **Step 2: 导出**

创建 `client/src/data-provider/Admin/index.ts`：

```ts
export * from './queries';
```

在 `client/src/data-provider/index.ts` 中，比照既有 feature 目录（如 `Skills`）的写法追加：

```ts
export * from './Admin';
```

- [ ] **Step 3: 类型检查**

```bash
cd /data/lidongyu/projects/LibreChat/client
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -5 /tmp/tsc.log
```

预期：EXIT=0。若报找不到 `AdminUsageParams`，说明 Task 3 的 data-provider 未重新构建，跑 `npm run build:data-provider`。

- [ ] **Step 4: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "🪝 feat(admin): useAdminUsageQuery

Focus refetching is off: the query scans a range of transactions and the
result does not move between tab switches. The date range is part of the
cache key, so changing preset still refetches."
```

---

### Task 7: 展示原语 —— 金额格式化与趋势图

先做两个无状态、可独立测试的小件：金额换算与 SVG 折线。它们没有数据依赖，先落地能让后面两个表专注于布局。

**不引图表库**：项目当前无任何图表依赖，为一个只有管理员看的内部页面引入 recharts（数百 KB）不划算。折线用内联 SVG，约 30 行。

**Files:**
- Create: `client/src/components/Admin/Usage/format.ts`
- Create: `client/src/components/Admin/Usage/format.spec.ts`
- Create: `client/src/components/Admin/Usage/Trend.tsx`

**Interfaces:**
- Consumes: `AdminUsageDayRow`（Task 3）
- Produces:
```ts
export function creditsToUsd(credits: number): string;   // '12.34' / '0.0008'
export default function Trend(props: { days: AdminUsageDayRow[] }): JSX.Element;
```

- [ ] **Step 1: 写格式化的失败测试**

创建 `client/src/components/Admin/Usage/format.spec.ts`：

```ts
import { creditsToUsd } from './format';

describe('creditsToUsd', () => {
  it('renders whole dollars with two decimals', () => {
    expect(creditsToUsd(12_340_000)).toBe('12.34');
  });

  it('keeps sub-cent amounts visible instead of rounding them to zero', () => {
    /** Beta traffic is small; 0.00 for every row would make the table useless. */
    expect(creditsToUsd(800)).toBe('0.0008');
  });

  it('renders exact zero plainly', () => {
    expect(creditsToUsd(0)).toBe('0.00');
  });

  it('keeps the sign on a negative margin', () => {
    expect(creditsToUsd(-2_500_000)).toBe('-2.50');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /data/lidongyu/projects/LibreChat/client
npx jest src/components/Admin/Usage/format.spec --maxWorkers=2 2>&1 | tail -5
```

预期：FAIL，模块不存在。

- [ ] **Step 3: 实现格式化**

创建 `client/src/components/Admin/Usage/format.ts`：

```ts
/** 1 tokenCredit = one micro-dollar. */
const CREDITS_PER_USD = 1_000_000;

/**
 * Formats an amount held in tokenCredits as a dollar string.
 *
 * Amounts under a cent keep four decimals rather than rounding to `0.00`.
 * Beta traffic is small enough that a whole table of `0.00` would carry no
 * information at all.
 */
export function creditsToUsd(credits: number): string {
  const usd = credits / CREDITS_PER_USD;
  if (usd !== 0 && Math.abs(usd) < 0.01) {
    return usd.toFixed(4);
  }
  return usd.toFixed(2);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /data/lidongyu/projects/LibreChat/client
npx jest src/components/Admin/Usage/format.spec --maxWorkers=2 2>&1 | grep -E "Tests:"
```

预期：4 passed。

- [ ] **Step 5: 实现趋势图**

创建 `client/src/components/Admin/Usage/Trend.tsx`：

```tsx
import React, { useMemo } from 'react';
import { useLocalize } from '~/hooks';
import type { AdminUsageDayRow } from 'librechat-data-provider';
import { creditsToUsd } from './format';

const WIDTH = 640;
const HEIGHT = 120;
const PADDING = 4;

export default function Trend({ days }: { days: AdminUsageDayRow[] }) {
  const localize = useLocalize();

  const path = useMemo(() => {
    if (days.length < 2) {
      return '';
    }
    const peak = Math.max(...days.map((day) => day.cost_credits), 1);
    const stepX = (WIDTH - PADDING * 2) / (days.length - 1);
    return days
      .map((day, index) => {
        const x = PADDING + index * stepX;
        const y = HEIGHT - PADDING - (day.cost_credits / peak) * (HEIGHT - PADDING * 2);
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [days]);

  const total = useMemo(
    () => days.reduce((sum, day) => sum + day.cost_credits, 0),
    [days],
  );

  if (days.length === 0) {
    return <p className="text-sm text-text-secondary">{localize('com_ui_admin_usage_empty')}</p>;
  }

  return (
    <figure className="w-full">
      <figcaption className="mb-2 text-sm text-text-secondary">
        {localize('com_ui_admin_usage_trend_caption', { total: creditsToUsd(total) })}
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-32 w-full"
        role="img"
        aria-label={localize('com_ui_admin_usage_trend')}
        preserveAspectRatio="none"
      >
        {path !== '' && (
          <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="flex justify-between text-xs text-text-secondary">
        <span>{days[0].day}</span>
        <span>{days[days.length - 1].day}</span>
      </div>
    </figure>
  );
}
```

单点区间不画线（`days.length < 2` 时 `path` 为空），但仍显示总额与日期 —— 一条两端相同的线比没有线更容易误读。

- [ ] **Step 6: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "📈 feat(admin): credit formatting and an inline SVG trend

No chart library. The project has no charting dependency today, and pulling
several hundred kilobytes in for one admin-only page is a poor trade — the
line is about thirty lines of SVG.

Sub-cent amounts render with four decimals. Beta traffic is small enough
that rounding to 0.00 would leave the table carrying no information."
```

---

### Task 8: 两张表

**Files:**
- Create: `client/src/components/Admin/Usage/UserMarginTable.tsx`
- Create: `client/src/components/Admin/Usage/CostBreakdown.tsx`

**Interfaces:**
- Consumes: `AdminUsageUserRow` / `AdminUsageModelRow`（Task 3）、`creditsToUsd`（Task 7）
- Produces: 两个默认导出组件，props 分别为 `{ users }` 与 `{ models }`

- [ ] **Step 1: 每用户毛利表**

创建 `client/src/components/Admin/Usage/UserMarginTable.tsx`：

```tsx
import React, { useMemo } from 'react';
import { DataTable } from '@librechat/client';
import { useLocalize } from '~/hooks';
import type { AdminUsageUserRow } from 'librechat-data-provider';
import { creditsToUsd } from './format';

export default function UserMarginTable({ users }: { users: AdminUsageUserRow[] }) {
  const localize = useLocalize();

  const columns = useMemo(
    () => [
      {
        accessorKey: 'email',
        header: localize('com_ui_admin_usage_user'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) => (
          <span className="font-mono text-xs">
            {/* A user deleted while their transactions remain has no email. */}
            {row.original.email ?? row.original.user_id}
          </span>
        ),
      },
      {
        accessorKey: 'plan_code',
        header: localize('com_ui_admin_usage_plan'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) => {
          const { plan_code, plan_recognized } = row.original;
          if (!plan_recognized) {
            return (
              <span className="text-red-500" title={localize('com_ui_admin_usage_plan_unknown')}>
                {plan_code} ⚠
              </span>
            );
          }
          return <span>{plan_code ?? localize('com_ui_admin_usage_plan_implicit_free')}</span>;
        },
      },
      {
        accessorKey: 'cost_credits',
        header: localize('com_ui_admin_usage_cost'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) =>
          `$${creditsToUsd(row.original.cost_credits)}`,
      },
      {
        accessorKey: 'revenue_credits',
        header: localize('com_ui_admin_usage_revenue'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) =>
          `$${creditsToUsd(row.original.revenue_credits)}`,
      },
      {
        accessorKey: 'margin_credits',
        header: localize('com_ui_admin_usage_margin'),
        cell: ({ row }: { row: { original: AdminUsageUserRow } }) => {
          const margin = row.original.margin_credits;
          return (
            <span className={margin < 0 ? 'font-medium text-red-500' : undefined}>
              ${creditsToUsd(margin)}
            </span>
          );
        },
      },
      {
        accessorKey: 'calls',
        header: localize('com_ui_admin_usage_calls'),
      },
      {
        accessorKey: 'model_count',
        header: localize('com_ui_admin_usage_models'),
      },
    ],
    [localize],
  );

  return <DataTable columns={columns} data={users} />;
}
```

- [ ] **Step 2: 成本结构表**

创建 `client/src/components/Admin/Usage/CostBreakdown.tsx`：

```tsx
import React, { useMemo } from 'react';
import { useLocalize } from '~/hooks';
import type { AdminUsageModelRow } from 'librechat-data-provider';
import { creditsToUsd } from './format';

export default function CostBreakdown({ models }: { models: AdminUsageModelRow[] }) {
  const localize = useLocalize();

  const total = useMemo(
    () => models.reduce((sum, row) => sum + row.cost_credits, 0),
    [models],
  );

  if (models.length === 0) {
    return <p className="text-sm text-text-secondary">{localize('com_ui_admin_usage_empty')}</p>;
  }

  return (
    <table className="w-full text-sm" aria-label={localize('com_ui_admin_usage_breakdown')}>
      <thead>
        <tr className="border-b border-border-medium text-left text-text-secondary">
          <th scope="col" className="py-2">{localize('com_ui_admin_usage_model')}</th>
          <th scope="col">{localize('com_ui_admin_usage_context')}</th>
          <th scope="col">{localize('com_ui_admin_usage_cost')}</th>
          <th scope="col">{localize('com_ui_admin_usage_share')}</th>
          <th scope="col">{localize('com_ui_admin_usage_calls')}</th>
          <th scope="col">{localize('com_ui_admin_usage_cache_hit')}</th>
        </tr>
      </thead>
      <tbody>
        {models.map((row) => {
          const prompt = row.input_tokens + row.write_tokens + row.read_tokens;
          /** Cache hit rate answers whether caching is actually working for a
           *  model — the rate table can be right while caching never engages. */
          const hitRate = prompt > 0 ? Math.round((row.read_tokens / prompt) * 100) : 0;
          const share = total > 0 ? Math.round((row.cost_credits / total) * 100) : 0;
          return (
            <tr key={`${row.model}:${row.context}`} className="border-b border-border-light">
              <td className="py-2 font-mono text-xs">{row.model}</td>
              <td>{row.context}</td>
              <td>${creditsToUsd(row.cost_credits)}</td>
              <td>{share}%</td>
              <td>{row.calls}</td>
              <td>{prompt > 0 ? `${hitRate}%` : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: 类型检查**

```bash
cd /data/lidongyu/projects/LibreChat/client
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -8 /tmp/tsc.log
```

预期：EXIT=0。文案 key 此时尚未加入 translation.json，`useLocalize` 在运行时会回退到 key 本身，不影响类型检查；Task 9 补齐。

- [ ] **Step 4: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "📋 feat(admin): per-user margin and cost-structure tables

Negative margin is coloured, an unrecognised plan renders with a warning
rather than blending in, and a user deleted while their transactions remain
falls back to showing the id.

The breakdown carries a cache-hit column: the rate table can be correct
while caching never actually engages, and those two failures look identical
in a total."
```

---

### Task 9: 页面容器、路由与文案

**Files:**
- Create: `client/src/components/Admin/Usage/UsagePanel.tsx`
- Create: `client/src/components/Admin/Usage/index.ts`
- Modify: `client/src/routes/index.tsx`
- Modify: `client/src/locales/en/translation.json`

**Interfaces:**
- Consumes: `useAdminUsageQuery`（Task 6）、三个展示组件（Task 7/8）
- Produces: `/admin/usage` 路由

- [ ] **Step 1: 写容器**

创建 `client/src/components/Admin/Usage/UsagePanel.tsx`：

```tsx
import React, { useMemo, useState } from 'react';
import { SystemRoles } from 'librechat-data-provider';
import { Spinner } from '@librechat/client';
import { useAuthContext, useLocalize } from '~/hooks';
import { useAdminUsageQuery } from '~/data-provider';
import UserMarginTable from './UserMarginTable';
import CostBreakdown from './CostBreakdown';
import Trend from './Trend';

type Preset = 'month' | 'days30' | 'all';

/** Defaults to a rolling 30 days rather than the calendar month: billing
 *  anchors differ per user, so a rolling window is what compares against a
 *  monthly fee, and it reacts sooner to someone who just started burning. */
function rangeFor(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (preset === 'all') {
    return { from: new Date(0).toISOString(), to };
  }
  if (preset === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to };
  }
  return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to };
}

export default function UsagePanel() {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const [preset, setPreset] = useState<Preset>('days30');

  const range = useMemo(() => rangeFor(preset), [preset]);
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const { data, isLoading, error } = useAdminUsageQuery(range, { enabled: isAdmin });

  /** UX only — the real guard is requireCapability on the route. */
  if (!isAdmin) {
    return <div className="p-6">{localize('com_ui_admin_usage_forbidden')}</div>;
  }

  const presets: Preset[] = ['month', 'days30', 'all'];
  const labels: Record<Preset, string> = {
    month: localize('com_ui_admin_usage_range_month'),
    days30: localize('com_ui_admin_usage_range_30d'),
    all: localize('com_ui_admin_usage_range_all'),
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-medium">{localize('com_ui_admin_usage_title')}</h1>
        <div role="group" aria-label={localize('com_ui_admin_usage_range')} className="flex gap-2">
          {presets.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreset(option)}
              aria-pressed={preset === option}
              className={`rounded px-3 py-1 text-sm ${
                preset === option ? 'bg-surface-tertiary font-medium' : 'text-text-secondary'
              }`}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      </header>

      {isLoading && <Spinner />}
      {error != null && (
        <p className="text-red-500">{localize('com_ui_admin_usage_error')}</p>
      )}

      {data != null && (
        <>
          <section aria-labelledby="usage-users">
            <h2 id="usage-users" className="mb-2 text-lg">
              {localize('com_ui_admin_usage_by_user')}
            </h2>
            <UserMarginTable users={data.users} />
          </section>

          <section aria-labelledby="usage-breakdown">
            <h2 id="usage-breakdown" className="mb-2 text-lg">
              {localize('com_ui_admin_usage_breakdown')}
            </h2>
            <CostBreakdown models={data.models} />
          </section>

          <section aria-labelledby="usage-trend">
            <h2 id="usage-trend" className="mb-2 text-lg">
              {localize('com_ui_admin_usage_trend')}
            </h2>
            <Trend days={data.days} />
            <p className="mt-2 text-xs text-text-secondary">
              {localize('com_ui_admin_usage_rate_change_note')}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
```

创建 `client/src/components/Admin/Usage/index.ts`：

```ts
export { default as UsagePanel } from './UsagePanel';
```

- [ ] **Step 2: 挂路由**

在 `client/src/routes/index.tsx` 中，比照 `loadSkillsView` 的写法加加载器：

```tsx
const loadAdminUsageView = () =>
  import('~/components/Admin/Usage/UsagePanel').then((m) => ({ Component: m.default }));
```

并在 `Root` 的 `children` 数组里（`path: 'projects'` 附近）追加：

```tsx
            {
              path: 'admin/usage',
              lazy: loadAdminUsageView,
            },
```

- [ ] **Step 3: 加文案**

在 `client/src/locales/en/translation.json` 中按字母序插入这些 key（该文件按 key 排序）：

```json
  "com_ui_admin_usage_by_user": "Per-user margin",
  "com_ui_admin_usage_cache_hit": "Cache hit",
  "com_ui_admin_usage_calls": "Calls",
  "com_ui_admin_usage_context": "Purpose",
  "com_ui_admin_usage_cost": "Cost",
  "com_ui_admin_usage_breakdown": "Cost structure",
  "com_ui_admin_usage_empty": "No usage in this range.",
  "com_ui_admin_usage_error": "Could not load usage data.",
  "com_ui_admin_usage_forbidden": "Admin access required.",
  "com_ui_admin_usage_margin": "Margin",
  "com_ui_admin_usage_model": "Model",
  "com_ui_admin_usage_models": "Models used",
  "com_ui_admin_usage_plan": "Plan",
  "com_ui_admin_usage_plan_implicit_free": "Free (implicit)",
  "com_ui_admin_usage_plan_unknown": "Unrecognised plan — revenue counted as zero",
  "com_ui_admin_usage_range": "Date range",
  "com_ui_admin_usage_range_30d": "Last 30 days",
  "com_ui_admin_usage_range_all": "All time",
  "com_ui_admin_usage_range_month": "This month",
  "com_ui_admin_usage_rate_change_note": "Model rates were corrected on 2026-08-19. Costs recorded before that date used the old rates and are not comparable.",
  "com_ui_admin_usage_revenue": "Revenue (30d)",
  "com_ui_admin_usage_share": "Share",
  "com_ui_admin_usage_title": "Usage & cost",
  "com_ui_admin_usage_trend": "Daily trend",
  "com_ui_admin_usage_trend_caption": "Total ${{total}} over the selected range",
  "com_ui_admin_usage_user": "User",
```

`com_ui_admin_usage_rate_change_note` 不是装饰 —— 费率修正是写入时固化的，该日期前后的成本口径不同，趋势图上的跳变否则会被误读成用量变化。

- [ ] **Step 4: 四态测试**

创建 `client/src/components/Admin/Usage/UsagePanel.spec.tsx`：

```tsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemRoles } from 'librechat-data-provider';
import UsagePanel from './UsagePanel';

const mockUseAdminUsageQuery = jest.fn();
const mockUseAuthContext = jest.fn();

jest.mock('~/data-provider', () => ({
  useAdminUsageQuery: (...args: unknown[]) => mockUseAdminUsageQuery(...args),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useLocalize: () => (key: string) => key,
}));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RecoilRoot>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <UsagePanel />
        </MemoryRouter>
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

beforeEach(() => {
  mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.ADMIN } });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('UsagePanel', () => {
  it('renders a loading state while the query is in flight', () => {
    mockUseAdminUsageQuery.mockReturnValue({ isLoading: true, data: undefined, error: null });
    renderPanel();
    expect(screen.queryByText('com_ui_admin_usage_error')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_title')).toBeInTheDocument();
  });

  it('renders the three sections on success', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-31T00:00:00Z',
        users: [
          {
            user_id: 'u1',
            email: 'a@example.com',
            plan_code: 'pro_m',
            plan_recognized: true,
            cost_credits: 1_000_000,
            revenue_credits: 29_990_000,
            margin_credits: 28_990_000,
            calls: 4,
            model_count: 2,
          },
        ],
        models: [
          {
            model: 'glm-5.2',
            context: 'message',
            cost_credits: 1_000_000,
            calls: 4,
            input_tokens: 100,
            write_tokens: 0,
            read_tokens: 20,
          },
        ],
        days: [
          { day: '2026-08-10', cost_credits: 600_000 },
          { day: '2026-08-11', cost_credits: 400_000 },
        ],
      },
    });
    renderPanel();
    expect(screen.getByText('com_ui_admin_usage_by_user')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_breakdown')).toBeInTheDocument();
    expect(screen.getByText('com_ui_admin_usage_trend')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
  });

  it('renders an error message when the query fails', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('boom'),
    });
    renderPanel();
    expect(screen.getByText('com_ui_admin_usage_error')).toBeInTheDocument();
  });

  it('renders an empty state rather than a spinner when there is no traffic', () => {
    mockUseAdminUsageQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-31T00:00:00Z',
        users: [],
        models: [],
        days: [],
      },
    });
    renderPanel();
    expect(screen.getAllByText('com_ui_admin_usage_empty').length).toBeGreaterThan(0);
  });

  it('refuses to render data for a non-admin and never issues the query', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.USER } });
    mockUseAdminUsageQuery.mockReturnValue({ isLoading: false, data: undefined, error: null });
    renderPanel();
    expect(screen.getByText('com_ui_admin_usage_forbidden')).toBeInTheDocument();
    /** The real guard is server-side, but the query must not fire either. */
    expect(mockUseAdminUsageQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
});
```

跑：

```bash
cd /data/lidongyu/projects/LibreChat/client
npx jest src/components/Admin/Usage --maxWorkers=2 > /tmp/ct.log 2>&1; echo "jest EXIT=$?"
grep -E "^Tests:" /tmp/ct.log
```

预期：format 的 4 个 + UsagePanel 的 5 个，共 9 passed。

- [ ] **Step 5: 类型检查与构建**

```bash
cd /data/lidongyu/projects/LibreChat/client
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.log 2>&1; echo "tsc EXIT=$?"; head -8 /tmp/tsc.log
node -e 'JSON.parse(require("fs").readFileSync("src/locales/en/translation.json","utf8")); console.log("translation.json 合法")'
cd /data/lidongyu/projects/LibreChat
npx eslint client/src/components/Admin client/src/data-provider/Admin > /tmp/lint.log 2>&1; echo "eslint EXIT=$?"; tail -5 /tmp/lint.log
```

预期：三项全部 EXIT=0。

- [ ] **Step 5: 端到端手工验证**

启动前后端，以管理员登录后访问 `http://localhost:3090/admin/usage`，确认：

1. 三个时间范围按钮可切换且数据随之刷新
2. 每用户表按成本降序，负毛利标红
3. 成本结构表出现 `title` 与 `message` 两种用途
4. 以非管理员账号访问时页面显示无权限，且 `curl` 直接打 `/api/admin/usage` 返回 403

- [ ] **Step 6: 提交**

```bash
cd /data/lidongyu/projects/LibreChat
git add -A
git commit -m "🖥️ feat(admin): /admin/usage dashboard

Defaults to a rolling 30 days rather than the calendar month: billing
anchors differ per user, so a rolling window is what actually compares
against a monthly fee, and it reacts sooner to a user who has just started
burning.

The trend carries a note about the 2026-08-19 rate correction. Rates are
fixed at write time, so costs either side of that date are not comparable
and the step would otherwise read as a change in usage.

Read-only by design. At 20-50 users, spotting a problem and handling it by
hand is entirely workable, and write paths need confirmation, audit and
rollback design that is not worth building yet."
```

---

## 完成标准

全部任务结束后应满足：

- `packages/data-schemas`、`packages/api`、`client` 三个 workspace 的 `tsc --noEmit` 均为 0 错
- 三个 workspace 的 jest 全绿，且失败数不高于实施前的基线
- `npx eslint` 对新增目录 0 错
- 以管理员访问 `/admin/usage` 能看到三个区块的真实数据
- 以非管理员直接请求 `/api/admin/usage` 返回 403
- 代码库中不再有 `UsageLog` / `IUsageLog` 的引用
