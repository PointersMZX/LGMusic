import { useMemo } from 'react'
import { ScrollView, View } from 'react-native'

import { useMyList } from '@/store/list/hook'
import ListItem from './ListItem'
import { useWindowSize } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'

const styles = createStyle({
  list: {
    paddingLeft: 15,
    paddingRight: 2,
    paddingBottom: 5,
    flexDirection: 'row',
    flexWrap: 'wrap',
    // backgroundColor: 'rgba(0,0,0,0.2)'
  },
})
const MIN_WIDTH = scaleSizeW(140)
const PADDING = styles.list.paddingLeft + styles.list.paddingRight

export default ({ listId, onPress }: {
  listId: string
  onPress: (listInfo: LX.List.MyListInfo) => void
}) => {
  const windowSize = useWindowSize()
  // 不展示用户自建歌单（仅试听列表/喜欢列表等系统列表）
  const allList = useMyList().filter((item): item is LX.List.MyDefaultListInfo | LX.List.MyLoveListInfo => !('locationUpdateTime' in item)).filter(l => l.id != listId)
  const itemWidth = useMemo(() => {
    let w = Math.floor(windowSize.width * 0.9 - PADDING)
    let n = Math.floor(w / MIN_WIDTH)
    if (n > 10) n = 10
    return Math.floor((w - 1) / n)
  }, [windowSize])

  return (
    <ScrollView style={{ flexGrow: 0 }}>
      <View style={{ ...styles.list }} onStartShouldSetResponder={() => true}>
        { allList.map(info => <ListItem key={info.id} listInfo={info} onPress={onPress} width={itemWidth} />) }
      </View>
    </ScrollView>
  )
}
