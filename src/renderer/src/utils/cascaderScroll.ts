import { nextTick } from 'vue'

/**
 * 级联下拉展开时，把一级菜单滚到当前选中项，并尽量放在列中间。
 *
 * antd 自己只在「激活路径变化」时滚动，而且首次展开时浮层还没完成布局，
 * 再次展开若值没变也不会重新触发，于是常常停在列表顶部。这里在浮层渲染后手动滚一次，
 * 找不到元素（浮层还没挂上 / 还没排版）时下一帧再试，最多试几帧。
 *
 * @param popupClass 级联的 popupClassName，用来在 body 下定位到这一个浮层
 * @param value 当前选中项的第一级 value
 */
export function scrollCascaderToActive(popupClass: string, value: string | undefined): void {
  if (!value) return
  void nextTick(() => attempt(popupClass, value, 6))
}

function attempt(popupClass: string, value: string, tries: number): void {
  requestAnimationFrame(() => {
    const menu = document.querySelector<HTMLElement>(
      `.${popupClass} .ant-cascader-menu:first-child`
    )
    const item = menu?.querySelector<HTMLElement>(`li[data-path-key="${CSS.escape(value)}"]`)
    if (!menu || !item || !menu.clientHeight) {
      if (tries > 0) attempt(popupClass, value, tries - 1)
      return
    }
    const top = item.offsetTop - menu.offsetTop - (menu.clientHeight - item.offsetHeight) / 2
    menu.scrollTop = Math.max(0, top)
  })
}
