<script setup lang="ts">
/**
 * 桌面 agent 的品牌图标。
 *
 * 图标放在 assets/agents/ 下，和 assets/sites/ 同一种用法：?raw 取出 SVG 原文再 v-html。
 * 不用 <img src>：单色图标写的是 currentColor，放进 img 就只剩黑色，暗色主题下看不见。
 * SVG 文件里只留 viewBox、不写 width/height，尺寸完全由外层 span 决定；
 * 带着这两个属性会和父级样式冲突，图标大小不稳定。
 *
 * SVG 是仓库内置的静态资源，不含外部输入，v-html 没有注入风险。
 */
import { computed } from 'vue'
import chatgptSvg from '@/assets/agents/chatgpt.svg?raw'
import claudeSvg from '@/assets/agents/claude.svg?raw'
import cursorSvg from '@/assets/agents/cursor.svg?raw'
import vscodeSvg from '@/assets/agents/vscode.svg?raw'
import deepseekSvg from '@/assets/agents/deepseek.svg?raw'
// WorkBuddy 取自它 app.asar 里的官方图标，内部 id 加了 wb- 前缀：
// 多个 SVG 内联进同一页面时 id 是全局的，撞名会让渐变、裁剪串到别的图标上
import workbuddySvg from '@/assets/agents/workbuddy.svg?raw'
// Qoder 是单色图标，写的 currentColor，跟随主题明暗
import qoderSvg from '@/assets/agents/qoder.svg?raw'
// ZCode 同样是单色 currentColor
import zcodeSvg from '@/assets/agents/zcode.svg?raw'
// Kimi Code 官网的字标「KIMI ‹Code›」是横幅，缩到卡片尺寸看不清；取其中的 K 和蓝色尖括号拼成方形，K 用 currentColor
import kimiSvg from '@/assets/agents/kimi.svg?raw'
import type { ProxyClientTarget } from '@shared/types'

const props = defineProps<{ target: ProxyClientTarget; size?: number }>()

/** 一个产品一个图标：两个 Codex 共用 ChatGPT 的标志，两个 Claude、两个 DeepSeek 同理 */
const ICONS: Record<ProxyClientTarget, string> = {
  claudeCode: claudeSvg,
  claudeApp: claudeSvg,
  codex: chatgptSvg,
  codexApp: chatgptSvg,
  cursor: cursorSvg,
  vscode: vscodeSvg,
  deepseek: deepseekSvg,
  deepseekApp: deepseekSvg,
  workbuddy: workbuddySvg,
  qoder: qoderSvg,
  zcode: zcodeSvg,
  kimi: kimiSvg
}

const svg = computed(() => ICONS[props.target])
const px = computed(() => `${props.size ?? 18}px`)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <span class="client-icon" :style="{ width: px, height: px }" v-html="svg" />
</template>

<style scoped>
.client-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
/* v-html 进来的节点不带 scoped 属性，必须 :deep 才选得到 */
.client-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
