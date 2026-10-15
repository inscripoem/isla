/**
 * Deterministic mono IEEE-float32 WAV encoding for generated speech.
 *
 * This is a tiny, dependency-free encoder built only on built-in typed arrays
 * and `DataView`. It never reads files, never decodes and never labels audio as
 * played: it turns finite mono samples into a canonical RIFF/WAVE byte snapshot.
 * Kokoro RawAudio is 24 kHz mono float32, which is a different material than the
 * increment B 22.05 kHz PCM16 fixtures, so callers must not reuse fixture
 * durations for generated data.
 */

/** Media type reported for the encoded mono float32 WAV snapshot. */
export const MONO_FLOAT32_WAV_FORMAT = 'audio/wav'

/** IEEE float PCM format tag (WAVE format code 3). */
const WAVE_FORMAT_IEEE_FLOAT = 3
const BITS_PER_SAMPLE = 32
const CHANNELS = 1
const HEADER_BYTES = 44
const BLOCK_ALIGN = CHANNELS * (BITS_PER_SAMPLE / 8)
/** Largest value representable in an unsigned 32-bit RIFF/WAVE header field. */
const UINT32_MAX = 0xffffffff

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

/**
 * Encode finite mono samples as a canonical 32-bit IEEE-float WAV. The caller
 * must have validated that every sample and the sample rate are finite and that
 * the rate is positive; an invalid rate is rejected before any byte is written.
 */
export function encodeMonoFloat32Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(sampleRate)) {
    throw new Error('m1-wav: sampleRate must be a positive integer')
  }
  if (sampleRate > UINT32_MAX) {
    throw new Error('m1-wav: sampleRate is not representable in a WAV header')
  }
  const byteRate = sampleRate * BLOCK_ALIGN
  if (byteRate > UINT32_MAX) {
    throw new Error('m1-wav: byte rate is not representable in a WAV header')
  }
  const dataBytes = samples.length * BITS_PER_SAMPLE / 8
  const riffSize = HEADER_BYTES - 8 + dataBytes
  if (dataBytes > UINT32_MAX || riffSize > UINT32_MAX) {
    throw new Error('m1-wav: data length is not representable in a WAV header')
  }
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, WAVE_FORMAT_IEEE_FLOAT, true)
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, BLOCK_ALIGN, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = HEADER_BYTES
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(offset, samples[index], true)
    offset += 4
  }
  return new Uint8Array(buffer)
}
