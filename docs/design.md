# Atlas · 技术设计文档

> 面向 DeepSeek Harness 的空间化对话工作台
> A spatial workspace for long conversations

| 项目 | 内容 |
|---|---|
| 状态 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-10-28 |
| 作者 | Atlas contributors |
| 许可证 | MIT |
| 仓库 | `dsh-atlas` |
| 包名 | `dsh-atlas` |
| 兼容 | DeepSeek Harness 0.1.x（developer preview） |

---

## 摘要

Atlas 把 DSH 的线性对话变成一张**可缩放的任务地图**：

- 每个节点是一段对话，画布表达任务结构；
- 点开节点，相机飞入并打开对话；
- 对话内的标题可以折叠成**子聊天**，像 Word 的标题一样；
- 关闭节点时生成**收口卡**，下次打开先给**续接简报**；
- 节点上的掌握度与到期徽标，让画布本身成为复习地图。

一句话：**树负责结构，栈负责当下，列表负责回访。**

本文记录 Atlas 的目标、交互模型、数据模型、DSH 集成方式、上下文工程、协议、里程碑与风险，作为开源仓库的 `docs/design.md`。

### Abstract (EN)

Atlas turns a linear DSH conversation into a zoomable map of tasks. Each node is a conversation; clicking a node flies the camera in and opens the thread; headings inside the thread collapse into nested sub-chats; closing a node produces a closure card that becomes the resume brief. The canvas doubles as a review map. This document specifies the interaction model, data model, DSH integration, context engineering, protocol, and roadmap.

---

## 1. 背景与问题

### 1.1 线性对话的三个硬问题

1. **结构缺失**：侧边栏只有时间序，没有“这个模块属于哪个任务”的层级。
2. **上下文污染**：子问题混进主线，之后每一轮都携带无关 token；长上下文还会触发 context rot。
3. **回访成本高**：关掉窗口就“失忆”；几天后回来，要重读几十条消息才知道自己停在哪。

### 1.2 现有 DSH 插件各解了一半

| 插件 | 机制 | 解决了 | 没解决 |
|---|---|---|---|
| `dsh-subtopic` | 选中文字 → 就地子话题卡 + 右侧追问树 | 就地提问、卡片可关、树是账本 | 卡片是浮层，不是画布；无收口、无复习 |
| `dsh-nested-followups` | 任意回答 fork 成会话树，Tree View | 真会话隔离、无限嵌套、渐进折叠 | 是树视图，不是空间画布；分支不能在原生界面续聊 |
| `dsh-session-tree-extension` | 会话树面板嵌在输入框 | 历史树、任意节点 fork | 面向 agent session，不是学习任务 |

**Atlas 的差异**：把“画布的空间结构”和“对话内的标题嵌套”合成一个交互循环，并补上“收口 / 复习”这一层。

### 1.3 目标用户与典型旅程

目标用户：需要在一个大领域里逐层深入、并且会反复回来复习的人（学生、研究者、工程师、知识工作者）。

典型旅程（数据库复习）：

1. 新建工作区“数据库系统”，输入目标：“八周内过一遍数据库的八个模块”。
2. Atlas 让模型给出 8 个模块，用户确认后自动生成 8 个节点，按树形布局。
3. 点“02 索引”，相机飞入，打开对话；模型给出 B+ 树、LSM、哈希三条线。
4. 在 B+ 树的回答里点“展开”，出现子聊天“页分裂”；问完后“收口”，生成 3 条结论。
5. 把“页分裂”**提升为节点**，它成为“B+ 树”的子节点，画布上多一条边。
6. 一周后打开 Atlas，节点上显示“3 轮 · 掌握 3/5”；点开先看到续接简报：“上次你停在页分裂的触发条件，还有 2 个问题没解决。”

---

## 2. 目标与非目标

### 2.1 目标（v1）

- 一个工作区一张无限画布，支持 pan / zoom / 拖拽节点 / 适配视图。
- 节点 = 一段对话；点节点进入对话，关闭回到画布原位。
- 对话内支持 Word 式标题：折叠、展开、搜索、目录轨。
- 标题可以“提升为节点”，把深度换成广度。
- 关闭节点生成收口卡；重新打开生成续接简报。
- 本地优先：工作区数据可导出、可迁移、不上传。
- 200 个节点、10k 条消息内保持可用（目标 55fps 平移，打开节点 <150ms 命中缓存）。

### 2.2 非目标（v1）

