/**
 * 网易云 MV 接口（eapi 签名，复用 wyEapiEncrypt）。
 * MV 列表 /eapi/mv/all，详情 /eapi/mv/detail，播放地址 /eapi/mv/url。
 */
import http from 'node:http'
import https from 'node:https'
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto'
import { wyEapiEncrypt } from './wy'

const WY_HOST = 'interface3.music.163.com'
const WY_UA =
  'Mozilla/5.0 (Linux; Android 12; 22041211AC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.79 Mobile Safari/537.36'
const WY_COOKIE =
  'appver=1.0.22; os=android; channel=netease; MUSIC_U=; NMTID=00O3nhQ8Br3egFvnEAIjk_hf0yT9jsAAAGNnSmw4w; __csrf=b383e0976daab42a166a9544f90a1dc3'

interface EapiResult {
  code: number
  msg?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/** 网易 eapi 请求（POST /eapi/<path>，body params=<encrypted>） */
function eapiPost(eapiPath: string, apiPath: string, payload: Record<string, unknown>): Promise<EapiResult> {
  const sign = wyEapiEncrypt(apiPath, JSON.stringify(payload))
  const body = `params=${encodeURIComponent(sign)}`
  return new Promise<EapiResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: WY_HOST,
        port: 80,
        path: `/eapi${eapiPath}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Cookie: WY_COOKIE,
          'User-Agent': WY_UA,
          Referer: 'https://music.163.com/'
        }
      },
      (res: { statusCode?: number; setEncoding: (e: string) => void; on: (ev: string, cb: (c?: string) => void) => void }) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk ?? ''))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as EapiResult)
          } catch {
            reject(new Error('MV 接口返回异常'))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export interface MvItem {
  id: number
  name: string
  artist: string
  pic: string
  playCount: number
  duration: number
}

/** 热门 MV 列表 */
export async function wyMvList(page = 1, limit = 24): Promise<{ code: number; msg?: string; mvs: MvItem[] }> {
  try {
    const offset = (page - 1) * limit
    const res = await eapiPost('/mv/all', '/api/mv/all', {
      limit,
      offset,
      area: '',
      order: 'hot',
      type: '全部'
    })
    if (res.code !== 200) return { code: res.code, msg: res.msg, mvs: [] }
    // 网易 mv/all 返回顶层 data 数组（非 data.mvs）
    const list = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : []
    const mvs: MvItem[] = list.map((it) => ({
      id: Number(it.id || 0),
      name: String(it.name || ''),
      artist: String(it.artistName || (it.artists as Array<Record<string, unknown>>)?.[0]?.name || ''),
      pic: String(it.cover || it.picUrl || ''),
      playCount: Number(it.playCount || 0),
      duration: Number(it.duration || 0) / 1000
    }))
    return { code: 200, mvs }
  } catch (err) {
    return { code: 500, msg: '获取 MV 列表失败: ' + String(err), mvs: [] }
  }
}

/** MV 详情（名称/歌手/封面/时长） */
export async function wyMvDetail(mvid: number): Promise<MvItem | null> {
  try {
    const res = await eapiPost('/mv/detail', '/api/mv/detail', { id: mvid })
    if (res.code !== 200) return null
    const data = (res.data || {}) as { mv?: Record<string, unknown> }
    const mv = data.mv || {}
    return {
      id: Number(mv.id || mvid),
      name: String(mv.name || ''),
      artist: String(mv.artistName || (mv.artists as Array<Record<string, unknown>>)?.[0]?.name || ''),
      pic: String(mv.cover || mv.picUrl || ''),
      playCount: Number(mv.playCount || 0),
      duration: Number(mv.duration || 0) / 1000
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 网易 weapi 加密（MV 播放地址用 weapi/song/enhance/play/mv，eapi 无此接口）
// ---------------------------------------------------------------------------

const WEPAPI_SECRET = '0CoJUm6Qyw8W8jud'
const WEPAPI_PUBLIC_KEY = '010001'
const WEPAPI_MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424f8138fe5dfc7f1b0a3c9e0d3d9f6b5c4f3d8e6a4b2c1d0f9e8'

function weapiAes(text: string, key: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from('0102030405060708', 'utf8'))
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return enc.toString('base64')
}

function weapiRsa(text: string): string {
  const key = {
    kty: 'RSA',
    n: Buffer.from(WEPAPI_MODULUS, 'hex'),
    e: Buffer.from(WEPAPI_PUBLIC_KEY, 'hex')
  }
  const enc = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(text, 'utf8'))
  return enc.toString('hex')
}

function weapiEncrypt(data: Record<string, unknown>): { params: string; encSecKey: string } {
  const text = JSON.stringify(data)
  const randomKey = randomBytes(8).toString('hex').slice(0, 16)
  const params = weapiAes(weapiAes(text, randomKey), WEPAPI_SECRET)
  const encSecKey = weapiRsa(randomKey)
  return { params, encSecKey }
}

/** weapi POST（https://music.163.com/weapi/<path>） */
function weapiPost(weapiPath: string, payload: Record<string, unknown>): Promise<EapiResult> {
  const { params, encSecKey } = weapiEncrypt({ ...payload, csrf_token: '' })
  const body = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`
  return new Promise<EapiResult>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'music.163.com',
        port: 443,
        path: `/weapi${weapiPath}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Cookie: WY_COOKIE,
          'User-Agent': WY_UA,
          Referer: 'https://music.163.com/'
        }
      },
      (res: { setEncoding: (e: string) => void; on: (ev: string, cb: (c?: string) => void) => void }) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk ?? ''))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as EapiResult)
          } catch {
            reject(new Error('MV 播放接口返回异常'))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** MV 播放地址（weapi/song/enhance/play/mv） */
export async function wyMvUrl(mvid: number): Promise<string> {
  try {
    const res = await weapiPost('/song/enhance/play/mv', { ids: [mvid] })
    if (res.code !== 200) return ''
    const list = (res.data as Array<Record<string, unknown>>) || []
    return String(list[0]?.url || '')
  } catch {
    return ''
  }
}
