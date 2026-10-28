# DSH-Atlas

> 把对话长成一张地图。
> A spatial workspace for long conversations.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6ea8fe.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Status: alpha](https://img.shields.io/badge/status-alpha-f2cc60.svg)](#roadmap)

DSH-Atlas 是 **DeepSeek Harness** 的插件，将线性对话组织为一张可缩放的任务地图。

- 每个节点对应一段对话，画布表达任务结构；
- 点击节点，相机飞入并打开对话面板；
- 对话内的标题可折叠为**子聊天**，层级组织方式与文档标题一致；
- 关闭节点时生成**收口卡**，再次打开时先呈现**续接简报**；
- 画布同时作为复习地图：绿色为已收口，蓝色为进行中，灰色为未开始。

设计原则：**树负责结构，栈负责当下，列表负责回访。**

交互原型：[`docs/prototype.html`](docs/prototype.html)（单文件、零依赖，可直接在浏览器中打开）。

![Atlas canvas](docs/assets/canvas.png)

## 背景

线性聊天界面把多层级的任务压缩为一条时间线，由此产生三个问题：

- 无法判断“某个知识点属于哪个模块”，只能回溯历史消息；
- 深入子问题时需要另开窗口，返回主线时上下文已经丢失；
- 会话结束后缺乏可恢复的状态，数日后需重读大量消息。

Atlas 将结构显式化：**画布承载广度，节点承载模块，标题承载子问题**。层级超过三层时，通过“提升为节点”把深度转换为广度，以维持空间位置感。

## 功能

- **无限画布**：平移、缩放、拖拽节点、适配视图；语义缩放，远景显示标题，近景显示完整卡片。
- **节点即对话**：点击节点进入对话面板，关闭后返回画布原位，相机位置保留。
- **标题折叠**：对话内标题可折叠、可搜索，并提供目录轨；标题下可继续展开子聊天。
- **收口卡**：关闭节点时生成结论、未解问题、掌握度与衔接句，并记录可追溯的消息范围。
- **续接简报**：重新打开节点时呈现“上次停在哪里、还有哪些问题未解决”。
- **提升为节点**：将子聊天转为画布子节点，控制嵌套深度。
- **本地优先**：工作区存放于 `~/.dsh/atlas`，支持导出与迁移；除模型 provider 外不发起网络请求。
- **复习**（M4）：由收口卡生成问答卡，按 FSRS 排期，画布即为复习地图。

![Chat sheet](docs/assets/chat.png)

![Nested sub-chat](docs/assets/subchat.png)

## 安装

> 当前处于早期开发阶段，仅提供静态原型，插件尚未发布至 npm。以下为目标安装方式。

```bash
dsh plugin --profile web add dsh-atlas
```

从源码安装：

```bash
git clone https://github.com/DSH-Atlas/dsh-atlas.git
cd dsh-atlas
pnpm install
pnpm run check
dsh plugin --profile web add .
```

环境要求：DeepSeek Harness `0.1.x`、Node.js `22.19+`、pnpm。

## 快速开始

1. 新建工作区并输入目标，例如“八周内完成数据库的八个模块”。
2. 由模型生成模块清单，确认后在画布上生成对应节点。
3. 点击“02 索引”进入对话；在 B+ 树的回答中展开子聊天“页分裂”。
4. 完成后执行“收口”，得到结论与未解问题。
5. 将“页分裂”提升为节点，成为画布上的子节点。
6. 一周后打开 Atlas，节点显示“3 轮 · 掌握 3/5”；进入前先阅读续接简报。

## 工作原理

```
L0 画布   任务地图（数据库 8 个模块）
L1 节点   模块对话（02 索引 → B+ 树）
L2 标题   子问题（页分裂 / 聚簇索引）
L3+       不再嵌套，改为「提升为节点」
```

- 画布负责**广度**，节点内标题负责**深度**。
- 每个节点是独立的上下文边界：祖先节点只传递收口卡，不传递完整 transcript。
- 子聊天仅携带“路径卡 + 父线程摘要 + 选中引用”，不携带整棵对话树。
- 关闭不等于删除，而是**收口**：生成一张卡，作为节点在树中的标识。

完整设计见 [`docs/design.md`](docs/design.md)。

## 项目结构

```
dsh-atlas/
├─ src/
│  ├─ host/       # 路由、存储、上下文组装、收口生成、模型与会话适配
│  ├─ client/     # 画布、对话面板、目录轨、客户端状态
│  └─ shared/     # 类型与协议定义
├─ tests/
└─ docs/
   ├─ design.md
   ├─ prototype.html
   └─ assets/
```

目录说明详见 [`docs/design.md` §4.2](docs/design.md)。

## 兼容性

DeepSeek Harness `0.1.x` 处于 developer preview 阶段，API 可能发生变更。Atlas 通过适配层隔离版本差异，并在启动时探测 `llm.stream`、`session.fork`、`conversation.portal` 等能力：能力缺失时自动降级（例如仅提供 Atlas-native 线程、隐藏 Agent mode），`llm.stream` 不可用时插件明确报错并拒绝加载。

## Roadmap

- [x] **M0** 静态原型：画布 / 对话 / 子聊天 / 收口（[`docs/prototype.html`](docs/prototype.html)，截图位于 `docs/assets`）
- [ ] **M1** 插件骨架 + 工作区 + 画布 + 节点 CRUD
- [ ] **M2** 对话面板 + Atlas-native 线程 + SSE + 收口
- [ ] **M3** 子聊天 + 引用 + 提升 + 搜索
- [ ] **M4** 复习（FSRS）+ 导出/导入
- [ ] **M5** Agent mode（绑定 DSH session）+ 原生对话 portal
- [ ] **M6** 开源发布：文档、demo、CI

## 开发

> 当前为 M0，仓库仅包含设计文档、原型与截图；下列命令在 M1 落地后可用。

```bash
pnpm install
pnpm run check      # lint + typecheck + test + build
pnpm run dev        # 开发模式
```

## 贡献

提交 Pull Request 前请确保 `pnpm run check` 通过。设计层面的讨论与问题反馈请通过 Issue 提交。

## 许可证

[MIT](LICENSE)
