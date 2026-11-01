# 点击节点打开 DSH Session：实现与验证

分支：`codex/dsh-session-integration`。适配版本：DSH Desktop/Web `0.2.1-rc.2`。

## 实现

- 画布点击调用 `POST /ext/atlas/nodes/:id/session`。Host 的 `NodeSessions` 使用原生 `sessionController.create` 创建普通 Session，保留宿主 preset 组合。每节点拥有单独的本地工作目录和 DSH Workspace 注册，保证原生空白会话的输入框可用。
- 节点保存唯一 `sessionId`，同时打开请求合并；固定 `atlas-<nodeId>` 身份允许空白创建失败后重试，不自动接受宿主返回的替代 Session ID。普通 PATCH 无法修改此绑定。
- 已绑定会话先经 controller.inspect 检查；原生 UI 的正常打开/发送路径承担 Agent 恢复。没有 parentAgent 或 Fork 操作。
- Client 刷新 Session catalog 后，使用 `uiWorkspace.openSession` 打开原生 Conversation。`sidebar.workspaces` 通过 priority -10 遮盖原工作区区域；退出 Atlas 导航会撤销遮盖，原注册不删除。
- 树显示父节点、同父兄弟及当前节点的直接子节点；支持多层继续创建、右键创建子节点、返回画布和返回 DSH 工作区。侧栏收起时使用 DSH 的展开按钮。
- 旧 Thread、消息、引用、卡片和坐标保留。查看旧对话为只读，已绑定节点的 Atlas-native turn 接口拒绝继续发送。新消息与工具记录只由 DSH Session 管理；没有自动导入旧历史或自动复制父历史。

## 验证

### 业务与既有回归

`npm run check`：类型检查、构建、旧 Atlas HTTP/SSE 冒烟，以及 `tests/session-routing.mjs`。后者覆盖并发打开、重复打开复用、空白 Session 重建、创建失败不写绑定、PATCH 无法伪造绑定。

### 真实 DSH 组件配模拟模型

`npm run test:dsh`（需先在 tests/dsh-fixture 安装锁定依赖）：临时 AtlasStore 节点绑定到真实 DSH Session；真实 Agent Loop 调度测试工具，固定授权文件写入成功、未授权文件不变；释放与恢复同一 Session，重新建立隔离 Host Context 后仍能从 JSONL 恢复。模型是模拟的，工具是测试专用工具，非真实内置文件工具与 OS 隔离验收。

### 运行与浏览器确认

本轮从本机官方 rc.2 Desktop 包提取运行库到临时目录，使用临时 DSH_HOME、DSH_AGENTS_HOME 和单独 Web 端口启动完整 Web profile；关闭版本检测、产品及 Session 遥测。没有读取真实模型密钥、发送外部消息或发起付费模型请求。

实际浏览器完成：画布创建 Root 测试 → 原生输入框；原生输入发送测试消息 → DSH Agent 调用 `atlas_fixture_echo` → 原生工具卡与最终回答；左树创建 A 测试并打开独立空白 Session → 返回 Root 仍见原消息；刷新后恢复树与原历史。截图见 [实际界面](assets/session-tree-native.png)。临时离线模型插件保存在 `tests/dsh-fixture/web-plugin.mjs`，只应加载到隔离测试 profile。

## 边界

本次没有安装或迁移用户真实 Desktop profile。源码和构建产物在当前分支；真实 App 中原有已安装包仍是旧版本，需要通过插件管理器安装此分支或本地 checkout，再重启/重新加载。

工具权限沿用 DSH 的配置和审批。独立 cwd/Workspace 不代表兄弟读取隔离、细粒度目录 ACL 或系统级沙箱证明；本插件没有新增在卸载后仍强制有效的节点权限机制。未验证真实模型、全部附件格式、真实网页抓取、所有审批交互、Windows/Linux 边界。未实现版本化上下文包、成果待审、节点移动或旧数据迁移；这些不计入本次点击跳转功能。

已使用或有历史的 Session 若绑定冲突不会静默替换。工作目录按节点独立新建，暂不支持选择现有代码目录；源码实验 A/B 的隔离与合并应另行实现，不应把当前目录安排视为已完成。

## 在 Desktop 使用本地分支

当前分支尚未推送或发布。可用 Desktop 自带的 CLI 将本地 checkout 作为插件安装：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "file:/Applications/code/DSH-Atlas"
```

安装后重启 DSH，再进入 Atlas 点击节点。此命令会更改 Desktop profile 的插件依赖，不能把它当成真实数据迁移。本轮没有自动执行此命令或中断用户正在运行的 Desktop 会话。
