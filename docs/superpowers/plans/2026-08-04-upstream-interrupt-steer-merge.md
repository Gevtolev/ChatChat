# 上游 Interrupt & Steer 合并实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游 LibreChat 的 Interrupt & Steer（运行中打断并引导 AI 生成）完整移植到 ChatChat，且不丢失我们已有的任何自定义改动。

**Architecture:** 这不是逐提交 cherry-pick，而是**分层对齐**。实测发现我们对后端 `packages/api/src/stream/` **零自定义**，可整体替换为上游版本；前端 `client/src/hooks/SSE/` 只有 6 处自定义，采用「取上游文件 → 逐条贴回自定义 → 测试」的方式。在对齐后的基座上，再增量引入 19 个 steer 专属新文件。

**Tech Stack:** TypeScript / JavaScript (Express) / React / Recoil / React Query / `@librechat/agents` SDK / Redis (job store + event transport) / Jest + mongodb-memory-server

---

## Global Constraints

- 目标上游基线：`upstream/dev` @ `b80729299`（2026-08-03）。所有 `git show upstream/dev:<path>` 均以此为准，执行期间**不要**重新 fetch 上游，避免基线漂移。
- 当前 merge-base：`190cdee30`（2026-05-26）。凡是判断「我们的自定义」，一律用 `git diff $(git merge-base main upstream/dev) main -- <path>`。
- `@librechat/agents` 必须升到 `^3.3.11`。Steering 需要 SDK 的 `injectedMessages`（agents#299），Preemptive 需要 preempt seam（agents#335、#346）。**3.2.62 不支持**，`isSteeringSupported()` 会返回 false。
- 所有测试命令必须带本机环境前缀：`LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18`。
- 从仓库根跑 jest 会因残留 worktree 触发 haste 冲突，**必须 `cd` 到对应 workspace 目录再跑**。
- 禁止 `any`；限制 `unknown`。
- **类型检查的验收标准分两套**（2026-08-05 修订，原「所有 TS/ESLint 报错必须清零」在 client 上从未成立）：
  - `packages/*` 与 `api/`：`npm run build` 必须零 `error TS`，`packages/api` 的 `npx tsc --noEmit` 必须退出码 0。
  - `client/`：**`npm run build` 走的是纯 `vite build`，不做类型检查**，所以「build 成功」不能作为 client 的类型证据。client 的实际状态是 159 条既有类型错误（涉及 76 个文件），已固化为 `docs/superpowers/plans/client-ts-baseline.txt`。任何触及 client 的 Task，结束时必须跑：

    ```bash
    cd client && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | sed -E 's/\(([0-9]+),([0-9]+)\)//' | sort > /tmp/client-ts-now.txt
    diff docs/superpowers/plans/client-ts-baseline.txt /tmp/client-ts-now.txt
    ```

    验收标准是 **`diff` 无新增行**（`>` 开头的行为零）。减少是允许的。基准去掉了行号，所以插入代码导致的行号漂移不会产生假阳性。
- 用户可见文本一律走 `useLocalize()`，只改 `client/src/locales/en/translation.json`。
- 每个 Task 结束必须提交一次，commit message 用英文，**禁止 Co-Authored-By 签名**。

---

## 规模与风险（实测数据，执行前必读）

| 项 | 实测 |
|---|---|
| 上游落后量 | 543 commit（177 个实质提交） |
| `packages/api/src/stream/` 差异 | `GenerationJobManager.ts` 6134+/737-、`RedisJobStore.ts` 3318+/205-、`InMemoryJobStore.ts` 2122+/49-、`IJobStore.ts` 996+/42-、`RedisEventTransport.ts` 775+/210-，**另有 9 个文件我们完全没有** |
| 我们对 `stream/` 的自定义 | **零**（可整体替换） |
| `useResumableSSE.ts` 差异 | 上游 +3192/-142；我们 +102/-18 |
| 我们对 `client/src/hooks/SSE/` 的自定义 | **仅 3 个文件、6 处**（详见下节） |
| steer 专属新文件 | 19 个（我们全部没有） |
| SDK | 我们 `^3.2.62` → 上游 `^3.3.11` |
| **预估工时** | **48–52 小时**（10h/周 ≈ 5 周） |

**最大三个风险：**

1. **SDK 3.2 → 3.3 的 breaking change 未知** —— Task 2 是整个计划的成败点。若 Task 2 无法在 8 小时内跑通回归，**停止整个计划**并回滚分支，不要硬推。
2. **`ChatForm.tsx` 与 `useTextarea.ts` 双方都改过** —— 上游为 steer 改了这两个文件（`useTextarea.ts` 上游改了 130 行），我们也有自定义（`ChatForm.tsx` +5/-1、`useTextarea.ts` +12/-5）。Task 8 必须手工合并。
3. **一次性大合并，回滚只能靠分支** —— 全程在 `feat/upstream-interrupt-steer` 分支上做，每个 Task 独立 commit，出问题按 Task 粒度回退。

---

## 必须保留的自定义清单（合并期间反复对照）

### A. `client/src/hooks/SSE/useResumableSSE.ts`（5 处）

**A1** — 新增 `STREAM_START_FALLBACK_TEXT` 常量、`parseSSEErrorData()`、`getSSEErrorText()`、导出 `getStreamStartFailureText()`（约 66 行，插在 `const MAX_RETRIES = 5;` 之后）。作用：流启动失败时给用户真实文案而非裸 JSON。

**A2** — `balanceQuery` 的 enabled 加双感叹号：
```ts
enabled: !!isAuthenticated && !!startupConfig?.balance?.enabled,
```

**A3** — 在 `startStream` 回调内声明 `let finalReceived = false;`（紧跟 `let textIndex: number | null = null;`）。

**A4** — 收到 final 事件时置位并清理重连状态：
```ts
if (data.final != null) {
  finalReceived = true;
  if (reconnectTimeoutRef.current) {
    clearTimeout(reconnectTimeoutRef.current);
    reconnectTimeoutRef.current = null;
  }
  reconnectAttemptRef.current = 0;
```

**A5** — `error` 监听器内，在读取 `responseCode` 之后、balance refetch 之前插入早退，并把 balance refetch 移到早退之后：
```ts
if (finalReceived) {
  console.log('[ResumableSSE] Ignoring error after FINAL event', {
    responseCode,
    hasData: !!e.data,
  });
  return;
}

(startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
```

### B. `client/src/hooks/SSE/useEventHandlers.ts`（3 处）

**B1** — 引入 `const setGuestUpgradeModalOpen = useSetRecoilState(store.guestUpgradeModalOpen);`

**B2** — **三处** conversation 更新点后，加 project 缓存失效（搜索 `updateConvoInAllQueries` 与 `location.pathname === '/c/${Constants.NEW_CONVO}'` 附近）：
```ts
if (update.chatProjectId) {
  queryClient.invalidateQueries([QueryKeys.projects]);
  queryClient.invalidateQueries([QueryKeys.project, update.chatProjectId]);
}
```
（第三处变量名是 `conversation.chatProjectId`）

