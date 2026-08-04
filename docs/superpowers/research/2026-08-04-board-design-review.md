# Board（项目工作台）设计评审结论

> **日期**: 2026-08-04 ｜ **作者**: 小天 ｜ **类型**: 设计评审记录（决策依据，非设计规格）
>
> **结论**: **暂缓**。不做完整 Board，先补可观测性与 beta 启动能力，拿到真实数据后再决定。
>
> **关联**: [second-brain spec（feat/second-brain-notes 分支）](../specs/2026-06-17-graupel-second-brain.md)、[MVP 设计](../specs/2026-05-21-graupel-mvp-design.md)

---

## 一、被评审的方案

把已有的 `chatProject` 从「对话分组」升级成「Board（工作台）」，含三个分区：

| 分区 | 内容 |
|---|---|
| 资料 | 该课题下的所有输入：上传文件、保存的 AI 回答、剪藏网页、手写笔记 |
| 对话 | 属于该 project 的对话（已有） |
| 作品 | 该课题最终产出：文档、报告、图片 |

交互：AI 回答下方「保存到资料」；对话里传过的文件自动进资料区；输入框 `@资料` 带回上下文；project 详情页扩成三个 tab。

核心价值主张：同一个 Board 里的资料，切换任何模型都在。定位：与 Notion/Obsidian **共存，不取代**。

评审方式：三个 agent 并行独立评审（产品视角、工程可行性、商业竞争），互不知晓对方存在。

---

## 二、必须记住的三个事实纠正

评审推翻了提案时的三个事实判断，**后续任何相关决策都要基于纠正后的版本**：

### 1. `chatProject` 是上游代码，不是我们的资产

`packages/data-schemas/src/schema/chatProject.ts` 与 `upstream/dev` **逐字节相同**，来自上游 `#13467 Add Private Chat Projects`，且上游仍在迭代（如 `#13647` 移动端侧栏修复）。

推论：「升级 chatProject」= **在上游最活跃的新功能上做侵入式分叉**。且上游正在做 ChatGPT parity，而「项目文件 / 项目知识库」是 ChatGPT Projects 的核心特性，上游做它的概率评估在 **70% 以上**。届时自研 Board 与上游 project files 正面冲突：合上游要弃自研，留自研就得永久 fork 掉整个 Projects 子系统（schema + methods + handlers + 5 个前端组件）。

### 2. `feat/second-brain-notes` 的「3020 行」是虚数

实际构成：markdown 文档 2121 行 + 代码 899 行（含测试 385 行），核心实现约 500 行。

有效复用率 **12–15%**，且集中在「骨架形状」这种最便宜的部分。逐块判断：

| 模块 | 行数 | 复用率 | 理由 |
|---|---:|---:|---|
| `schema/note.ts` | 38 | 0–10% | `ref: 'Notebook'` 指向不存在的 model；`user: ObjectId` 与 chatProject 的 `user: String` 类型冲突 |
| `types/note.ts` | 88 | ~10% | 仅两个枚举有参考价值 |
| `methods/note.ts` | 99 | ~20% | 三处必须重写：无分页返回全部正文、`$regex` 全集合扫描、删除不清理悬空 links |
| `routes/notes.js` | 86 | ~10% | 业务逻辑写在 JS 路由里（违反「/api 只做薄包装」）；`catch(_error)` 一刀切吞掉原始错误 |
| `notes/ingest.ts` | 83 | ~50%（但大概率用不上） | 唯一有真实工程价值的一块，但与现有 `Files/process.js` 上传管线功能重叠 |
| `notes/caption.ts` | 68 | **0%，直接丢** | 硬编码 `gpt-4.1-mini` + `OPENAI_API_KEY`；生产走 OpenRouter/gptsapi，线上必然静默返回空串 |

**处置：archive 或删除该分支。** 落后 164 commit，rebase 成本已超重写成本；保留只会持续制造「我们已经有一半了」的错觉。

### 3. 「作品区：图像生成已有」是错的

图像生成的 File 记录（`packages/api/src/images/service.ts`）只有 `user` + `context: 'image_generation'` + `metadata.imageGen`，**没有 conversationId，更没有 project 关联**；`/images` 是完全独立的路由。作品 tab 的数据链路目前是空的，需先改生成链路才有内容。