- 不是通用白板：不做自由绘图、图片、形状、多人光标。
- 不是多 agent 编排器：不做自动任务分解、自动并行子代理。
- 不是 DSH 聊天内核的替代：不重写工具、审批、工作区执行。
- 不做协作/CRDT：单用户、本地文件。
- 不做富文本编辑器：消息是 Markdown，收口卡是结构化 JSON。
- 不做移动端：v1 只保证桌面 Web。

---

## 3. 核心概念与交互

### 3.1 三层模型

```
L0 画布   任务地图（数据库 8 个模块）
L1 节点   模块对话（02 索引 → B+ 树）
L2 标题   子问题（页分裂 / 聚簇索引）
L3+       不再嵌套，改为「提升为节点」
```

- 画布负责**广度**，节点内标题负责**深度**。
- **超过三层，位置感会崩**；第四层用“提升为节点”把深度换成广度。
- 提升时保留对父对话的引用（消息范围 / 引用 chip），否则会断链。

### 3.2 画布

- 无限画布，世界坐标 + 相机 `{x, y, zoom}`。
- 语义缩放，不是整体缩小：

| zoom | LOD | 显示 |
|---|---|---|
| `> 0.95` | full | 标题、副标题、掌握度、轮数、状态 |
| `0.55–0.95` | mid | 标题、副标题、状态点 |
| `0.3–0.55` | far | 标题 pill |
| `< 0.3` | map | 形状、颜色、状态点 |

- 双击空白适配全部；`F` 适配；`⌘/Ctrl + 滚轮` 缩放；拖拽空白平移；拖拽节点移动。
- 边：父子贝塞尔曲线；引用/交叉链接用虚线。
- 导航：面包屑、minimap、“适配子树”、“只看当前路径”（其余淡化）。
- **布局稳定性**：只在新节点首次放置或手动“整理”时自动布局；其余保持用户位置。空间记忆是特性，不是装饰。

### 3.3 节点

节点状态机：

```
seed ──▶ active ◀──▶ paused ──▶ closed ──▶ archived
          │
          └── fork ──▶ active'（兄弟节点，互不污染）
```

- `seed`：只有标题和目标，未开始。
- `active`：对话进行中。
- `paused`：折叠但还活着（后台可继续）。
- `closed`：有收口卡，不再接受新消息，除非“重新打开”。
- `archived`：从工作列表消失，但可搜索。

节点上显示：标题、副标题、状态点、掌握度（5 点）、轮数/到期徽标。

### 3.4 对话面板

点节点：

1. 相机飞到节点（约 600ms，尊重 `prefers-reduced-motion`）。
2. 打开“纸张式”对话面板（覆盖层），画布在后面变暗但不消失。
3. 面板顶部：面包屑、标题、状态、掌握度、搜索、收口、定位、关闭。
4. 左侧：本节目录（outline）。
5. 中间：对话；用户消息右对齐，AI 消息按文档排版。
6. 底部：输入框 + 发送；`Enter` 发送，`Esc` 关闭。

**为什么是覆盖层而不是把节点本身拉成聊天框**：节点要保持“地图角色”；把节点拉大再缩小会破坏布局与空间记忆。相机飞入 + 纸张面板，既保留“进入感”，又不改变地图。

### 3.5 子聊天（Word 式标题）

对话内的每个标题是一段可折叠的子聊天：

```
▾ 02.2.1 为什么数据都在叶子节点        3 轮 · 已收口
   你：为什么非叶节点不存数据？
   AI：为了让一页能装下更多键……
   ┌ ↳ 页分裂的触发条件        2 轮   [提升为节点]
   │  你：页分裂是怎么发生的？
   │  AI：当一个叶子页写满……
   └
▸ 02.2.2 聚簇索引 vs 二级索引          2 轮
```

- 标题行：chevron、标题、轮数、收口状态；点击折叠。
- 子聊天：缩进 + 虚线左边框 + 自己的消息列表；可以继续追问。
- 搜索：命中标题或内容时自动展开对应标题与子聊天。
- 目录轨：点击跳转；折叠全部 / 展开全部。
- **提升为节点**：把子聊天变成画布子节点，保留父引用。

### 3.6 收口

关闭节点或点击“收口”时，生成一张**收口卡**：

| 字段 | 说明 |
|---|---|
| `tldr` | 一句话结论（≤30 字） |
| `points` | 3–7 条要点 |
| `openQuestions` | 0–3 个未解问题 |
| `artifacts` | 文件/链接/代码/表格引用 |
| `mastery` | 0–5，附一句理由 |
| `nextHint` | 回到上层的衔接句 |
| `sourceRange` | 基于哪些消息（可追溯） |

卡片是节点在树里的“脸”；父节点的上下文只读卡，不读 transcript。用户可以在保存前编辑；模型生成失败时降级为手动卡。