**B3** — 错误处理里加匿名配额弹窗，并把 `setGuestUpgradeModalOpen` 加进依赖数组：
```ts
/**
 * Anonymous (GUEST) visitors exhaust their free-trial quota with an
 * `upgrade_required_quota` error; surface the strong login prompt instead of leaving
 * them with only the inline error bubble. The modal only mounts in the guest layout,
 * so setting this for a non-guest is a harmless no-op.
 */
if (data && JSON.stringify(data).includes('upgrade_required_quota')) {
  setGuestUpgradeModalOpen(true);
}
```

### C. `client/src/hooks/SSE/useSSE.ts`（1 处）

同 A2：`enabled: !!isAuthenticated && !!startupConfig?.balance?.enabled,`

### D. `api/server/controllers/agents/client.js`（+81/-12，Task 5 起不得破坏）

我们的 memory 改造：`getRequestMemories` / `agentHasInlineMemoryTools` / `processTextWithTokenLimit` / `DEFAULT_MEMORY_MAX_INPUT_TOKENS` 导入、`MEMORY_INPUT_CHARS_PER_TOKEN = 8`、keyed vs unkeyed 记忆上下文分流、`useMemory()` 返回 `{withKeys, withoutKeys}`、记忆输入的字符级截断，以及 `chatProjectId: this.options.chatProjectId` 透传。

### E. 其他 steer 触及区域的自定义（Task 8 对照）

`BadgeRow.tsx` +3/-1、`ChatForm.tsx` +5/-1、`ConversationStarters.tsx` +277/-20、`AttachFileMenu.tsx` +98/-156、`Memory.tsx` +40、`ToolsDropdown.tsx` +60/-5、`useQueryParams.ts` +21/-4、`useSelectMention.ts` +31/-4、`useTextarea.ts` +12/-5、`callbacks.js` +22、`v1.js` +10/-2。

---

## Task 1: 建立分支与回归基准

**Files:**
- Create: `docs/superpowers/plans/regression-baseline-steer.md`

**Interfaces:**
- Produces: 分支 `feat/upstream-interrupt-steer`；一份记录了合并前测试通过状况的基准文档，后续每个 Task 都拿它对照。

- [ ] **Step 1: 建分支**

```bash
cd /data/lidongyu/projects/LibreChat
git checkout main && git pull --ff-only origin main
git checkout -b feat/upstream-interrupt-steer
```

- [ ] **Step 2: 跑合并前的全量后端测试，记录结果**

```bash
cd /data/lidongyu/projects/LibreChat/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -30
cd /data/lidongyu/projects/LibreChat/packages/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -30
cd /data/lidongyu/projects/LibreChat/packages/data-schemas && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -30
cd /data/lidongyu/projects/LibreChat/packages/data-provider && npx jest 2>&1 | tail -20
cd /data/lidongyu/projects/LibreChat/client && npx jest 2>&1 | tail -30
```

- [ ] **Step 3: 把每个 workspace 的 `Tests: X passed, Y failed` 原样写进基准文档**

文档内容格式（把实际数字填进去，**不要**写"全部通过"这种模糊描述）：

```markdown
# Interrupt & Steer 合并回归基准

基线 commit: <git rev-parse HEAD>
上游目标: upstream/dev @ b80729299

| workspace | 合并前 |
|---|---|
| api | Tests: __ passed, __ failed, __ total |
| packages/api | Tests: __ passed, __ failed, __ total |
| packages/data-schemas | Tests: __ passed, __ failed, __ total |
| packages/data-provider | Tests: __ passed, __ failed, __ total |
| client | Tests: __ passed, __ failed, __ total |

合并前已存在的失败用例（这些不算回归）：
- <逐条列出>
```

- [ ] **Step 4: 跑一次全量构建，确认基线可构建**

```bash
cd /data/lidongyu/projects/LibreChat && npm run build 2>&1 | tail -20
```
Expected: 构建成功，无 TS 错误。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/plans/regression-baseline-steer.md
git commit -m "docs: record pre-merge regression baseline for steer merge"
```

---

## Task 2: 升级 @librechat/agents 到 ^3.3.11

> ⚠️ **这是成败点。** 若本 Task 超过 8 小时仍无法让回归回到基准水平，停止整个计划，`git checkout main` 并向决策者汇报。

**Files:**
- Modify: `api/package.json`（`"@librechat/agents": "^3.2.62"` → `"^3.3.11"`）
- Modify: `packages/api/package.json`（同上）
- Modify: `package-lock.json`（由 npm 生成）

**Interfaces:**
- Consumes: Task 1 的回归基准
- Produces: 可用的 `injectedMessages` hook 支持与 preempt seam；后续所有 Task 依赖此版本

- [ ] **Step 1: 查看上游锁定的确切版本与两版之间的变化**

```bash
git show upstream/dev:api/package.json | grep '@librechat/agents'
npm view @librechat/agents@3.3.11 dependencies
npm view @librechat/agents versions --json | tail -20
```

- [ ] **Step 2: 改两处 package.json 的版本号**

`api/package.json` 与 `packages/api/package.json` 中：
```json
"@librechat/agents": "^3.3.11",
```

- [ ] **Step 3: 安装并构建**

```bash
cd /data/lidongyu/projects/LibreChat && npm run smart-reinstall 2>&1 | tail -40
```
Expected: 安装成功。若出现 peer dependency 冲突，记录完整错误后再决定是否同步升级相关依赖。

- [ ] **Step 4: 跑全量后端测试，与基准逐行对比**

```bash
cd /data/lidongyu/projects/LibreChat/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -40
cd /data/lidongyu/projects/LibreChat/packages/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -40
```
Expected: 失败用例集合与 Task 1 基准**完全一致**。任何新增失败都必须定位到 SDK 变更并修复，不得跳过。

- [ ] **Step 5: 手工验证一次真实对话**

```bash
cd /data/lidongyu/projects/LibreChat && npm run backend:dev
```
另开终端 `npm run frontend:dev`，浏览器打开 `http://localhost:3090/`，验证：
1. 发一条普通消息能正常流式返回
2. 中途点停止能正常中断
3. 刷新页面后对话历史仍在

- [ ] **Step 6: 提交**

```bash
git add api/package.json packages/api/package.json package-lock.json
git commit -m "chore(deps): upgrade @librechat/agents to ^3.3.11 for steering support"
```

---

## Task 3: 后端 stream 子系统对齐 + steering 模块

> **2026-08-04 裁定**：原 Task 3 与 Task 4 合并为本 Task。原因是原 Task 3 结束时 `stream/` 会引用尚未补齐的 steering 模块，必然留下类型错误，与 Global Constraints「所有 TypeScript / ESLint 报错必须清零」冲突。合并后**本 Task 结束时类型必须全绿**，不存在中间态。后续 Task 编号不变（Task 4 已并入本 Task）。

