/**
 * 收口卡生成与校验。
 *
 * 生成失败不阻塞收口：降级为基于最近回答的“手动卡”，用户仍可继续工作。
 */
import { randomUUID } from 'node:crypto'
import type { AtlasStore } from './store.js'
import type { AtlasModel } from './model.js'
import { buildClosureContext } from './context.js'
import type { Artifact, AtlasMessage, AtlasNode, ClosureCard, Thread } from '../shared/types.js'

interface RawClosure {
  tldr?: unknown
  points?: unknown
  openQuestions?: unknown
  artifacts?: unknown
  mastery?: unknown
  masteryReason?: unknown
  nextHint?: unknown
}

const ARTIFACT_KINDS = new Set<Artifact['kind']>(['file', 'link', 'code', 'table', 'image'])

export async function generateClosure(
  store: AtlasStore,
  model: AtlasModel,
  node: AtlasNode,
  threadId: string,
): Promise<ClosureCard> {
  const threadSnapshot = await store.getThread(threadId)

  if (threadSnapshot.messages.length === 0) {
    return store.saveCard(fallbackCard(node, threadSnapshot.thread, [], 'empty'))
  }

  const context = buildClosureContext({
    workspace: threadSnapshot.workspace,
    node,
    path: threadSnapshot.path,
    messages: threadSnapshot.messages,
  })

  try {
    const { value, model: modelName } = await model.json<RawClosure>({
      system: context.system,
      messages: context.messages,
      maxTokens: 1200,
    })
    return store.saveCard(normalizeCard(value, node, threadSnapshot.thread, threadSnapshot.messages, modelName))
  } catch {
    return store.saveCard(
      fallbackCard(node, threadSnapshot.thread, threadSnapshot.messages, 'model-failed'),
    )
  }
}

function normalizeCard(
  raw: RawClosure,
  node: AtlasNode,
  thread: Thread,
  messages: AtlasMessage[],
  model: string,
): ClosureCard {
  const tldr = text(raw.tldr)?.slice(0, 120) ?? '（模型未给出结论）'
  const points = stringList(raw.points, 7).slice(0, 7)
  const openQuestions = stringList(raw.openQuestions, 3).slice(0, 3)
  const mastery = clampInt(raw.mastery, 0, 5, node.mastery)
  const artifacts = artifactList(raw.artifacts)
  const sourceRange: ClosureCard['sourceRange'] = messages.length
    ? [messages[0]!.id, messages[messages.length - 1]!.id]
    : []

  return {
    id: `c_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    nodeId: node.id,
    threadId: thread.id,
    tldr,
    points: points.length ? points : [tldr],
    openQuestions,
    artifacts,
    mastery,
    masteryReason: text(raw.masteryReason)?.slice(0, 160) ?? '模型依据本轮对话给出的估计。',
    nextHint: text(raw.nextHint)?.slice(0, 160) ?? '回到上层，把这个节点放回地图。',
    sourceRange,
    generatedAt: new Date().toISOString(),
    model,
    version: 1,
  }
}

function fallbackCard(node: AtlasNode, thread: Thread, messages: AtlasMessage[], reason: 'empty' | 'model-failed'): ClosureCard {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const content = lastAssistant?.content.trim() ?? ''
  const lines = content
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .filter(Boolean)

  const tldr =
    (lines[0] ?? (reason === 'empty' ? '还没有开始对话。' : '自动收口不可用，请手动补充结论。')).slice(0, 120)
  const points = lines.slice(0, 5).map((line) => line.slice(0, 80))
  const sourceRange: ClosureCard['sourceRange'] = messages.length
    ? [messages[0]!.id, messages[messages.length - 1]!.id]
    : []

  return {
    id: `c_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    nodeId: node.id,
    threadId: thread.id,
    tldr,
    points: points.length ? points : [tldr],
    openQuestions: reason === 'model-failed' ? ['检查模型配置后重新收口，或手动补充未解问题。'] : [],
    artifacts: [],
    mastery: reason === 'empty' ? 0 : Math.max(1, node.mastery),
    masteryReason: reason === 'empty' ? '尚未开始。' : '自动收口不可用，掌握度由最近一轮回答估计。',
    nextHint: '回到地图，决定下一步。',
    sourceRange,
    generatedAt: new Date().toISOString(),
    model: reason === 'empty' ? 'empty' : 'fallback',
    version: 1,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 160))
    .slice(0, limit)
}

function artifactList(value: unknown): Artifact[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const kind = typeof item['kind'] === 'string' ? item['kind'] : ''
      const ref = text(item['ref'])
      if (!ref || !ARTIFACT_KINDS.has(kind as Artifact['kind'])) return undefined
      return {
        kind: kind as Artifact['kind'],
        ref,
        ...(text(item['label']) ? { label: text(item['label']) } : {}),
      }
    })
    .filter((item): item is Artifact => item !== undefined)
    .slice(0, 8)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

