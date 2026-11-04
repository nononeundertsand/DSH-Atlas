# 分开管理节点删除与会话归档

审查日期：2026-11-01。对象：`codex/dsh-session-integration` 当前工作区，包括尚未提交的修改。本轮不修改业务代码、不更新桌面插件、不操作真实用户数据。

以下问题描述保留审查时的快照；后续两个入口的修复结果见文末补充。

## 结论

删除节点不归档 Session 的主通路已经符合最新选择。混乱主要来自：当前会话绑定与历史来源共用一个字段、两套归档入口写入不同状态、DSH 分组缺失被当作删除逻辑树的证据，以及界面仍使用旧语义。

建议保留现有画布、原生聊天、节点回收站和目录布局；增加一份按 Session ID 保存的来源关系，统一归档/恢复服务。不需要引入并行多会话或新 Agent Loop。

## 当前代码的主要问题

### 1. 换成新会话后，旧会话在 Atlas 中失去恢复入口

源码确认：`AtlasStore.replaceSession` 覆盖 `node.sessionId`，清除 `sessionArchivedAt`，只保留一个 `replacedSessionId`；`deletedNodes` 从当前节点字段拼装会话列表；`NodeSessions.unarchiveSession(nodeId)` 恢复的是节点当前 `sessionId`。因此它不能表达“恢复旧 S1，但当前仍绑定 S2”。

- [replaceSession](/Applications/code/DSH-Atlas/src/host/store.ts:396)
- [deletedNodes](/Applications/code/DSH-Atlas/src/host/store.ts:238)
- [unarchiveSession](/Applications/code/DSH-Atlas/src/host/sessions.ts:139)

Fixture 确认：归档 S1、显式创建 S2 后，S1 仍在模拟 DSH 原生归档中，但不在 Atlas 会话列表；调用节点恢复会话接口也不会恢复 S1。日志未被删除，丢失的是 Atlas 的可操作来源记录。

### 2. 两种归档入口产生不同结果

右键经 `NodeSessions.archiveSession` 调用 DSH，再写节点归档标记。会话列表经 `dismissSessions` 调用 DSH 后，只写 `hidden-sessions.json`，没有同样更新节点状态。`GET /trash` 又会对没有本地标记的原生归档会话清除响应中的 sessionId，使会话从列表消失。

- [右键归档服务](/Applications/code/DSH-Atlas/src/host/sessions.ts:127)
- [列表归档存储](/Applications/code/DSH-Atlas/src/host/store.ts:268)
- [列表归档路由](/Applications/code/DSH-Atlas/src/host/routes.ts:102)
- [响应过滤](/Applications/code/DSH-Atlas/src/host/routes.ts:84)

Fixture 确认：从会话列表归档后，原生归档集合包含 Session，本地无 sessionArchivedAt，响应不再包含其 sessionId。这解释了为什么有的归档能看到恢复，有的直接消失。

### 3. 分组删除仍会反向删除逻辑树

`reconcileWorkspaces` 在专属分组缺失时调用 `deleteNode`；`GET /bootstrap`、读取地图和读取回收站都会触发该检查。画布每四秒读取快照，所以读页面可能引发节点子树软删除。

- [缺失分组触发删除](/Applications/code/DSH-Atlas/src/host/sessions.ts:46)
- [bootstrap 入口](/Applications/code/DSH-Atlas/src/host/routes.ts:117)
- [画布刷新](/Applications/code/DSH-Atlas/src/client/AtlasApp.tsx:49)

Fixture 确认：移除模拟 DSH 分组后，只发 GET /bootstrap，就会发现对应节点已有 deletedAt。这是现存行为，并非 DSH 原生要求。建议删除这种反向推断，只将分组标记为已脱离；Atlas 删除节点才是移除逻辑节点的明确入口。

### 4. 界面标签和实际动作冲突

- `NodeLibrary` 的工具栏固定写“全部归档”，节点页却调用永久删除。
- 彻底删除确认写“删除专属目录中的全部文件”，实际 `removeWorkspaces` 明确保留目录。
- `SessionUnavailable` 标题写“会话已删除”，实际是可恢复的归档，且没有恢复入口。
- `isArchived = sessionArchivedAt && !deletedAt` 错误地把“节点已删除且会话已归档”排除在归档状态外；随后会显示“打开会话”，但接口拒绝打开归档 Session。

证据：[NodeLibrary](/Applications/code/DSH-Atlas/src/client/NodeLibrary.tsx:60)、[SessionUnavailable](/Applications/code/DSH-Atlas/src/client/SessionUnavailable.tsx:13)、[removeWorkspaces](/Applications/code/DSH-Atlas/src/host/sessions.ts:106)。以上为源码确认，本轮未启动浏览器复现布局。

### 5. 归档状态存在两个事实来源

本地 sessionArchivedAt 与 DSH archivedSessionIds 并存。原生界面归档/恢复不会必然更新本地标记，导致菜单、打开入口和列表判断不一致。恢复服务还吞掉了重建分组的失败，可能返回成功却没有完成显示分组。

证据：[菜单仅看本地标记](/Applications/code/DSH-Atlas/src/client/NodeActions.tsx:47)、[打开入口同时看两者](/Applications/code/DSH-Atlas/src/host/sessions.ts:156)、[忽略分组恢复错误](/Applications/code/DSH-Atlas/src/host/sessions.ts:149)。

## 推荐的行为契约

