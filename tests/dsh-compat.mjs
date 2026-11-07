/**
 * Version 2：DSH 0.2.1-rc.2 / 0.2.2-rc.1 会话接口兼容回归。
 *
 * 模拟端口按「真实 DSH 0.2.2-rc.1 源码」构造：
 * - sessionQuery.observeSession(id, { projectionMode: 'none' }) → 带 [Symbol.dispose]() 的观察租约
 * - 不存在时抛 code = SESSION_QUERY_SESSION_NOT_FOUND
 * - readTitleSnapshots(ids) → 逐会话 { sessionId, status, value: { session, title: { title, ... } }, reason? }
 * 旧版端口为 sessionController.inspect + ApiSessionNotFound + 标题映射。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: `
      export { AtlasStore } from './src/host/store.ts';
      export { NodeSessions } from './src/host/sessions.ts';
      export { createAtlasRouter } from './src/host/routes.ts';
      export { sessionChecker, toTitleMap, readTitleMap } from './src/host/dsh-compat.ts';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const { AtlasStore, NodeSessions, createAtlasRouter, sessionChecker, toTitleMap, readTitleMap } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

function titleSnapshot(text) {
  // dsh-session-title 的 foldSessionTitle 返回值（真实字段）。
  return { title: text, messageSeqs: [], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
}

function newQuery({ outcome = 'exists' } = {}) {
  const calls = []
  const disposed = []
  return {
    calls, disposed,
    async observeSession(sessionId, options) {
      calls.push({ sessionId, options })
      if (outcome === 'notFound') throw Object.assign(new Error('session not found'), { code: NOT_FOUND })
      if (outcome === 'offline') throw Object.assign(new Error('backend offline'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
      if (outcome === 'plain') throw new Error('backend offline')
      return { header: { id: sessionId }, [Symbol.dispose]: () => disposed.push(sessionId) }
    },
    async readTitleSnapshots() { return [] },
  }
}

function legacyController({ outcome = 'exists' } = {}) {
  const calls = []
  let creates = 0
  return {
    calls,
    get creates() { return creates },
    async inspect(sessionId) {
      calls.push(sessionId)
      if (outcome === 'notFound') { class ApiSessionNotFound extends Error {}; throw new ApiSessionNotFound('missing') }
      if (outcome === 'offline') throw new Error('inspect offline')
    },
    async create({ sessionId }) { creates++; return { sessionId } },
  }
}

// ── 1. 能力选择 ─────────────────────────────────────────────────────────────
{
  const query = newQuery()
  const check = sessionChecker({ sessionQuery: query, sessionController: undefined })
  assert.equal(await check('s1'), 'exists', '仅新版接口：会话存在')
  assert.deepEqual(query.calls[0].options, { projectionMode: 'none' }, '仅新版：projectionMode=none')
  assert.deepEqual(query.disposed, ['s1'], '查询对象必须释放')
  console.log('  ✓ 仅新版接口：observeSession + 释放租约')
}
{
  const legacy = legacyController()
  const check = sessionChecker({ sessionController: legacy })
  assert.equal(await check('s1'), 'exists', '仅旧版接口：会话存在')
  assert.deepEqual(legacy.calls, ['s1'])
  console.log('  ✓ 仅旧版接口：inspect')
}
{
  const query = newQuery()
  const legacy = legacyController()
  const check = sessionChecker({ sessionQuery: query, sessionController: legacy })
  assert.equal(await check('s1'), 'exists')
  assert.equal(query.calls.length, 1, '两者都有时调用新版')
  assert.deepEqual(legacy.calls, [], '两者都有时不得调用旧版')
  console.log('  ✓ 两者都有：优先新版')
}
{
  assert.throws(
    () => sessionChecker({ sessionQuery: { readTitleSnapshots: async () => ({}) }, sessionController: { create: async id => id } }),
    /E_UNSUPPORTED.*不兼容/s,
    '两者都没有：明确提示不兼容',
  )
  console.log('  ✓ 两者都没有：E_UNSUPPORTED 明确提示')
}

// ── 2. 新版查询失败不降级旧版 / 错误分类 ───────────────────────────────────
{
  for (const outcome of ['offline', 'plain']) {
    const query = newQuery({ outcome })
    const legacy = legacyController()
    const check = sessionChecker({ sessionQuery: query, sessionController: legacy })
    await assert.rejects(check('s1'), /backend offline/, '真实错误必须上抛')
    assert.deepEqual(legacy.calls, [], '新版查询失败不得降级调用旧版')
    assert.deepEqual(query.disposed, [], '查询失败时没有租约可释放')
  }
  console.log('  ✓ 新版查询失败：原样上抛且不调用旧版')
}
{
  const check = sessionChecker({ sessionQuery: newQuery({ outcome: 'notFound' }) })
  assert.equal(await check('s1'), 'missing', '仅明确的 SESSION_QUERY_SESSION_NOT_FOUND 进入不存在处理')
  const legacy = legacyController({ outcome: 'notFound' })
  assert.equal(await (sessionChecker({ sessionController: legacy }))('s1'), 'missing', '旧版 ApiSessionNotFound 仍识别')
  await assert.rejects((sessionChecker({ sessionController: legacyController({ outcome: 'offline' }) }))('s1'), /inspect offline/)
  console.log('  ✓ 明确不存在与其他错误分别处理（新旧两版）')
}

// ── 3. 标题返回值转换 ───────────────────────────────────────────────────────
{
  assert.deepEqual(toTitleMap({ s1: '旧标题', s2: null, s3: undefined, s4: '' }), { s1: '旧标题' }, '旧版映射：跳过空/空标题')
  console.log('  ✓ 旧版标题映射')
}
{
  const raw = [
    { sessionId: 's1', status: 'fulfilled', value: { session: { id: 's1' }, title: titleSnapshot('新版标题') } },
    { sessionId: 's2', status: 'rejected', reason: new Error('cold read failed') },
    { sessionId: 's3', status: 'fulfilled', value: { session: { id: 's3' }, title: titleSnapshot('   ') } },
    { sessionId: 's4', status: 'fulfilled', value: { session: { id: 's4' } } },
    { sessionId: 's5', status: 'fulfilled', value: { session: { id: 's5' }, title: titleSnapshot('另一标题') } },
    null,
  ]
  assert.deepEqual(toTitleMap(raw), { s1: '新版标题', s5: '另一标题' }, '新版列表：单项失败/空标题/无标题只回退该项')
  console.log('  ✓ 新版逐会话结果：部分失败与空标题隔离')
}
{
  assert.deepEqual(toTitleMap(null), {})
  assert.deepEqual(toTitleMap('bad'), {})
  assert.deepEqual(await readTitleMap(undefined, ['s1']), {})
  let called = 0
  assert.deepEqual(await readTitleMap({ readTitleSnapshots: async () => { called++; return {} } }, []), {}, '空 ids 不查询')
  assert.equal(called, 0)
  assert.deepEqual(await readTitleMap({ readTitleSnapshots: async () => { throw new Error('service down') } }, ['s1']), {}, '整体查询失败返回空映射')
  assert.deepEqual(await readTitleMap({ readTitleSnapshots: async ids => ({ [ids[0]]: '可用标题' }) }, ['s1']), { s1: '可用标题' })
  console.log('  ✓ 整体失败/异常返回值：列表仍可用')
}

// ── 4. NodeSessions 集成 ────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'atlas-dsh-compat-'))
try {
  function workspaces(extra = {}) {
    const archivedSessionIds = []
    return {
      archivedSessionIds,
      async create() { return { id: 'native-ws', async attachSession() {} } },
      async archiveSession(id) { if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id) },
      async unarchiveSession(id) { const i = archivedSessionIds.indexOf(id); if (i >= 0) archivedSessionIds.splice(i, 1) },
      ...extra,
    }
  }
  const store = new AtlasStore(root)
  const w = await store.createWorkspace('compat')
  const node = async title => (await store.createNode({ workspaceId: w.id, title })).node

  // 仅新版：沿用原 Session ID、并发去重、重复点击不重复创建
  {
    const n = await node('new-only')
    const query = newQuery()
    const controller = legacyController()
    const sessions = new NodeSessions(store, controller, workspaces(), query)
    const [a, b] = await Promise.all([sessions.open(n.id), sessions.open(n.id)])
    assert.equal(a.sessionId, b.sessionId, '并发打开去重')
    assert.equal(controller.creates, 1)
    const again = await sessions.open(n.id)
    assert.equal(again.sessionId, a.sessionId, '重复点击沿用原 Session ID')
    assert.equal(controller.creates, 1, '重复点击不创建重复会话')
    assert.equal(query.calls.length, 1, '已有绑定时才做会话检查')
    assert.deepEqual(query.disposed, [a.sessionId], '查询对象正确释放')
    assert.equal(query.calls[0].options.projectionMode, 'none')
    // 重启后打开：新版检查判定存在 → 不重新创建，绑定不变
    const restartQuery = newQuery()
    const restartedController = legacyController()
    const restarted = new NodeSessions(new AtlasStore(root), restartedController, workspaces(), restartQuery)
    assert.equal((await restarted.open(n.id)).sessionId, a.sessionId, '重启后沿用原 Session ID')
    assert.equal(restartedController.creates, 0, '会话存在时不再创建')
    assert.equal(restartQuery.calls.length, 1)
    assert.deepEqual(restartQuery.disposed, [a.sessionId])
    console.log('  ✓ 仅新版：沿用原 ID、并发去重、重启打开、租约释放')
  }
  // 空白会话恢复：明确不存在 → 沿用同一确定身份重建
  {
    const n = await node('blank-recovery')
    const first = new NodeSessions(store, legacyController(), workspaces(), newQuery())
    const bound = await first.open(n.id)
    const query = newQuery({ outcome: 'notFound' })
    const controller = legacyController()
    const restarted = new NodeSessions(new AtlasStore(root), controller, workspaces(), query)
    const recovered = await restarted.open(n.id)
    assert.equal(recovered.sessionId, bound.sessionId, '空白会话恢复沿用原 Session ID')
    assert.equal(controller.creates, 1)
    console.log('  ✓ 明确不存在：空白会话恢复（同 ID）')
  }
  // 其他错误：不误判不存在、不覆盖绑定、不换 ID、不调用旧版、无副作用
  {
    const n = await node('other-error')
    const binding = await new NodeSessions(store, legacyController(), workspaces(), newQuery()).open(n.id)
    const query = newQuery({ outcome: 'offline' })
    const legacy = legacyController()
    let workspaceCreates = 0
    const ws = workspaces({ create: async () => { workspaceCreates++; return { id: 'native-ws', async attachSession() {} } } })
    const failing = new NodeSessions(store, legacy, ws, query)
    await assert.rejects(failing.open(n.id), /backend offline/)
    await assert.rejects(failing.open(n.id), /backend offline/, '重复点击同样失败')
    assert.deepEqual(legacy.calls, [], '新版存在时不得降级旧版')
    assert.equal(legacy.creates, 0, '失败不创建新会话')
    assert.equal(workspaceCreates, 0, '检查失败发生在工作区创建之前')
    assert.equal((await store.getNode(n.id)).sessionId, binding.sessionId, '失败不改变原 Session 绑定')
    console.log('  ✓ 其他错误：不改绑定/不换 ID/无副作用/不降级')
  }
  // 两者都没有：节点打开报 E_UNSUPPORTED，但插件仍可加载
  {
    const n = await node('unsupported')
    const controller = { create: async ({ sessionId }) => ({ sessionId }) }
    const sessionQuery = { readTitleSnapshots: async () => [] }
    let workspaceCreates = 0
    const ws = workspaces({ create: async () => { workspaceCreates++; return { id: 'native-ws', async attachSession() {} } } })
    const sessions = new NodeSessions(store, controller, ws, sessionQuery)
    await assert.rejects(sessions.open(n.id), /E_UNSUPPORTED.*不兼容/s)
    assert.equal(workspaceCreates, 0, '不兼容检查先于工作区创建')
    assert.equal((await store.getNode(n.id)).sessionId, undefined, '不兼容不产生绑定')
    await assert.rejects(sessions.startNew(n.id, 'any-session'), /E_UNSUPPORTED.*不兼容/s, 'startNew 也先做不兼容检查')
    assert.equal((await store.getNode(n.id)).replacedSessionId, undefined, '不兼容检查先于 replaceSession 绑定变更')
    console.log('  ✓ 两者都没有：打开/新建 E_UNSUPPORTED，无副作用')
  }
  // 已归档会话仍进入现有恢复流程（新版接口下）
  {
    const n = await node('archived')
    const ws = workspaces()
    const sessions = new NodeSessions(store, legacyController(), ws, newQuery())
    const bound = await sessions.open(n.id)
    await sessions.archiveSession(n.id, bound.sessionId)
    assert.equal((await store.getNode(n.id)).sessionId, undefined)
    await assert.rejects(sessions.open(n.id), /E_SESSION_ARCHIVED/, '归档后打开仍进入恢复提示流程')
    assert.equal((await sessions.sessionState(n.id)).archivedSessionId, bound.sessionId)
    const replacement = await sessions.startNew(n.id, bound.sessionId)
    assert.notEqual(replacement.sessionId, bound.sessionId, '恢复归档后新建会话')
    console.log('  ✓ 已归档会话：仍走 E_SESSION_ARCHIVED / startNew 恢复流程')
  }

  // ── 5. 回收站节点列表与保留会话列表共用标题转换 ──────────────────────────
  const trashRoot = await mkdtemp(join(tmpdir(), 'atlas-dsh-compat-trash-'))
  try {
    const trashStore = new AtlasStore(trashRoot)
    const tw = await trashStore.createWorkspace('trash')
    const make = async (title, sessionId) => {
      const n = (await trashStore.createNode({ workspaceId: tw.id, title })).node
      await trashStore.bindSession(n.id, sessionId)
      return n
    }
    const n1 = await make('节点一', 's1')
    await make('节点二', 's2')
    await make('失败节点', 's-failed')
    const plan = await trashStore.deletionPreview(n1.id)
    await trashStore.deleteNode(n1.id, plan.token)

    const routerFor = sessionQuery => createAtlasRouter({
      store: trashStore,
      model: {},
      dataDir: trashRoot,
      modelHint: 'auto',
      checkUpdate: async () => ({}),
      nodeSessions: new NodeSessions(trashStore, legacyController(), workspaces(), sessionQuery),
      sessionQuery,
      isSessionRunning: () => false,
    })
    const request = async (router) => {
      const req = { method: 'GET', url: '/ext/atlas/trash', headers: {}, on() {}, async *[Symbol.asyncIterator]() {} }
      let status = 0
      let body = ''
      const res = {
        writeHead(s) { status = s }, write() { return true }, on() {},
        end(chunk) { body = chunk ?? '' },
      }
      await router(req, res)
      assert.equal(status, 200)
      return JSON.parse(body)
    }
    const nodeTitle = list => list.nodes.find(n => n.id === n1.id)?.sessionTitle
    const sessionTitle = (list, id) => list.sessions.find(s => s.sessionId === id)?.title

    // 新版逐会话结果：成功项生效，单项失败/空标题回退，两个列表共用转换
    const newTitles = {
      async readTitleSnapshots(ids) {
        return ids.map(id => {
          if (id === 's-failed') return { sessionId: id, status: 'rejected', reason: new Error('cold read failed') }
          if (id === 's-empty') return { sessionId: id, status: 'fulfilled', value: { session: { id }, title: titleSnapshot('  ') } }
          return { sessionId: id, status: 'fulfilled', value: { session: { id }, title: titleSnapshot(`真实标题-${id}`) } }
        })
      },
    }
    const newList = await request(routerFor(newTitles))
    assert.equal(nodeTitle(newList), '真实标题-s1', '回收站节点列表用新版标题')
    assert.equal(sessionTitle(newList, 's1'), '真实标题-s1', '保留会话列表用同一转换逻辑')
    assert.equal(sessionTitle(newList, 's2'), '真实标题-s2', '其他成功项不受影响')
    assert.equal(sessionTitle(newList, 's-failed'), '失败节点', '单项失败回退现有标题')
    console.log('  ✓ 新版标题：两个列表共用转换，单项失败回退')

    // 旧版映射
    const oldTitles = { readTitleSnapshots: async ids => Object.fromEntries(ids.map(id => [id, `旧标题-${id}`])) }
    const oldList = await request(routerFor(oldTitles))
    assert.equal(nodeTitle(oldList), '旧标题-s1')
    assert.equal(sessionTitle(oldList, 's1'), '旧标题-s1')
    assert.equal(sessionTitle(oldList, 's2'), '旧标题-s2')
    console.log('  ✓ 旧版标题：两个列表仍可用')

    // 整体查询失败：列表仍可用，回退现有标题
    const broken = { readTitleSnapshots: async () => { throw new Error('service down') } }
    const fallbackList = await request(routerFor(broken))
    assert.equal(nodeTitle(fallbackList), undefined, '整体失败时节点回退节点标题')
    assert.equal(sessionTitle(fallbackList, 's1'), '节点一', '整体失败时会话回退来源标题快照')
    assert.ok(fallbackList.nodes.length && fallbackList.sessions.length, '整体失败时列表仍可用')
    console.log('  ✓ 整体失败：列表可用且逐项回退')
  } finally { await rm(trashRoot, { recursive: true, force: true }) }
} finally { await rm(root, { recursive: true, force: true }) }

// ── 6. 缺少节点打开能力不阻止插件加载 ──────────────────────────────────────
{
  const { apply } = await import('../lib/host/index.js')
  const loadRoot = await mkdtemp(join(tmpdir(), 'atlas-dsh-compat-load-'))
  try {
    const routes = []
    const ctx = {
      agents: { get: () => undefined },
      sessionController: { create: async ({ sessionId }) => ({ sessionId }) }, // 无 inspect
      workspaceRegistry: { create: async () => ({ id: 'w', async attachSession() {} }), archivedSessionIds: [] },
      sessionQuery: { readSurface: async () => ({ session: {}, events: [] }) }, // 无 observeSession
      llm: { listProviders: () => [], listModels: async () => [], stream: async function* () {} },
      webServer: { register(route) { routes.push(route); return () => {} } },
      effect(fn) { return fn() },
    }
    apply(ctx, { dataDir: loadRoot, checkUpdates: false })
    assert.equal(routes.length, 1, '缺少节点打开能力不影响插件加载与路由注册')
    console.log('  ✓ 能力缺失：插件仍加载并注册路由')
  } finally { await rm(loadRoot, { recursive: true, force: true }) }
}

// ── 7. 真实插件入口（apply）的新版接口闭环 ─────────────────────────────────
{
  const { apply } = await import('../lib/host/index.js')
  const httpRoot = await mkdtemp(join(tmpdir(), 'atlas-dsh-compat-http-'))
  const routes = []
  const liveSessions = new Set()
  const archivedSessionIds = []
  const nativeWorkspaces = new Map()
  const observed = []
  const disposed = []
  const ctx = {
    agents: { get: () => ({ status: 'idle' }) },
    // 新版：只有 create，没有 inspect
    sessionController: {
      create: async ({ sessionId }) => { liveSessions.add(sessionId); return { sessionId } },
    },
    // 新版：observeSession + 逐会话标题结果，没有 inspect 的旧版形状
    sessionQuery: {
      async observeSession(sessionId, options) {
        observed.push({ sessionId, options })
        if (!liveSessions.has(sessionId)) throw Object.assign(new Error('session not found'), { code: NOT_FOUND })
        return { header: { id: sessionId }, [Symbol.dispose]: () => disposed.push(sessionId) }
      },
      async readTitleSnapshots(ids) {
        return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: { id }, title: titleSnapshot(`真实标题-${id}`) } }))
      },
    },
    workspaceRegistry: {
      archivedSessionIds,
      create: async path => {
        let item = [...nativeWorkspaces.values()].find(w => w.path === path)
        if (!item) { item = { id: 'native-' + nativeWorkspaces.size, path, sessionIds: [], attachSession: async () => {} }; nativeWorkspaces.set(item.id, item) }
        return item
      },
      list: () => [...nativeWorkspaces.values()],
      delete: async id => nativeWorkspaces.delete(id),
      archiveSession: async id => { if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id) },
      unarchiveSession: async id => { const i = archivedSessionIds.indexOf(id); if (i >= 0) archivedSessionIds.splice(i, 1) },
    },
    llm: { listProviders: () => [{ id: 'fake', name: 'Fake' }], listModels: async () => [{ id: 'fake', name: 'Fake' }], stream: async function* () {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) { return fn() },
  }
  apply(ctx, { dataDir: httpRoot, checkUpdates: false })
  const server = createServer((req, res) => {
    Promise.resolve(routes[0].handler(req, res)).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'E_INTERNAL', message: String(error) } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const json = async (path, init) => {
    const response = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
    const body = await response.json()
    assert.equal(response.status, 200, `${path} 失败：${JSON.stringify(body)}`)
    return body
  }
  try {
    const boot = await json('/ext/atlas/bootstrap')
    const created = await json('/ext/atlas/nodes', { method: 'POST', body: JSON.stringify({ workspaceId: boot.snapshot.workspace.id, title: '新版节点' }) })
    const nodeId = created.node.id
    const opened = await json(`/ext/atlas/nodes/${nodeId}/session`, { method: 'POST' })
    assert.ok(opened.node.sessionId, '新版 DSH 下节点打开成功（不再 HTTP 500）')
    assert.equal(liveSessions.size, 1)
    const reopened = await json(`/ext/atlas/nodes/${nodeId}/session`, { method: 'POST' })
    assert.equal(reopened.node.sessionId, opened.node.sessionId, '重启式重新打开沿用原 Session ID')
    assert.equal(liveSessions.size, 1, '重新打开不创建新会话')
    assert.ok(observed.length >= 1, '走新版 observeSession')
    assert.equal(observed[0].options.projectionMode, 'none')
    assert.ok(disposed.length >= 1, '观察租约已释放')
    const plan = await json(`/ext/atlas/nodes/${nodeId}/delete-preview`)
    await json(`/ext/atlas/nodes/${nodeId}`, { method: 'DELETE', body: JSON.stringify({ token: plan.token }) })
    const trash = await json('/ext/atlas/trash')
    const entry = trash.nodes.find(n => n.id === nodeId)
    assert.equal(entry.sessionTitle, `真实标题-${opened.node.sessionId}`, '回收站节点列表显示新版标题')
    assert.equal(trash.sessions.find(s => s.sessionId === opened.node.sessionId).title, `真实标题-${opened.node.sessionId}`, '保留会话列表显示新版标题')
    console.log('  ✓ apply 闭环：节点打开/重新打开/标题显示走新版接口')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(httpRoot, { recursive: true, force: true })
  }
}

console.log('DSH compat: capability selection, error handling, lease release, title conversion and regressions passed')
