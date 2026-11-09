// Orchestrator: boot the plugin's private runtime against the REAL installed
// DSH 0.2.2-rc.1 packages extracted from the desktop app.asar.
// This is a package-level native verification, not a mock of the new interface.
import { openSync, readSync, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const asar = process.env.DSH_ASAR || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
if (!existsSync(asar)) {
  console.log('SKIP native-runtime: no installed DSH app.asar (set DSH_ASAR to run this check)')
  process.exit(0)
}
const info = await stat(asar)
const cache = join(root, 'node_modules/.cache/dsh-native-runtime')
const marker = join(cache, '.extracted')
const stamp = `${info.size}:${info.mtimeMs}`
await mkdir(join(cache, 'node_modules'), { recursive: true })

if (!existsSync(marker) || (await readFile(marker, 'utf8')) !== stamp) {
  const fd = openSync(asar, 'r')
  const head = Buffer.alloc(20)
  readSync(fd, head, 0, 20, 0)
  const dataOffset = 8 + head.readUInt32LE(4)
  const jsonLen = head.readUInt32LE(12)
  const header = Buffer.alloc(jsonLen)
  readSync(fd, header, 0, jsonLen, 16)
  const tree = JSON.parse(header.toString('utf8'))
  const files = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const path = `${prefix}/${name}`
      if (value.files) walk(value, path)
      else files.push({ path, size: value.size, offset: Number(value.offset) })
    }
  }
  walk(tree, '')
  const prefix = '/dsh/node_modules/'
  const pick = files.filter(file => file.path.startsWith(prefix) && Number.isFinite(file.offset) && /\.(js|mjs|cjs|json|wasm|node)$/.test(file.path))
  const dirs = new Set()
  for (const file of pick) {
    const out = join(cache, 'node_modules', file.path.slice(prefix.length))
    const dir = dirname(out)
    if (!dirs.has(dir)) { await mkdir(dir, { recursive: true }); dirs.add(dir) }
    const buffer = Buffer.alloc(file.size)
    readSync(fd, buffer, 0, file.size, dataOffset + file.offset)
    await writeFile(out, buffer)
  }
  await writeFile(marker, stamp, 'utf8')
  console.log(`Extracted ${pick.length} real 0.2.2-rc.1 runtime files from the installed DSH app`)
}

for (const entry of ['src/host/selection-memory.ts', 'src/host/selection-chat.ts']) {
  const output = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', packages: 'external', logLevel: 'silent' })
  await writeFile(join(cache, entry.split('/').at(-1).replace('.ts', '.mjs')), output.outputFiles[0].text)
}
await copyFile(join(root, 'tests/native-runtime-harness.mjs'), join(cache, 'harness.mjs'))
await import(pathToFileURL(join(cache, 'harness.mjs')).href)