**Files:**
- Overwrite: `packages/api/src/stream/GenerationJobManager.ts`、`createStreamServices.ts`、`index.ts`、`interfaces/IJobStore.ts`、`implementations/{InMemoryEventTransport,InMemoryJobStore,RedisEventTransport,RedisJobStore}.ts`
- Create: `packages/api/src/stream/{ApprovalLifecycle,SteerRecovery,SteeringLifecycle,abortContent,jobStoreCapabilities,metadata}.ts`、`packages/api/src/stream/internal/chunkPublication.ts`、`packages/api/src/stream/implementations/index.ts`、`packages/api/src/stream/interfaces/index.ts`
- Overwrite: `packages/api/src/stream/` 下全部 `__tests__` 与 `*.spec.ts`
- Create: `packages/api/src/agents/steering/{index,media,offset,refs,request,runtime}.ts` + 对应 spec
- Create: `api/server/controllers/agents/protocol.js`
- Modify: `packages/api/src/index.ts`（只补 steering 相关导出行）

**Interfaces:**
- Consumes: Task 2 的 SDK ^3.3.11
- Produces: `GenerationJobManager`（含 `requestPreempt` / `isPreemptRequested` / `noteSteersRemoved` / `clearPreemptRequests`）、`IEventTransport` 的 `emitPreempt` / `onPreempt`、`SteeringLifecycle`、`SteerRecovery`；`handleSteerRequest` / `handleSteerCancel` / `handleSteerArm`（从 `@librechat/api` 导出）；`getRequestedGenerationProtocol` / `getServerGenerationProtocol` / `GENERATION_PROTOCOL_HEADER`（来自 `protocol.js`）。Task 5 的 `steer.js` 直接消费这些。

- [ ] **Step 1: 再次确认我们对该目录零自定义（安全整体覆盖的前提）**

```bash
cd /data/lidongyu/projects/LibreChat
git diff --stat $(git merge-base main upstream/dev) main -- packages/api/src/stream/
```
Expected: **输出为空**。若非空，停止本 Task，改为逐文件手工合并，并把差异记入本计划。

- [ ] **Step 2: 整体取上游版本**

```bash
git checkout upstream/dev -- packages/api/src/stream/
git status --short packages/api/src/stream/ | head -40
```

- [ ] **Step 3: 记录该目录对外部模块的依赖，确认缺失项**

```bash
grep -rhoE "from '[~@][^']*'" packages/api/src/stream/ | sort -u
```
逐个确认这些路径在我们仓库里存在。把缺失的记进报告（预期会有指向 `~/agents/steering/*` 的），它们由本 Task 的 Step 4 补齐。**本 Task 结束时不允许残留任何类型错误。**

- [ ] **Step 4: 取上游 steering 模块与 protocol**

```bash
cd /data/lidongyu/projects/LibreChat
git checkout upstream/dev -- packages/api/src/agents/steering/
git checkout upstream/dev -- api/server/controllers/agents/protocol.js
ls packages/api/src/agents/steering/
```

- [ ] **Step 5: 对比 packages/api 的导出入口，只补 steering 相关行**

```bash
git diff main:packages/api/src/index.ts upstream/dev:packages/api/src/index.ts | grep -iE '^\+.*(steer|preempt|protocol)'
```
把匹配到的 `export` 行手工加进 `packages/api/src/index.ts`。**不要**整体覆盖该文件 —— 它包含我们自己的 billing / images 等导出。

- [ ] **Step 6: 类型检查必须全绿**

```bash
cd /data/lidongyu/projects/LibreChat && npm run build 2>&1 | grep -E "error TS" | head -30
```
Expected: **零输出**。若仍有 TS 错误，逐个定位缺失文件并从上游补齐，不得遗留。

- [ ] **Step 7: 跑 stream 与 steering 测试**

```bash
cd /data/lidongyu/projects/LibreChat/packages/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest src/stream src/agents/steering 2>&1 | tail -40
```
Expected: 全绿。例外：`redisClients.cache_integration.spec.ts` 等 Redis 集成套件在本机因无 Redis 服务而进程级崩溃，属基准中已记录的环境限制，不算失败。

- [ ] **Step 8: 提交**

```bash
git add packages/api/src/stream/ packages/api/src/agents/steering/ api/server/controllers/agents/protocol.js packages/api/src/index.ts
git commit -m "feat(stream): align stream subsystem with upstream and add steering module"
```

---

## Task 4: 已并入 Task 3

见 Task 3 开头的裁定说明。后续 Task 编号保持不变。

---

## Task 5: 后端 steer 控制器与路由

**Files:**
- Create: `api/server/controllers/agents/steer.js`
- Create: `api/server/controllers/agents/__tests__/steer.spec.js`、`__tests__/client.steerWiring.spec.js`
- Modify: `api/server/routes/agents/chat.js`（挂载 steer 路由）
- Modify: `api/server/controllers/agents/client.js`（steer 接线，**必须保住 D 节的 81 行 memory 自定义**）

**Interfaces:**
- Consumes: Task 4 的 `handleSteerRequest` / `handleSteerCancel` / `handleSteerArm` / protocol 三件套
- Produces: `POST /api/agents/chat/steer`（body 支持 `preempt: true`）、steer cancel / arm 端点。Task 7、8 的前端直接打这些端点。

- [ ] **Step 1: 取上游 steer 控制器与测试**

```bash
cd /data/lidongyu/projects/LibreChat
git checkout upstream/dev -- api/server/controllers/agents/steer.js
git checkout upstream/dev -- api/server/controllers/agents/__tests__/steer.spec.js
git checkout upstream/dev -- api/server/controllers/agents/__tests__/client.steerWiring.spec.js
```

- [ ] **Step 2: 手工合并路由挂载（不要整体覆盖）**

```bash
git diff main:api/server/routes/agents/chat.js upstream/dev:api/server/routes/agents/chat.js
```
只把 steer 相关的 `require` 与 `router.post(...)` 行加进我们的 `chat.js`。

- [ ] **Step 3: 手工合并 client.js 的 steer 接线**

```bash
git diff main:api/server/controllers/agents/client.js upstream/dev:api/server/controllers/agents/client.js | grep -iE '^[+-].*(steer|preempt|injectedMessage)' | head -40
```
只移植 steer / preempt / injectedMessages 相关 hunk。**逐条核对本计划 D 节，确认 memory 改造与 `chatProjectId` 透传一行未丢。**

- [ ] **Step 4: 跑 steer 与 agents 控制器测试**

```bash
cd /data/lidongyu/projects/LibreChat/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest server/controllers/agents 2>&1 | tail -40
```
Expected: 全绿，含新增的 `steer.spec.js` 与 `client.steerWiring.spec.js`。

- [ ] **Step 5: 验证 memory 自定义没被破坏**

