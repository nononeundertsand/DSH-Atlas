/**
 * DSH Host 插件入口。
 *
 * 一行 cordis.patch.yml 同时激活 Host 半和浏览器半：
 * - 这里注册 /ext/atlas/*；
 * - package.json 的 dsh.client 让 DSH 把 lib/client.js 发给浏览器。
 */
import type { HostContext } from '../shared/dsh.js'
import { ATLAS_BASE } from '../shared/protocol.js'
import { AtlasStore } from './store.js'
import { AtlasModel } from './model.js'
import { createAtlasRouter } from './routes.js'
import { UpdateChecker } from './update.js'

export interface AtlasConfig {
  /** 留空时自动选择第一个可用 provider。 */
  provider?: string
  /** 留空时自动选择该 provider 的第一个模型。 */
  model?: string
  /** 覆盖 ~/.dsh/atlas，主要用于测试。 */
  dataDir?: string
  maxTokens?: number
  /** 是否检测 GitHub 新版本；默认开启，可设为 false 关闭。 */
  checkUpdates?: boolean
  /** 默认 nononeundertsand/DSH-Atlas。 */
  updateRepo?: string
  updateBranch?: string
}

export const inject = ['webServer', 'llm', 'agentDefaultModel']

export function apply(ctx: HostContext, config: AtlasConfig = {}): void {
  const store = new AtlasStore(config.dataDir)
  const model = new AtlasModel(ctx.llm, config, () => ctx.agentDefaultModel?.currentSelection())
  const updates = new UpdateChecker(config)
  const router = createAtlasRouter({
    store,
    model,
    dataDir: store.location,
    modelHint: config.model ?? 'auto',
    checkUpdate: (force) => updates.check(force),
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ATLAS_BASE, handler: router }),
    'dsh-atlas: routes',
  )

  // 只打印路径与能力状态，不输出任何对话内容。
  console.log(`[atlas] ready · workspaces: ${store.location}`)
}
