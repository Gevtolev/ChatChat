# ChatChat — 知识库容器与文件摄入（第二大脑 · 子项目一）

> **版本**: 0.1.0
> **创建日期**: 2026-08-29
> **状态**: Draft（待用户复审）
> **预估**: 20-30 小时
> **系列**: 第二大脑三部曲之一
> **后续**: [子项目二 · 编译管道](./2026-08-29-chatchat-wiki-compiler-design.md) · [子项目三 · 浏览与图谱](./2026-08-29-chatchat-wiki-browse-graph-design.md)

---

## 一、目标与定位

给每个用户一个**唯一的知识库容器**，能上传文件、按文件夹组织、查看和删除。

**本子项目不含 wiki、不含 agent、不含图谱。** 它的独立价值是：文件终于有地方放了 —— 现有的 Project（`chatProject`）只能装会话，`schema/chatProject.ts` 里没有任何文件字段。即使子项目二三永不实施，用户也得到了一个可用的文件库。

### 1.1 它在整体中的位置

三个子项目对应 Karpathy LLM Wiki 模式的三层：

| 子项目 | 对应 | 交付 |
|---|---|---|
| **一（本文）** | `raw/` 不可变原始层 | 文件能传能管 |
| 二 | `wiki/` 编译层 + `SCHEMA.md` | 文件自动变成互链页面 |
| 三 | 导航与发现 | 可浏览、可视化、可 lint |

### 1.2 为什么不是 RAG

整个系列**不使用向量检索**。Karpathy 的原始论证是：个人知识库是数百份资料而非数百万份，与其每次查询重新做向量召回并重新推导结构，不如让 LLM **提前把知识编译好并持续维护**。

直接后果是我们**不需要 pgvector、不需要 rag_api、不需要 embedding 供应商** —— 上游 `docker-compose.yml` 里那两个服务一个都不用起。这条决定省掉的不只是部署，还有一整条无人计费的成本路径（上游对 embedding 零计费，`tokenValues` 里没有任何 embedding 条目）。

---

## 二、数据模型

### 2.1 新增 `KnowledgeBase`

```ts
{
  user: ObjectId,        // unique 索引 —— 一人一个
  name: string,          // 默认 "My Knowledge Base"
  schema: {              // 子项目二填充，本子项目只建字段
    domain: string,
    tags: string[],
    conventions: string,
  } | null,
  fileCount: number,
  totalBytes: number,
  tenantId: string,
}
```

`schema` 字段本子项目**不写入**，但必须现在建。它是子项目二的领域约束载体（LLM 首次摄入后自动生成、用户可编辑），留到那时再加字段意味着改表。

### 2.2 新增 `KnowledgeFolder`

```ts
{
  knowledgeBase: ObjectId,
  parent: ObjectId | null,   // null = 根
  name: string,
  path: string,              // 冗余全路径，如 "技术/前端"
  tenantId: string,
}
```

`path` 是**刻意的冗余**：面包屑渲染和"某文件夹下所有文件"是两个高频操作，存全路径可避免递归查树。代价是重命名文件夹要批量更新子孙的 `path`，属低频操作，接受。

### 2.3 复用 `File`，新增两字段

```ts
knowledgeBase: ObjectId | null,   // 非知识库文件为 null
folder: ObjectId | null,
```

并在 `FileContext` 枚举（`packages/data-provider/src/types/files.ts:24`）新增 `knowledge_base`。

**为什么复用而非新建表**：`File` 已具备 `text`（提取的正文）、`status`（pending/ready/failed）、`bytes`、`source`、`metadata`，以及配套的 R2 上传下载、预览、删除清理（`api/server/services/Files/strategies.js`）。新建一张表等于把这些全部重写，并产生**两套并行的文件生命周期管理** —— 这正是本仓库上个月删除 `UsageLog` 所针对的问题：一个从未通电的平行实现，会让后来者以为存在两个真相源。

