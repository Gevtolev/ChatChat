# Interrupt & Steer 合并回归基准

基线 commit: 5e72ef4c88d8c78a376c970f7502caa88a1cf306
上游目标: upstream/dev @ b80729299
合并后 commit: af91ed004（Task 10 回归时的 HEAD，相对基线共 22 个提交）

| workspace | 合并前 | 合并后 |
|---|---|---|
| api | Tests: 2395 passed, 11 failed, 1 skipped, 2407 total | Tests: 2421 passed, 11 failed, 1 skipped, 2433 total |
| packages/api | Tests: 5594 passed, 3 failed, 43 skipped, 5640 total | Tests: 6470 passed, 3 failed, 51 skipped, 6524 total |
| packages/data-schemas | Tests: 1554 passed, 0 failed, 1554 total | Tests: 1554 passed, 0 failed, 1554 total |
| packages/data-provider | Tests: 1124 passed, 0 failed, 1 skipped, 1125 total | Tests: 1135 passed, 0 failed, 1 skipped, 1136 total |
| client | Tests: 2387 passed, 18 failed, 2405 total | Tests: 2847 passed, 18 failed, 2865 total |

**逐条对比结论：**

- **api**：失败集合与合并前完全一致（仍是同一批 `responses.spec.js` 里的 11 个 Open Responses 集成测试）。总数从 2407 → 2433（+26 passed），来自本次为 steer 功能新增的测试（`api/server/controllers/agents/__tests__/steer.spec.js`、`client.steerWiring.spec.js`、`request.steerTerminalRecovery.spec.js`）。首次全量跑时曾出现 15 failed（多出的 4 个来自 `server/services/Config/loadAsyncEndpoints.spec.js`，报 `PrincipalType.USER` undefined），原因是该次运行与 `npm run build` 并行争抢了机器资源；单独隔离重跑该文件 4/4 全绿，随后单独重跑整个 `api` workspace（不与其他任务并行）稳定复现 11 failed，与基准一致，判定为已知的并发 flake，不计入回归。
- **packages/api**：失败集合与合并前完全一致（`models.spec.ts` 的默认 Anthropic 模型列表断言过期、`summarization.e2e.test.ts` 的 2 个 `--experimental-vm-modules` 相关用例），外加同样的 3 个 Redis 集成测试套件进程级崩溃（本机无 Redis 服务）。总数从 5640 → 6524（+884 total，其中 651 来自本次为 `packages/api/src/stream/` 与 `packages/api/src/agents/steering/` 新增的测试文件），skipped 从 43 → 51（新测试里新增的 skip 用例）。
- **packages/data-schemas**：合并前后完全一致，1554/1554 全绿，无回归。
- **packages/data-provider**：0 failed，总数从 1125 → 1136（+11 passed），来自本次新增的 steer 相关类型/工具函数测试。无回归。
- **client**：失败集合与合并前完全一致（`ImageGallery.spec.tsx` + `ImageWorkspace.spec.tsx` 共 18 个用例，均因 `useGetStartupConfig is not a function` 的过期 mock，与本次 steer 功能无关）。总数从 2405 → 2865（+460 total），来自 SSE hooks 全量对齐产生的新增/扩写测试（`useResumableSSE.spec.ts`、`useStepHandler.spec.ts`、`useResumeOnLoad.spec.tsx` 等）以及 steer UI 组件测试（`DuringRunSendButton.test.tsx`、`InFlightSteers.test.tsx`、`PendingSteerChips.test.tsx`）。`UploadSkillDialog.spec.tsx` 已知并发 flake本轮未触发（未出现在失败列表中）。

合并前已存在的失败用例（这些不算回归）：

**api**（`server/routes/agents/__tests__/responses.spec.js`，全部因 `expect(response.status).toBe(200)` 收到 500 或类似断言失败，Open Responses API 集成测试与真实/mock 后端行为不一致）：
- Open Responses API Integration Tests › Compliance Tests › basic-response › should return a valid ResponseResource for a simple text request
- Open Responses API Integration Tests › Compliance Tests › streaming-response › should return valid SSE streaming events
- Open Responses API Integration Tests › Compliance Tests › streaming-response › should include logprobs array in output_text events
- Open Responses API Integration Tests › Compliance Tests › system-prompt › should handle developer role messages in input (as system)
- Open Responses API Integration Tests › Compliance Tests › multi-turn › should handle multi-turn conversation history
- Open Responses API Integration Tests › Compliance Tests › string-input › should accept simple string input
- Open Responses API Integration Tests › Extended Thinking › should return reasoning output when thinking is enabled
- Open Responses API Integration Tests › Extended Thinking › should stream reasoning events when thinking is enabled
- Open Responses API Integration Tests › Schema Validation › should include all required fields in response
- Open Responses API Integration Tests › Schema Validation › should have valid message item structure
- Open Responses API Integration Tests › Response Storage › should store response when store: true and retrieve it

