/**
 * 轻量版本检测：读取 GitHub 上的 package.json，与当前安装版本比较。
 *
 * 只检测，不自动安装。DSH 的插件安装/重启仍由用户显式执行，
 * 避免后台悄悄替换正在运行的 Host 代码。
 */
import pkg from '../../package.json'
import type { UpdateInfo } from '../shared/types.js'

export interface UpdateConfig {
  checkUpdates?: boolean
  updateRepo?: string
  updateBranch?: string
  updateIntervalMs?: number
}

const DEFAULT_REPO = 'nononeundertsand/DSH-Atlas'
const DEFAULT_BRANCH = 'main'
const DEFAULT_INTERVAL = 6 * 60 * 60 * 1000

export class UpdateChecker {
  private cached?: { at: number; info: UpdateInfo }
  private pending?: Promise<UpdateInfo>

  constructor(private readonly config: UpdateConfig = {}) {}

  get currentVersion(): string {
    return pkg.version
  }

  async check(force = false): Promise<UpdateInfo> {
    const repo = validRepo(this.config.updateRepo)
    const url = `https://github.com/${repo}`
    const disabled = this.config.checkUpdates === false
    if (disabled) {
      return {
        currentVersion: pkg.version,
        updateAvailable: false,
        url,
        checkedAt: new Date().toISOString(),
        error: 'disabled',
      }
    }

    const interval = this.config.updateIntervalMs ?? DEFAULT_INTERVAL
    if (!force && this.cached && Date.now() - this.cached.at < interval) return this.cached.info
    // force 只用于手动刷新；一分钟内仍复用结果，避免本地进程刷爆 GitHub 限额。
    if (force && this.cached && Date.now() - this.cached.at < 60_000) return this.cached.info
    if (this.pending) return this.pending

    this.pending = this.fetchLatest(repo, url)
      .catch((error: unknown) => ({
        currentVersion: pkg.version,
        updateAvailable: false,
        url,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : '更新检查失败',
      }))
      .then((info) => {
        this.cached = { at: Date.now(), info }
        this.pending = undefined
        return info
      })

    return this.pending
  }

  private async fetchLatest(repo: string, url: string): Promise<UpdateInfo> {
    const branch = validBranch(this.config.updateBranch)
    const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')
    const candidates = [
      {
        url: `https://api.github.com/repos/${repo}/contents/package.json?ref=${encodedBranch}`,
        accept: 'application/vnd.github.raw+json',
      },
      {
        url: `https://raw.githubusercontent.com/${repo}/${encodedBranch}/package.json`,
        accept: 'application/json',
      },
    ]

    let lastError: unknown
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.url, {
          headers: { accept: candidate.accept, 'user-agent': 'dsh-atlas' },
          signal: AbortSignal.timeout(6_000),
        })
        if (!response.ok) {
          lastError = new Error(`GitHub 返回 ${response.status}`)
          continue
        }
        const remote = (await response.json()) as { version?: unknown }
        if (typeof remote.version !== 'string') {
          lastError = new Error('远端 package.json 没有 version')
          continue
        }
        return {
          currentVersion: pkg.version,
          latestVersion: remote.version,
          updateAvailable: compareVersions(remote.version, pkg.version) > 0,
          url,
          checkedAt: new Date().toISOString(),
        }
      } catch (error) {
        lastError = error
      }
    }

    throw lastError instanceof Error ? lastError : new Error('更新检查失败')
  }
}

/** 比较两段 semver 的核心数字；稳定版高于同号预发布版。 */
export function compareVersions(left: string, right: string): number {
  const [leftCore, leftPre] = splitVersion(left)
  const [rightCore, rightPre] = splitVersion(right)
  for (let index = 0; index < 3; index++) {
    const diff = (leftCore[index] ?? 0) - (rightCore[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (!leftPre && rightPre) return 1
  if (leftPre && !rightPre) return -1
  if (!leftPre && !rightPre) return 0
  return leftPre.localeCompare(rightPre)
}

function splitVersion(version: string): [number[], string] {
  const clean = version.trim().replace(/^v/i, '')
  const [core = '0', ...pre] = clean.split('-')
  return [core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre.join('-')]
}

function validRepo(repo: string | undefined): string {
  return repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : DEFAULT_REPO
}

function validBranch(branch: string | undefined): string {
  return branch && /^[A-Za-z0-9_./-]+$/.test(branch) ? branch : DEFAULT_BRANCH
}