### 3.7 复习（Phase 2）

- 收口卡 → 生成 3–5 张问答卡（定义/对比/为什么/边界）。
- FSRS 排期；节点上显示到期徽标。
- 复习模式：按到期顺序飞到一个节点 → 打开“测验模式”（不打开整段聊天）→ 用户回答 → 模型对照收口卡评分 → 更新掌握度与 `dueAt`。
- 画布本身就是复习地图：绿色=已收口，蓝色=进行中，灰色=未开始，红点=到期。

### 3.8 键盘

| 键 | 动作 |
|---|---|
| `Enter` | 进入选中节点 |
| `Esc` | 关闭面板 / 返回画布 |
| `←/→` | 兄弟节点间移动 |
| `⌘K` | 全局搜索（节点、标题、消息、卡片） |
| `⌘Enter` | 收口 |
| `⌘Shift+Enter` | 从当前节点/选中句子分叉 |
| `Space` | 偷看（peek）选中节点最近一条，不进入 |
| `F` | 适配视图 |
| `+ / -` | 缩放 |

---

## 4. 架构

### 4.1 总体架构

```
┌──────────────────────────── DSH Web Client ────────────────────────────┐
│  Atlas Client Plugin                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Canvas       │  │ Chat Sheet   │  │ Outline      │                 │
│  │ camera / LOD │  │ threads      │  │ headings     │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                 │
│         └─────────────────┼─────────────────┘                         │
│                    Atlas Client Store                                  │
│                           │ HTTP / SSE                                 │
└───────────────────────────┼────────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────────┐
│  Atlas Host Plugin (Cordis)                                            │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐          │
│  │ Workspace  │ │ Thread     │ │ Closure    │ │ Review     │          │
│  │ Store      │ │ Service    │ │ Service    │ │ Scheduler  │          │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘          │
│         │               │              │                               │
│   ~/.dsh/atlas/    LlmAdapter      SessionAdapter (M5)                │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 插件结构

```
dsh-atlas/
├─ package.json
├─ cordis.patch.yml
├─ tsconfig.json
├─ src/
│  ├─ host/
│  │  ├─ index.ts          # 注册路由、存储、服务
│  │  ├─ routes.ts         # /ext/atlas/*
│  │  ├─ store.ts          # 工作区/节点/线程/卡片的文件存储
│  │  ├─ context.ts        # 上下文组装
│  │  ├─ closure.ts        # 收口卡生成与校验
│  │  ├─ llm.ts            # LlmAdapter，封装 llm.stream
│  │  └─ sessions.ts       # SessionAdapter（M5）
│  ├─ client/
│  │  ├─ index.ts          # 注册 Atlas 入口/命令
│  │  ├─ canvas/           # 画布、相机、LOD、边
│  │  ├─ chat/             # 对话面板、消息流、composer
│  │  ├─ outline/          # 标题、折叠、搜索、目录轨
│  │  └─ store.ts          # 客户端状态（工作区、相机、选中）
│  └─ shared/
│     ├─ types.ts
│     └─ protocol.ts
├─ tests/
├─ docs/
│  ├─ design.md
│  ├─ prototype.html
│  └─ assets/
└─ README.md
```

> `protocol.md` / `roadmap.md` 在 M1 拆出；v0.1 先保持单文档，避免过早分裂。

### 4.3 DSH 集成点

以当前 DSH 0.1.x 插件生态的用法为参考；落地时通过适配层隔离版本差异：

| 能力 | 用途 | 适配层 |
|---|---|---|
| `llm.stream()` | Atlas-native 线程的模型调用 | `LlmAdapter` |
| `session` / 官方 fork | Agent mode 下绑定真实会话 | `SessionAdapter` |
| `shell.overlay` / 客户端 slots | 承载画布与对话面板 | `UiHost` |
| `conversation.input.shell` / `inputTriggers` | 把引用 chip 插入输入框（M3） | `ComposerBridge` |
| 插件配置 `cordis.patch.yml` | 注册 bundle、路由、默认配置 | — |
| 本地文件系统 | 工作区持久化 | `WorkspaceStore` |

**能力探测**：启动时检测 `session.fork`、`conversation.portal`、`llm.stream` 是否可用；缺失时降级，并在 UI 上显示“Notebook / Agent”徽标。

### 4.4 绑定策略：Atlas-native 优先，Agent mode 可选

| 线程类型 | v1 默认 | 说明 |
|---|---|---|
| 节点主线程 | **Atlas-native** | Atlas 自己存消息、自己组装上下文、调 `llm.stream`；不依赖会话续聊限制 |
| 子聊天 | **Atlas-native + 无工具写权限** | 子聊天可以多轮对话，但不执行写工具；上下文只带父链卡片 + 引用，不带整棵树 |
| Agent mode（M5） | 绑定 DSH session | 需要工具/工作区/审批时开启；Atlas 镜像消息，session 为执行引擎 |
| 提升为节点 | 新建 Atlas 线程 | M5 起可选 fork 一个真实 session |

**为什么 v1 不默认 session**：

- DSH 0.1.x 中，子代理来源的会话不能在原生对话界面续聊（`dsh-nested-followups` 的 README 已记录该限制）。
- 把每个子聊天都建成 session 会污染会话列表，并让“关闭/收口”的语义变复杂。
- 学习场景的核心是“讲解 + 追问 + 收口”，不需要工具执行；Atlas-native 足够，且上下文完全可控。

代价：v1 的 Atlas 线程没有工具/工作区能力；需要时用 Agent mode（M5）。

### 4.5 数据流

**打开节点**

```
client: GET /ext/atlas/workspaces/:wid
        → { nodes, edges, viewport }