```bash
cd /data/lidongyu/projects/LibreChat/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest memory 2>&1 | tail -20
git diff $(git merge-base main upstream/dev) HEAD -- api/server/controllers/agents/client.js | grep -c "getRequestMemories"
```
Expected: memory 测试全绿；grep 计数 > 0。

- [ ] **Step 6: 提交**

```bash
git add api/server/controllers/agents/ api/server/routes/agents/chat.js
git commit -m "feat(steer): wire steer controller and routes into agents chat"
```

---

## Task 5b: steer 终局回收链

> **2026-08-04 新增**：Task 5 的审查用真实 `GenerationJobManager` 探针发现的 Critical，范围超出 Task 5 故另立。**必须在 Task 6 之前完成** —— 原计划全文 grep `request.js` 零命中，没有任何后续步骤会碰到它，不补则一路带到 Task 10 手工验收才暴露，届时已有 5 个前端任务压在死后端上。

**问题**：运行结束前未被排空的 steer 会被静默销毁。

链路：`completeJob(streamId, err)` → `claimTerminalJob` → `jobStore.transitionStatusAndDrainSteers`（`GenerationJobManager.ts:3077`）把残留 steer 收进 `claim.drainedSteers`。上游 `request.js:1644-1654` 把它变成 final 事件里的 `pendingSteers` 并 park 起来，`index.js:470-500` 与 `sendJoblessStatus` 再用 `claimDetailed` 交还给客户端。

我们 fork：`request.js` 全部走两参数 `completeJob`，**从不读 `terminalClaim.drainedSteers`**；`park` / `claimDetailed` / `unrecoveredSteers` / `recoveredSteer` 全仓库**零调用点**（`api/` 与 `packages/api/src` 双向 grep 确认）。

**失败场景**：drain 只发生在 `PostToolBatch`（工具批次边界）或 `PreemptBoundary`。因此只要 agent 在这条 steer 入队后不再调用任何工具 —— **纯聊天回答是 ChatChat 最常见的形态** —— 用户打字发出的 steer 会 202 成功、chip 亮起、然后随运行结束一起消失：无错误、无回执、无重投。受影响的是全部普通订阅用户。

**Files:**
- Modify: `api/server/controllers/agents/request.js`（读取终局 claim 的 `drainedSteers`，park 并放进 final 事件）
- Modify: `api/server/routes/agents/index.js`（`claimDetailed` 状态路由，把未回收的 steer 交还客户端）
- Test: `api/server/controllers/agents/__tests__/` 下新增终局回收用例

**Interfaces:**
- Consumes: Task 3 的 `GenerationJobManager.transitionStatusAndDrainSteers` / `claimTerminalJob`、Task 5 的 job identity（`initialMetadata` + `client.jobCreatedAt`）
- Produces: final 事件中的 `pendingSteers` 字段；`unrecoveredSteers` 回收路径。Task 7 的前端 chip 状态机依赖它来决定 chip 是消失还是保留待重投。

- [ ] **Step 1: 对拍上游三处实现**

```bash
cd /data/lidongyu/projects/LibreChat
git show upstream/dev:api/server/controllers/agents/request.js | sed -n '1630,1670p'
git show upstream/dev:api/server/routes/agents/index.js | sed -n '460,510p'
git grep -n "claimDetailed\|unrecoveredSteers\|recoveredSteer" upstream/dev -- api packages/api/src
```
把上游的完整回收链读明白后再动手，记进报告。

- [ ] **Step 2: 用真实对象写失败测试（先红）**

用真实 `GenerationJobManager` + 真实 `InMemoryJobStore`（**不要 mock**）构造场景：建 job → 入队一条 steer → 不经过任何工具边界直接 `completeJob` → 断言这条 steer 能从终局 claim 中被取回。

Run: `cd api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest server/controllers/agents --testPathPattern=<新测试文件>`
Expected: FAIL —— 当前 `drainedSteers` 从不被读取。

- [ ] **Step 3: 按上游实现回收链**

`request.js` 改用能拿到终局 claim 的 `completeJob` 形式，读 `claim.drainedSteers`，park 后放进 final 事件的 `pendingSteers`；`index.js` 补 `claimDetailed` 状态路由。每处与上游区间对拍。

- [ ] **Step 4: 测试转绿并跑真实探针**

Run: 同 Step 2 命令
Expected: PASS

另跑一次真实（无 mock）探针，确认「入队 steer → 无工具边界 → 运行结束」后该 steer 可被取回，输出贴进报告。

- [ ] **Step 5: 串行全量回归**

```bash
cd /data/lidongyu/projects/LibreChat/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -20
cd /data/lidongyu/projects/LibreChat/packages/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -20
cd /data/lidongyu/projects/LibreChat && npm run build 2>&1 | grep -E "error TS|Tasks:"
```
Expected: 失败集合 ⊆ 基准；build 零 `error TS`。**不要并行跑**（mongodb-memory-server 争用会产生假失败）。

- [ ] **Step 6: 提交**

```bash
git add api/server/controllers/agents/ api/server/routes/agents/index.js
git commit -m "fix(steer): recover undrained steers on job termination"
```

---

## Task 6: 前端基础设施 + SSE 层对齐（已并入原 Task 7）

> ⚠️ **2026-08-05 范围修订。** 首次执行本 Task 时报 BLOCKED：`git checkout upstream/dev -- client/src/hooks/SSE/` 拿到的新代码依赖大量本 fork 不存在的前端基础设施。实测闭包为 **174 条新增类型错误、37 个缺失导出符号、5 个缺失模块**，横跨 steer / 活动标签 / HITL 审批 / 协议 v2 协商 / usage 统计五个功能域 —— **上游前端 SSE 层已与这些功能深度耦合，无法只取 steer 部分**。决策者裁定：全量对齐。原 Task 7 的内容并入本 Task（状态层是这批基础设施的一部分），后续 Task 编号不变。
>
> 上一次执行的成果保存在 WIP 提交 `cc2326fac`（SSE 目录的自定义贴回 + `getStreamStartFailureText` 的 export 与对象分支修复），**不要丢弃，在其基础上继续**。
>
> ⚠️ 本 Task 是整个计划风险最高的一步。

**必须搬入的缺失模块**（均已确认存在于 `upstream/dev @ b80729299`，可直接 `git checkout upstream/dev -- <path>`）：

```
client/src/utils/steer.ts          client/src/utils/approval.ts
client/src/utils/tokens.ts         client/src/utils/focus.ts
client/src/store/usage.ts          client/src/store/sandbox.ts
client/src/store/steer.ts          client/src/data-provider/SSE/protocol.ts
client/src/hooks/Chat/useSteering.ts        client/src/hooks/Chat/useSteerCancel.ts
client/src/hooks/Chat/useSteerConvert.ts    client/src/hooks/Chat/useFocusRegeneratedResponse.ts
```

