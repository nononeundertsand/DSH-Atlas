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
  /** DSH 普通 Session 的绑定；旧 Atlas-native 节点没有此字段。 */
  sessionId?: string
  /** DSH 工作区分组身份，用于同步原生删除；与逻辑地图 ID 分开。 */
  runtimeWorkspaceId?: string
  /** 最近一次显式新建会话所替换的身份，供失败重试使用。 */
  replacedSessionId?: string
  /** 用户显式「归档会话」时记录；删除节点不再打此标记。恢复节点不清除，恢复归档会话时清除。 */
  sessionArchivedAt?: string
  deletedAt?: string
  deletionBatchId?: string
  deletionRootId?: string
  createdAt: string
  updatedAt: string
  closedAt?: string
  dueAt?: string
  /** 最近一次打开对话的时间。 */
  lastOpenedAt?: string
  /** 最近一次打开对话的持续时间（毫秒）。 */
  lastDurationMs?: number
  /** 打开次数。 */
  openCount?: number
}

/**
 * 节点的历史会话来源，按 Session ID 独立保存，不被新建会话覆盖。
 * 这是「恢复旧 S1 但当前仍绑定 S2」所需的元数据，不是同时绑定多个当前会话。
 */
export interface NodeSessionLink {
  sessionId: string
  /** 来源节点 ID。 */
  originNodeId: string
  /** 来源地图 ID。 */
  originWorkspaceId: string
  /** 创建绑定时的节点标题快照。 */
  nodeTitleSnapshot: string
  /** 该会话最后被 Atlas 归档的时间（展示用；原生归档状态以 DSH 为准）。 */
  archivedAt?: string
  /** 首次记录时间。 */
  createdAt: string
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

export interface VisitInput {
  openedAt: string
  durationMs: number
}

export interface ExplainInput {
  text: string
}

export interface ExplainResult {
  term: string
  meaning: string
  inContext: string
  model: string
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
  | 'E_SESSION_ARCHIVED'
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

export interface DeletePreview { nodes: AtlasNode[]; token: string }

/** 回收站展示信息由当前地图和节点关系推导，不改写旧记录。 */
export interface TrashNode extends AtlasNode { workspaceName: string; pathTitles: string[]; pathComplete: boolean }
export type LibraryItem = Pick<TrashNode, 'id' | 'workspaceId' | 'workspaceName' | 'title' | 'sessionId' | 'deletedAt' | 'deletionBatchId' | 'deletionRootId' | 'sessionArchivedAt' | 'pathTitles' | 'pathComplete'> & { purgedAt?: string; /** DSH 真实会话标题，缺失时回退节点标题。 */ sessionTitle?: string }

/**
 * 会话页的一条记录：来自历史来源 + 当前绑定 + DSH 原生归档状态。
 * 会话是否归档以 DSH 原生状态为准，不受节点 deletedAt 影响。
 */
export interface SessionRecord {
  sessionId: string
  /** 来源节点 ID（可能已删除或彻底删除）。 */
  originNodeId: string
  /** 来源地图 ID。 */
  originWorkspaceId: string
  /** 来源地图名称。 */
  workspaceName?: string
  /** 节点标题快照。 */
  nodeTitle: string
  /** 会话真实标题（缺失回退节点标题快照）。 */
  title: string
  /** 是否当前绑定到某个节点。 */
  isCurrent: boolean
  /** 当前绑定到的节点 ID（无则空）。 */
  currentNodeId?: string
  /** DSH 原生归档状态（事实来源）。 */
  archived: boolean
  /** Atlas 侧记录的时间（展示用）。 */
  archivedAt?: string
}
