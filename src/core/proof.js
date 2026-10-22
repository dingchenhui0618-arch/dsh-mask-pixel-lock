// The hash proof.
//
// Two different questions are answered by two different digests:
//
//   * file sha256  — "is this the exact file I was given?" (bytes, including
//                    encoder metadata and timestamps-free PNG chunks)
//   * pixel digest — "are the protected pixels of these two images identical?"
//                    (canonical RGBA stream, encoder-independent)
//
// The proof digest binds the policy, both file hashes and both pixel digests
// into one value. It is a local integrity statement, not a signature: anyone
// who can rewrite the report can rewrite the digests too.

import { createHash } from 'node:crypto'

export const PROOF_SCHEMA = 'dsh-mask-pixel-lock/proof@1'
export const PIXEL_SCHEMA = 'dsh-mask-pixel-lock/protected-pixels@1'

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Canonical digest of the protected pixels of one image.
 *
 * The stream is: schema, dimensions, mode, count, then each protected pixel's
 * compared channels in scanline order. Two images with the same protected
 * pixels produce the same digest even if their PNG encoders differ.
 */
export function protectedPixelDigest(image, lock, options) {
  const settings = options || {}
  const compareAlpha = settings.ignoreAlpha !== true
  const channels = compareAlpha ? 4 : 3
  let count = 0
  for (let i = 0; i < lock.length; i += 1) if (lock[i] === 1) count += 1

  const hash = createHash('sha256')
  hash.update(PIXEL_SCHEMA + '\0')
  hash.update(image.width + 'x' + image.height + '\0')
  hash.update((compareAlpha ? 'rgba' : 'rgb') + '\0')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(count, 0)
  hash.update(head)

  const chunk = Buffer.alloc(64 * 1024 * channels)
  let used = 0
  for (let i = 0; i < lock.length; i += 1) {
    if (lock[i] !== 1) continue
    const p = i * 4
    chunk[used] = image.rgba[p]
    chunk[used + 1] = image.rgba[p + 1]
    chunk[used + 2] = image.rgba[p + 2]
    if (compareAlpha) chunk[used + 3] = image.rgba[p + 3]
    used += channels
    if (used === chunk.length) {
      hash.update(chunk)
      used = 0
    }
  }
  if (used > 0) hash.update(chunk.subarray(0, used))

  return { count, channels, digest: hash.digest('hex') }
}

/**
 * Build the proof object from file bytes, decoded images and the comparison.
 */
export function buildProof(input) {
  const originalDigest = protectedPixelDigest(input.original, input.lock, { ignoreAlpha: input.policy.ignoreAlpha })
  const generatedDigest = protectedPixelDigest(input.generated, input.lock, { ignoreAlpha: input.policy.ignoreAlpha })

  const files = {
    original: sha256Hex(input.originalBytes),
    generated: sha256Hex(input.generatedBytes),
    mask: sha256Hex(input.maskBytes),
  }

  const lines = [
    PROOF_SCHEMA,
    'original.file=' + files.original,
    'generated.file=' + files.generated,
    'mask.file=' + files.mask,
    'dimensions=' + input.original.width + 'x' + input.original.height,
    'maskMode=' + input.policy.maskMode,
    'maskThreshold=' + input.policy.maskThreshold,
    'tolerance=' + input.policy.tolerance,
    'compareAlpha=' + (input.policy.ignoreAlpha !== true),
    'protectedPixels=' + originalDigest.count,
    'protected.original=' + originalDigest.digest,
    'protected.generated=' + generatedDigest.digest,
    'changedPixels=' + input.comparison.changedPixels,
    'exactChangedPixels=' + input.comparison.exactChangedPixels,
  ]

  return {
    algorithm: 'sha256',
    schema: PROOF_SCHEMA,
    pixelSchema: PIXEL_SCHEMA,
    files,
    protectedPixels: {
      count: originalDigest.count,
      channels: originalDigest.channels,
      original: originalDigest.digest,
      generated: generatedDigest.digest,
      equal: originalDigest.digest === generatedDigest.digest,
    },
    proofDigest: sha256Hex(lines.join('\n')),
    statement:
      originalDigest.digest === generatedDigest.digest
        ? '受保护像素逐字节相同'
        : '受保护像素存在差异（详见差异统计）',
  }
}
