# DSH-Atlas

> 把对话长成一张地图。
> A spatial workspace for long conversations.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6ea8fe.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Status: MVP](https://img.shields.io/badge/status-MVP-f2cc60.svg)](#roadmap)

DSH-Atlas 是 **DeepSeek Harness** 的插件：把线性对话组织为一张可缩放的任务地图。

- 每个节点对应一段对话，画布表达任务结构；
- 点击节点，画布保留原位，打开纸张式对话面板；
- 回答中的标题生成目录轨，可跳转定位；
- 任意回答可以**分支**成子聊天，再**提升**为画布子节点；
- 关闭节点时生成**收口卡**，再次打开时先呈现**续接简报**；
- 画布同时作为复习地图：绿色为已收口，蓝色为进行中，灰色为未开始。

设计原则：**树负责结构，栈负责当下，列表负责回访。**

静态交互原型：[`docs/prototype.html`](docs/prototype.html)（单文件、零依赖）。
完整设计：[`docs/design.md`](docs/design.md)。

![Atlas canvas](docs/assets/canvas.png)

## 当前状态

已完成可运行的 MVP（M1 + M2 + M3 基础版）：

| 能力 | 状态 |
|---|---|
| 无限画布：平移、缩放、拖拽、适配、语义缩放 | ✅ |
| 节点 CRUD：新建根/子节点、重命名、移动、删除 | ✅ |
| 对话面板：SSE 流式回答、Markdown 基础排版、目录轨 | ✅ |
| 子聊天：从任意回答分支、继续追问、提升为节点 | ✅ |
| 收口卡：模型生成、失败降级、掌握度、未解问题 | ✅ |
| 续接简报：重新打开已收口节点时展示 | ✅ |
| 搜索：节点、消息、收口卡 | ✅ |
| 本地优先：`~/.dsh/atlas` 文件存储 | ✅ |
| 复习（FSRS）、导出/导入、Agent mode | 未开始 |

Host 端有端到端冒烟测试（真实 HTTP + SSE + 假模型），见 [`tests/smoke.mjs`](tests/smoke.mjs)。
浏览器端按 DSH 0.2.1 的 `dsh.client` / `__ModuleLoader__` / slot 协议构建。

已在 **DSH `0.2.1-rc.2` + 真实 `deepseek-flash`** 上实测：

- `dsh plugin --profile web add .` 成功，Boot graph 包含 `dsh-atlas`；
- 组合模块 URL `/plugins/??dsh-atlas/client.js` 返回 200；
- 无头浏览器加载 `/#atlas` 后，页面出现 `.atlas-app` 与 `.atlas-canvas`；
- 真实模型 SSE 流式返回，收口卡生成并校验成功。

## 安装

需要 DeepSeek Harness `0.2.x`、Node.js `22.19+`、npm；DSH 的插件管理器还要求 `pnpm` 在 PATH 中。

```bash
# 直接填 GitHub 仓库（推荐给普通用户；请使用 github:owner/repo 形式）
dsh plugin --profile web add github:nononeundertsand/DSH-Atlas

# 或者从本地源码安装（开发时用）
git clone https://github.com/nononeundertsand/DSH-Atlas.git
cd DSH-Atlas
npm install
npm run check          # typecheck + build + 冒烟测试
dsh plugin --profile web add .
dsh web
```

打开 DSH Web 后，左侧边栏会出现 **Atlas · 图志** 图标。
访问 `http://127.0.0.1:<port>/#atlas` 也可以直接打开地图面板。

> 如果本机还没有 `dsh` 命令，可先安装：
> `npm install -g @deepseek-ai/dsh@0.2.1-rc.2`。
> DSH 仍处于 developer preview，插件 API 可能随版本变化。

### 可选配置

在 profile 的 `cordis.patch.yml` 中覆盖默认模型或数据目录：

```yaml
- id: atlas
  config:
    provider: deepseek-official
    model: deepseek-flash
    # dataDir: D:/atlas-data
    # maxTokens: 1600
```

不填 `provider` / `model` 时，Atlas 自动选择第一个可用 provider 的模型。
如果没有可用模型，对话会返回明确的 `E_AUTH` / `E_MODEL` 错误，画布与收口降级仍可用。

## 快速开始

1. 打开 Atlas，输入第一个模块，例如「02 索引」。
2. 点击节点进入对话，问「B+ 树为什么把数据放在叶子节点？」。
3. 在回答下方点「分支」，把「页分裂」展开成子聊天。
4. 子聊天里继续追问，然后点「提升为节点」，画布上多一个子节点。
5. 回到主节点，点右上角「收口」；节点变绿，生成结论、要点、未解问题与掌握度。
6. 再次打开该节点，先看到续接简报；点「重新打开」即可继续追问。
7. 顶部搜索框可搜索节点、消息与收口卡。

## 工作原理

```
L0 画布   任务地图（数据库 8 个模块）
L1 节点   模块对话（02 索引 → B+ 树）
L2 标题   子问题（页分裂 / 聚簇索引）
L3+       不再嵌套，改为「提升为节点」
```

- 画布负责**广度**，节点内标题负责**深度**。
- 每个节点是独立的上下文边界：祖先节点只传递收口卡，不传完整 transcript。
- 子聊天只携带「路径卡 + 父线程最近两轮 + 引用 + 自己的轮次」。
- 关闭不等于删除，而是**收口**：生成一张卡，作为节点在树中的标识。
- 提升为节点时复制子聊天消息与引用，父节点只保留一条引用关系，避免上下文污染。

## 架构

```
dsh-atlas/
├─ cordis.patch.yml        # 单包插件注册（Host + 浏览器半）
├─ package.json            # dsh.bundle / dsh.client 声明
├─ scripts/build.mjs       # esbuild：Host ESM + 浏览器 __ModuleLoader__ 包装
├─ src/
│  ├─ host/
│  │  ├─ index.ts          # 插件入口：路由注册
│  │  ├─ routes.ts         # /ext/atlas/*、JSON、SSE
│  │  ├─ store.ts          # 工作区/节点/线程/消息/卡片文件存储
│  │  ├─ context.ts        # 上下文组装与预算裁剪
│  │  ├─ closure.ts        # 收口卡生成、校验、降级
│  │  ├─ actions.ts        # 提升为节点
│  │  └─ model.ts          # LlmPort 适配：路由选择、流式、JSON
│  ├─ client/
│  │  ├─ index.tsx         # 注册 main 面板与 sidebar.panellist 图标
│  │  ├─ AtlasApp.tsx      # 主面板、工作区、搜索、对话框
│  │  ├─ Canvas.tsx        # 相机、平移缩放、拖拽、边、LOD
│  │  ├─ ChatSheet.tsx     # 对话、目录轨、收口卡、子聊天
│  │  ├─ api.ts            # HTTP + SSE 客户端
│  │  ├─ markdown.tsx      # 轻量 Markdown 与标题提取
│  │  └─ styles.ts         # 作用域化 CSS
│  └─ shared/
│     ├─ types.ts          # 领域类型
│     ├─ protocol.ts       # 路由与限制
│     └─ dsh.ts            # DSH 适配端口（webServer / llm / slots）
├─ tests/smoke.mjs         # 真实 HTTP + SSE 的端到端冒烟
└─ docs/
```

### 本地存储

```
~/.dsh/atlas/workspaces/<workspace-id>/
  workspace.json           # 元数据、目标、rev
  nodes.json               # 节点与位置
  threads.json             # 主线程与子聊天元数据
  viewport.json            # 相机
  threads/<thread-id>.jsonl # 追加写消息
  cards/<node-id>.json     # 收口卡
```

整文件写入使用 `write temp → rename`；消息追加写；单进程内用 Promise 队列串行化写操作。

### HTTP 与 SSE

所有请求走同源 `/ext/atlas/*`，由 DSH `webServer` 承载：

- `GET /bootstrap`：工作区列表与当前快照；
- `POST /nodes`、`PATCH /nodes/:id`、`DELETE /nodes/:id`；
- `POST /nodes/:id/close`：收口；
- `GET /threads/:id`：线程、消息、卡片、路径、子聊天；
- `POST /threads/:id/turn`：SSE（`meta → delta* → done/error`）；
- `POST /threads/:id/promote`：提升为节点；
- `GET /search?q=`：节点、消息、卡片搜索。

## 开发

```bash
npm install
npm run typecheck    # TypeScript
npm run build        # lib/host/index.js + lib/client.js
npm run smoke        # 端到端冒烟
npm run check        # 三者一起跑
npm run dev          # Host watch（客户端改动后需再跑一次 build）
```

`lib/` 是构建产物。为了让 `dsh plugin add <GitHub URL>` 对其他人直接可用，仓库会保留构建后的 `lib/`；修改源码后请运行 `npm run build`，并提交更新后的 `lib/`。

### 浏览器插件协议

- `package.json` 的 `dsh.client` 声明平台与依赖顺序；
- `lib/client.js` 由 esbuild 打成 CJS，再包进 `window.__ModuleLoader__.load({ id, factory })`；
- React、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-*` 等由 DSH 平台模块表提供，不打进 bundle；
- 面板注册在 `main` 的 `atlas` key，侧边栏图标注册在 `sidebar.panellist`。

## 兼容性

- 目标版本：DeepSeek Harness `0.2.x`（在 `0.2.1-rc.2` 的插件约定上实现）。
- DSH `0.1.x` 的 slot 名称、SSE 与模型 API 可能不同；如需兼容旧版，应在 [`src/shared/dsh.ts`](src/shared/dsh.ts) 适配层中补端口，而不是改业务代码。
- 能力缺失时：
  - 无 `llm`：Host 插件等待该服务；对话返回明确错误，画布仍可使用；
  - 无 `webServer`：插件不会加载（Atlas 需要 HTTP 路由）；
  - 无 `layout` / `slots`：浏览器半不会挂载。

## Roadmap

- [x] **M0** 静态原型
- [x] **M1** 插件骨架 + 工作区 + 画布 + 节点 CRUD
- [x] **M2** 对话面板 + Atlas-native 线程 + SSE + 收口
- [x] **M3（基础版）** 子聊天 + 引用 + 提升 + 搜索
- [ ] **M4** 复习（FSRS）+ 导出/导入 + 设置页
- [ ] **M5** Agent mode（绑定 DSH session）+ 原生对话 portal
- [ ] **M6** 开源发布：CI、截图回归、npm 发布

## 已知限制（MVP 有意收敛）

- 标题目前生成**目录轨**，尚未实现“标题折叠为子聊天块”；子聊天从回答的「分支」按钮创建。
- 子聊天只有一层；更深层请「提升为节点」。
- Markdown 渲染器覆盖标题、列表、引用、代码块与行内强调，不包含表格、脚注、数学公式。
- SSE 不支持断线续传；页面刷新后会重新拉取完整线程。
- 收口卡由模型生成；模型不可用时降级为基于最近回答的手动卡。
- 暂不支持多用户、CRDT、移动端。
- 搜索为本地逐条匹配，面向 10k 消息以内；更大规模需要索引。

## 隐私与安全

- **本地优先**：工作区存储在 `~/.dsh/atlas`，除模型 provider 外不发网络请求。
- **不遥测**：插件不采集消息内容；日志只打印工作区路径。
- **路由边界**：`/ext/atlas/*` 不带额外鉴权，默认只在 DSH 的 loopback 监听下使用。若把 DSH 绑定到非回环地址，请在前面加反向代理鉴权。
- **Markdown**：使用自绘渲染器，不执行内联脚本、iframe 或事件属性。
- **模型上下文**：祖先节点只发送收口卡；节点边界是硬边界，不跨节点压缩。

## 贡献

提交 PR 前请确保 `npm run check` 通过。设计层面的讨论请通过 Issue 提交。

## 许可证

[MIT](LICENSE)

## Disclaimer

“Atlas” 是常见词，本项目与 MongoDB Atlas、Atlas Copco 等无任何关联。
