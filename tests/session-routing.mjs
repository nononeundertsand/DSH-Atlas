import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
const bundle = await build({ stdin: { contents: "export {AtlasStore} from './src/host/store.ts'; export {NodeSessions} from './src/host/sessions.ts'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })
const { AtlasStore, NodeSessions } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const root = await mkdtemp(join(tmpdir(), 'atlas-routing-'))
try {
 const store = new AtlasStore(root)
 const workspace = await store.createWorkspace('test')
 const {node} = await store.createNode({workspaceId:workspace.id,title:'node'})
 let creates = 0
 let missing = false
 const controller = {
  async create({sessionId}) { creates++; return {sessionId} },
  async inspect() { if(missing) { class ApiSessionNotFound extends Error {} ; throw new ApiSessionNotFound('missing') } },
 }
 const workspaces = { archivedSessionIds:[], async archiveSession(id){if(!this.archivedSessionIds.includes(id))this.archivedSessionIds.push(id)}, async unarchiveSession(id){const i=this.archivedSessionIds.indexOf(id);if(i>=0)this.archivedSessionIds.splice(i,1)}, async create() { return {id:'native-workspace',async attachSession(){}} } }
 const sessions = new NodeSessions(store,controller,workspaces)
 const [a,b] = await Promise.all([sessions.open(node.id),sessions.open(node.id)])
 assert.equal(a.sessionId,b.sessionId)
 assert.equal(creates,1)
 await sessions.open(node.id)
 assert.equal(creates,1)
 missing = true
 await sessions.open(node.id)
 assert.equal(creates,2)
 assert.equal((await store.getNode(node.id)).sessionId,a.sessionId)
 await store.updateNode(node.id,{sessionId:'forged',id:'forged',title:'renamed'})
 assert.equal((await store.getNode(node.id)).sessionId,a.sessionId)
 const fresh = await store.createNode({workspaceId:workspace.id,title:'failure'})
 const failed = new NodeSessions(store,{...controller,async create(){throw new Error('offline')}},workspaces)
 await assert.rejects(failed.open(fresh.node.id),/offline/)
 assert.equal((await store.getNode(fresh.node.id)).sessionId,undefined)
 const directory = join(root,'session-workspaces',node.id)
 await writeFile(join(directory,'evidence.txt'),'keep this file')
 const registered = [
  {id:'owned',path:directory,sessionIds:[a.sessionId]},
  {id:'other',path:join(root,'other-project'),sessionIds:[]},
 ]
  const removed=[]
  const cleanup = new NodeSessions(store,controller,{...workspaces,list:()=>registered.filter(w=>!removed.includes(w.id)),delete:async id=>{removed.push(id);return true}})
  await assert.rejects(cleanup.removeWorkspaces([node.id],()=>true),/E_CONFLICT/)
  assert.deepEqual(removed,[])
  await cleanup.removeWorkspaces([node.id],()=>false)
  await cleanup.removeWorkspaces([node.id],()=>false)
  assert.deepEqual(removed,['owned'])
  assert.equal(await readFile(join(directory,'evidence.txt'),'utf8'),'keep this file','删除工作区分组必须保留 cwd 目录（Session 仍可用）')
  const otherDirectory=join(root,'other-project')
  await mkdir(otherDirectory)
  await writeFile(join(otherDirectory,'keep.txt'),'untouched')
  assert.equal(await readFile(join(otherDirectory,'keep.txt'),'utf8'),'untouched')
 const archived=[]
 const archiveSessions=new NodeSessions(store,controller,{...workspaces,archivedSessionIds:archived,archiveSession:async id=>{if(!archived.includes(id))archived.push(id)}})
 await assert.rejects(archiveSessions.archiveSessions([a.sessionId],()=>true),/E_CONFLICT/)
 assert.deepEqual(archived,[])
 await archiveSessions.archiveSessions([a.sessionId,a.sessionId],()=>false)
 assert.deepEqual(archiveSessions.archivedSessionIds,[a.sessionId])
 const syncParent=(await store.createNode({workspaceId:workspace.id,title:'native-parent'})).node
 const syncChild=(await store.createNode({workspaceId:workspace.id,title:'native-child',parentId:syncParent.id})).node
 const draft=(await store.createNode({workspaceId:workspace.id,title:'never opened'})).node
 await store.bindSession(syncParent.id,'sync-session')
 const syncPath=join(root,'session-workspaces',syncParent.id)
 await mkdir(syncPath)
 await writeFile(join(syncPath,'keep.txt'),'preserve evidence')
 const nativeRows=[{id:'sync-workspace',path:syncPath,sessionIds:['sync-session']}]
 const sync=new NodeSessions(store,{...controller,inspect:async id=>id==='sync-session'?{meta:{cwd:syncPath}}:{}},{...workspaces,list:()=>nativeRows})
 await sync.reconcileWorkspaces()
 assert.equal((await store.getNode(syncParent.id)).id,syncParent.id)
 nativeRows.pop()
 await Promise.all([sync.reconcileWorkspaces(),sync.reconcileWorkspaces()])
 assert.equal((await store.getNode(syncParent.id)).id,syncParent.id,'原生分组缺失不得删除逻辑节点')
 assert.equal((await store.getNode(syncChild.id)).id,syncChild.id,'原生分组缺失不得删除子树')
 assert.ok(await store.getNode(draft.id),'unopened nodes are not inferred deleted')
 assert.equal((await store.getNode(syncParent.id)).sessionId,'sync-session')
 assert.equal(await readFile(join(syncPath,'keep.txt'),'utf8'),'preserve evidence')
 const blank=(await store.createNode({workspaceId:workspace.id,title:'blank after restart'})).node
 await store.bindSession(blank.id,'blank-session','blank-native-workspace')
 const restarted=new NodeSessions(new AtlasStore(root),{...controller,inspect:async()=>{throw new Error('must not inspect a blank Session')}},{...workspaces,list:()=>[]})
 await restarted.reconcileWorkspaces()
 assert.ok(await store.getNode(blank.id),'reconcile 不再删除任何节点')
 const solo=(await store.createNode({workspaceId:workspace.id,title:'session-only deletion'})).node
 const boundSolo=await sessions.open(solo.id)
 await sessions.archiveSessions([boundSolo.sessionId])
 const soloSync=new NodeSessions(store,controller,{...workspaces,list:()=>[{id:'native-workspace',path:join(root,'session-workspaces',solo.id),sessionIds:[boundSolo.sessionId]}]})
 await soloSync.reconcileWorkspaces()
 assert.equal((await store.getNode(solo.id)).sessionId,boundSolo.sessionId,'archiving Session must keep node')
 await assert.rejects(sessions.open(solo.id),/E_SESSION_ARCHIVED/)
 assert.ok(workspaces.archivedSessionIds.includes(boundSolo.sessionId),'opening must not unarchive deleted conversation')
 const replacement=await sessions.startNew(solo.id,boundSolo.sessionId)
 assert.notEqual(replacement.sessionId,boundSolo.sessionId)
 assert.equal((await sessions.startNew(solo.id,boundSolo.sessionId)).sessionId,replacement.sessionId,'retry does not create a second replacement')
 await assert.rejects(sessions.startNew(solo.id,replacement.sessionId),/E_CONFLICT/)
 await sessions.archiveSessions([replacement.sessionId])
 let failCreate=true
 const retrySessions=new NodeSessions(store,{...controller,create:async input=>{if(failCreate)throw new Error('create failed');return {sessionId:input.sessionId}}},workspaces)
 await assert.rejects(retrySessions.startNew(solo.id,replacement.sessionId),/create failed/)
 const reserved=(await store.getNode(solo.id)).sessionId
 failCreate=false
 assert.equal((await retrySessions.startNew(solo.id,replacement.sessionId)).sessionId,reserved,'failed creation reserves stable replacement identity')
 const gated=(await store.createNode({workspaceId:workspace.id,title:'archive gate'})).node
 const gatedSession=await sessions.open(gated.id)
 await sessions.archiveSession(gated.id,gatedSession.sessionId)
 assert.equal((await store.getNode(gated.id)).sessionId,undefined)
 const beforeOpen=creates
 await assert.rejects(sessions.open(gated.id),/E_SESSION_ARCHIVED/)
 assert.equal(creates,beforeOpen,'opening an empty node with archived history must not attempt to recreate old identity')
 assert.equal((await sessions.sessionState(gated.id)).archivedSessionId,gatedSession.sessionId)
 const freshGated=await sessions.startNew(gated.id,gatedSession.sessionId)
 assert.notEqual(freshGated.sessionId,gatedSession.sessionId)
 assert.equal((await sessions.sessionState(gated.id)).archivedSessionId,undefined,'old archived history must not block a new current binding')
 const blankArchived=(await store.createNode({workspaceId:workspace.id,title:'unpersisted archive'})).node
 const blankSession=await sessions.open(blankArchived.id)
 const noLog=new NodeSessions(store,controller,{...workspaces,archivedSessionIds:[],archiveSession:async()=>{class WorkspaceUnknownSessionError extends Error{};throw new WorkspaceUnknownSessionError('unpersisted')}})
 await noLog.archiveSession(blankArchived.id,blankSession.sessionId)
 await assert.rejects(noLog.open(blankArchived.id),/E_SESSION_ARCHIVED/)
 assert.equal((await noLog.sessionState(blankArchived.id)).archivedSessionId,blankSession.sessionId)
 assert.notEqual((await noLog.startNew(blankArchived.id,blankSession.sessionId)).sessionId,blankSession.sessionId)
 console.log('Session routing: concurrent open, reuse, blank recovery, failure and binding integrity passed')
} finally { await rm(root,{recursive:true,force:true}) }
