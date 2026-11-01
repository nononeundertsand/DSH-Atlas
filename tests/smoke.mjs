/**
 * 无 DSH 依赖的端到端冒烟测试。
 *
 * 用假的 cordis ctx（webServer + effect + llm）加载构建后的 Host 半，
 * 再通过真实 HTTP 请求走完核心闭环。这样在没有安装 DSH 的机器上
 * 也能验证路由、存储、SSE、收口、提升与搜索。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/host/index.js'

const temp = await mkdtemp(join(tmpdir(), 'dsh-atlas-smoke-'))
const routes = []
let seenUserText = ''
const fakeLlm = {
  listProviders: () => [{ id: 'fake', name: 'Fake' }],
  listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
  async *stream({ system, messages }) {
    seenUserText = [...messages].reverse().find((message) => message.role === 'user')?.content?.[0]?.text ?? ''
    const text = system.includes('收口编辑')
      ? JSON.stringify({
          tldr: 'B+ 树用页分裂维持平衡',
          points: ['数据都在叶子节点', '页分裂保持树高稳定', '非叶节点只存键'],
          openQuestions: ['什么情况下会触发合并？'],
          artifacts: [],
          mastery: 3,
          masteryReason: '能解释结构与触发条件。',
          nextHint: '回到索引模块，比较 LSM。',
        })
      : '## 结论\nB+ 树把数据放在叶子节点。\n\n- 页分裂维持平衡\n- 非叶节点只存键'
    yield { type: 'text-delta', text }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const archivedSessionIds = []
const nativeWorkspaces = new Map()
const liveSessionIds = new Set()
let running = false
const ctx = {
  agents: { get: () => ({status: running ? 'running' : 'idle'}) },
  sessionController: { create: async ({sessionId}) => {liveSessionIds.add(sessionId);return {sessionId}}, inspect: async id => {if(!liveSessionIds.has(id)){class ApiSessionNotFound extends Error{};throw new ApiSessionNotFound('missing')}return {}} },
  workspaceRegistry: { create: async path => { let item=[...nativeWorkspaces.values()].find(w=>w.path===path); if(!item){item={id:'native-'+nativeWorkspaces.size,path,sessionIds:[],attachSession:async()=>{}};nativeWorkspaces.set(item.id,item)}return item }, list: () => [...nativeWorkspaces.values()], delete: async id => nativeWorkspaces.delete(id), archivedSessionIds, unarchiveSession: async id => { const i=archivedSessionIds.indexOf(id); if(i>=0) archivedSessionIds.splice(i,1) }, archiveSession: async id => { if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id) } },
  webServer: {
    register(route) {
      routes.push(route)
      return () => undefined
    },
  },
  effect(fn) {
    return fn()
  },
  llm: fakeLlm,
}

apply(ctx, { dataDir: temp, provider: 'fake', model: 'fake-model' })
assert.equal(routes.length, 1, '应注册一条 Atlas 前缀路由')

const handler = routes[0].handler
const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'E_INTERNAL', message: String(error) } }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function json(path, init) {
  const response = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await response.json()
  assert.equal(response.ok, true, `${path} 失败：${JSON.stringify(body)}`)
  return body
}

function passed(step) {
  console.log(`  ✓ ${step}`)
}

try {
  const boot = await json('/ext/atlas/bootstrap')
  assert.ok(boot.snapshot.workspace.id.startsWith('w_'))
  passed('bootstrap 自动创建工作区')

  const created = await json('/ext/atlas/nodes', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: boot.snapshot.workspace.id, title: '02 索引' }),
  })
  const node = created.node
  assert.equal(node.status, 'seed')
  assert.ok(node.threadId.startsWith('t_'))
  passed('创建根节点与主线程')

  const firstThread = await json(`/ext/atlas/threads/${node.threadId}`)
  assert.equal(firstThread.snapshot.messages.length, 0)

  const turnResponse = await fetch(`${base}/ext/atlas/threads/${node.threadId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '为什么非叶节点不存数据？' }),
  })
  const sse = await turnResponse.text()
  assert.match(sse, /event: meta/)
  assert.match(sse, /event: delta/)
  assert.match(sse, /event: done/)
  assert.match(seenUserText, /为什么非叶节点不存数据/, '新问题必须进入模型上下文')
  passed('SSE 一轮对话（含最新用户消息）')

  const afterTurn = await json(`/ext/atlas/threads/${node.threadId}`)
  assert.equal(afterTurn.snapshot.messages.length, 2)
  assert.equal(afterTurn.snapshot.node.status, 'active')
  assert.match(afterTurn.snapshot.messages[1].content, /B\+ 树/)
  passed('消息落盘并更新节点状态')

  const closed = await json(`/ext/atlas/nodes/${node.id}/close`, {
    method: 'POST',
    body: JSON.stringify({ threadId: node.threadId }),
  })
  assert.equal(closed.card.tldr, 'B+ 树用页分裂维持平衡')
  assert.equal(closed.node.status, 'closed')
  assert.equal(closed.node.mastery, 3)
  passed('收口卡生成并关闭节点')

  const sub = await json('/ext/atlas/threads', {
    method: 'POST',
    body: JSON.stringify({ nodeId: node.id, title: '页分裂的触发条件', anchorMessageId: afterTurn.snapshot.messages[1].id }),
  })
  await fetch(`${base}/ext/atlas/threads/${sub.thread.id}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '页分裂具体什么时候发生？' }),
  }).then((response) => response.text())
  const promoted = await json(`/ext/atlas/threads/${sub.thread.id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ threadId: sub.thread.id }),
  })
  assert.equal(promoted.node.parentId, node.id)
  assert.equal(promoted.node.title, '页分裂的触发条件')
  passed('子聊天创建、追问并提升为子节点')

  const moved = await json(`/ext/atlas/nodes/${node.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ position: { x: 320, y: 180 } }),
  })
  assert.deepEqual(moved.node.position, { x: 320, y: 180 })
  passed('节点位置写回')

  const search = await json(`/ext/atlas/search?q=${encodeURIComponent('页分裂')}&workspaceId=${boot.snapshot.workspace.id}`)
  assert.ok(search.hits.length >= 1)
  assert.ok(search.hits.some((hit) => hit.nodeId === node.id))
  passed('跨节点/消息/卡片搜索')

  const preview = await json(`/ext/atlas/nodes/${promoted.node.id}/delete-preview`)
  const deleted = await json(`/ext/atlas/nodes/${promoted.node.id}`, { method: 'DELETE', body: JSON.stringify({token: preview.token}) })
  assert.deepEqual(deleted.deleted, [promoted.node.id])
  const finalSnapshot = await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)
  assert.equal(finalSnapshot.snapshot.nodes.length, 1)
  passed('删除节点')

  let bound = await json(`/ext/atlas/nodes/${node.id}/session`, {method:'POST'})
  const boundSessionId = bound.node.sessionId
  const plan = await json(`/ext/atlas/nodes/${node.id}/delete-preview`)
  running = true
  const blocked = await fetch(`${base}/ext/atlas/nodes/${node.id}`, {method:'DELETE',body:JSON.stringify({token:plan.token})})
  assert.equal(blocked.status,409)
  running = false
  await json(`/ext/atlas/nodes/${node.id}`, {method:'DELETE',body:JSON.stringify({token:plan.token})})
  const trash = await json('/ext/atlas/trash')
  assert.equal(trash.version,8)
  assert.ok(!archivedSessionIds.includes(boundSessionId),'删除节点不归档其绑定 Session')
  assert.equal((await json('/ext/atlas/trash')).nodes.find(n => n.id === node.id).sessionId, boundSessionId, '删除节点保留绑定记录')
  await json(`/ext/atlas/nodes/${node.id}/restore`,{method:'POST'})
  assert.ok((await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)).snapshot.nodes.some(n=>n.id===node.id))
  const reopened = await json(`/ext/atlas/nodes/${node.id}/session`,{method:'POST'})
  assert.equal(reopened.node.sessionId, boundSessionId, '恢复节点继续绑定原 Session')
  passed('运行中拒绝删除、删除不归档、恢复回绑原会话')

  // 归档会话：节点保留，Session 进原生归档，节点当前绑定清空
  await json(`/ext/atlas/nodes/${node.id}/archive-session`,{method:'POST',body:JSON.stringify({sessionId:boundSessionId})})
  assert.ok(archivedSessionIds.includes(boundSessionId),'归档会话进入原生归档')
  assert.equal((await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)).snapshot.nodes.some(n=>n.id===node.id),true,'归档会话保留节点')
  assert.equal((await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)).snapshot.nodes.find(n=>n.id===node.id).sessionId,undefined,'归档清空节点当前绑定')
  // 会话页应包含该归档会话（历史来源）
  const sessionList = (await json('/ext/atlas/trash')).sessions
  assert.ok(sessionList.some(s => s.sessionId === boundSessionId && s.archived), '归档会话出现在会话页且标记已归档')
  // 恢复归档会话：节点当前无绑定，应回绑
  await json(`/ext/atlas/unarchive-session`,{method:'POST',body:JSON.stringify({sessionId:boundSessionId})})
  assert.ok(!archivedSessionIds.includes(boundSessionId),'恢复归档会话取消归档')
  assert.equal((await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)).snapshot.nodes.find(n=>n.id===node.id).sessionId, boundSessionId, '恢复后回绑原会话')
  passed('归档会话与恢复归档会话')

  // 归档 S1 后新建 S2，再恢复 S1：S2 绑定不变，两条来源都在
  await json(`/ext/atlas/nodes/${node.id}/archive-session`,{method:'POST',body:JSON.stringify({sessionId:boundSessionId})})
  const s2 = await json(`/ext/atlas/nodes/${node.id}/new-session`,{method:'POST',body:JSON.stringify({expectedSessionId:boundSessionId})})
  const s2Id = s2.node.sessionId
  assert.notEqual(s2Id, boundSessionId)
  const unarchiveS1 = await json(`/ext/atlas/unarchive-session`,{method:'POST',body:JSON.stringify({sessionId:boundSessionId})})
  assert.equal(unarchiveS1.rebound, false, '已绑定 S2 时恢复 S1 不回绑')
  assert.equal((await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)).snapshot.nodes.find(n=>n.id===node.id).sessionId, s2Id, '节点仍绑定 S2')
  const afterLinks = (await json('/ext/atlas/trash')).sessions
  assert.ok(afterLinks.some(s => s.sessionId === boundSessionId), 'S1 来源记录仍在')
  assert.ok(afterLinks.some(s => s.sessionId === s2Id), 'S2 来源记录仍在')
  passed('归档 S1 后新建 S2 并恢复 S1，不覆盖 S2')

  const batchNode=(await json('/ext/atlas/nodes',{method:'POST',body:JSON.stringify({workspaceId:boot.snapshot.workspace.id,title:'列表归档回归'})})).node
  const batchSession=(await json(`/ext/atlas/nodes/${batchNode.id}/session`,{method:'POST'})).node.sessionId
  const batchNode2=(await json('/ext/atlas/nodes',{method:'POST',body:JSON.stringify({workspaceId:boot.snapshot.workspace.id,title:'批量归档回归'})})).node
  const batchSession2=(await json(`/ext/atlas/nodes/${batchNode2.id}/session`,{method:'POST'})).node.sessionId
  running=true
  const batchBlocked=await fetch(`${base}/ext/atlas/trash/sessions`,{method:'POST',body:JSON.stringify({sessionIds:[batchSession]})})
  assert.equal(batchBlocked.status,409)
  running=false
  assert.ok(!archivedSessionIds.includes(batchSession))
  assert.equal((await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)).snapshot.nodes.find(n=>n.id===batchNode.id).sessionId,batchSession)
  await json('/ext/atlas/trash/sessions',{method:'POST',body:JSON.stringify({sessionIds:[batchSession,batchSession,batchSession2]})})
  assert.equal((await json(`/ext/atlas/nodes/${batchNode2.id}/session-state`)).node.sessionId,undefined,'批量中的不同节点均清空绑定')
  await json('/ext/atlas/trash/sessions',{method:'POST',body:JSON.stringify({sessionIds:[batchSession]})})
  const state=await json(`/ext/atlas/nodes/${batchNode.id}/session-state`)
  assert.equal(state.node.sessionId,undefined,'列表归档同样清空当前绑定')
  assert.equal(state.archivedSessionId,batchSession)
  const gate=await fetch(`${base}/ext/atlas/nodes/${batchNode.id}/session`,{method:'POST'})
  assert.equal(gate.status,409)
  assert.equal((await gate.json()).error.code,'E_SESSION_ARCHIVED')
  const batchRecord=(await json('/ext/atlas/trash')).sessions.find(s=>s.sessionId===batchSession)
  assert.equal(batchRecord.isCurrent,false)
  assert.equal(batchRecord.archived,true)
  const restoredBatch=await json('/ext/atlas/unarchive-session',{method:'POST',body:JSON.stringify({sessionId:batchSession})})
  assert.equal(restoredBatch.rebound,true)
  const batchNewPlan=await json(`/ext/atlas/nodes/${batchNode.id}/delete-preview`)
  await json(`/ext/atlas/nodes/${batchNode.id}`,{method:'DELETE',body:JSON.stringify({token:batchNewPlan.token})})
  await json('/ext/atlas/trash/sessions',{method:'POST',body:JSON.stringify({sessionIds:[batchSession]})})
  assert.equal((await json('/ext/atlas/trash')).nodes.find(n=>n.id===batchNode.id).sessionId,undefined,'列表归档也会清空已删除节点的当前绑定')
  passed('列表归档统一清空绑定、空会话入口和重复请求')

  const promotedBatch = trash.nodes.find(n => n.id === promoted.node.id).deletionBatchId
  await json(`/ext/atlas/nodes/${promoted.node.id}/purge`, {method:'POST',body:JSON.stringify({batchId:promotedBatch})})
  const newPlan = await json(`/ext/atlas/nodes/${node.id}/delete-preview`)
  await json(`/ext/atlas/nodes/${node.id}`, {method:'DELETE',body:JSON.stringify({token:newPlan.token})})
  const rootBatch = (await json('/ext/atlas/trash')).nodes.find(n => n.id === node.id).deletionBatchId
  await json('/ext/atlas/trash/purge', {method:'POST',body:JSON.stringify({targets:[{id:node.id,batchId:rootBatch}]})})
  assert.ok(!archivedSessionIds.includes(s2Id),'彻底删除节点不归档 Session')
  assert.ok((await json('/ext/atlas/trash')).nodes.find(n => n.id === node.id).purgedAt)
  // 彻底删除节点后恢复 S2，不重建节点
  const purgeThenUnarchive = await json(`/ext/atlas/unarchive-session`,{method:'POST',body:JSON.stringify({sessionId:s2Id})})
  assert.equal(purgeThenUnarchive.rebound, false, '彻底删除节点后恢复会话不重建节点')
  passed('彻底删除节点并保留会话入口')
  console.log('\nAtlas smoke: OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(temp, { recursive: true, force: true })
}
