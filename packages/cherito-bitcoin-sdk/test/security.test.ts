import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeCompressedPubkey, loadCredential, LightningError } from '../src/index.js'

describe('@cherito/bitcoin-sdk security and credentials', () => {
  describe('normalizeCompressedPubkey', () => {
    test('accepts valid 02 and 03 prefix 33-byte compressed pubkeys', () => {
      const valid02 = `02${'11'.repeat(32)}`
      const valid03 = `03${'aa'.repeat(32)}`
      assert.equal(normalizeCompressedPubkey(valid02), valid02)
      assert.equal(normalizeCompressedPubkey(valid03), valid03)
      assert.equal(normalizeCompressedPubkey(`  ${valid02.toUpperCase()}  `), valid02)
    })

    test('rejects invalid prefixes and lengths', () => {
      for (const bad of [
        '',
        `04${'11'.repeat(32)}`,
        `02${'11'.repeat(31)}`,
        `02${'11'.repeat(33)}`,
        `02${'zz'.repeat(32)}`,
      ]) {
        assert.throws(() => normalizeCompressedPubkey(bad), TypeError)
      }
    })
  })

  describe('loadCredential', () => {
    test('loads credential from inline base64 and hex', async () => {
      const b64 = await loadCredential(undefined, Buffer.from('hello').toString('base64'), 'base64')
      assert.equal(b64.toString('utf8'), 'hello')

      const hex = await loadCredential(undefined, 'aabbcc', 'hex')
      assert.equal(hex.toString('hex'), 'aabbcc')
    })

    test('rejects invalid hex encoding in inline credential', async () => {
      await assert.rejects(
        () => loadCredential(undefined, 'not-hex-data!', 'hex'),
        (error: LightningError) => {
          assert.equal(error.code, 'CONFIGURATION_ERROR')
          return true
        },
      )
    })

    test('loads credential from a mounted file path', async () => {
      const filePath = join(tmpdir(), `cred-${Date.now()}.bin`)
      await writeFile(filePath, Buffer.from('secret-data'))
      try {
        const result = await loadCredential(filePath, undefined, 'base64')
        assert.equal(result.toString('utf8'), 'secret-data')
      } finally {
        await unlink(filePath).catch(() => {})
      }
    })

    test('throws when neither path nor inline credential is provided', async () => {
      await assert.rejects(
        () => loadCredential(undefined, undefined, 'base64'),
        (error: LightningError) => {
          assert.equal(error.code, 'CONFIGURATION_ERROR')
          return true
        },
      )
    })

    test('throws when the mounted path cannot be read', async () => {
      await assert.rejects(
        () => loadCredential('/non/existent/path/credential.macaroon', undefined, 'base64'),
        (error: LightningError) => {
          assert.equal(error.code, 'CONFIGURATION_ERROR')
          return true
        },
      )
    })
  })
})
