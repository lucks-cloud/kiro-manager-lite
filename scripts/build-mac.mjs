// macOS 打包：先一次打完两个架构的 dmg + zip，再按架构依次打 pkg。
//
// 为什么 pkg 不能和其它目标一起打：electron-builder 打 pkg 时在 dist/ 下用固定的文件名
// （<bundle id>.pkg、distribution.xml）放中间产物，打完就删。两个架构并行打时会共用这两个文件，
// 先打完的一方把它们删掉，另一方再删就报 ENOENT，整个构建失败（CI 上 arm64 + x64 必然撞上）。
//
// dmg / zip 仍然两个架构一起打：latest-mac.yml（自动更新用）要一次性列出两个架构的 zip，
// 分开打的话后一次会把前一次的覆盖掉。
//
// 命令行参数（如 CI 里的 --publish never）原样转给每一次 electron-builder。
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'

const extra = process.argv.slice(2)
const APP = 'Kiro Manager Lite.app'

function builder(args) {
  const result = spawnSync('npx', ['electron-builder', ...args, ...extra], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

builder(['--mac', 'dmg', 'zip', '--arm64', '--x64'])

// 复用上一步打好的 .app，不再重新打包；x64 的输出目录是 dist/mac，arm64 是 dist/mac-arm64
for (const [arch, dir] of [
  ['--arm64', 'dist/mac-arm64'],
  ['--x64', 'dist/mac']
]) {
  const app = `${dir}/${APP}`
  if (!existsSync(app)) {
    console.error(`找不到 ${app}，无法打 pkg`)
    process.exit(1)
  }
  builder(['--mac', 'pkg', arch, '--prepackaged', app])
}
