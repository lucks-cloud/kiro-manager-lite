#!/usr/bin/env bash
#
# 开发模式专用：给 node_modules 里的开发用 Electron.app 声明 kiro:// 自定义协议。
#
# 为什么需要：macOS 上 app.setAsDefaultProtocolClient('kiro') 只对「Info.plist 已声明该
# scheme」的 bundle 生效。打包版由 electron-builder 按 electron-builder.yml 声明了 kiro，
# 没问题；但 `npm run dev` 跑的是 node_modules/electron 里的 Electron.app，它的 Info.plist
# 没声明 kiro，于是社交登录的 kiro:// 回调抢不到，会被别的应用接走。这里在 dev 启动前
# 给它补上声明并重新登记，使 dev 模式也能把回调收回本应用。
#
# 影响范围：只改本机 node_modules 的开发用 Electron（npm install / 升级 electron 后会被
# 重置，重跑 dev 即可自动再打一次）。打包产物的 Info.plist 另行生成，与此脚本完全无关。
#
# 幂等：已声明过 kiro 就直接跳过，不会重复修改、不会反复触碰签名。
set -u

# 仅 macOS 需要（Windows 写注册表、Linux 写 .desktop，运行时注册即可，无需预声明）
[ "$(uname)" = "Darwin" ] || exit 0

APP="node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
PB="/usr/libexec/PlistBuddy"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

[ -f "$PLIST" ] || {
  echo "[dev-scheme] 未找到开发用 Electron.app，跳过（请先 npm install）"
  exit 0
}

# 已声明过 kiro:// 就不再处理（避免每次 dev 都改 Info.plist 与重新签名）
if "$PB" -c "Print :CFBundleURLTypes" "$PLIST" 2>/dev/null | grep -q "kiro"; then
  exit 0
fi

echo "[dev-scheme] 为开发用 Electron.app 声明 kiro:// 协议…"

"$PB" -c "Add :CFBundleURLTypes array" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0 dict" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLName string dev.kiro.account.lite.kiro" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string kiro" "$PLIST" 2>/dev/null || true

# 改动 Info.plist 会让 Electron.app 的 ad-hoc 签名失效，Apple Silicon 上会导致进程被内核
# 拒绝启动，必须用 ad-hoc 身份重新签名（- 表示 ad-hoc，和 Electron 预签的方式一致）。
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# 让 LaunchServices 重新读取该 bundle 的协议声明
"$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

echo "[dev-scheme] 完成：dev 模式下 kiro:// 回调将回到本应用"
exit 0
