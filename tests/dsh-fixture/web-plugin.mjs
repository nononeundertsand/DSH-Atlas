import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
export const inject = ['llm', 'tools']
class Fixture extends LlmAdapter {
 async listModels() { return [{provider:'fixture',id:'fixture',name:'Fixture offline'}] }
 async resolveModel(provider, model) { return {provider,id:model,name:'Fixture offline'} }
 async *stream(options) {
  const last = options.messages.at(-1)
  if(last?.role === 'tool') {
   yield {type:'block-start',index:0,blockType:'text'}
   yield {type:'text-delta',index:0,text:'测试完成：消息由 DSH Agent 接收，工具结果已返回。'}
   yield {type:'block-end',index:0,block:{type:'text',text:'测试完成：消息由 DSH Agent 接收，工具结果已返回。'}}
   yield {type:'finish',reason:{kind:'stop'}}
  } else {
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixture-'+Date.now(),name:'atlas_fixture_echo',arguments:'{"text":"offline test"}'}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }
 }
}
export function apply(ctx) {
 ctx.llm.registerAdapter(['fixture'],new Fixture())
 ctx.tools.register(defineContentToolFixture({name:'atlas_fixture_echo',description:'Offline test echo',parameters:{text:{type:'string',required:true}},async execute(args){return [{type:'text',text:args.text}]}}))
 ctx.on('agent/created',({agent})=>{ if(agent.id.startsWith('atlas-')) agent.ctx.tools.restrict({allow:['atlas_fixture_echo']}) })
}
