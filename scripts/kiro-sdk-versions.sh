#!/usr/bin/env bash
# 下载 Kiro IDE 各版本 dmg，提取其中打包的 AWS SDK 版本，生成「IDE 版本 → SDK 版本」对照表 JSON
#
# UA 里的 aws-sdk-js/<版本> 取自 kiro-agent 扩展打包的 @aws/codewhisperer-streaming-client，
# 新版还会额外打包 @amzn/kiro-runtime-service-typescript-client 等，这里一并列出。
#
# 用法：
#   scripts/kiro-sdk-versions.sh                   # 处理全部版本
#   scripts/kiro-sdk-versions.sh 0.10.78 1.4.121   # 只处理指定版本（会覆盖输出文件，只剩这几条）
#
# 新版本发布后：把版本号加进下面的 VERSIONS 重跑，生成的 JSON 直接被
# src/shared/kiroVersion.ts 读取，「常用工具 → 请求头版本号」的级联下拉随之更新，无需改代码。
#
# 环境变量：
#   DMG_DIR   dmg 存放目录，默认 ~/Downloads/kiro-dmgs（~/Downloads 下已有同名 dmg 会直接复用，不重复下载）
#   OUT       输出 JSON 路径，默认 src/shared/data/kiro-sdk-versions.json（与脚本所在位置相对，在哪个目录执行都一样）
#   KEEP_DMG  1=保留下载的 dmg（默认），0=提取完即删除，节省磁盘（不会删 ~/Downloads 里原有的文件）
#   https_proxy / all_proxy   curl 会自动走代理，例如 https_proxy=http://127.0.0.1:7897
set -u

VERSIONS=(
  1.4.121 1.4.62 1.4.51 1.4.26 1.4.10 1.4.5 1.4.0
  1.3.11 1.3.0
  1.2.56 1.2.37
  1.1.70
  1.0.437
  0.12.200 0.12.184
  0.11.133 0.11.132 0.11.131 0.11.130 0.11.107 0.11.63 0.11.34
  0.10.78 0.10.32
  0.9.47
  0.8.206
)
[ $# -gt 0 ] && VERSIONS=("$@")

BASE=https://prod.download.desktop.kiro.dev/releases/stable/darwin-arm64/signed
DMG_DIR=${DMG_DIR:-$HOME/Downloads/kiro-dmgs}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$SCRIPT_DIR/../src/shared/data/kiro-sdk-versions.json}
mkdir -p "$(dirname "$OUT")"
KEEP_DMG=${KEEP_DMG:-1}

mkdir -p "$DMG_DIR"
MNT=$(mktemp -d /tmp/kiro-dmg.XXXXXX)
ENTRIES=$(mktemp /tmp/kiro-entries.XXXXXX)

cleanup() {
  hdiutil detach "$MNT" -force >/dev/null 2>&1
  rmdir "$MNT" 2>/dev/null
  rm -f "$ENTRIES"
}
trap cleanup EXIT INT TERM