---

## 三、三份评审收敛的五点

三个视角互相独立，但在这五件事上完全一致：

1. **完整三分区 Board 不做** —— 工程实测 120–150 小时（12–15 周），吞掉整个 beta 窗口
2. **`@资料` 是错的**
   - 产品侧：opt-in 检索必死。用户要先记得存过、再记得 @、再选对哪份；而 @ 一次的成本 ≈ 重新拖个文件的成本，于是「存」的价值 ≈ 0。（对照：我们自己的 Memory Agent 就是自动注入的）
   - 工程侧：`@` 在 LibreChat 里是**模型切换器** —— `useSelectMention.ts` 六个分支终点全是 `newConversation`；且 `useHandleKeyUp.ts` 里 `@` **只在输入框第 0 个字符触发**，句中用法今天根本不成立。改它要动 `@`/`+`/`/`/`$` 四命令共用的函数。
   - **正确做法**：回形针附件菜单里选「本项目资料」，写入 Recoil `files` Map。约 4 小时，对比 `@` 路线 20 小时起步且带上游冲突。
3. **作品区移出 P0**
4. **不新建 Note collection** —— 现存已有四套「文件真相源」（File、agent tool_resources、MemoryEntry、图像产物），加 Note 是第五套，且要重新实现删除级联、配额计费、保留期清扫、**S3 签名刷新**、`deleteUser` 级联 —— 每条漏一个就是线上事故。改成「资料 = 打了 `chatProjectId` 标签的 File 记录」，这些全部免费继承。
5. **`feat/second-brain-notes` archive**

### 附带抓到的致命盲区

新会话在第一条消息发出前 `conversationId === Constants.NEW_CONVO`，此时上传的文件**不带 conversationId**（`client/src/hooks/Files/useFileHandling.ts`）。而「进项目 → 开新对话 → 拖 PDF → 提问」恰是主路径。若按「事后 join conversation 找 project」实现，主路径上的文件**全部静默丢失**。

**正确做法**：上传时直接 `formData.append('chatProjectId', ...)`，后端落库，不依赖 conversationId。

---

## 四、分歧与最终判断

三份的唯一分歧：现在做缩小版，还是先做别的。

- **商业**：先做 UsageLog 成本可见度，Board 延后到有数据
- **产品**：先开 beta 拿 4 周数据；若一定要做，做 20–30h 的 Project Context
- **工程**：37h 可行，但四个前置条件，第一条是**先做完 416 commit 的上游同步**

**判断：现在不做 Board。** 三条独立论证指向同一方向：

1. **工程**：先做上游同步本身就是一大块；且有 70% 概率在给一个上游三个月后会自带的功能造轮子
2. **商业**：Board 是**输入 token 乘数**（挂 15 个文档，单条消息成本可能是裸对话的 3–10 倍），而我们对每用户成本零可见度 —— 等于在没有对冲的 $29.99 无限量结构上再加一个成本乘数
3. **产品**：整个方案的地基是 project 采纳率，而那是零数据假设（尚未开放注册，且聊天产品里「文件夹」采纳率历来 <20%）

---

## 五、决定的优先级顺序

| 顺序 | 事项 | 估时 | 理由 |
|---|---|---:|---|
| 1 | **UsageLog + 每用户成本看板** | 8–12h | 唯一「不做会出财务事故」的项。$29.99 flat + 顶级模型 + 零成本可见度 = 卖一份没有对冲的看跌期权 |
| 2 | **PostHog 埋点** | 4–8h | 没有它，后续所有功能决策都是盲投，包括 Board 该不该做 |
| 3 | **邀请码/allowlist + 开通 Pro 脚本 + Sentry** | 6–12h | 让 beta 能开、不崩。20–50 人的 beta **不需要完整 Admin API**，一个脚本够 |
| 4 | 开 invite-only beta，跑 4 周 | — | 观测三个数字（见下） |
| 5 | 依数据决定下一个功能 | — | 候选见第六节 |

注：**邮件魔链登录不是 beta 硬阻塞**（Google/GitHub OAuth 已能发邀请），它是转化率优化项。在还不知道漏斗形状之前优化转化，顺序是反的。

