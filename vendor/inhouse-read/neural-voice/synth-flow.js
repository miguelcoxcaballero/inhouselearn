// What the synthesis worker (and the Android client) do around the model: the Piper phoneme-id bookkeeping and the
// finishing of every chunk of audio (cleaning, page-boundary placement, tempo, rests). All of it is the voice core
// (rust-core/src/synth_flow.rs, with pcm.rs, duration_marks.rs and speech_tempo.rs); this file only lays the arguments out in
// the core's memory and reads the answer back. The caller has awaited requireRustVoiceCore(): there is no second
// implementation to fall back on. The frozen JavaScript originals are tests/unit/helpers/reference-*.js.
import { loadedRustVoiceCore } from '../rust-voice-core.js'
import { layout, putText, withArena } from './core-call.js'

// The one voice whose quiet speech is lifted further than the usual six times (rust-core/src/pcm.rs).
const NVCC = 'no_NO-nvcc-medium'

/** `ms` of silence. */
export const silence = (sampleRate, ms) => new Float32Array(Math.max(0, Math.round(sampleRate * ms / 1000)))

const failures = { '-2': 'Invalid speech tempo input', '-3': 'Too many speech boundaries', '-4': 'Voice core: output too small' }
const check = status => { if (status !== 1) throw new Error(failures[status] || 'Voice core: invalid call') }

/** length_scale for a speaking rate: Piper stretches time, so a faster voice is a smaller scale. */
export const lengthScaleFor = (base, rate) => loadedRustVoiceCore().voice_length_scale(base, Number(rate))
/** The speed the model itself is asked for: never faster than its natural pace. */
export const synthesisRate = rate => loadedRustVoiceCore().voice_synthesis_rate(Number(rate))

/** The float32 `scales` of one Piper run at the speaking `rate`: the config's inference values, else the model defaults. */
export function piperScales(inference, rate) {
  const core = loadedRustVoiceCore()
  return withArena(core, 2, pointer => {
    check(core.voice_piper_scales(inference.noise_scale, inference.noise_scale == null, inference.length_scale, inference.length_scale == null,
      inference.noise_w, inference.noise_w == null, Number(rate), pointer))
    return new Float32Array(core.memory.buffer, pointer, 3).slice()
  })
}

/** Drops the ids a voice trained with fewer symbols does not know, with their pads. */
export function limitIds(ids, numSymbols) {
  const core = loadedRustVoiceCore(), count = ids.length
  if (!count) return []
  const { at, cells } = layout(count * 4, count * 4)
  return withArena(core, cells, pointer => {
    new Uint32Array(core.memory.buffer, pointer, count).set(ids)
    const written = core.voice_limit_ids(pointer, count, Number(numSymbols), pointer + at[1])
    if (written < 0) throw new Error('Voice core: invalid call')
    return Array.from(new Uint32Array(core.memory.buffer, pointer + at[1], written))
  })
}

/** Splits what piper_phonemize returns (several '^...$' sentences concatenated) into one id sequence per sentence, dropping the empty ones. */
export function splitSegments(ids) {
  const core = loadedRustVoiceCore(), count = ids.length
  if (!count) return []
  const { at, cells } = layout(count * 4, count * 4, (count >> 2) * 4 + 4)
  return withArena(core, cells, pointer => {
    new Uint32Array(core.memory.buffer, pointer, count).set(ids)
    const segments = core.voice_split_segments(pointer, count, pointer + at[1], pointer + at[2])
    if (segments < 0) throw new Error('Voice core: invalid call')
    const lengths = new Uint32Array(core.memory.buffer, pointer + at[2], segments), all = new Uint32Array(core.memory.buffer, pointer + at[1], count)
    let from = 0
    return Array.from(lengths, length => Array.from(all.subarray(from, from += length)))
  })
}

/**
 * The finished audio of one sentence of a Piper fragment. `raw` is the model's output (cleaned on a copy), `durations` its
 * frame durations (or null), `points` the page boundaries of the fragment as {offset, phoneme}; `base`/`count` place this
 * sentence among the fragment's phonemes. Returns {pcm, marks:[{offset, sample}]}: cleaned, sped up and with its rests.
 */
