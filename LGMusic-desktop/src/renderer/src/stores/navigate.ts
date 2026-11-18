/** 页面导航状态（歌单详情/榜单等二级页共用） */
import { reactive } from 'vue'

interface NavigateState {
  detailVisible: boolean
  detailKind: 'playlist' | 'ranking' | ''
  detailSource: string
  detailId: string
  detailName: string
}

export const navigateState = reactive<NavigateState>({
  detailVisible: false,
  detailKind: '',
  detailSource: '',
  detailId: '',
  detailName: ''
})

export function openDetail(kind: 'playlist' | 'ranking', source: string, id: string, name: string): void {
  navigateState.detailKind = kind
  navigateState.detailSource = source
  navigateState.detailId = id
  navigateState.detailName = name
  navigateState.detailVisible = true
}

export function closeDetail(): void {
  navigateState.detailVisible = false
}
