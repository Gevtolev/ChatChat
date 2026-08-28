# ChatChat — 编译管道（第二大脑 · 子项目二）

> **版本**: 0.1.0（**简略版** —— 记录决策与理由，待子项目一完成、探针跑过后细化）
> **创建日期**: 2026-08-29
> **状态**: Draft，暂不实施
> **预估**: 30-40 小时
> **前置**: [子项目一 · 知识库容器](./2026-08-29-chatchat-knowledge-base-design.md) 必须先完成
> **前置**: 探针验证（见子项目一 §十）必须先跑

---

## 一、目标

把用户上传到知识库的文件，自动编译成**互链的 wiki 页面**，并在新文件进来时增量维护。

这是整个系列的价值所在，也是唯一有真实不确定性的部分。

---

## 二、方法论来源

采用 **Karpathy 的 LLM Wiki 模式**，具体实现参照本机 `~/.hermes/skills/research/llm-wiki/SKILL.md`（**MIT 许可，可参考**，v2.1.0，526 行）。

⚠️ **法律注意**：调研过的其他四个 LLM Wiki 项目（`nashsu/llm_wiki` 1.7万星、`inkeep/open-knowledge`、`AgriciDaniel/claude-obsidian`、`atomicstrata/llm-wiki-compiler`）**全部无许可证**，即保留所有权利。可以阅读架构、学习思路，**不得复制代码**。

### 2.1 三层结构

| skill 中的 | 我们的实现 |
|---|---|
| `raw/` 目录（不可变） | 子项目一的 `File` 记录（R2 存储） |
| `wiki/` markdown 文件 | MongoDB 文档 |
| `[[wikilink]]` | 页面文档的 `links[]` 字段 |
| `index.md` | 集合查询 |
| `log.md` | 操作日志表 |
| `SCHEMA.md` | `KnowledgeBase.schema` 字段（子项目一已建） |
| `search_files` | Mongo 文本索引 |

### 2.2 页面结构（源自 skill 的 frontmatter）

```ts
{
  knowledgeBase: ObjectId,
  title: string,
  slug: string,
  type: 'entity' | 'concept' | 'comparison' | 'query' | 'summary',
  tags: string[],           // 必须来自 KnowledgeBase.schema.tags 受控词表
  body: string,             // markdown
  links: string[],          // 出链的 slug
  sources: ObjectId[],      // File 引用
  confidence: 'high' | 'medium' | 'low',
  contested: boolean,
  contradictions: string[], // 冲突页面的 slug
  created / updated: Date,
}
```

`confidence` / `contested` / `contradictions` 三个质量信号来自 skill，作用是**防止弱证据悄悄固化成 wiki 事实** —— lint 会把它们挑出来供人工复核。

---

## 三、已定的决策

### 3.1 增量策略：阈值驱动 + 跨页更新

**不是**"只处理新文件"，**也不是**"全量重写"。照 skill 的阈值规则：

```
创建新页   —— 实体/概念在 2+ 个来源出现，或是某来源的核心
追加到现有 —— 来源提到的东西已被覆盖
不建页     —— 顺带一提、次要细节、领域外
拆页       —— 超过约 200 行时拆成子主题并互链
归档       —— 内容被完全取代时移入归档，从索引移除
```

skill 原文：**"一个来源可以触发 5-15 个页面的更新。这是正常且期望的 —— 这就是复利效应。"**

成本随单次来源的关联面波动，但**不随知识库总量线性增长**。控制手段是"先查后写"（③ 步）而非限制范围。

### 3.2 冲突处理：并存标记，不压制

新旧矛盾时：① 比日期，新的一般覆盖旧的 ② 若确实矛盾，**两个立场都记录**，带日期与来源 ③ frontmatter 标 `contradictions: [页名]` ④ lint 时提请人工复核。

### 3.3 执行方式：内部专用 agent

**基于 LibreChat 既有的 agent 运行时**，不自建。

已验证的三个前提：

