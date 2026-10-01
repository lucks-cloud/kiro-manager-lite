// 拉起别的应用时用的环境变量：去掉本应用（Electron / electron-vite）自己的那一套
//
// 踩过的坑：开发模式下 electron-vite 往环境里塞了 ELECTRON_RENDERER_URL=http://localhost:5173、
// NODE_ENV=development 等变量，`open` / spawn 拉起的应用会原样继承。Qoder CN 也是 electron-vite 打包的，
// 它的主进程看到 ELECTRON_RENDERER_URL 就去加载这个地址——窗口里跑的成了本应用的界面，
// 缺它自己的 preload，一启动就报错白屏，表现为「重启后卡死进不去」。
// 打包后的本应用没有这些变量，但 ELECTRON_RUN_AS_NODE 之类一旦漏过去同样会让对方起不来，统一清掉。

const LEAKY = /^(ELECTRON_|VITE_|NODE_ENV)/

export function cleanChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!LEAKY.test(key)) env[key] = value
  }
  return { ...env, ...extra }
}
