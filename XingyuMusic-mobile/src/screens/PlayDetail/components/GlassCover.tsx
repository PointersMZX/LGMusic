import { memo } from 'react'
import { StyleSheet, View } from 'react-native'

import { usePlayerMusicInfo } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import Image from '@/components/common/Image'


// 玻璃封面：封面作播放页背景层（暗化蒙层，紫金黑主题更暗，玻璃质感来自其上 c-glass 元素）
export default memo(() => {
  const musicInfo = usePlayerMusicInfo()
  const enabled = useSettingValue('player.glassCover')
  const theme = useTheme()

  if (!enabled || !musicInfo.pic) return null

  const isLiquidGlass = theme['c-liquid-glass'] == 'true'

  return (
    <View pointerEvents="none" style={styles.container}>
      <Image url={musicInfo.pic} resizeMode="cover" style={styles.cover} />
      <View style={{ ...styles.veil, backgroundColor: isLiquidGlass ? 'rgba(6,4,12,0.55)' : 'rgba(0,0,0,0.35)' }} />
    </View>
  )
})

const styles = createStyle({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  cover: {
    width: '100%',
    height: '100%',
  },
  veil: {
    ...StyleSheet.absoluteFillObject,
  },
})