代价是 `File` 表混装两类文件（对话附件与知识库资料），以 `knowledgeBase` 是否为 null 区分。可接受 —— `context` 字段本就在做同类区分。

---

## 三、上传流程

```
用户选文件
  ① 原子占坑：配额检查 + 计数递增（见 §四）
  ② 复用 processFileUpload：存 R2、提取正文写入 File.text
  ③ 写 File 记录：knowledgeBase / folder / context='knowledge_base'
  ④ 失败则回滚 ① 的计数
```

**顺序不可颠倒。** 若先上传后检查配额，超限时 R2 already 有了对象，会留下孤儿。先占坑意味着最坏情况是"计数占了但文件没传成"，而这可以在同一请求内回滚。

正文提取沿用现有能力：PDF / Office / EPUB 等格式由 `processFileUpload` 处理，本子项目不新增解析器。提取失败时 `File.status` 置 `failed`，文件仍保留（用户可见其失败状态并重传），**不回滚配额** —— 因为 R2 上的对象确实占着空间。

---

## 四、配额

### 4.1 挂在 PLANS 上

```ts
features: { ..., knowledge_base: boolean }
knowledge_max_files: number
knowledge_max_bytes: number
```

| 档位 | 可用 | 文件数 | 容量 |
|---|---|---|---|
| anonymous | ❌ | — | — |
| free | ❌ | — | — |
| trial | ✓ | 20 | 50 MB |
| pro_m / pro_q / pro_h | ✓ | 500 | 2 GB |

**Free 档不开放是产品决策，不是技术限制。** 这是订阅的差异化理由；而且存储是**持续成本**而非一次性 —— 免费用户传完就永久占用 R2，与我们既有的按次计量体系性质不同。

### 4.2 检查必须原子

按项目规范（CLAUDE.md：quota check-and-increment must be atomic），单条 `findOneAndUpdate` 带上界过滤：

```js
KnowledgeBase.findOneAndUpdate(
  {
    user: userId,
    fileCount: { $lt: plan.knowledge_max_files },
    totalBytes: { $lte: plan.knowledge_max_bytes - size },
  },
  { $inc: { fileCount: 1, totalBytes: size } },
  { new: true },
)
```

返回 `null` 即超限，拒绝上传。**禁止读后写** —— 并发上传会突破上限。

### 4.3 删除的清理顺序

以 `File` 记录为准，顺序为：删 `File` 记录 → 回滚计数 → 清 R2 对象。

R2 清理失败**只记日志，不回滚前两步**。理由：孤儿对象只是浪费存储，可用后续清扫任务处理；而"计数还占着但文件已不可见"会让用户永久损失配额且无法自助恢复。两害相权取其轻。

---

## 五、API

| 端点 | 说明 |
|---|---|
| `GET /api/knowledge` | 取知识库；不存在则**惰性创建**；返回配额用量 |
| `PATCH /api/knowledge` | 改名 |
| `GET /api/knowledge/files` | 列文件，按 `folderId` 过滤，游标分页 |
| `POST /api/knowledge/files` | 上传（multipart，带 `folderId`） |
| `DELETE /api/knowledge/files/:id` | 删除 |
| `POST /api/knowledge/folders` | 建文件夹 |
| `PATCH /api/knowledge/folders/:id` | 改名 / 移动（须级联更新子孙 `path`） |
| `DELETE /api/knowledge/folders/:id` | 删除（须处理其下文件：一并删除或移至根，见 §7.2） |

**惰性创建**：用户首次访问才建记录，不在注册时批量建，避免为从不使用的用户留下空记录。

**守卫**：`requireJwtAuth` + 新增 `requireFeature('knowledge_base')` 中间件（读当前 plan 的 `features`）。后端是唯一的安全边界；前端的隐藏仅为 UX。