client: GET /ext/atlas/threads/:tid?limit=50
        → { thread, messages, card }
client: POST /ext/atlas/threads/:tid/read   (标记已读)
```

**发送一轮**

```
client: POST /ext/atlas/threads/:tid/turn  { text, quote?, clientRev }
host:   buildContext(thread, { quote })
        → llm.stream(...)
        → SSE: meta → delta* → done
        → 持久化 user/assistant 消息、tokens、thread.summary
client: 渲染流式消息；更新节点轮数/状态
```

**收口**

```
client: POST /ext/atlas/nodes/:nid/close { threadId }
host:   closure.generate(transcript, node, pathCards)
        → validate(zod) → 保存 card → 更新 node(status=closed, mastery, closedAt)
        → 返回 card
client: 显示收口卡；节点变绿；关闭面板；相机回到画布
```

**提升为节点**

```
client: POST /ext/atlas/threads/:tid/promote { title?, position? }
host:   创建 node + 新 thread；复制引用范围；建立 parent 边
        → 返回 node
client: 重绘画布；相机飞到新节点
```

---

## 5. 数据模型

### 5.1 类型

```ts
type NodeStatus = 'seed' | 'active' | 'paused' | 'closed' | 'archived';
type ThreadKind = 'main' | 'sub';

interface Workspace {
  id: string;
  name: string;
  goal?: string;
  glossary?: { term: string; def: string }[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

interface Node {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  subtitle?: string;
  kind: 'root' | 'module' | 'topic' | 'concept';
  status: NodeStatus;
  mastery: number;              // 0..5
  position: { x: number; y: number };
  size?: { w: number; h: number };
  threadId: string;             // 主线程
  sessionId?: string;           // M5: Agent mode
  createdAt: string;
  closedAt?: string;
  dueAt?: string;
  meta?: Record<string, unknown>;
}

interface Thread {
  id: string;
  nodeId: string;
  parentThreadId: string | null;
  kind: ThreadKind;
  title: string;
  order: number;
  collapsed: boolean;
  summary?: string;             // 滚动摘要
  sessionId?: string;           // M5
  createdAt: string;
  closedAt?: string;
}

interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tokens?: number;
  createdAt: string;
  source?: { sessionId?: string; messageId?: string };
  quote?: {
    messageId: string;
    range: [number, number];
    text: string;
  };
}

interface ClosureCard {
  id: string;
  nodeId: string;
  threadId: string;
  tldr: string;
  points: string[];
  openQuestions: string[];
  artifacts: Artifact[];
  mastery: number;
  nextHint: string;
  sourceRange: [string, string];
  generatedAt: string;
  model: string;
  version: 1;
}

interface Artifact {
  kind: 'file' | 'link' | 'code' | 'table' | 'image';
  ref: string;
  label?: string;
}
```

### 5.2 存储布局

本地优先，文件存储，便于导出、diff、备份：

```
~/.dsh/atlas/
  workspaces/
    <workspace-id>/
      workspace.json          # 元数据、目标、术语表
      nodes.json              # 全部节点（含位置）
      edges.json              # 父子之外的引用边
      viewport.json           # 相机、折叠状态
      threads/
        <thread-id>.jsonl     # 追加写：消息
      cards/
        <card-id>.json        # 收口卡
      index.json              # 搜索索引、token 统计
```

- 写入：`write temp → fsync → rename`，避免半写。
- 消息：JSONL 追加；每行一条，带 `id`、`createdAt`。
- 迁移：`schemaVersion` + `migrations/`；启动时按版本迁移。
- 导出：整个目录打包 `.atlas`（zip），包含 `manifest.json`。

### 5.3 版本与并发

- 每个工作区有 `rev`；客户端写请求带 `clientRev`。
- 不匹配返回 `409 E_CONFLICT` + 最新快照；客户端合并或提示。
- 单进程 host 内用 per-workspace mutex；文件锁防止多开。

---

## 6. 上下文工程

### 6.1 组装算法

```ts
function buildContext(threadId: string, opts: BuildOptions): PromptParts {
  const thread = store.getThread(threadId);
  const node = store.getNode(thread.nodeId);
  const path = ancestors(node);                    // 根 → 当前
  const cards = path.map(n => store.getClosureCard(n.id)).filter(Boolean);
  const nodeBrief = store.getNodeBrief(node.id);   // 目标、状态、未解问题
  const recent = store.getRecentMessages(thread.id, opts.recentTurns ?? 8);
  const quote = opts.quote;
  const siblings = siblingsOf(thread).map(t => store.getThreadDigest(t.id));
  const artifacts = retrieveArtifacts(node, opts.query, opts.artifactBudget);

  return {
    system: SYSTEM_PROMPT,
    workspace: workspaceBrief,
    path: cards.map(c => `## ${c.tldr}\n${c.points.map(p => `- ${p}`).join('\n')}`),
    node: nodeBrief,
    thread: thread.summary ?? '',
    quote: quote ? `> ${quote.text}` : '',
    siblings,
    recent,
    artifacts,
  };
}
```

### 6.2 预算

| 片段 | 预算（tokens） | 说明 |
|---|---|---|
| system | 800–1200 | 固定角色与输出规范 |
| workspace | 500 | 目标、术语表、偏好 |
| 祖先收口卡 | 1500–2500 | 只放卡，不放 transcript |
| 节点 brief | 500–1000 | 目标、状态、未解问题 |
| 线程摘要 | 800–1200 | 滚动摘要 |
| 最近轮次 | 4000–6000 | 最近 8–12 轮原文 |
| 产物 | 2000–4000 | 按需检索 |
| 输出预留 | 2000 | — |

总计约 12k–18k；在 128k 窗口下留足余量。超过预算时按“产物 → 最近轮次 → 线程摘要”的顺序压缩，**祖先卡不压**。

### 6.3 压缩（compaction）

- 触发：`thread.tokens > 0.6 * threadBudget`。
- 把最旧的 50% 轮次总结进 `thread.summary`，保留最近 8 轮原文。
- 先清理 tool 结果，再压缩对话。
- 收口卡与产物永不压缩。
- 节点边界是硬边界：**不跨节点压缩**。

### 6.4 续接简报（resume brief）

重新打开一个 `closed` 节点时，先注入：

```text
你在恢复节点「{{title}}」。
路径：{{path}}
上次停在这里：{{card.tldr}}
已得结论：{{card.points}}
未解问题：{{card.openQuestions}}
最近两轮：{{lastTwoTurns}}

先不要回答问题。用一句话确认你理解的位置，然后问：
“要从哪里继续？”
```

这样“恢复”是一次低成本确认，而不是重读全文。

### 6.5 收口卡生成

- 输入：线程 transcript（或最近 N 轮 + 摘要）、节点目标、路径卡。
- 输出：严格 JSON；用 zod 校验。
- 规则：不引入新事实；只写线程里已经成立的结论；不确定的放 `openQuestions`。
- 失败：重试一次；仍失败则生成手动卡（用户填写）。
- 保存：写入 `cards/<id>.json`，更新节点状态与掌握度。
- 可追溯：`sourceRange` 指向消息 id，UI 可“查看原文”。

### 6.6 子聊天的上下文

子聊天只带：

```
路径卡（祖先链）
+ 父线程摘要 / 最近 2 轮
+ 选中的引用（quote）
+ 兄弟线程一行摘要（防重复）
+ 自己的最近轮次
```

**不带**整棵树、不带其他子聊天的 transcript。这是“关闭即可隔离”的技术基础。

---

## 7. 协议

### 7.1 HTTP 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/ext/atlas/workspaces` | 列出工作区 |
| `POST` | `/ext/atlas/workspaces` | 新建（可带目标） |
| `GET` | `/ext/atlas/workspaces/:id` | 工作区快照（nodes/edges/viewport） |
| `PATCH` | `/ext/atlas/workspaces/:id/viewport` | 保存相机 |
| `POST` | `/ext/atlas/nodes` | 新建节点 |
| `PATCH` | `/ext/atlas/nodes/:id` | 改名、移动、状态 |
| `POST` | `/ext/atlas/nodes/:id/close` | 收口 |
| `GET` | `/ext/atlas/threads/:id` | 线程 + 消息 + 卡片 |
| `POST` | `/ext/atlas/threads/:id/read` | 标记已读 |
| `POST` | `/ext/atlas/threads/:id/turn` | 发送一轮（SSE） |
| `POST` | `/ext/atlas/threads/:id/promote` | 提升为节点 |
| `GET` | `/ext/atlas/search?q=` | 全局搜索 |

### 7.2 SSE

```text
event: meta
data: {"threadId":"t_1","messageId":"m_9","model":"..."}

event: delta
data: {"text":"B+ 树"}

event: card
data: {"id":"c_1","tldr":"...","points":["..."]}

event: done
data: {"usage":{"in":1200,"out":300}}

event: error
data: {"code":"E_MODEL","message":"provider returned 429"}
```

- `meta` 先到，客户端先插入占位消息。
- `delta` 只带增量文本；客户端按 `messageId` 拼接。
- `done` 后客户端拉一次线程摘要/节点统计（或由 host 推送 `node` 事件）。
- 断线：客户端带 `Last-Event-ID` 重连；host 从上次序号继续。

### 7.3 错误码

| code | 含义 |
|---|---|
| `E_AUTH` | 未登录/无 provider |
| `E_MODEL` | 模型调用失败/限流 |
| `E_BUDGET` | 上下文超预算 |
| `E_CONFLICT` | `clientRev` 不匹配 |
| `E_NOT_FOUND` | 节点/线程不存在 |
| `E_UNSUPPORTED` | 当前 DSH 版本不支持该能力 |
| `E_VALIDATION` | 收口卡 JSON 校验失败 |

---

## 8. 画布实现

### 8.1 坐标与相机

- 世界坐标：节点 `{x, y}`，尺寸 `{w: 280, h: 92}`。
- 相机：`{x, y, zoom}`；屏幕坐标 = `world * zoom + camera`。
- 滚轮缩放以鼠标为锚点；拖拽平移；点击节点飞行。
- 相机更新用 `requestAnimationFrame`，只改 CSS transform，不触发 React 全量重渲染。

### 8.2 语义缩放

- 用 `zoom` 切换 CSS class（`far/mid/near`），不是把文字整体缩小。
- `far` 只显示标题；`mid` 标题+副标题；`near` 全卡。
- 低缩放时隐藏边上的标签，只保留线。

### 8.3 布局

- 首次生成：按深度从左到右，叶子按顺序纵向排布。
- 用户拖拽后：位置固定（pin）。
- “整理”：重新计算布局，带动画；只在用户主动点击时执行。
- 新节点：放在父节点右侧、兄弟节点下方；避免重叠（简单碰撞检测 + 偏移）。

### 8.4 渲染与性能

- v1：自绘 DOM + CSS transform + 单个 SVG 边层。
- 只渲染视口 ±1 屏的节点（空间网格索引）；其余用占位。
- 消息列表虚拟化；长线程只渲染可见消息。
- 边在拖动结束后重算，不在每一帧重算。
- 目标：200 节点、10k 消息下平移 55fps；1000 节点作为 v2 目标。

### 8.5 引擎选择

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 自绘 DOM + SVG | 零重依赖、完全可控、包小 | 1000+ 节点要自己做虚拟化 | **v1 采用** |
| tldraw | 成熟无限画布、手柄/箭头/缩放 | 包大、样式定制成本 | v2 适配器 |
| React Flow | 节点图、minimap 内置 | 更像流程图，不是自由画布 | 备选 |

抽象 `CanvasEngine` 接口，v1 自绘，v2 可替换：

```ts
interface CanvasEngine {
  mount(el: HTMLElement): void;
  setNodes(nodes: Node[]): void;
  setCamera(cam: Camera): void;
  fit(padding?: number): void;
  focus(nodeId: string): void;
  onNodeClick(cb: (id: string) => void): void;
  onNodeDrag(cb: (id: string, pos: Point) => void): void;
  screenToWorld(p: Point): Point;
}
```

---

## 9. 搜索与复习

### 9.1 搜索

- 索引范围：节点标题/副标题、线程标题、消息内容、收口卡。
- 中文：字符 bigram；英文：小写词 token；查询用 AND，按字段权重排序。
- 索引持久化到 `index.json`；启动时增量重建（按 `updatedAt`）。
- 目标：10k 消息内查询 <50ms。
- UI：`⌘K` 打开命令面板；结果按“节点 / 标题 / 消息 / 卡片”分组；回车跳转并展开。

### 9.2 复习

- 收口卡 → 生成问答卡：

```json
{
  "question": "为什么 B+ 树的非叶节点不存数据？",
  "answer": "为了让一页装下更多键，降低树高与 I/O 次数。",
  "sourceCardId": "c_1",
  "tags": ["B+树", "页"]
}
```

- FSRS-5：`stability`、`difficulty`、`dueAt`、`lastReview`。
- 评分：Again / Hard / Good / Easy；掌握度用 EWMA 更新。
- 复习模式：到期队列 → 飞到节点 → 测验模式（只显示问题与输入框）→ 评分。
- 导出：CSV（Anki 可导入）；APKG 作为 v2。

---

## 10. 安全与隐私

- **本地优先**：工作区在 `~/.dsh/atlas`；除模型 provider 外不发网络请求。
- **不遥测**：默认关闭；若未来加，必须显式 opt-in。
- **密钥**：使用 DSH 的 provider 配置；Atlas 不存 API key。
- **路径安全**：工作区 id 白名单；禁止 `..`；所有写入限制在 `~/.dsh/atlas` 下。
- **Markdown 渲染**：白名单 sanitize；禁止内联脚本、iframe、事件属性。
- **工具权限**：v1 子聊天不执行写工具；Agent mode（M5）继承 DSH 的审批与权限。
- **日志**：默认不记录消息内容；错误日志只记 id、code、耗时。

---

## 11. 兼容性与版本

- DSH 0.1.x 是 developer preview；API 可能变化。
- `peerDependencies` 固定范围，例如 `>=0.1.0-rc.7 <0.2.0`；CI 跑多个 rc 版本。
- 能力探测：

```ts
const caps = {
  llm: !!ctx.get('llm')?.stream,
  sessionFork: !!ctx.get('session')?.fork,
  portal: !!ctx.get('conversation')?.portal,
};
```

- 缺失能力时：
  - 无 `sessionFork`：只能 Atlas-native；隐藏“Agent mode”。
  - 无 `portal`：对话面板用 Atlas 自己的消息渲染；不嵌入原生会话。
  - 无 `llm.stream`：插件不可用，显示明确错误。

---

## 12. 测试

### 12.1 单元

- 上下文组装：给定 fixture，输出与 golden 一致；预算不超。
- 收口卡：schema 校验、失败降级、sourceRange 正确。
- 存储：迁移、原子写、并发冲突。
- 搜索：中文 bigram、英文 token、排序。
- FSRS：排期与掌握度更新。

### 12.2 集成

- 假 DSH ctx：假 `llm`、假 `session`、临时目录。
- 路由：创建/打开/发送/收口/提升；SSE 帧顺序。
- 断线重连：`Last-Event-ID` 续传。

### 12.3 E2E

- Playwright + 测试 profile；截图对比（画布、对话、子聊天、收口）。
- 交互：点节点 → 面板 → 折叠 → 搜索 → 提升 → 收口。
- 性能脚本：200 节点、10k 消息；记录 FPS、打开耗时、内存。

### 12.4 Golden 文件

`tests/golden/context/*.txt`、`tests/golden/closure/*.json`；PR 修改 prompt 时必须更新并说明。

---

## 13. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M0** | 静态原型（[`prototype.html`](prototype.html)） | 画布/对话/子聊天/收口可点 |
| **M1** | 插件骨架 + 工作区 + 画布 + 节点 CRUD | 安装后可建工作区、加 3 个节点、拖拽、刷新不丢 |
| **M2** | 对话面板 + Atlas-native 线程 + SSE + 收口 | 打开节点、发一轮、流式返回、收口生成卡 |
| **M3** | 子聊天 + 引用 + 提升 + 搜索 | 标题折叠、搜索命中、提升后画布多一个节点 |
| **M4** | 复习（FSRS）+ 导出/导入 + 设置 | 到期队列、评分、导出 `.atlas` |
| **M5** | Agent mode（绑定 DSH session）+ 原生对话 portal | 节点可切 Agent，工具/审批可用 |
| **M6** | 开源发布 | README、demo、CI、LICENSE、贡献指南 |

---

## 14. 风险与开放问题

### 14.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH API 变化 | 插件不可用 | 适配层 + 多版本 CI + 能力探测 |
| 会话续聊限制 | 子聊天无法用 session | v1 用 Atlas-native；M5 再绑定 |
| 画布性能 | 节点多后卡顿 | 视口裁剪、虚拟化、LOD；1000 节点作为 v2 |
| 上下文重复 | Atlas 与 DSH 各存一份 | 每个节点单一真相源；`source` 引用去重 |
| 画布变垃圾场 | 找不到东西 | 过滤、折叠已完成、聚焦路径、搜索 |
| 范围蔓延 | 做不完 | v1 冻结功能；复习放 M4，Agent 放 M5 |
| 商标 | “Atlas” 重名多 | README 加 disclaim；不暗示与 MongoDB Atlas 等关联 |

### 14.2 开放问题

1. 节点主线程默认 Atlas-native 还是 session？——v1 选前者，M5 提供切换。
2. 工具调用/审批如何嵌入对话面板？——M5 用原生 portal；否则只读展示。
3. 子聊天如何“合并”回父线程？——v1 只写收口卡 + 引用，不做自动合并。
4. 多工作区如何切换？——v1 一个活动工作区，多个可存；顶部切换器。
5. 协作？——v2 再考虑 CRDT；v1 文件锁 + 单用户。
6. 移动端？——v2 只读浏览。

---

## 15. 附录

### A. 收口卡 Prompt

```text
你是 Atlas 的收口编辑。给定一段对话、节点目标和祖先路径，输出严格 JSON。

要求：
1. 只写对话里已经成立的结论；不要引入新事实。
2. tldr ≤ 30 个汉字；points 3–7 条，每条 ≤ 40 字。
3. openQuestions 0–3 条；不确定的内容必须放这里。
4. mastery 0–5，并给一句理由。
5. nextHint 是一句“回到上层”的衔接句。
6. sourceRange 用第一条和最后一条消息的 id。

JSON schema:
{
  "tldr": string,
  "points": string[],
  "openQuestions": string[],
  "artifacts": [{"kind":"file|link|code|table|image","ref":string,"label":string}],
  "mastery": number,
  "masteryReason": string,
  "nextHint": string,
  "sourceRange": [string, string]
}
```

### B. 系统 Prompt（Atlas-native）

```text
你是 Atlas 中的学习/分析助手。当前节点：{{node.title}}。
路径：{{path}}。
你的任务：只在这个节点的范围内回答；不要重复祖先节点已经讲过的内容。
需要引用上层时，用一句话带过，并标注来源卡片。
回答尽量短；先给结论，再给 2–4 条要点；需要时给一个例子。
如果用户的问题超出当前节点，提醒他可以“提升为节点”或回到上层。
```

### C. 仓库结构

见 4.2。建议额外包含：

```
.github/workflows/ci.yml
LICENSE
CONTRIBUTING.md
CODE_OF_CONDUCT.md
docs/assets/canvas.png
docs/assets/chat.png
docs/assets/subchat.png
```

### D. README 大纲

1. Atlas 是什么（一句话 + GIF）
2. 截图（画布 / 对话 / 子聊天）
3. 特性
4. 安装（`dsh plugin --profile web add dsh-atlas`）
5. 快速开始（建工作区 → 点节点 → 收口 → 复习）
6. 工作原理（三层模型）
7. 配置
8. 兼容性
9. Roadmap
10. Contributing
11. License
12. Disclaimer（与 MongoDB Atlas 等无关联）

### E. 命名与商标

- 项目名：**Atlas**；中文：**图志**。
- 包名：`dsh-atlas`；仓库：`dsh-atlas`。
- 标语：**把对话长成一张地图。**
- “Atlas” 是常见词，MongoDB Atlas、Atlas Copco 等已使用；开源项目可用，但 README 需注明无关联，商业发行前做商标检索。
- npm 若被占用，使用 scope：`@yourorg/dsh-atlas`。

### F. 参考

- Branchat, CHI EA 2026 — https://dl.acm.org/doi/10.1145/3772363.3798792
- 樹型生成AIチャットインタフェースの有効性検証, JSAI 2026 — https://www.jstage.jst.go.jp/article/pjsai/JSAI2026/0/JSAI2026_5J3OS31b06/_article/-char/ja/
- Anthropic, Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, How we built our multi-agent research system — https://www.anthropic.com/research/multi-agent-research-system
- Canvas Chat — https://github.com/ericmjl/canvas-chat
- Slashspace — https://www.slashspace.ai/
- tldraw branching-chat-template — https://github.com/tldraw/branching-chat-template
- dsh-subtopic — https://github.com/jcx3915-pixel/dsh-subtopic
- dsh-nested-followups — https://github.com/sluminositys/dsh-nested-followups
- Shneiderman, The Eyes Have It: A Task by Data Type Taxonomy — overview / zoom / filter / details-on-demand
- Furnas, Generalized Fisheye Views — focus + context
- FSRS — https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler
