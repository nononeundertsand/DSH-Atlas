// Load only in an isolated DSH profile. No credentials or external model requests.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
export const inject = ['llm', 'tools', 'webServer', 'approval', 'sessions', 'workspaceRegistry']
export function apply(ctx) {
  const requests = []
  let failNext = false
  class Fixture extends LlmAdapter {
    async listModels() { return [{ provider: 'fixture', id: 'fixture', name: 'Selection offline fixture' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: 'Selection offline fixture' } }
    async *stream(options) {
      if (failNext) { failNext = false; throw new Error('Offline fixture: forced recoverable model failure') }
      const texts = options.messages.filter(m => m.role === 'user').map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))
      const initial = texts.find(text => text.includes('selectedText'))
      requests.push({ texts, tools: options.tools?.map(t => t.name) ?? [] })
      const last = options.messages.filter(m => m.role === 'user' && m.source?.kind === 'user').at(-1)?.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? texts.at(-1) ?? ''
      let answer
      if (initial) {
        const material = JSON.parse(initial.slice(initial.indexOf('{')))
        if (last.includes('第二次追问')) answer = `仍在同一临时会话：第一次追问中的蓝色盒子，指「${material.selectedText}」分裂前的数据页。`
        else if (last.includes('第一次追问')) answer = `记住这个类比：蓝色盒子代表「${material.selectedText}」对应的数据页。`
        else answer = `通用含义：${material.selectedText} 是数据结构中的一个概念。\n\n当前语境：${material.visibleParagraph}\n\n在 B+ 树中，页分裂是将装满的数据页拆为两页，并在父节点增加索引项。`
      } else if (/工具测试|审批测试/.test(last) && options.messages.at(-1)?.role !== 'tool') {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-' + Date.now(), name: 'atlas_fixture_echo', arguments: JSON.stringify({ text: last.includes('审批测试') ? 'approval' : 'offline only' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      } else answer = '当一个数据页已经放不下新记录时，B+ 树会通过页分裂腾出空间，并维持索引结构。\n\n可以理解为把一个装满的盒子分成两个：\n\n1. 将部分记录移到新页。\n2. 在父节点中增加指向新页的索引项。\n3. 如果父节点也满了，就继续向上分裂。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const text of answer.match(/.{1,8}|\n/g) ?? []) {
        await new Promise(resolve => setTimeout(resolve, last.includes('慢速') ? 200 : 35))
        if (options.signal?.aborted) throw options.signal.reason
        yield { type: 'text-delta', index: 0, text }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Fixture())
  ctx.tools.register(defineContentToolFixture({ name: 'atlas_fixture_echo', description: 'Offline test echo', parameters: { text: { type: 'string', required: true } }, async execute(args, exec) {
    if (args.text === 'approval') {
      const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'atlas_fixture_echo', callId: exec.callId, reason: 'Offline fixture approval; no files or network are changed', signal: exec.signal })
      return [{ type: 'text', text: outcome }]
    }
    return [{ type: 'text', text: args.text }]
  } }))
  ctx.webServer.register({ kind: 'exact', path: '/ext/selection-fixture/catalog', handler(_req, res) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sessions: ctx.sessions.list().map(session => session.id), workspaces: ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, sessionIds: workspace.sessionIds })) })) } })
  ctx.webServer.register({ kind: 'exact', path: '/ext/selection-fixture/fail-next', handler(req, res) { if (req.method !== 'POST') { res.writeHead(405); res.end(); return }; failNext = true; res.writeHead(200); res.end('armed') } })
  ctx.webServer.register({ kind: 'exact', path: '/ext/selection-fixture', handler(_req, res) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(requests)) } })
}
