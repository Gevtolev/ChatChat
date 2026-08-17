# gptsapi 在 Claude Opus 上少报 system 用量

> **日期**: 2026-08-17 ｜ **类型**: 实测记录（计费地基问题，非设计文档）
>
> **一句话**: `api.gptsapi.net` 对 **Claude Opus** 系列会把 `system` 消息内容送达模型、但**不计入 `usage.prompt_tokens`**，少报可达两个数量级；Haiku 与 GPT 正常。
>
> **状态**: 现象已确证，**归属未定** —— 尚不知道 gptsapi 是按这个少报的数字向我们收费（对我们有利），还是只是上报字段错、实际按真实量扣费（我们在亏）。**需要登录 gptsapi 后台核对账单才能定性。**

---

## 一、为什么去查这个

在设计积分制计费时，需要确认缓存（prompt caching）能否降低长对话成本。查证过程中先发现"我们的 Transaction 记录里没有任何缓存类型"，顺着查中转商是否透传缓存字段，意外发现了这个更严重的问题。

---

## 二、实测方法与结果

所有测试直接打 `https://api.gptsapi.net/v1/chat/completions`，**绕过我们自己的代码**，排除本地实现的干扰。

对照设计：同样一段约 7,800 字符的文本，一次放 `system` 消息，一次放 `user` 消息，比较 `usage.prompt_tokens`。

| 模型 | 放 system | 放 user | 判定 |
|---|---:|---:|---|
| `claude-opus-4-7` | **17** | 2,151 | ⚠️ 少报 ~126× |
| `claude-opus-4-8` | **11** | 2,146 | ⚠️ 少报 ~195× |
| `claude-opus-4-8-cc` | **11** | 2,146 | ⚠️ 同样少报 |
| `claude-haiku-4-5-cc` | 1,161 | 1,163 | ✅ 正常 |
| `gpt-5.4` | 1,021 | 1,028 | ✅ 正常 |

### 长度相关性

同一模型（`claude-opus-4-7`）下按 system 长度递增：

| system 长度 | `prompt_tokens` | 模型是否遵守 system 指令 |
|---:|---:|---|
| 123 字符 | 80 | 否（回答 `4`） |
| 1,605 字符 | 479 | 是（回答 `ZEBRA`） |
| 7,845 字符 | **17** | 是 |
| 23,445 字符 | **17** | 是 |

**关键**：长 system 下模型**确实遵守了指令**（回答 ZEBRA），证明内容送达了；但 token 计数塌缩成一个恒定小值。所以不是"内容被丢弃"，是"计数漏算"。

---

## 三、排查过程中被推翻的两个中间结论

记下来是为了避免重走：

1. **"gptsapi 丢弃 system 角色"** —— 错。用行为测试（给一个只能来自 system 的指令，看模型认不认）证伪：Claude 和 GPT 都遵守了。最初误判是因为只看 `prompt_tokens` 变小就下了结论。
2. **"`-cc` 变体是原生 Anthropic 通道，可能修正统计"** —— 错。`claude-opus-4-8-cc` 与非 `-cc` 版本表现完全一致（都是 11）。而 `claude-haiku-4-5-cc` 正常，说明差异在**模型系列**而非通道后缀。

---

## 四、顺带确证的缓存现状

| 中转商 | 协议兼容性 | 缓存字段 |
|---|---|---|
| **gptsapi**（Claude/Gemini/GPT/DeepSeek/GLM 等） | 不认结构化 content 数组（带 `cache_control` 的块会被丢弃，`prompt_tokens` 只剩最后一段短文本） | 只有恒为 0 的 `cached_tokens`，无 `cache_write_tokens` |
| **OpenRouter**（Grok/DeepSeek 等） | 好 | **完整**：`cached_tokens` + `cache_write_tokens`，另有 `cost` 与 `upstream_inference_cost`（真实成本） |

OpenRouter 对 Anthropic 模型返回 `403 This model is not available in your region.`，与既有记录一致（OpenRouter 对 Claude/Gemini/GPT 的 ToS 拦截）。

gptsapi 官方文档（`https://api2.gptsapi.net/tutorial`）未说明 system 与用量统计的关系；其 OpenClaw 配置示例中 `cacheRead: 0, cacheWrite: 0` 且注明"不影响功能"，侧面印证这条线上缓存不计价。

---

## 五、对我们的影响

### 计费

`spendTokens` 直接消费 `usage.prompt_tokens`（见 `api/server/controllers/agents/client.js` 的调用点）。Opus 是我们最贵的模型，少报的绝对金额最大。

**积分体系不能建立在这个数上** —— 在失真的计量层上做精算没有意义。

### 上下文管理

LibreChat 用 token 计数决定何时截断对话历史。少报会让它误以为余量充足，可能导致请求超出模型上下文窗口而失败。这个影响与计费无关，但同样真实。

### 影响面

LibreChat 的系统提示词、agent 指令、memory 注入都走 `system`。也就是说这不是边缘场景，是 Opus 的每一次调用。

---

## 六、待办

1. **【需人工】登录 gptsapi 后台核对账单** —— 用 Opus 发一个长 system 请求，看实际扣费金额对应多少 token。这决定问题性质：
   - 若按少报的数字扣费 → 对我们有利，但计量层仍不可信，不能用于积分换算
   - 若按真实量扣费 → **我们在持续亏钱**，且亏损随 Opus 用量增长
2. 核对其他 Opus 变体（`claude-opus-5`、`claude-fable-5`）是否同样
3. 定位塌缩阈值（1,605 字符正常、7,845 字符异常，中间未测）
4. 在问题定性前，积分体系的成本换算**不要采用 gptsapi 上报的 Opus 用量**；可选的替代口径：本地用 tokenizer 自行计数，或对 Opus 走 OpenRouter（但有区域限制）

---

## 七、复现方法

```bash
k=$(grep -E "^GPTSAPI_KEY=" .env | cut -d= -f2-)
python3 - "$k" <<'PY'
import json,sys,urllib.request
k=sys.argv[1]
def call(model, role):
    txt='Additional context about distributed consensus protocols and replicated logs. '*100
    msgs=[{'role':'system','content':'Answer briefly. '+txt},{'role':'user','content':'What is 2+2?'}] if role=='system' \
         else [{'role':'user','content':txt+'\n\nWhat is 2+2? Answer briefly.'}]
    body=json.dumps({'model':model,'max_tokens':20,'messages':msgs}).encode()
    r=urllib.request.Request('https://api.gptsapi.net/v1/chat/completions',data=body,
        headers={'Authorization':'Bearer '+k,'Content-Type':'application/json','User-Agent':'curl/8.5.0'})
    return json.load(urllib.request.urlopen(r,timeout=90))['usage']['prompt_tokens']
for m in ('claude-opus-4-8','claude-haiku-4-5-cc','gpt-5.4'):
    print(m, 'system=', call(m,'system'), 'user=', call(m,'user'))
PY
```

注意：不带 `User-Agent` 头会被 403 拦截。