**另需向桶文件追加导出**（只加 steer/协议/usage 相关行，**禁止整体覆盖** —— 这些文件含本 fork 自己的导出）：
`client/src/utils/index.ts`、`client/src/store/index.ts`、`client/src/store/families.ts`、`client/src/data-provider/index.ts`、`client/src/data-provider/SSE/queries.ts`、`client/src/utils/messages.ts`

**37 个缺失符号的完整清单**（验收时逐个确认可解析）：
`appendAppliedSteerIds` `applyActivityLabelPart` `applyPendingAction` `applySteerPart` `carriedSteerContext` `collectAppliedSteerIds` `countTaggedApprovalParts` `countTrailingOutputChars` `dedupeSteersById` `DrainAfterAbort` `estimateTokens` `findActivityLabelMessageIndex` `findPendingActionMessageIndex` `findSteerMessageIndex` `generationProtocolHeaders` `GenerationProtocolVersion` `GENERATION_PROTOCOL_VERSION` `getBranchSiblingIndexesForTarget` `getGenerationProtocolVersion` `insertQueuedOrigin` `markStreamStartFailedMetadata` `markTitleGenerationProcessed` `migrateIndex` `normalizeUsageUnits` `PendingSteer` `postGenerationRequest` `QueuedMessage` `QueuedMessageOrigin` `requestChatFocus` `resolveRunEndTarget` `sandboxStartingByToolCallId` `setEntryUsage` `sumBranch` `sumTotalUsage` `supportsGenerationProtocolV2` `upsertEntries`

**建议施工顺序**（叶子优先，每层跑一次 `tsc` 看新增错误数单调下降）：
1. `utils/*`（steer、approval、tokens、focus）与 `store/*`（usage、sandbox、steer）—— 叶子，不依赖 SSE
2. `data-provider/SSE/protocol.ts` 与 `queries.ts` 的增量
3. 桶文件追加导出
4. 最后收 `hooks/SSE/`（在 WIP 基础上）与 `hooks/Chat/` 的四个 steer hooks

**已知结论（首次执行验证，可直接采信，不必重做）**：6 处自定义中 **A3–A5（`finalReceived` 早退）与 B2（project 缓存失效三处）已被上游独立收敛为等价或更完备的实现，无需贴回**；需要手工贴回的只有 **A2/C（`!!` 布尔强制）与 B1/B3（匿名配额弹窗）**。另外上游自带的 `getStreamStartFailureText` 未 export、且对象型 `errorData` 分支跳过文本提取（即"用户看到裸 JSON"的 bug 重现），WIP 提交已修复并补回 6 个单测 —— 保留该修复。

**Files:**
- Overwrite then patch: `client/src/hooks/SSE/useResumableSSE.ts`、`useEventHandlers.ts`、`useSSE.ts`
- Overwrite: `client/src/hooks/SSE/` 下其余文件与 `__tests__`

**Interfaces:**
- Consumes: Task 5 的 steer 端点
- Produces: 支持 steer 事件（`on_steer_applied`）的 SSE 层；`getStreamStartFailureText` 保持导出（其他模块可能引用）

- [ ] **Step 1: 先把我们的自定义存成补丁，作为对照物**

```bash
cd /data/lidongyu/projects/LibreChat
git diff $(git merge-base main upstream/dev) main -- client/src/hooks/SSE/ > /tmp/our-sse-customizations.patch
wc -l /tmp/our-sse-customizations.patch
```

- [ ] **Step 2: 取上游整个 SSE 目录**

```bash
git checkout upstream/dev -- client/src/hooks/SSE/
```

- [ ] **Step 3: 贴回 A1–A5（`useResumableSSE.ts`）**

按本计划 A 节逐条施工。完成后自检：

```bash
grep -c "getStreamStartFailureText" client/src/hooks/SSE/useResumableSSE.ts
grep -c "finalReceived" client/src/hooks/SSE/useResumableSSE.ts
grep -c '!!startupConfig?.balance?.enabled' client/src/hooks/SSE/useResumableSSE.ts
```
Expected: 依次为 ≥1、≥4、1。

- [ ] **Step 4: 贴回 B1–B3（`useEventHandlers.ts`）与 C（`useSSE.ts`）**

按本计划 B、C 节逐条施工。完成后自检：

```bash
grep -c "setGuestUpgradeModalOpen" client/src/hooks/SSE/useEventHandlers.ts
grep -c "chatProjectId" client/src/hooks/SSE/useEventHandlers.ts
grep -c "upgrade_required_quota" client/src/hooks/SSE/useEventHandlers.ts
grep -c '!!startupConfig?.balance?.enabled' client/src/hooks/SSE/useSSE.ts
```
Expected: 依次为 ≥2、≥3、1、1。

- [ ] **Step 5: 类型检查与前端测试**

```bash
cd /data/lidongyu/projects/LibreChat && npm run build 2>&1 | grep -E "error TS" | head -20
cd /data/lidongyu/projects/LibreChat/client && npx jest src/hooks/SSE 2>&1 | tail -40
```
Expected: 无 TS 错误；SSE 测试全绿。

- [ ] **Step 6: 手工验证三条自定义行为仍然有效**

启动前后端后逐条验证：
1. **匿名配额弹窗** —— 未登录访问，连发 4 条消息，第 4 条应弹出 GuestUpgradeModal（而非只有内联错误）
2. **project 缓存刷新** —— 在某个 project 下新建对话并发消息，侧栏该 project 的对话计数应即时更新
3. **流启动错误文案** —— 临时把 `chatchat.yaml` 里某个 endpoint 的 apiKey 改成无效值，发消息应看到可读错误文案而非裸 JSON（验证后改回）

- [ ] **Step 7: 提交**

```bash
git add client/src/hooks/SSE/
git commit -m "chore(sse): align SSE hooks with upstream and restore local customizations"
```

---

## Task 7: 已并入 Task 6

见 Task 6 开头的范围修订说明。状态层（`store/steer.ts`、`utils/steer.ts`、四个 steer hooks、`data-provider/SSE/mutations.ts`）是 SSE 层的编译前置依赖，无法分开交付。后续 Task 编号保持不变。

---

## Task 8: 前端 steer UI 组件

> ⚠️ `ChatForm.tsx` 与 `useTextarea.ts` 双方都改过，必须手工合并。

**Files:**
- Create: `client/src/components/Chat/Input/{InFlightSteers,InterruptSteerButton,PendingSteerChips,SteerMenu}.tsx` + `__tests__`
- Create: `client/src/components/Chat/Messages/Content/Parts/SteerPart.tsx` + 测试
- Modify: `client/src/components/Chat/Input/ChatForm.tsx`（上游 +18/-，我们 +5/-1）
- Modify: `client/src/hooks/Input/useTextarea.ts`（上游改 130 行，我们 +12/-5）
- Create: `client/src/hooks/Input/useComposerBindings.ts`
- Modify: `client/src/components/Chat/Messages/Content/Part.tsx`（注册 SteerPart 分支）
- Modify: `client/src/components/Chat/Messages/Content/Parts/index.ts`（导出 SteerPart）
- Modify: `client/src/components/Chat/Messages/Content/Parts/AuthorHeader.tsx`（steer 作者标识）
- Modify: `client/src/components/Endpoints/Icon.tsx`（steer 图标分支）

