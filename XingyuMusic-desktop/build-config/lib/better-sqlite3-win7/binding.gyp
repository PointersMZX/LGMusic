# stub: electron-builder npmRebuild=false，本文件不参与真实编译；
# 仅配合 build-config/deps.js 的 beforePack/afterPack rename 流程（防止 electron-builder 触碰原生模块）。
{
  'targets': {
    'better_sqlite3': {
      'sources': [ 'src/better_sqlite3.cpp' ]
    }
  }
}
