import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
 const workspaces = { async create() { return {id:'native-workspace',async attachSession(){}} } }
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
 console.log('Session routing: concurrent open, reuse, blank recovery, failure and binding integrity passed')
} finally { await rm(root,{recursive:true,force:true}) }
