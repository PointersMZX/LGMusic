const fs = require('fs')
const path = require('path')
const bindingFilePath = path.join(__dirname, '../node_modules/better-sqlite3/binding.gyp')
const bindingBakFilePath = path.join(__dirname, '../node_modules/better-sqlite3/binding.gyp.bak')
exports.beforePack = async() => {
  if (!fs.existsSync(bindingFilePath)) return
  fs.renameSync(bindingFilePath, bindingBakFilePath)
  // try {
  //   fs.writeFileSync(
  //     bindingFilePath,
  //     fs.readFileSync(bindingFilePath, 'utf-8').replace('\'force_build%\': 0,', '\'force_build%\': 1,'),
  //   )
  // } catch (error) {
  //   console.error(error)
  // }
}
exports.afterPack = async() => {
  if (fs.existsSync(bindingFilePath)) return
  if (!fs.existsSync(bindingBakFilePath)) return // pnpm 布局下 .bak 可能从未生成，安全跳过
  fs.renameSync(bindingBakFilePath, bindingFilePath)
  // try {
  //   fs.writeFileSync(
  //     bindingFilePath,
  //     fs.readFileSync(bindingFilePath, 'utf-8').replace('\'force_build%\': 1,', '\'force_build%\': 0,'),
  //   )
  // } catch (error) {
  //   console.error(error)
  // }
}


const replaceSqliteLib = async(arch) => {
  // console.log(await fs.readdir(path.join(context.appOutDir, './resources/')))
  // if (context.electronPlatformName != 'linux' || context.arch != Arch.arm64) return
  console.log('replace sqlite lib...')
  const filePath = path.join(__dirname, `./lib/better_sqlite3_${process.platform}-${arch}.node`)
  console.log(filePath)
  const targetPath = path.join(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  await fs.promises.unlink(targetPath).catch(_ => _)
  await fs.promises.copyFile(filePath, targetPath)
}
exports.copyLib = async(arch = process.arch, replaceLocal = false) => {
  if (process.platform === 'linux' || replaceLocal) {
    await replaceSqliteLib(arch)
    return
  }
  const libPath = path.join(__dirname, `../node_modules/better-sqlite3/prebuilds/${process.platform}-${arch}.node`)
  if (!fs.existsSync(libPath)) {
    console.error(`Better-sqlite3 prebuild not found for ${process.platform}-${arch}`)
    return
  }
  const targetPath = path.join(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  await fs.promises.cp(libPath, targetPath, { recursive: true, force: true })
}
