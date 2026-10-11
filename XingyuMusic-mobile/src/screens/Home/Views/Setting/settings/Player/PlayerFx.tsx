import { memo } from 'react'
import { View } from 'react-native'

import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle } from '@/utils/tools'

import CheckBoxItem from '../../components/CheckBoxItem'
import SubTitle from '../../components/SubTitle'


export default memo(() => {
  const t = useI18n()
  const glassCover = useSettingValue('player.glassCover')
  const waveProgress = useSettingValue('player.waveProgress')
  const showLyricPanel = useSettingValue('player.showLyricPanel')

  return (
    <View style={styles.content}>
      <SubTitle title={t('setting_player_fx')}>
        <CheckBoxItem check={glassCover} onChange={val => { updateSetting({ 'player.glassCover': val }) }} label={t('setting_play_fx_glass_cover')} />
        <CheckBoxItem check={waveProgress} onChange={val => { updateSetting({ 'player.waveProgress': val }) }} label={t('setting_play_fx_wave_progress')} />
        <CheckBoxItem check={showLyricPanel} onChange={val => { updateSetting({ 'player.showLyricPanel': val }) }} label={t('setting_play_fx_show_lyric_panel')} />
      </SubTitle>
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
