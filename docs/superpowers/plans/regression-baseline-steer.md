# Interrupt & Steer 合并回归基准

基线 commit: 5e72ef4c88d8c78a376c970f7502caa88a1cf306
上游目标: upstream/dev @ b80729299

| workspace | 合并前 |
|---|---|
| api | Tests: 2395 passed, 11 failed, 1 skipped, 2407 total |
| packages/api | Tests: 5594 passed, 3 failed, 43 skipped, 5640 total |
| packages/data-schemas | Tests: 1554 passed, 0 failed, 1554 total |
| packages/data-provider | Tests: 1124 passed, 0 failed, 1 skipped, 1125 total |
| client | Tests: 2387 passed, 18 failed, 2405 total |

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