1. **Skill 系统原生支持 SKILL.md 格式** —— `Skill` schema 字段为 `name`/`description`/`body`/`frontmatter`/`category`/`author`/`version`/`source`，与 SKILL.md 的 YAML frontmatter + markdown 正文一一对应；`packages/api/src/agents/skillFiles.ts` 专门处理
2. **agent 可脱离用户请求被程序化调用** —— 先例见 `packages/api/src/agents/memory.ts:821`，用 `Run.create({ graphConfig, tools, instructions })` + `run.processStream()` 在后台运行
3. **成本可封顶** —— `recursionLimit`（memory.ts 用的是 3）限制 agent 循环次数，`llmConfig` 锁定模型

需要新写的只有工具层：`读页面` / `写页面` / `搜页面` / `读原文` / `更新索引`，本质是 Mongo 增删改查的薄封装。

**agent 完全内部，用户不可见、不可自定义。** 理由：编译质量直接决定知识库好坏，放开自定义会把"我的 wiki 变乱了"变成无法排查的问题，且成本锁定失效。

### 3.4 模型：配置项，默认 `qwen/qwen3.7-flash`

单次摄入成本估算（源文 5K + 上下文 35K 输入，8K 输出）：

| 模型 | 单次成本 | Pro 月额度可摄入 | 上下文 |
|---|---|---|---|
| `mistralai/mistral-nemo` | $0.0010 | 12,000 份 | 131K |
| **`qwen/qwen3.7-flash`** | **$0.0022** | **5,454 份** | **1000K** |
| `~deepseek/deepseek-v4-flash-latest` | $0.0020 | 6,000 份 | 1311K |
| `gpt-5.6-luna` | $0.0176 | 681 份 | 1050K |

不选最便宜的 `mistral-nemo`，因为编译任务对模型能力有实质要求：抽取实体、判断建页阈值、生成受控词表内的结构化 frontmatter、判断跨页矛盾、正确埋 wikilink。**编译质量差的代价是错误内容永久沉淀进知识库**，与一次对话答错性质不同。

**超长上下文是刚需** —— 编译时需同时容纳原文 + schema + index + 若干现有页面。

**做成配置而非硬编码**：编译质量只有真跑过才知道，配置化可在不改代码不重新部署的前提下更换。

### 3.5 计费：走积分，固定模型

摄入与对话**共享同一积分池**，但编译强制使用配置的便宜模型，用户不可选。

- 一套计量、一个余额，**无需新建计费概念**
- 成本看板的 `byModel` 分组按 `context` 拆分，自动出现 `context: 'wiki_ingest'` 一行
- 参照 `api/app/clients/tools/structured/GeminiImageGen.js:287` 的模式（`context: 'image_generation'` 调 `spendTokens`）

**不做用户可选编译模型** —— YouMind 被抱怨最多的正是"积分消耗不可预测"。

### 3.6 SCHEMA 自动生成

用户直接传文件，**首批摄入时由 LLM 归纳出领域与初始标签词表**，写入 `KnowledgeBase.schema`，之后在设置里可编辑。

不做开局向导：调研显示"超过 10 秒的捕获方式会被抛弃"，开局先问一堆问题是典型的弃用起点。代价是首批归纳可能不准，需用户后续修正。

### 3.7 基础设施：Redis + BullMQ

生产当前**无队列框架、无 Redis**（`USE_REDIS` 未设置）。编译是长耗时任务，需要队列。

副作用是好的：生产现有 **3 个 `cache_integration` 测试套件因缺 Redis 而失败**，装上一并解决。

---

## 四、待细化（探针之后）

以下需在探针验证后才能定：

- 工具的具体粒度与签名
- `recursionLimit` 的具体取值
- 单次摄入的 token 上限与超限处理
- 编译失败的重试策略
- 是否需要"先分析后生成"的两步链式思考（llm_wiki 的做法）

---

## 五、明确不做

- **向量检索 / embedding** —— 整个系列不用 RAG，见子项目一 §1.2
- **对话历史入库** —— 知识源仅限上传的文件
- **用户自定义编译 agent** —— 见 §3.3
- **定期全量整理** —— 增量 + lint 已足够，lint 归子项目三
