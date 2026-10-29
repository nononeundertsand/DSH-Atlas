/**
 * Atlas 的领域类型。Host 与浏览器共用，不依赖任何 DSH 运行时类型。
 *
 * 设计约束：
 * - 一个节点对应一段对话（主线程）；
 * - 子聊天是同节点下的一级线程，锚定在某条消息上；
 * - 关闭节点产出收口卡，卡片是节点在树里的“脸”。
 */

export type NodeStatus = 'seed' | 'active' | 'paused' | 'closed' | 'archived'
export type ThreadKind = 'main' | 'sub'
export type NodeKind = 'root' | 'module' | 'topic' | 'concept'
export type Role = 'user' | 'assistant' | 'system'

export interface Point {
  x: number
  y: number
}

export interface Workspace {
  id: string
  name: string
  goal?: string
  createdAt: string
  updatedAt: string
  active: boolean
  /** 单调递增的本地修订号，用于客户端冲突检测。 */
  rev: number
}

export interface AtlasNode {
  id: string
  workspaceId: string
  parentId: string | null
  title: string
  subtitle?: string
  kind: NodeKind
  status: NodeStatus
  mastery: number
  position: Point
  threadId: string
  createdAt: string
  updatedAt: string
  closedAt?: string
  dueAt?: string
}

export interface Thread {
  id: string
  nodeId: string
  parentThreadId: string | null
  /** 子聊天锚定的助手消息；主线程为空。 */
  anchorMessageId?: string
  kind: ThreadKind
  title: string
  order: number
  collapsed: boolean
  summary?: string
  createdAt: string
}

export interface MessageQuote {
  messageId: string
  text: string
}

export interface AtlasMessage {
  id: string
  threadId: string
  role: Role
  content: string
  createdAt: string
  quote?: MessageQuote
  error?: boolean
}

export interface Artifact {
  kind: 'file' | 'link' | 'code' | 'table' | 'image'
  ref: string
  label?: string
}

export interface ClosureCard {
  id: string
  nodeId: string
  threadId: string
  tldr: string
  points: string[]
  openQuestions: string[]
  artifacts: Artifact[]
  mastery: number
  masteryReason: string
  nextHint: string
  sourceRange: [string, string] | []
  generatedAt: string
  model: string
  version: 1
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** 一个节点的完整快照：画布用它渲染，面板打开时再拉线程。 */
export interface WorkspaceSnapshot {
  workspace: Workspace
  nodes: AtlasNode[]
  threads: Thread[]
  viewport: Viewport
  rev: number
}

/** 祖先链上的简报，供续接与调试展示。 */
export interface PathBrief {
  nodeId: string
  title: string
  tldr?: string
}

export interface SubthreadSnapshot {
  thread: Thread
  messages: AtlasMessage[]
}

export interface ThreadSnapshot {
  workspace: Workspace
  thread: Thread
  messages: AtlasMessage[]
  card?: ClosureCard
  path: PathBrief[]
  node: AtlasNode
  /** 仅主线程携带：挂在消息下方的一级子聊天。 */
  subthreads?: SubthreadSnapshot[]
}

export interface SearchHit {
  kind: 'node' | 'message' | 'card'
  id: string
  nodeId: string
  title: string
  excerpt: string
}

export interface CreateWorkspaceInput {
  name: string
  goal?: string
}

export interface CreateNodeInput {
  workspaceId: string
  parentId?: string | null
  title: string
  subtitle?: string
  position?: Point
}

export interface UpdateNodeInput {
  title?: string
  subtitle?: string
  position?: Point
  status?: NodeStatus
  mastery?: number
}

export interface TurnInput {
  text: string
  quote?: MessageQuote
}

export interface CloseInput {
  threadId?: string
}

export interface PromoteInput {
  threadId: string
  title?: string
  position?: Point
}

export interface CreateSubthreadInput {
  title: string
  anchorMessageId?: string
  quote?: MessageQuote
}

export interface SearchInput {
  q: string
  workspaceId?: string
}

export type AtlasErrorCode =
  | 'E_AUTH'
  | 'E_MODEL'
  | 'E_BUDGET'
  | 'E_CONFLICT'
  | 'E_NOT_FOUND'
  | 'E_UNSUPPORTED'
  | 'E_VALIDATION'
  | 'E_BAD_REQUEST'
  | 'E_INTERNAL'

export interface ApiError {
  code: AtlasErrorCode
  message: string
}

/** GitHub 版本检测结果；失败时 updateAvailable 保持 false。 */
export interface UpdateInfo {
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  url: string
  checkedAt: string
  error?: string
}

/** SSE 帧。meta → delta* → done/error。 */
export type AtlasEvent =
  | { event: 'meta'; data: { threadId: string; messageId: string; model: string } }
  | { event: 'delta'; data: { messageId: string; text: string } }
  | { event: 'done'; data: { messageId: string; usage?: { input: number; output: number } } }
  | { event: 'error'; data: ApiError }
