/**
 * 分组读写的统一门面。
 *
 * 账号和 API Key 的分组交互完全一样，但底层存储不同：账号存在渲染层、改完同步落盘，
 * Key 存在主进程、每个动作都是一次异步 IPC。为了让分组面板与批量弹窗只写一份，
 * 这里把两套差异收敛成同一个接口 —— 一律 async，一律「返回错误文案或 null」。
 */
import { useAccountsStore } from '@/stores/accounts'
import { useKeysStore } from '@/stores/keys'
import type { AccountGroup } from '@shared/types'

export interface GroupApi {
  /** 分组列表，已按 order 排好 */
  readonly groups: AccountGroup[]
  /** 各分组下的条目数，含「未分组」 */
  readonly counts: Record<string, number>
  /** 新建；同名复用已有分组，此时 created 为 false */
  add: (name: string) => Promise<{ error?: string; group?: AccountGroup; created?: boolean }>
  rename: (id: string, name: string) => Promise<string | null>
  /** 删除；引用该分组的条目会变为未分组 */
  remove: (id: string) => Promise<string | null>
  reorder: (orderedIds: string[]) => Promise<string | null>
  /**
   * 批量设置分组，返回实际变化的条数。
   * groupId 传 null 表示移出分组（把条目变回未分组）。
   */
  assign: (ids: string[], groupId: string | null) => Promise<{ error?: string; changed: number }>
}

/** 账号侧：store 里是同步方法，这里包成 async 以对齐接口 */
export function accountGroupApi(): GroupApi {
  const store = useAccountsStore()
  return {
    // 用 getter 而不是取值：组件渲染时才访问，响应式才跟得上
    get groups() {
      return store.groups
    },
    get counts() {
      return store.groupCounts
    },
    async add(name) {
      const before = store.groups.length
      const group = store.addGroup(name)
      if (!group) return { error: '分组名称不能为空' }
      return { group, created: store.groups.length > before }
    },
    async rename(id, name) {
      return store.renameGroup(id, name) ? null : '分组名称不能为空'
    },
    async remove(id) {
      store.removeGroup(id)
      return null
    },
    async reorder(orderedIds) {
      store.reorderGroups(orderedIds)
      return null
    },
    async assign(ids, groupId) {
      return { changed: store.setGroupForAccounts(ids, groupId) }
    }
  }
}

/** API Key 侧：store 方法本身就是异步 IPC，直接转发 */
export function keyGroupApi(): GroupApi {
  const store = useKeysStore()
  return {
    get groups() {
      return store.groups
    },
    get counts() {
      return store.groupCounts
    },
    async add(name) {
      const before = store.groups.length
      const res = await store.addGroup(name)
      if (res.error) return { error: res.error }
      return { group: res.group, created: store.groups.length > before }
    },
    rename: (id, name) => store.renameGroup(id, name),
    remove: (id) => store.removeGroup(id),
    reorder: (orderedIds) => store.reorderGroups(orderedIds),
    async assign(ids, groupId) {
      const res = await store.setGroupForKeys(ids, groupId)
      return res.error ? { error: res.error, changed: 0 } : { changed: res.changed ?? 0 }
    }
  }
}