**Interfaces:**
- Consumes: Task 7 的 `useSteering` / `useSteerCancel` / `useSteerConvert` / steer atoms
- Produces: 完整可交互的 steer UI

- [ ] **Step 1: 取上游全新组件（这些我们没有，可直接取）**

```bash
cd /data/lidongyu/projects/LibreChat
git checkout upstream/dev -- client/src/components/Chat/Input/InFlightSteers.tsx client/src/components/Chat/Input/InterruptSteerButton.tsx client/src/components/Chat/Input/PendingSteerChips.tsx client/src/components/Chat/Input/SteerMenu.tsx
git checkout upstream/dev -- client/src/components/Chat/Input/__tests__/InFlightSteers.test.tsx client/src/components/Chat/Input/__tests__/PendingSteerChips.test.tsx
git checkout upstream/dev -- client/src/components/Chat/Messages/Content/Parts/SteerPart.tsx client/src/components/Chat/Messages/Content/Parts/__tests__/SteerPart.test.tsx
git checkout upstream/dev -- client/src/hooks/Input/useComposerBindings.ts
```

- [ ] **Step 2: 先记录我们对 ChatForm 与 useTextarea 的自定义，再手工合并**

```bash
git diff $(git merge-base main upstream/dev) main -- client/src/components/Chat/Input/ChatForm.tsx client/src/hooks/Input/useTextarea.ts > /tmp/our-composer-customizations.patch
cat /tmp/our-composer-customizations.patch
git diff main:client/src/components/Chat/Input/ChatForm.tsx upstream/dev:client/src/components/Chat/Input/ChatForm.tsx
git diff main:client/src/hooks/Input/useTextarea.ts upstream/dev:client/src/hooks/Input/useTextarea.ts
```
把上游的 steer 相关改动叠加进我们的版本，我们的自定义一行不丢。合并后重新 `cat /tmp/our-composer-customizations.patch` 逐条核对。

- [ ] **Step 3: 把 SteerPart 接进四个引用点**

上游共有四个文件引用 `SteerPart`，逐个 diff 后只把 steer 相关行合进我们的版本：

```bash
git diff main:client/src/components/Chat/Messages/Content/Part.tsx upstream/dev:client/src/components/Chat/Messages/Content/Part.tsx | grep -iE '^\+.*steer'
git diff main:client/src/components/Chat/Messages/Content/Parts/index.ts upstream/dev:client/src/components/Chat/Messages/Content/Parts/index.ts | grep -iE '^\+.*steer'
git diff main:client/src/components/Chat/Messages/Content/Parts/AuthorHeader.tsx upstream/dev:client/src/components/Chat/Messages/Content/Parts/AuthorHeader.tsx | grep -iE '^\+.*steer'
git diff main:client/src/components/Endpoints/Icon.tsx upstream/dev:client/src/components/Endpoints/Icon.tsx | grep -iE '^\+.*steer'
```

合完自检，四个文件都应命中：

```bash
grep -l "SteerPart\|steer" client/src/components/Chat/Messages/Content/Part.tsx client/src/components/Chat/Messages/Content/Parts/index.ts client/src/components/Chat/Messages/Content/Parts/AuthorHeader.tsx client/src/components/Endpoints/Icon.tsx
```
Expected: 四个路径全部输出。

- [ ] **Step 4: 类型检查与组件测试**

```bash
cd /data/lidongyu/projects/LibreChat && npm run build 2>&1 | grep -E "error TS" | head -20
cd /data/lidongyu/projects/LibreChat/client && npx jest src/components/Chat/Input src/components/Chat/Messages/Content/Parts 2>&1 | tail -40
```
Expected: 无 TS 错误；测试全绿。

- [ ] **Step 5: 提交**

```bash
git add client/src/components/Chat/ client/src/hooks/Input/
git commit -m "feat(steer): add in-flight steer UI components and composer bindings"
```

---

## Task 9: 设置项、快捷键挂载与本地化

> **2026-08-05 范围调整**：`client/src/utils/shortcuts.ts` 与 `client/src/hooks/useKeyboardShortcuts.ts` **已在 Task 8 提前搬入**（`useTextarea.ts` 的编译依赖，两文件与上游逐字节一致，各自的上游 spec 也已跑过：`shortcuts.spec.ts` 53/53、`useKeyboardShortcuts.spec.tsx` 29/29）。本 Task 的实际剩余范围是三件事：
>
> 1. **挂载全局快捷键框架** —— `useKeyboardShortcuts` 的默认导出（全局 keydown 监听）目前**从未被挂载**，整套框架处于 inert 状态。挂载时注意：它会一并启用 `newChat` / `toggleSidebar` / `focusSearch` 等一批与 steer 无关的快捷键，需确认这些不与本 fork 既有交互冲突。
> 2. **设置项注册** —— `client/src/store/settings.ts` 的两个 steer 相关 atom 已在 Task 8 随 `store/misc.ts` 合并时处理，本 Task 负责把设置项接进 `client/src/components/Nav/Settings/registry.tsx`。
> 3. **补全 30 个缺失的 `com_shortcut_*` key**（Task 8 审查 M-1）—— 如 `com_shortcut_submit_message` / `com_shortcut_group_chat` 等。它们目前不可见（只被未挂载的快捷键设置弹窗消费），但**一旦第 1 项挂载就会立刻暴露为缺失文案**。
>
> **必办复查项**：挂载完成后回头看 Task 8 遗留的 I-4 —— `SteerMenu.tsx:249` 的 `aria-keyshortcuts` 会向读屏用户播报 `Control+Shift+.`（escalateSteer），在框架未挂载时那是个按了没反应的假承诺。挂载后该播报即成真实，与上游自带 `PendingSteerChips.test.tsx` 中"hover 激活时播报快捷键"断言的冲突自然消失。**若本 Task 最终决定不挂载全局框架，必须回头单独处理 I-4，且禁止为此新建自研的「是否已挂载」信号。**

**Files:**
- Modify: `client/src/store/settings.ts`（steer 默认行为设置）
- Modify: `client/src/components/Nav/Settings/registry.tsx`（设置项注册）
- Modify: `client/src/hooks/useKeyboardShortcuts.ts`、`client/src/utils/shortcuts.ts` + `shortcuts.spec.ts`
- Modify: `client/src/locales/en/translation.json`

**Interfaces:**
- Consumes: Task 7 的 steer atoms、Task 8 的 UI
- Produces: 用户可配置的 steer/queue 默认行为与键盘快捷键

- [ ] **Step 1: 逐个 diff 并手工合并 steer 相关行**

