import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
// ant-design-vue 组件按需自动引入（见 electron.vite.config.ts 的 Components 插件），
// 不要全量 app.use(Antd)。命令式 API（message / Modal / theme 等）按需具名导入。
// reset.css 是静态样式基线，与按需加载无关，需要全局引入。
import 'ant-design-vue/dist/reset.css'
import './assets/styles.css'

createApp(App).use(createPinia()).use(router).mount('#app')