export function finishPiper(raw, durations, points, text, { sampleRate, model, rate, base, count, last, first }) {
  const core = loadedRustVoiceCore(), units = text.length, marks = points.length, frames = durations ? durations.length : 0
  const capacity = raw.length + Math.ceil(sampleRate) + 16
  const { at, cells } = layout(raw.length * 4, frames * 4, marks * 8, units * 2, 7 * 8, capacity * 4, marks * 16, 16)
  return withArena(core, cells, pointer => {
    const buffer = () => core.memory.buffer
    new Float32Array(buffer(), pointer + at[0], raw.length).set(raw)
    if (frames) new Float32Array(buffer(), pointer + at[1], frames).set(durations)
    const phonemes = new Float64Array(buffer(), pointer + at[2], marks)
    for (let i = 0; i < marks; i++) phonemes[i] = points[i].phoneme
    putText(core, pointer + at[3], text)
    new Float64Array(buffer(), pointer + at[4], 7).set([sampleRate, model === NVCC ? 1 : 0, Number(rate), base, count, last ? 1 : 0, first ? 0 : 1])
    check(core.voice_finish_piper(pointer + at[0], raw.length, pointer + at[1], frames, pointer + at[2], marks, pointer + at[3], units,
      pointer + at[4], pointer + at[5], capacity, pointer + at[6], pointer + at[7]))
    const [samples, found] = new Float64Array(buffer(), pointer + at[7], 2)
    const records = new Float64Array(buffer(), pointer + at[6], found * 2)
    return { pcm: new Float32Array(buffer(), pointer + at[5], samples).slice(),
      marks: Array.from({ length: found }, (_, i) => ({ offset: points[records[i * 2]].offset, sample: records[i * 2 + 1] })) }
  })
}

/**
 * The finished audio of one Supertonic fragment, already at its final speed: cleaned, with the rest after it. `timeline`
 * are the page boundaries (any fields, a `sample` in the raw audio). Returns {pcm, marks} or null when the model's audio
 * holds a sample that is not a finite number.
 */
export function finishSupertonic(raw, text, timeline, { sampleRate, rate }) {
  const core = loadedRustVoiceCore(), units = text.length, marks = timeline.length
  const capacity = raw.length + Math.ceil(sampleRate) + 16
  const { at, cells } = layout(raw.length * 4, units * 2, marks * 8, 2 * 8, capacity * 4, marks * 16, 16)
  return withArena(core, cells, pointer => {
    const buffer = () => core.memory.buffer
    new Float32Array(buffer(), pointer + at[0], raw.length).set(raw)
    putText(core, pointer + at[1], text)
    const samples = new Float64Array(buffer(), pointer + at[2], marks)
    for (let i = 0; i < marks; i++) samples[i] = timeline[i].sample
    new Float64Array(buffer(), pointer + at[3], 2).set([sampleRate, Number(rate)])
    const status = core.voice_finish_supertonic(pointer + at[0], raw.length, pointer + at[1], units, pointer + at[2], marks,
      pointer + at[3], pointer + at[4], capacity, pointer + at[5], pointer + at[6])
    if (status === -2) return null
    check(status)
    const [length] = new Float64Array(buffer(), pointer + at[6], 2), records = new Float64Array(buffer(), pointer + at[5], marks * 2)
    return { pcm: new Float32Array(buffer(), pointer + at[4], length).slice(),
      marks: timeline.map((mark, i) => ({ ...mark, sample: records[i * 2 + 1] })) }
  })
}

/** Transform marks along with their waveform; do not divide timestamps again. */
export function speedUpSpeech(pcm, sampleRate, rate, marks = []) {
  const core = loadedRustVoiceCore()
  if (core.voice_tempo_speed(Number(rate)) === 1 || !pcm.length) return { pcm, marks }
  if (!(pcm instanceof Float32Array)) throw new Error('Invalid speech tempo input')
  const count = pcm.length, found = marks.length
  const { at, cells } = layout(count * 4, found * 8, 2 * 8, count * 4, found * 16, 16)
  return withArena(core, cells, pointer => {
    const buffer = () => core.memory.buffer
    new Float32Array(buffer(), pointer + at[0], count).set(pcm)
    const samples = new Float64Array(buffer(), pointer + at[1], found)
    for (let i = 0; i < found; i++) samples[i] = Number.isInteger(marks[i].sample) ? marks[i].sample : NaN
    new Float64Array(buffer(), pointer + at[2], 2).set([sampleRate, Number(rate)])
    const written = core.voice_speed_up(pointer + at[0], count, pointer + at[1], found, pointer + at[2], pointer + at[3], pointer + at[4], pointer + at[5])
    if (written < 0) check(written)
    const [kept] = new Float64Array(buffer(), pointer + at[5], 1), records = new Float64Array(buffer(), pointer + at[4], kept * 2)
    return { pcm: new Float32Array(buffer(), pointer + at[3], written).slice(),
      marks: Array.from({ length: kept }, (_, i) => ({ ...marks[records[i * 2]], sample: records[i * 2 + 1] })) }
  })
}