```bash
cd /data/lidongyu/projects/LibreChat
git diff main:client/src/store/settings.ts upstream/dev:client/src/store/settings.ts | grep -iE '^\+.*(steer|preempt|interrupt)'
git diff main:client/src/components/Nav/Settings/registry.tsx upstream/dev:client/src/components/Nav/Settings/registry.tsx | grep -iE '^\+.*(steer|preempt|interrupt)'
git diff main:client/src/hooks/useKeyboardShortcuts.ts upstream/dev:client/src/hooks/useKeyboardShortcuts.ts
git diff main:client/src/utils/shortcuts.ts upstream/dev:client/src/utils/shortcuts.ts
```

- [ ] **Step 2: 补齐英文文案**

```bash
git diff main:client/src/locales/en/translation.json upstream/dev:client/src/locales/en/translation.json | grep -iE '^\+.*(steer|interrupt|queue)'
```
把匹配到的 key 加进我们的 `en/translation.json`。**只改英文文件**，其他语言由外部流程自动同步。

- [ ] **Step 3: 取上游快捷键测试并运行**

```bash
git checkout upstream/dev -- client/src/utils/shortcuts.spec.ts
cd /data/lidongyu/projects/LibreChat/client && npx jest src/utils/shortcuts 2>&1 | tail -20
```
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add client/src/store/settings.ts client/src/components/Nav/Settings/registry.tsx client/src/hooks/useKeyboardShortcuts.ts client/src/utils/shortcuts.ts client/src/utils/shortcuts.spec.ts client/src/locales/en/translation.json
git commit -m "feat(steer): add steer settings, shortcuts and English copy"
```

---

## Task 10: 全量回归与端到端验证

**Files:**
- Modify: `docs/superpowers/plans/regression-baseline-steer.md`（补合并后一列）

**Interfaces:**
- Consumes: Task 1 的基准、Task 2–9 的全部产出
- Produces: 可合并到 main 的分支

- [ ] **Step 1: 跑全量测试，与 Task 1 基准逐 workspace 对比**

```bash
cd /data/lidongyu/projects/LibreChat/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -30
cd /data/lidongyu/projects/LibreChat/packages/api && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -30
cd /data/lidongyu/projects/LibreChat/packages/data-schemas && LD_LIBRARY_PATH="$HOME/.local/ssl1.1/usr/lib/x86_64-linux-gnu" MONGOMS_VERSION=4.4.18 npx jest 2>&1 | tail -30
cd /data/lidongyu/projects/LibreChat/packages/data-provider && npx jest 2>&1 | tail -20
cd /data/lidongyu/projects/LibreChat/client && npx jest 2>&1 | tail -30
```
Expected: 失败集合 ⊆ Task 1 记录的既有失败。**任何新增失败都是阻塞项。**

- [ ] **Step 2: 全量构建 + lint**

```bash
cd /data/lidongyu/projects/LibreChat && npm run build 2>&1 | tail -20
npx eslint client/src/hooks/SSE client/src/components/Chat/Input client/src/store api/server/controllers/agents packages/api/src/stream packages/api/src/agents/steering 2>&1 | tail -30
```
Expected: 构建成功；lint 零 error 零 warning。

- [ ] **Step 3: 端到端手工验证（逐条打勾）**

启动前后端，逐条验证：

**Steer 核心路径**
1. 发一条会长时间生成的消息（例如「写一篇 2000 字的文章」），生成过程中再发一条「改成用中文写」→ 应看到 steer chip，且 AI 在**同一条回答**里接住新指示继续写，之前的内容保留
2. 生成过程中发消息但选择「排队」→ 本轮结束后自动作为新一轮发出
3. 生成过程中发 steer 后点取消 → chip 消失，不影响本轮生成
4. steer 过的对话刷新页面 → steer 内容作为用户消息正确重放
5. 分享该对话 → 分享页能正确渲染含 steer 的消息

**我们的自定义未回归**
6. 未登录连发 4 条消息 → 第 4 条弹出 GuestUpgradeModal
7. 在 project 下新建对话发消息 → 侧栏该 project 计数即时更新
8. 记忆功能正常（对话中提到个人偏好，下一轮 AI 记得）
9. 图像生成正常
10. 中途点停止能正常中断，历史保留

- [ ] **Step 4: 更新基准文档并提交**

在 `regression-baseline-steer.md` 补一列「合并后」，写入实际数字与第 3 步的逐条结论。

```bash
git add docs/superpowers/plans/regression-baseline-steer.md
git commit -m "docs: record post-merge regression results for steer merge"
```

- [ ] **Step 5: 推送并开 PR**

```bash
git push -u origin feat/upstream-interrupt-steer
gh pr create --repo Gevtolev/ChatChat --title "feat: merge upstream Interrupt & Steer" --body "$(cat <<'EOF'
## Summary
Ports upstream LibreChat's Interrupt & Steer to ChatChat: users can send a message while a response is generating and the model picks it up mid-stream, keeping partial output.

## Scope
- Upgrade `@librechat/agents` 3.2.62 → 3.3.11
- Align `packages/api/src/stream/` with upstream (we had zero local changes there)
- Add steering module, generation protocol, steer controller and routes
- Align `client/src/hooks/SSE/` with upstream and restore all 6 local customizations
- Add steer state layer, UI components, settings, shortcuts and English copy

## Preserved customizations
- `getStreamStartFailureText` (readable stream-start errors)
- Guest quota upgrade modal on `upgrade_required_quota`
- Project cache invalidation on `chatProjectId`
- Balance query enabled-flag coercion
- Memory keyed/unkeyed context split in agents client