**packages/api**：
- `src/endpoints/models.spec.ts` › getAnthropicModels › returns default models when ANTHROPIC_MODELS is not set（期望的默认 Anthropic 模型列表与代码里维护的默认模型清单已经不同步，测试数据过期）
- `src/agents/__tests__/summarization.e2e.test.ts` › Anthropic Summarization E2E (LibreChat) › multi-turn triggers summarization, summary persists across runs（`TypeError: A dynamic import callback was invoked without --experimental-vm-modules`）
- `src/agents/__tests__/summarization.e2e.test.ts` › Anthropic Summarization E2E (LibreChat) › tight context (maxContextTokens=200) does not infinite-loop（同上，`--experimental-vm-modules` 相关）
- 另有 3 个测试套件整体崩溃（不计入上面的 Tests 计数，因为一个测试都没跑起来）：`src/mcp/registry/cache/__tests__/ServerConfigsCacheRedis.cache_integration.spec.ts`、`src/mcp/registry/cache/__tests__/ServerConfigsCacheRedisAggregateKey.cache_integration.spec.ts`、`src/cache/__tests__/redisClients.cache_integration.spec.ts`，均报 `Jest worker encountered 4 child process exceptions, exceeding retry limit`（本机没有可用的 Redis 服务，这几个是 Redis 集成测试）

**client**（`src/components/Images/__tests__/ImageWorkspace.spec.tsx` 与 `ImageGallery.spec.tsx`，全部报 `TypeError: (0 , _dataProvider.useGetStartupConfig) is not a function`，是这两个测试文件里对 `data-provider` 的 mock 已经过期，和本次要合并的 Interrupt & Steer 功能无关）：
- ImageWorkspace › renders prompt textarea and Generate button
- ImageWorkspace › Generate button is disabled when prompt is empty
- ImageWorkspace › Generate button is enabled after entering a prompt
- ImageWorkspace › clicking Generate calls mutate with prompt, default model, and its provider
- ImageWorkspace › shows generating state (spinner) while prediction pending
- ImageWorkspace › clears generating state and invalidates gallery on completed result
- ImageWorkspace › shows error message on failed result
- ImageWorkspace › unlocks the Generate button and shows error when the mutation itself errors
- ImageWorkspace › clears generating state and shows error when useImageResult is in error state (502 backend)
- ImageWorkspace › shows timeout error when poll cap is exceeded (pollCount >= POLL_TIMEOUT_COUNT)
- ImageGallery › renders the section heading
- ImageGallery › shows empty state when there are no images
- ImageGallery › renders thumbnails when images are present
- ImageGallery › does not render Load more button when hasNextPage is false
- ImageGallery › renders Load more button when hasNextPage is true
- ImageGallery › calls fetchNextPage when Load more is clicked
- ImageGallery › disables Load more while fetching next page
- ImageGallery › flattens images across multiple pages

**packages/data-schemas**：无
**packages/data-provider**：无（`request-interceptor.spec.ts` 里有若干 `console.warn` 输出，属于测试预期内触发的日志，不是失败）

## 构建验证

`npm run build`（从仓库根执行）：构建成功，Turborepo 报告 `Tasks: 5 successful, 5 total`，耗时 1m34.093s，退出码 0，无 TypeScript 报错（唯一的 "error" 命中是 `react-virtualized` 的 Rollup 打包警告 "Module level directives cause errors when bundled"，不是构建失败）。

## Task 10 合并后验证（af91ed004）

**构建**：`npm run build`（仓库根）：Turborepo 报告 `Tasks: 5 successful, 5 total`（全部 6 个子包中 5 个纳入 build pipeline，逐一 cache hit），无 `error TS` 命中，构建通过。

**类型检查**：
- `packages/api`：`npx tsc --noEmit -p tsconfig.json` 退出码 0，零报错。
- `client`：`npx tsc --noEmit` 报错行数与合并前基准（`docs/superpowers/plans/client-ts-baseline.txt`）逐条 diff，结果为**零新增**，且减少 2 条（`src/hooks/SSE/__tests__/useAttachmentHandler.spec.tsx` 里两条 `Type 'null' is not assignable to type 'string | undefined'` 在本次 SSE hooks 对齐中被顺带修掉）。`client` 的 `npm run build` 仅是 `vite build`，不做类型检查，故以此 `tsc --noEmit` diff 作为类型证据。

**Lint**：`npx eslint client/src/hooks/SSE client/src/components/Chat/Input client/src/store api/server/controllers/agents packages/api/src/stream packages/api/src/agents/steering` 命中 `8 errors, 3 warnings`，但经与本分支 `git diff 5e72ef4c8..af91ed004 --stat` 逐文件核对，全部命中集中在 3 个本分支**完全未触碰**的文件：`client/src/components/Chat/Input/ActiveSetting.tsx`、`CircleRender.tsx`、`Files/Table/TemplateTable.tsx`（`i18next/no-literal-string` 硬编码字符串 + `no-nested-ternary`，均是 pre-existing、早于本次 fork 就存在于 `main` 的示例/模板组件）。本分支实际改动或新增的所有文件（`ChatForm.tsx`、`DuringRunSendButton.tsx`、`InFlightSteers.tsx`、`PendingSteerChips.tsx`、`SteerMenu.tsx`、`useResumableSSE.ts`、`GenerationJobManager.ts` 等 87 个文件）lint 零 error 零 warning。