代码位置遵循工作区边界：业务逻辑 TypeScript 置于 `packages/api/src/knowledge/`，数据库方法置于 `packages/data-schemas/src/methods/knowledge.ts`，`api/server/routes/knowledge.js` 仅作薄封装。

---

## 六、前端

路由 `/knowledge`，挂在 `Root` 之下。

```
client/src/components/Knowledge/
  KnowledgePanel.tsx     容器 + 配额条
  FolderTree.tsx         左侧文件夹树
  FileList.tsx           右侧文件列表（复用 @librechat/client 的 DataTable）
  UploadDropzone.tsx     拖拽上传
```

数据层按规范：`client/src/data-provider/Knowledge/queries.ts` → 端点入 `api-endpoints.ts` → 服务入 `data-service.ts` → 类型入 `packages/data-provider`。

**导航入口必须在侧边栏可见** —— 与成本看板（内部工具、无入口）相反，知识库是卖点。对无权限档位仍然显示，点击触发 `UpgradeModal`（stage 3 已定义但至今未启用的组件）。

文案全部经 `useLocalize()`，只改 `client/src/locales/en/translation.json`。

---

## 七、边界与错误处理

### 7.1 必须处理

| 情形 | 行为 |
|---|---|
| 超配额 | 明确提示超的是文件数还是容量，不含糊 |
| 正文提取失败 | 文件保留、状态 `failed`、可重传；配额不回滚 |
| 上传中断 | 回滚计数；R2 残留由清扫处理 |
| 无权限档位直接访问 URL | 后端 403，前端显示升级引导而非空白页 |
| 并发上传 | 原子递增保证不超限 |

### 7.2 删除文件夹的语义

删除非空文件夹时，**其下文件移至根目录，不级联删除**。理由：文件是用户上传的原始资料，误删代价高且不可恢复；而文件夹只是组织方式。UI 上需明确告知"N 个文件将移至根目录"。

---

## 八、测试

- **配额原子性** —— `mongodb-memory-server` 真库，并发发起 N+1 次上传，断言只有 N 次成功
- **占坑回滚** —— 模拟上传失败，断言计数回到原值
- **惰性创建** —— 首次 GET 建记录，二次 GET 不重复建
- **文件夹 path 级联** —— 重命名父文件夹后，断言子孙 `path` 全部更新
- **删除文件夹** —— 断言其下文件移至根而非被删
- **档位守卫** —— free 档请求返回 403
- **前端** —— 加载 / 成功 / 空 / 超限 / 无权限五态

按项目规范：Mongo 用真实内存实例，不 mock 查询。

---

## 九、范围

### 9.1 在范围内

§二 的三个数据模型改动、§五 的八个端点、§六 的四个组件、PLANS 的三个新字段、`requireFeature` 中间件。

### 9.2 不在范围内

- **文件预览 / 在线阅读** —— 子项目三
- **全文搜索** —— 需索引，子项目三
- **拖拽移动文件夹** —— 先用"移动到"菜单
- **批量上传进度条** —— 先串行、显示"第 N 个 / 共 M 个"
- **SCHEMA 编辑界面** —— 字段留着，子项目二填充后再做界面
- **对话历史入库** —— 明确不做。知识源仅限用户主动上传的文件；把聊天记录自动纳入涉及隐私边界，且用户未必希望每次对话都进入知识库
- **任何 wiki / agent / 图谱能力** —— 子项目二三

---

## 十、上线后的下一步

子项目一完成后、正式启动子项目二之前，**必须先做一次抛弃式探针**（2-3 小时）：

取 10 份真实文档，手工调用一次编译 agent，观察三件事：编译出的 wiki 质量、实际 token 成本分布、agent 是否跑偏。

理由：整个系列的价值全部押在"编译质量是否够好"这一个假设上。若所选模型编译结果不可用，子项目二的设计（尤其模型选择与工具粒度）需要推倒重来。**在写 30 小时代码之前，花 3 小时知道答案。**