| 操作 | 节点 | 会话与分组 |
|---|---|---|
| 删除节点及子树 | 回收站，保留原位置和绑定记录 | 解除对应 DSH 分组；可用会话进入未分组；已归档会话仍归档 |
| 恢复节点 | 恢复原树关系和保留的当前绑定 | 重建分组；未被另行归档的原会话可以继续；不自动取消主动归档 |
| 彻底删除节点 | 永久移除节点 | Session 与 cwd 目录保留；不改变会话自身归档状态 |
| 归档当前会话 | 节点保留，当前绑定清空 | DSH 原生归档；保留来源关系 |
| 创建新会话 | 绑定新 Session | 不继承旧历史，创建失败可重试同一新身份 |
| 恢复旧会话 | 节点存在、未删除且当前无绑定才自动回绑 | 先取消原生归档；若已有 S2 则保留 S2，只恢复 S1 的可用性 |
| 原生删除工作区分组 | 不删除 Atlas 节点 | 只影响分组；需要时显式修复分组 |

同一时刻最多一个当前绑定；允许多条历史来源记录。这是恢复能力所需的元数据，不是多 Agent 运行或同时绑定多个当前会话。

## 最小数据调整

```ts
interface NodeSessionLink {
  sessionId: string
  originNodeId: string
  originWorkspaceId: string
  nodeTitleSnapshot: string
}

interface NodeSessionBinding {
  nodeId: string
  currentSessionId: string | null
}
```

当前绑定可以继续存在节点中，不强求另建一张表；关键是历史来源记录必须独立保存，不能被新建会话覆盖。原生归档状态以 DSH 为准，Atlas 的时间戳仅作显示或操作记录。

归档/恢复命令必须显式携带 Session ID，不能只传 Node ID 并由服务器猜测。写绑定时检查预期当前 Session ID 或版本，避免归档旧 S1 的并发请求把新 S2 标错。批量归档复用单条归档服务；失败逐项保留可重试记录，不用隐藏列表冒充操作成功。

恢复 S1 时若 S2 已绑定，只恢复原生会话，不改绑定、不重建节点。DSH 恢复后的实际分组还受原始 cwd 和原生工作区规则影响，不能承诺任意移到不同路径的工作区。

## 界面建议

- 保留现有两个页签，命名“节点回收站”“会话”；会话页显示“可用 / 已归档”和“当前绑定 / 历史来源”，可以筛选。
- 节点页：恢复节点、彻底删除节点；批量按钮明确叫“彻底删除当前范围节点”。
- 会话页：可用会话显示“打开 / 归档”，归档会话显示“恢复会话”。根据原生状态判断，不能受节点 deletedAt 干扰。
- 无当前会话的节点显示“当前没有会话”，提供“恢复归档会话”“创建新会话”，不再显示“已删除”。
- 恢复结果分别显示“已恢复并绑定到节点”或“会话已恢复，节点仍使用 S2”。

## 调整顺序与验证

1. 先修按钮文案与动作对应，移除分组缺失触发节点删除的副作用。
2. 加入按 Session ID 的来源记录，统一右键、列表、批量归档及恢复入口。
3. 接入原生归档状态刷新，补充绑定的并发检查和分组操作失败反馈。
4. 在复制数据上迁移：从现有 sessionId、replacedSessionId、retained-sessions.json 的明确身份生成来源记录，保留原文件。不能仅凭相同 cwd 猜测更早会话的归属；无法可靠恢复的关系保留为待确认。

关键验收：S1 归档后新建 S2，再恢复 S1，S2 绑定不变且两条来源记录均在；没有新会话时恢复 S1 会回绑；两个归档入口结果一致；归档后删除节点仍能恢复会话；彻底删除节点后会话独立存在；原生分组删除不改变逻辑树；归档与新建并发不会错标新会话；恢复失败不误报成功。

本轮已执行：TypeScript 无输出检查、tests/session-routing.mjs、tests/node-trash.mjs，均通过；另执行了内存构建当前源码的 HTTP fixture 探针并复现上面三个行为。所有探针使用临时目录和模拟 DSH registry，没有真实模型调用，也没有访问或修改真实会话数据。本轮未执行真实 DSH、浏览器或 OS 边界测试。

现有测试通过不能覆盖上述缺口：例如 session-routing 测试还明确期待“原生分组删除导致节点进回收站”，与本次推荐语义相反，应在调整时改成正确行为验收。

## 后续修复：空会话入口与统一归档

- `NodeSessions.sessionState` 从当前绑定和独立来源记录确定待恢复的会话。归档后当前绑定为空时，点击节点返回空会话状态，不再自动尝试旧的固定 Session ID；从未创建会话的节点仍沿用首次创建流程。
- 空会话页面提供“恢复上次会话”和“创建新会话”。显式新建使用不同身份；恢复期间若已有新绑定，不覆盖该绑定。
- 列表及批量归档通过 `archiveStoredSession` 复用右键归档的绑定清理逻辑。已删除节点同样清空当前绑定；历史来源继续保存。已归档的重复请求也会核对绑定，不再直接跳过。
- 新增回归覆盖：归档后普通点击不创建旧身份、空白会话未落盘、不同节点批量归档、重复归档、运行中拒绝，以及回收站节点归档后的绑定清理。
- 验证：`npm run check`；隔离 DSH rc.2 的浏览器实测右键归档 → 点节点 → 显式新建 → 列表归档 → 点节点 → 恢复上次会话，确认原始和新 Session ID 不同且恢复绑定正确。未调用真实模型，未操作真实用户数据，未安装或重启桌面插件。
