// Boot the complete, installed DSH runtime against a fresh, isolated profile.
// node tests/dsh-fixture/selection-web.mjs /path/to/extracted/dsh [--port 5279]
// The runtime directory must contain node_modules/@deepseek-ai/dsh.
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const [runtimeArg, ...flags] = process.argv.slice(2)
assert.ok(runtimeArg, 'Pass an installed/extracted DSH runtime directory')
const runtime = resolve(runtimeArg)
const requireRuntime = createRequire(join(runtime, 'package.json'))
const cliPackage = requireRuntime.resolve('@deepseek-ai/dsh/package.json')
assert.equal(JSON.parse(await readFile(cliPackage, 'utf8')).version, '0.2.1-rc.2')
const root = await mkdtemp(join(tmpdir(), 'atlas-selection-native-'))
const profile = join(root, 'home/profiles/web')
await mkdir(join(profile, 'node_modules'), { recursive: true })
await mkdir(join(root, 'documents'))
const checkout = fileURLToPath(new URL('../../', import.meta.url))
await symlink(checkout, join(profile, 'node_modules/dsh-atlas'), 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'atlas-selection-offline', private: true, dependencies: { 'dsh-atlas': `file:${checkout}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-atlas'] } } }))
let fixture = await readFile(new URL('selection-web-plugin.mjs', import.meta.url), 'utf8')
for (const pkg of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) fixture = fixture.replace(`from '${pkg}'`, `from '${pathToFileURL(requireRuntime.resolve(pkg)).href}'`)
await writeFile(join(root, 'fixture.mjs'), fixture)
await writeFile(join(profile, 'cordis.patch.yml'), `
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(join(root, 'documents'))}
- id: llm-retry
  disabled: true
- id: session-log-deepseek
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: session-title-llm
  disabled: true
- id: agent-default-model
  config:
    provider: fixture
    model: fixture
- id: atlas
  config:
    dataDir: ${JSON.stringify(join(root, 'atlas'))}
    checkUpdates: false
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
- insert:
    - id: selection-offline-fixture
      name: ${JSON.stringify(join(root, 'fixture.mjs'))}
`)
console.log(`Isolated native DSH profile: ${root}\nOffline fixed-response model only; Ctrl+C stops this test server. Logs remain for read-only audit.`)
const child = spawn(process.execPath, [join(cliPackage, '../lib/bin.js'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', ...flags], {
  cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_MODE: 'OFF', DSH_TELEMETRY_DISABLED: '1' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code === 130 ? 0 : code ?? 1 })