### beta 期必须观测的三个数字

1. 建过 project 的用户占比
2. 每 project 的对话数 / 文件数分布
3. 同一用户一周内切换模型的次数与模式

---

## 六、重启 Board 的判定门槛

**若下列条件不满足，不要再往 Board 方向投一小时**（提前写下，避免第三次沉没成本陷阱）：

1. beta 稳定运行 ≥6 周、≥30 名周活用户
2. 单用户毛利率 ≥60%，且已有限额机制能吸收上下文注入带来的成本上升
3. 以下至少满足两条：
   - 周活用户中 ≥40% 使用了对话分组
   - 挂载了项目附件的用户，7 日留存显著高于未挂载组（≥15pp）
   - 用户主动反馈中「持续上下文 / 资料复用」进入 top-3
   - 流失访谈中「材料没地方放」被独立提及 ≥3 次

**kill 指标**：上线 4 周后若 project 平均来源数 < 2，或有来源的 project 占比 < 25%，立刻停手。

### 若门槛达成，P0 应该是这个形态（37h）

「项目资料 = 打了 `chatProjectId` 的 File 记录」，一条端到端闭环：

| # | 任务 | 工时 |
|---|---|---:|
| 1 | `schema/file.ts` + types 加 `chatProjectId` + 复合索引 | 2h |
| 2 | 上传链路带 `chatProjectId`（前端 append + 后端落库） | 3h |
| 3 | `listProjectMaterials` cursor 分页 + handler + 挂路由 | 5h |
| 4 | `ProjectWorkspace.tsx` 拆「资料 / 对话」两 tab + 资料列表 | 7h |
| 5 | 「附加到本轮对话」：选中 → 写 Recoil `files` Map | 4h |
| 6 | 「保存 AI 回答到资料」：建 `source: text` 的 File 记录 | 5h |
| 7 | 测试（mongodb-memory-server） | 6h |
| 8 | i18n、回归、上游冲突体检 | 5h |

**四个前置条件，缺一不可**：

1. 先做完上游同步，再动 Projects 区域
2. 不新建 Note collection
3. `@资料` 改为附件菜单入口，不碰 `useSelectMention` / `useHandleKeyUp`
4. 作品 tab 移出 P0

**明确排除**：剪藏网页、手写笔记编辑器、作品 tab、多模态 ingest、`@资料`。

---

## 七、另一个候选方向（未经代码验证）

**跨模型对话**：同一线程中途换模型继续说、「用另一个模型重答这条」、双栏对比。

理由：这是 ChatGPT / Claude **结构上给不了**的（他们只有自家模型），直接兑现 "One subscription. All top AI models." 这句承诺，天然高频、**零冷启动**，可做成落地页主视觉和 demo。产品视角估 10–15h 且认为 LibreChat 底层基本已有。

⚠️ **该估时未经代码验证**，可信度低于工程评审给出的 37h。若要选这个方向，需先做一次代码可行性核查。

---

## 八、其他记账项

- **命名**：若将来做资料层，不要叫「笔记 / 资料」—— 那会自动进入 Notion/Obsidian 心智赛道。叫「上下文 / 工作集 / 附件」，任务绑定、可抛弃、不承诺长期保存。
- **导出**：没有导出功能的知识库，用户不会往里放重要东西（订阅制私有仓，退订即失；对照 llm_wiki 写本地 markdown 零风险）。结果是用户只放无所谓的东西，数据难看，我们还会误判成「用户不需要」。导出按钮成本极低，必须有。
- **安全（P1 记账，不在 P0 修）**：`packages/data-schemas/src/methods/file.ts` 的 `updateFilesUsage` 不校验 file 归属，只按 `file_id` 更新，靠 UUID 不可猜测防护。资料区会把 `file_id` 更广泛暴露到前端列表，**放大**这个面。资料列表接口必须有 `user` + `chatProjectId` 双重过滤。
- **竞品参照系**：真正的竞争面是 ChatGPT Projects / Claude Projects / NotebookLM / Gemini Gems —— 项目级资料层在 2026 年是 $20 档产品的**标配，不是差异化**。不要用独立开发者产品（llm_wiki / YouMind）当参照系推导「我们独一份」。
</content>
</invoke>