# 在扩展目录里找所有提到 Kiro / CodeWhisperer 客户端包的 js 与 package.json，提取包名与版本。
# 输出两行：第一行是 codewhisperer-streaming-client 的最高版本（没有则为空），第二行是 {包名:[版本...]} JSON
read -r -d '' PERL_EXTRACT <<'PERL'
use File::Find;
my $root = shift;
my $pkg = qr{\@(?:aws|amzn)/[\w.-]*(?:codewhisperer|kiro)[\w.-]*};
my %seen;
find({ no_chdir => 1, wanted => sub {
  return unless -f $_ && /(\.c?js|package\.json)$/;
  open my $fh, '<', $_ or return; local $/; my $s = <$fh>; close $fh;
  return unless $s =~ /codewhisperer|kiro-runtime/;
  # 未压缩的对象字面量与 package.json：name → description → version 依次出现
  while ($s =~ /"?name"?\s*:\s*"($pkg)"\s*,\s*"?description"?\s*:\s*"[^"]*"\s*,\s*"?version"?\s*:\s*"(\d[^"]*)"/g) { $seen{$1}{$2} = 1 }
  # 压缩后被提成变量：a="包名",b="描述",c="版本"
  while ($s =~ /[\w\$]+="($pkg)",[\w\$]+="[^"]*",[\w\$]+="(\d[^"]*)"/g) { $seen{$1}{$2} = 1 }
}}, $root);
sub vcmp { my @a = split /[.-]/, $_[0]; my @b = split /[.-]/, $_[1];
  for my $i (0..2) { my $d = ($a[$i] // 0) <=> ($b[$i] // 0); return $d if $d } 0 }
my $cw = '@aws/codewhisperer-streaming-client';
my @cwv = sort { vcmp($a, $b) } keys %{ $seen{$cw} || {} };
print(($cwv[-1] // ''), "\n");
print '{', join(',', map { my $p = $_;
  "\"$p\":[" . join(',', map { "\"$_\"" } sort { vcmp($a, $b) } keys %{ $seen{$p} }) . ']'
} sort keys %seen), "}\n";
PERL

# 记录一条结果：ide、包内版本号、SDK 版本、包列表 JSON、状态
add_entry() {
  local sdk=null
  [ -n "$3" ] && sdk="\"$3\""
  printf '{"ide":"%s","bundleVersion":"%s","awsSdkVersion":%s,"packages":%s,"status":"%s"}\n' \
    "$1" "$2" "$sdk" "${4:-{\}}" "$5" >>"$ENTRIES"
}

echo "共 ${#VERSIONS[@]} 个版本，每个 dmg 约 200~300 MB，dmg 目录：$DMG_DIR"

for ver in "${VERSIONS[@]}"; do
  name="kiro-ide-$ver-stable-darwin-arm64.dmg"
  echo
  echo "==== $ver"

  # 1. 找本地已有的 dmg，没有再下载
  downloaded=0
  if [ -s "$DMG_DIR/$name" ]; then
    dmg="$DMG_DIR/$name"
  elif [ -s "$HOME/Downloads/$name" ]; then
    dmg="$HOME/Downloads/$name"
  else
    dmg="$DMG_DIR/$name"
    echo "下载 $BASE/$ver/$name"
    if curl -fL --retry 3 --retry-delay 3 -C - --progress-bar -o "$dmg.part" "$BASE/$ver/$name"; then
      mv "$dmg.part" "$dmg"
      downloaded=1
    else
      echo "下载失败，跳过"
      add_entry "$ver" "" "" "" download_failed
      continue
    fi
  fi
  echo "使用 $dmg"

  # 2. 只读挂载，不弹 Finder 窗口
  if ! hdiutil attach -readonly -nobrowse -noautoopen -noverify -mountpoint "$MNT" "$dmg" >/dev/null 2>&1; then
    echo "挂载失败（文件可能不完整，可删除后重试）"
    add_entry "$ver" "" "" "" mount_failed
    continue
  fi

  app=$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)
  if [ -z "$app" ]; then
    echo "dmg 里没有找到 .app"
    add_entry "$ver" "" "" "" app_not_found
  else
    bundle=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null)
    ext="$app/Contents/Resources/app/extensions/kiro.kiro-agent"
    [ -d "$ext" ] || ext="$app/Contents/Resources/app"

    # 3. 提取版本
    result=$(perl -e "$PERL_EXTRACT" "$ext")
    sdk=$(printf '%s\n' "$result" | sed -n 1p)
    pkgs=$(printf '%s\n' "$result" | sed -n 2p)
    status=ok
    [ -z "$sdk" ] && status=not_found
    echo "IDE $bundle → aws-sdk-js/${sdk:-?}  $pkgs"
    add_entry "$ver" "$bundle" "$sdk" "$pkgs" "$status"
  fi

  hdiutil detach "$MNT" -force >/dev/null 2>&1
  # 只删本次下载的文件，用户原有的 dmg 保留
  [ "$KEEP_DMG" = 0 ] && [ "$downloaded" = 1 ] && rm -f "$dmg"
done

# 4. 汇总成格式化 JSON（JSON::PP 是 macOS 自带 perl 的核心模块）
# 不开 utf8：note 里的中文按原始字节透传，避免二次编码成乱码
perl -MJSON::PP -e '
  my @rows; while (<STDIN>) { chomp; push @rows, JSON::PP->new->decode($_) if length }
  my $doc = {
    generatedAt => scalar(gmtime) . " UTC",
    note => q{awsSdkVersion 取 @aws/codewhisperer-streaming-client 的最高版本；同一 IDE 打包了多份时 packages 里会全部列出},
    versions => \@rows,
  };
  print JSON::PP->new->pretty->canonical->encode($doc);
' <"$ENTRIES" >"$OUT"

echo
echo "完成，对照表已写入 $OUT"
printf '%-10s %-12s %s\n' IDE AWS_SDK 状态
perl -MJSON::PP -e '
  local $/; my $d = decode_json(<STDIN>);
  printf "%-10s %-12s %s\n", $_->{ide}, $_->{awsSdkVersion} // "-", $_->{status} for @{ $d->{versions} };
' <"$OUT"
