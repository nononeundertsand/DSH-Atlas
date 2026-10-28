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

const ctx = {
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

  const deleted = await json(`/ext/atlas/nodes/${promoted.node.id}`, { method: 'DELETE' })
  assert.deepEqual(deleted.deleted, [promoted.node.id])
  const finalSnapshot = await json(`/ext/atlas/workspaces/${boot.snapshot.workspace.id}`)
  assert.equal(finalSnapshot.snapshot.nodes.length, 1)
  passed('删除节点')

  console.log('\nAtlas smoke: OK')
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(temp, { recursive: true, force: true })
}