## Testing
See `docs/superpowers/plans/regression-baseline-steer.md` for before/after test counts and the manual E2E checklist.
EOF
)"
```

---

## 分批交付断点

本计划可在两处安全停下并交付：

- **Task 3 结束后** —— 后端 stream 子系统已对齐上游、SDK 已升级，此时没有任何 steer 功能，但基座变新。可单独合入 main，把后续 steer 工作留到之后。
- **Task 6 结束后** —— 前后端基座全部对齐，steer 后端可用但前端无入口。**不建议**停在这里对外发布（用户看不到功能却承担了全部回归风险），但作为一个可评审的中间点是合理的。

Task 7–9 必须连续完成，中途停下会留下半截 UI。

---

## Task 11: `useChatHelpers` abort 链（前端）

> **2026-08-05 新增**，决策者要求补齐。端到端实测坐实：Alt+Enter（interrupt-and-send）只完成了"打断"，"发送"那一半断掉——文字变成挂着的 chip 等人手点 "Send now"。根因是 `client/src/hooks/Chat/useChatHelpers.ts` 与上游差 **203 行**，缺失部分正是 abort 后的 steer 回收链。

**缺失清单**（对拍 `git diff HEAD:client/src/hooks/Chat/useChatHelpers.ts upstream/dev:client/src/hooks/Chat/useChatHelpers.ts` 确认）：
- `client/src/hooks/Chat/abort.ts` 与 `useAbortCleanup`（约 36 行）
- `signalInterruptDrain` / `clearInterruptDrain`
- `stopGenerating` 里的 epoch 守卫
- 从 abort 响应中回收 `pendingSteers` 的整段逻辑
- 上游自带 `client/src/hooks/Chat/__tests__/abort.spec.tsx`（464 行）

**验收**：Alt+Enter 在生成中触发后，文字应作为新一轮**自动发出**（而非停在 chip）；Ctrl+Shift+Enter（interruptSteer）同理。**必须补一个能复现当前缺陷的测试**——先红后绿，并回退验证红是真红。

---

## Task 12: `/api/files/usage` 路由与 `extendFilesTTL`（后端）

> **2026-08-05 新增**。前端 `useMarkQueuedFilesUsage` 已就绪但被 `filesUsageBackendAvailable = false` 常量短路（Task 6 修复轮所加），因为该路由不存在。

**两个必须一起做的部分**：
1. `POST /api/files/usage` 路由 + `extendFilesTTL` 实现（对拍上游 `handleFilesUsageRequest`）
2. 落地后**删除** `client/src/hooks/Chat/useSteering.ts` 的 `filesUsageBackendAvailable` 短路常量，并把 `useSteering.spec.tsx` 里那两条断言**改回**期望恰好一次 `markFilesUsage` 调用（当前断言为 `not.toHaveBeenCalled()`，注释里已写明恢复方法）

**背景**：本 fork `packages/data-schemas/src/schema/file.ts` 有 `expiresAt` + `expires: 3600`（Mongo TTL 1 小时）。不补则排队消息的附件超过 1 小时会被回收，消息带着悬空 file 引用发出。另注意 `api/server/routes/files/index.js` 对该路径下所有 POST 套了限流。

---

## Task 13: 三个 override 字段的端到端打通（前后端）

> **2026-08-05 新增**。Task 8 采用 B 方案时**故意**没透传 `clientRequestId` / `recoverySteerId` / `expectedPredecessorCreatedAt`，因为消费端在后端而后端从不读。现在两端一起补。**只做后端或只做前端都无意义，必须一起。**

- **后端**：`api/server/controllers/agents/request.js` 读 `req.body` 的这三个字段。**下游基础设施已就绪**——`packages/api/src/stream/GenerationJobManager.ts` 的 `generationClaimKey` / `legacyGenerationClaimKey` 等幂等设施是 Task 2 升 SDK 时白捡的，只差读取这几行。
- **前端**：`ChatForm.tsx` 的 `sendNow` 目前只转发 `manualSkills`，其余静默丢弃；`useChatFunctions.ts` 的 `ask()` 需按上游把 `recoverySteerId` 转成 `overrideUserMessageId`（该字段在 `TAskProps` 上已存在）。

**收益**：排队/回收发送获得幂等去重（避免网络重试产生重复消息）与正确的续投语义。**当前缺失导致的具体故障**：恢复态队列消息二次发送失败时，`useResumableSSE.ts:2731-2757` 的恢复分支因 `submission.recoverySteerId` 恒 undefined 而永不进入，**用户文本静默丢失**。

---

## Task 14: `KeyboardDeleteDialog`（前端）

> **2026-08-05 新增**。Task 9 已移植 `KeyboardShortcutsDialog`/`ShortcutRecorder`/`ShortcutKeyCombo`，唯独这个未移植——真实阻塞是本 fork `DeleteButton.tsx` 的 `DeleteButtonProps` 缺 `currentConversationId`（上游有），逐字节搬运会触发 TS 多余属性检查报错。

需要：给 `DeleteButton.tsx` 加该 prop 并透传进 `DeleteConversationDialog`，再移植 `KeyboardDeleteDialog.tsx`（34 行）并在 `Root.tsx` 的 `KeyboardShortcutsProvider` 中渲染。完成后 `keyboardDeleteTarget` atom 才有消费方（当前写入后永无消费者）。同时更新 `Root.tsx` 那段 JSDoc。

---

## Task 16: 生成协议 v2 协商（`request.js` 接 `protocol.js`）

> **2026-08-05 新增**，决策者批准。这是 Interrupt & Steer 工作的收尾项，在独立分支 `feat/steer-protocol-v2` 上做（基于 `feat/upstream-interrupt-steer`，PR #30 之上的 stacked PR）。

**问题**：`api/server/controllers/agents/request.js` 对 `protocol.js` **零引用**，协商从未发生，生成协议永远退回 v1。实测前端有 **21 处 v2-only 分支**（`useResumableSSE.ts` 18 处 + `useSteering.ts` 3 处）全是死代码。

**三个具体后果**：
1. **无 `clientSteerId` 回执** —— `useSteering.ts:479-493` 靠回执把 steer 从「待确认」划掉。没有它，客户端只能靠 202 判断成功，**移动网络下 202 丢包 → 用户重按 → 服务端收到两条**。
2. **恢复态 steer 认不出** —— `useSteering.ts:695` 用 `recoveryClientSteerId` 匹配「这条被 park 的 steer 就是我之前那条」。Task 13 正是卡在这里（接 parked-steer payload 消费要求 v2 已协商，硬接会 100% 抛错）。
3. **收不到 `on_steer_updated`** —— steer 状态变化无实时反馈。

**上游做法**（对拍 `git show upstream/dev:api/server/controllers/agents/request.js`）：

```js
const { GENERATION_PROTOCOL_HEADER, negotiateNewGenerationProtocol,
        negotiateExistingGenerationProtocol } = require('./protocol');

function sendGenerationJson(res, status, body, generationProtocolVersion) {
  res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  return res.status(status).json({ ...body, generationProtocolVersion });
}
```

上游把**所有响应出口**换成 `sendGenerationJson`；新生成走 `negotiateNewGenerationProtocol`，已存在的走 `negotiateExistingGenerationProtocol`，协商结果写进 job metadata（`getJobGenerationProtocol` 从那儿读）。

**环境事实**：`getServerGenerationProtocol` 在**无 Redis 时返回 V2**、有 Redis 时返回 V1（除非 `GENERATION_PROTOCOL_VERSION` 覆盖）。上游这个保守默认是为多实例滚动升级设计的；**我们生产是 Coolify 单容器，该顾虑不成立**，上线时可安全设 `GENERATION_PROTOCOL_VERSION=2`。本地开发无 Redis，接上后立刻是 v2，可即时真机验证。

**风险**：高于此前所有任务 —— 改的是 `request.js` **所有响应出口**，那是每次对话的必经之路。缓解：上游有完整实现可逐字对拍，且本地能立刻端到端验证。

**验收**：start 响应带 `generationProtocolVersion` 且本地为 2；`GENERATION_PROTOCOL_HEADER` 正确下发；前端 v2 分支激活（`clientSteerId` 回执可见）；五 workspace 失败集合 ⊆ 基准。
