// import { setUserApi as setUserApiAction } from '@renderer/utils/ipc'
import musicSdk from '@/utils/musicSdk'
// import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { updateSetting } from './common'
import settingState from '@/store/setting/state'
import { destroyUserApi, setUserApi } from './userApi'
import apiSourceInfo from '@/utils/musicSdk/api-source-info'
import { validateQingLines, buildQingCloudApis, QINGCLOUD_API_ID } from '@/utils/musicSdk/qingCloud'

/**
 * 官方渠道云（星雨音乐官方音源·青听渠道，钥匙模型）：
 * 导入 `{gateway?,lines:[...]}` 配置后，构造内置 6 渠道解析 api，
 * 挂载进 `global.lx.apis` 并把 `apiSource` 指向 qingcloud 虚拟源，解锁对应渠道。
 * 未导入配置时保持"无解析"（各内置源 getMusicUrl 抛"未找到可用音源"）。
 */
export const applyQingCloud = () => {
  const config = settingState.setting['source.qingtngConfig']
  if (!config) {
    global.lx.apis = {}
    global.lx.qualityList = {}
    if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](false)
    return false
  }
  const valid = validateQingLines(config)
  if (!valid.ok) {
    global.lx.apis = {}
    global.lx.qualityList = {}
    if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](false)
    return false
  }
  global.lx.apis = buildQingCloudApis(valid.lines, valid.gateway) as unknown as Partial<LX.UserApi.UserApiSources>
  global.lx.qualityList = valid.qualityList
  destroyUserApi()
  if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](true)
  return true
}

/** 设置页"导入官方音源 B 型"入口：持久化钥匙并立即启用。 */
export const saveQingCloudConfig = (json: string) => {
  updateSetting({ 'source.qingtngConfig': json, 'source.qingtngEnabled': true })
  setApiSource(QINGCLOUD_API_ID)
}

/** 关闭官方渠道云（钥匙移除后恢复"无解析"，并切回可用源）。 */
export const disableQingCloud = () => {
  updateSetting({ 'source.qingtngConfig': '', 'source.qingtngEnabled': false })
  global.lx.apis = {}
  global.lx.qualityList = {}
  destroyUserApi()
  const fallback = apiSourceInfo.find(api => !api.disabled)?.id ?? ''
  if (settingState.setting['common.apiSource'] === QINGCLOUD_API_ID) setApiSource(fallback)
  else if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](true)
}

export const setApiSource = (apiId: string) => {
  if (global.lx.apiInitPromise[1]) {
    global.lx.apiInitPromise[0] = new Promise(resolve => {
      global.lx.apiInitPromise[1] = false
      global.lx.apiInitPromise[2] = (result: boolean) => {
        global.lx.apiInitPromise[1] = true
        resolve(result)
      }
    })
  }
  if (apiId === QINGCLOUD_API_ID) {
    applyQingCloud()
  } else if (/^user_api/.test(apiId)) {
    setUserApi(apiId).catch(err => {
      if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](false)
      console.log(err)
      let api = apiSourceInfo.find(api => !api.disabled)
      if (!api) return
      if (api.id != settingState.setting['common.apiSource']) setApiSource(api.id)
    })
  } else {
    // @ts-expect-error
    global.lx.qualityList = musicSdk.supportQuality[apiId] ?? {}
    destroyUserApi()
    if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](true)
    // apiSource.value = apiId
    // void setUserApiAction(apiId)
  }

  if (apiId != settingState.setting['common.apiSource']) {
    updateSetting({ 'common.apiSource': apiId })
    requestAnimationFrame(() => {
      global.state_event.apiSourceUpdated(apiId)
    })
  }
}
