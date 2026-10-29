/**
 * 上下文工程：只给模型它此刻需要的东西。
 *
 * 一条硬规则：祖先节点只传收口卡，不传完整 transcript。
 * 节点边界是上下文硬边界；最近轮次超预算时从最旧的开始丢。
 */
import type { LlmRequestMessage } from '../shared/dsh.js'
import type { AtlasMessage, ClosureCard, PathBrief, Workspace, AtlasNode } from '../shared/types.js'

const SYSTEM = `你是 Atlas 中的学习与分析助手。当前节点：{{title}}。
地图目标：{{goal}}
路径：{{path}}

你的任务：
1. 只在这个节点的范围内回答；不要重复祖先节点已经讲过的内容。
2. 先给结论，再给 2–4 条要点；需要时补一个例子。
3. 回答尽量短，使用 Markdown；标题用 ## / ###，方便折叠与定位。
4. 如果问题明显超出当前节点，提醒用户可以“提升为节点”或回到上层。
5. 不确定的内容直说，不要编造。`

export interface ChatContextInput {
  workspace: Workspace
  node: AtlasNode
  path: PathBrief[]
  card?: ClosureCard
  messages: AtlasMessage[]
  /** 子聊天的父线程最近两轮，用于接住上下文。 */
  parentMessages?: AtlasMessage[]
}

export function buildChatContext(input: ChatContextInput): {
  system: string
  messages: LlmRequestMessage[]
} {
  const { workspace, node, path, card } = input
  const recent = trimMessages(input.messages, 24_000, 12)

  const ancestors = path
    .filter((item) => item.nodeId !== node.id)
    .map((item) => `- ${item.title}${item.tldr ? `：${item.tldr}` : ''}`)
    .join('\n')

  const resume = card
    ? `\n\n【续接简报】\n上次结论：${card.tldr}\n已得要点：\n${card.points
        .map((point) => `- ${point}`)
        .join('\n')}\n未解问题：\n${card.openQuestions.length ? card.openQuestions.map((q) => `- ${q}`).join('\n') : '（无）'}`
    : ''

  const parent = input.parentMessages?.length
    ? `\n\n【父线程最近两轮】\n${input.parentMessages
        .slice(-2)
        .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.slice(0, 800)}`)
        .join('\n')}`
    : ''

  const system = SYSTEM.replace('{{title}}', node.title)
    .replace('{{goal}}', workspace.goal ?? '（未填写）')
    .replace('{{path}}', path.map((item) => item.title).join(' › ') || node.title)
    .concat(ancestors ? `\n\n祖先节点的收口卡：\n${ancestors}` : '')
    .concat(parent)
    .concat(resume)

  const messages: LlmRequestMessage[] = recent.map((message) => ({
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [
      {
        type: 'text',
        text: message.quote ? `> ${message.quote.text}\n\n${message.content}` : message.content,
      },
    ],
    source:
      message.role === 'assistant'
        ? { kind: 'model', provider: 'atlas', model: 'atlas' }
        : { kind: 'user' },
  }))

  return { system, messages }
}

export function buildClosureContext(input: {
  workspace: Workspace
  node: AtlasNode
  path: PathBrief[]
  messages: AtlasMessage[]
}): { system: string; messages: LlmRequestMessage[] } {
  const transcript = trimMessages(input.messages, 24_000, 30)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
    .join('\n\n')

  const system = `你是 Atlas 的收口编辑。给定一段对话、节点目标和祖先路径，输出严格 JSON。
只写对话里已经成立的结论，不引入新事实；不确定的内容放进 openQuestions。
tldr 不超过 30 个汉字；points 3–7 条，每条不超过 40 字；openQuestions 0–3 条。
mastery 为 0–5 的整数并给一句理由；nextHint 是一句回到上层的衔接句。
JSON 形状：
{"tldr":string,"points":string[],"openQuestions":string[],"artifacts":[{"kind":"file|link|code|table|image","ref":string,"label":string}],"mastery":number,"masteryReason":string,"nextHint":string}`

  const user = `节点：${input.node.title}
地图目标：${input.workspace.goal ?? '（未填写）'}
路径：${input.path.map((item) => item.title).join(' › ') || input.node.title}

对话：
${transcript || '（还没有对话）'}`

  return {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }],
  }
}

/** 选中文字的解释上下文：只带最近几轮，避免把整段对话重复送给模型。 */
export function buildExplainContext(input: {
  workspace: Workspace
  node: AtlasNode
  path: PathBrief[]
  messages: AtlasMessage[]
  text: string
}): { system: string; messages: LlmRequestMessage[] } {
  const recent = trimMessages(input.messages, 6_000, 8)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.slice(0, 1_200)}`)
    .join('\n\n')

  const system = `你是 Atlas 的术语解释助手。结合当前节点与对话上下文，解释用户选中的词或短语。
只解释选中内容，不展开无关话题。输出严格 JSON：
{"term":string,"meaning":string,"inContext":string}
meaning 是这个词的通用含义，1–2 句；inContext 是它在这段对话里的具体含义，1–2 句。`

  const user = `节点：${input.node.title}
路径：${input.path.map((item) => item.title).join(' › ') || input.node.title}
地图目标：${input.workspace.goal ?? '（未填写）'}

最近对话：
${recent || '（暂无）'}

选中文字：${input.text}`

  return {
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }],
  }
}

/** 保留最近 N 条，并从最旧的开始压到字符预算内。 */
export function trimMessages(messages: AtlasMessage[], budget: number, maxCount: number): AtlasMessage[] {
  const recent = messages.filter((message) => message.role !== 'system').slice(-maxCount)
  let total = recent.reduce((sum, message) => sum + message.content.length, 0)
  let start = 0
  while (start < recent.length - 1 && total > budget) {
    total -= recent[start]!.content.length
    start++
  }
  return recent.slice(start)
}
