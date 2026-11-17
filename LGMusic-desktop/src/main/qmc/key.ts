/**
 * QMC ekey 解包（TEA 16 轮 + 经典混淆种子）。
 * 逻辑忠实还原自青听 v1.0.3 桌面端主进程。
 */

const TEA_DELTA = 2654435769
const TEA_ROUNDS = 16
const QMC_KEY_SIZE = 528

function readU32(buf: Buffer, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
}

function writeU32(buf: Buffer, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 255
  buf[offset + 1] = (value >>> 16) & 255
  buf[offset + 2] = (value >>> 8) & 255
  buf[offset + 3] = value & 255
}

/** 单块 TEA 解密（8 字节） */
function teaDecryptBlock(block: Buffer, key: Uint32Array): Buffer {
  let y = readU32(block, 0)
  let z = readU32(block, 4)
  const k0 = readU32(key as unknown as Buffer, 0)
  const k1 = readU32(key as unknown as Buffer, 4)
  const k2 = readU32(key as unknown as Buffer, 8)
  const k3 = readU32(key as unknown as Buffer, 12)
  let sum = Math.imul(TEA_DELTA, TEA_ROUNDS) >>> 0
  for (let i = 0; i < TEA_ROUNDS; i += 1) {
    z =
      (z -
        ((((y << 4) + k2) ^ (y + sum) ^ ((y >>> 5) + k3)) >>> 0)) >>>
      0
    y =
      (y -
        ((((z << 4) + k0) ^ (z + sum) ^ ((z >>> 5) + k1)) >>> 0)) >>>
      0
    sum = (sum - TEA_DELTA) >>> 0
  }
  const out = Buffer.allocUnsafe(8)
  writeU32(out, 0, y)
  writeU32(out, 4, z)
  return out
}

/** TEA CBC 式解出密文主体（含尾部校验与前缀剥离） */
function teaUnpack(cipher: Buffer, key: Uint32Array): Buffer {
  if (cipher.length < 16 || cipher.length % 8 !== 0) throw new Error('QMC 密钥密文长度无效')
  let prevPlain = Buffer.alloc(8)
  let prevCipher = Buffer.alloc(8)
  const plain = Buffer.alloc(cipher.length)
  for (let off = 0; off < cipher.length; off += 8) {
    const chunk = cipher.subarray(off, off + 8)
    const xored = Buffer.allocUnsafe(8)
    for (let i = 0; i < xored.length; i += 1) xored[i] = chunk[i] ^ prevCipher[i]
    const decrypted = teaDecryptBlock(xored, key)
    for (let i = 0; i < decrypted.length; i += 1) plain[off + i] = decrypted[i] ^ prevPlain[i]
    prevPlain = Buffer.from(chunk)
    prevCipher = Buffer.from(decrypted)
  }
  const skip = (plain[0] & 7) + 3
  const end = plain.length - 7
  if (skip >= end) throw new Error('QMC 密钥填充长度无效')
  for (let i = end; i < plain.length; i += 1) {
    if (plain[i] !== 0) throw new Error('QMC 密钥尾部校验失败')
  }
  return plain.subarray(skip, end)
}

/** 经典 QMC 混淆种子（tan(106+i*0.1)*100 & 255） */
function seedKey(): Buffer {
  const seed = Buffer.alloc(8)
  for (let i = 0; i < seed.length; i += 1) {
    seed[i] = Math.trunc(Math.abs(Math.tan(106 + i * 0.1)) * 100) & 255
  }
  return seed
}

/** base64 ekey（528 字节）→ 完整解密密钥（前 8 字节种子段 + TEA 解出主体） */
export function unpackEkey(encoded: string): Buffer {
  const cleaned = String(encoded || '')
    .trim()
    .replace(/\s+/g, '')
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new Error('QMC 解密密钥为空或格式无效')
  }
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4)
  const cipher = Buffer.from(padded, 'base64')
  if (cipher.length !== QMC_KEY_SIZE) {
    throw new Error(`QMC 解密密钥长度异常: ${cipher.length}`)
  }
  const seed = seedKey()
  const teaKey = Buffer.alloc(16)
  for (let i = 0; i < teaKey.length; i += 2) {
    teaKey[i] = seed[i / 2]
    teaKey[i + 1] = cipher[i / 2]
  }
  const body = teaUnpack(cipher.subarray(8), new Uint32Array(teaKey.buffer, teaKey.byteOffset, 4))
  return Buffer.concat([cipher.subarray(0, 8), body])
}
