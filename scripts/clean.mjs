// 打包前清理：删掉 dist（安装包产物）与 out（编译产物）。
//
// 连 out 一起删：保证打进安装包的一定是本轮重新编译的产物，不混进上一轮的残留文件。
//
// 用 Node 的 fs 而不是 rm -rf：Windows 上没有 rm。
import fs from 'fs'
import path from 'path'
import chalk from 'chalk'

const targets = ['dist', 'out']

for (const target of targets) {
  const full = path.resolve(target)
  if (!fs.existsSync(full)) {
    console.log(chalk.gray(`[ clean ] skip ${target}（不存在）`))
    continue
  }
  try {
    fs.rmSync(full, { recursive: true, force: true })
    console.log(chalk.green(`[ clean ] removed ${target}`))
  } catch (err) {
    console.log(chalk.red(`[ clean error ] 删除 ${target} 失败: ${err.message}`))
    process.exit(1)
  }
}
