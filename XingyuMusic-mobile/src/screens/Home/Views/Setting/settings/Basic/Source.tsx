import { memo, useCallback, useMemo, useRef } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { createStyle, toast } from '@/utils/tools'
import { setApiSource, saveQingCloudConfig, disableQingCloud } from '@/core/apiSource'
import { useI18n } from '@/lang'
import apiSourceInfo from '@/utils/musicSdk/api-source-info'
import { useSettingValue } from '@/store/setting/hook'
import { useStatus, useUserApiList } from '@/store/userApi'
import Button from '../../components/Button'
import UserApiEditModal, { type UserApiEditModalType } from './UserApiEditModal'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import { readFile } from '@/utils/fs'

import { validateQingLines, QINGCLOUD_API_ID } from '@/utils/musicSdk/qingCloud'
import settingState from '@/store/setting/state'
// import { importUserApi, removeUserApi } from '@/core/userApi'

const apiSourceList = apiSourceInfo.map(api => ({
  id: api.id,
  name: api.name,
  disabled: api.disabled,
}))

const useActive = (id: string) => {
  const activeLangId = useSettingValue('common.apiSource')
  const isActive = useMemo(() => activeLangId == id, [activeLangId, id])
  return isActive
}

const Item = ({ id, name, desc, statusLabel, change }: {
  id: string
  name: string
  desc?: string
  statusLabel?: string
  change: (id: string) => void
}) => {
  const isActive = useActive(id)
  const theme = useTheme()
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  return (
    <CheckBox marginBottom={5} check={isActive} onChange={() => { change(id) }} need>
      <Text style={styles.sourceLabel}>
        {name}
        {
          desc ? <Text style={styles.sourceDesc} color={theme['c-500']} size={13}>  {desc}</Text> : null
        }
        {
          statusLabel ? <Text style={styles.sourceStatus} size={13}>  {statusLabel}</Text> : null
        }
      </Text>
    </CheckBox>
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const list = useMemo(() => apiSourceList.map(s => ({
    // @ts-expect-error
    name: t(`setting_basic_source_${s.id}`) || s.name,
    id: s.id,
  })), [t])
  const setApiSourceId = useCallback((id: string) => {
    setApiSource(id)
  }, [])
  const userApiListRaw = useUserApiList()
  const apiStatus = useStatus()
  const apiSourceSetting = useSettingValue('common.apiSource')
  const userApiList = useMemo(() => {
    const getApiStatus = () => {
      let status
      if (apiStatus.status) status = t('setting_basic_source_status_success')
      else if (apiStatus.message == 'initing') status = t('setting_basic_source_status_initing')
      else status = t('setting_basic_source_status_failed')

      return status
    }
    return userApiListRaw.map(api => {
      const statusLabel = api.id == apiSourceSetting ? `[${getApiStatus()}]` : ''
      return {
        id: api.id,
        name: api.name,
        label: `${api.name}${statusLabel}`,
        desc: [/^\d/.test(api.version) ? `v${api.version}` : api.version].filter(Boolean).join(', '),
        statusLabel,
        // status: apiStatus.status,
        // message: apiStatus.message,
        // disabled: false,
      }
    })
  }, [userApiListRaw, apiStatus, apiSourceSetting, t])

  const modalRef = useRef<UserApiEditModalType>(null)
  const handleShow = () => {
    modalRef.current?.show()
  }

  /* ---------------- B 型 · 官方音源（青听渠道） ---------------- */
  const qingCloudEnabled = useSettingValue('source.qingtngEnabled')
  const qingCloudActive = useMemo(() => apiSourceSetting == QINGCLOUD_API_ID, [apiSourceSetting])
  const qingConfig = settingState.setting['source.qingtngConfig']
  const channelNames = (() => {
    if (!qingConfig) return ''
    const valid = validateQingLines(qingConfig)
    if (!valid.ok) return ''
    return Object.values(valid.lines).flatMap(l => l.map(x => x.name)).join(' / ')
  })()
  const choosePathRef = useRef<ChoosePathType>(null)

  const handleImportB = () => {
    choosePathRef.current?.show({
      title: t('source_import_b_file'),
      dirOnly: false,
      filter: ['json'],
    })
  }
  const handleConfirmBPath = (path: string) => {
    void readFile(path).then(script => {
      if (script == null) {
        toast(t('user_api_import_failed_tip', { message: '' }), 'long')
        return
      }
      const valid = validateQingLines(script)
      if (!valid.ok) {
        toast(t('source_b_invalid', { message: valid.error ?? '' }), 'long')
        return
      }
      saveQingCloudConfig(script)
      toast(t('source_b_import_ok'))
    }).catch((error: any) => {
      toast(t('source_b_import_failed', { message: error.message }), 'long')
    })
  }
  const handleDisableB = () => {
    disableQingCloud()
    toast(t('source_b_disabled'))
  }

  return (
    <SubTitle title={t('setting_basic_source')}>
      {/* A 型 · JS 音源 */}
      <View style={styles.card}>
        <Text size={14} style={styles.cardTitle}>{t('source_card_a_title')}</Text>
        <Text size={12} color={theme['c-500']} style={styles.cardDesc}>{t('source_card_a_desc')}</Text>
        <View style={styles.list}>
          {
            list.map(({ id, name }) => <Item name={name} id={id} key={id} change={setApiSourceId} />)
          }
          {
            userApiList.map(({ id, name, desc, statusLabel }) => <Item name={name} desc={desc} statusLabel={statusLabel} id={id} key={id} change={setApiSourceId} />)
          }
          {
            userApiList.length == 0 && list.length == 0
              ? <Text size={13} color={theme['c-500']} style={styles.empty}>{t('user_api_empty')}</Text>
              : null
          }
        </View>
        <View style={styles.btn}>
          <Button onPress={handleShow}>{t('setting_basic_source_user_api_btn')}</Button>
        </View>
      </View>

      {/* B 型 · 官方音源（青听渠道） */}
      <View style={styles.card}>
        <Text size={14} style={styles.cardTitle}>{t('source_card_b_title')}</Text>
        <Text size={12} color={theme['c-500']} style={styles.cardDesc}>{t('source_card_b_desc')}</Text>
        {
          qingCloudEnabled
            ? (
              <>
                <Text size={13} color={theme['c-400']} style={styles.status}>
                  {t('source_b_enabled', { channels: channelNames || '...' })}
                  {qingCloudActive ? ` [${t('source_b_active')}]` : ''}
                </Text>
                <View style={styles.btn}>
                  <Button onPress={handleDisableB}>{t('source_b_disable')}</Button>
                </View>
              </>
              )
            : (
              <View style={styles.btn}>
                <Button onPress={handleImportB}>{t('source_btn_import_b')}</Button>
              </View>
              )
        }
        <Text size={11} color={theme['c-600']} style={styles.hint}>{t('source_b_hint')}</Text>
      </View>
      <UserApiEditModal ref={modalRef} />
      <ChoosePath ref={choosePathRef} onConfirm={handleConfirmBPath} />
    </SubTitle>
  )
})

const styles = createStyle({
  card: {
    marginBottom: 12,
  },
  cardTitle: {
    marginBottom: 6,
  },
  cardDesc: {
    marginBottom: 8,
    lineHeight: 18,
  },
  status: {
    marginBottom: 8,
  },
  hint: {
    marginTop: 8,
    lineHeight: 16,
  },
  empty: {
    paddingVertical: 4,
  },
  list: {
    flexGrow: 0,
    flexShrink: 1,
    // flexDirection: 'row',
    // flexWrap: 'wrap',
  },
  btn: {
    marginTop: 10,
    flexDirection: 'row',
  },
  sourceLabel: {

  },
  sourceDesc: {

  },
  sourceStatus: {

  },
})
