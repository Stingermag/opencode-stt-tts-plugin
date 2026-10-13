// Voice input (STT) + spoken responses (TTS) for OpenCode V2 on Windows.
//
// STT: Ctrl+R -> record via sox -> transcribe via whisper-cli -> submit.
//      (Нормализация отключена — текст используется как есть)
//      Ctrl+Alt+Space -> hands-free: mic stays armed, sox ends each segment
//      after N seconds of silence (handsFreeSilence, default 3) and the
//      segment is transcribed, normalized and auto-sent to the open session.
// TTS: optional auto-speak of assistant replies via Piper + sox playback.
//
// All binaries/paths are passed via plugin options in cli.json.

import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

const LOG_FILE = path.join(os.homedir(), ".local", "share", "opencode-voice.log")
function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

log(`module imported: index.js, pid=${process.pid}`)

const SAMPLE_RATE = 16000

// Segment gates: shorter than 0.4s or peaking below ~7.6% of full scale is
// treated as silence (whisper happily hallucinates full sentences on noise;
// a higher gate keeps room hiss and quiet echo out of the pipeline). 0.4s
// keeps single words like "привет" while the peak gate blocks noise blips.
const MIN_SEGMENT_BYTES = 12800 // 0.4s @ 16 kHz s16 mono
// Thresholds are tuned for micGainDb=3. At the old gain of 10 dB the recorded
// peaks hit the 32767 ceiling (99th percentile 31789 — a 3% margin), and
// clipped audio is exactly what whisper transcribes worst. Dropping the gain to
// 3 dB frees that headroom (99th percentile lands at ~14200) while these
// thresholds come down by the same factor, so effective sensitivity is
// unchanged — only the distortion goes away.
const SPEECH_PEAK = 1100

// const STT_SYSTEM = `You clean up speech-to-text transcriptions for a coding assistant.
// Fix punctuation, obvious homophone errors and filler words.
// Preserve the user's language exactly (Russian stays Russian, English stays English).
// Return ONLY the corrected text with no quotes, no explanations and no markdown.`

// const TTS_SYSTEM = `You convert a coding assistant's markdown reply into plain spoken text.
// Rules:
// - Output the same language as the input text (Russian stays Russian).
// - Never read code blocks, file paths, URLs, tables or long lists aloud; replace
//   them with a short summary like "отправляю код на экран" / "code is on screen".
// - Expand common identifiers into readable words (parseConfig -> "parse config").
// - Keep it concise and conversational. Return ONLY the spoken text.`

// Whisper's hallucinations on silence/noise come in TWO shapes, and conflating
// them made real messages vanish:
//   TRAILERS — filler it APPENDS to a perfectly real transcription
//     ("…стих про кота расскажешь? Продолжение следует…"). A blanket pattern
//     match on those threw away the WHOLE message including the user's actual
//     words — so they are STRIPPED and the remainder is sent.
//   STANDALONE — the entire utterance IS the hallucination (the viral
//     "Субтитры сделал ДимаТорчок" meme included) — never auto-send these.
// Verbs that introduce the "субтитры сделал X" meme. Stems + optional
// imperfective suffix, so one entry covers создал / создавал / создавали.
const HALLUC_VERBS = "сделал|сделали|сделал[аи]?м|делал|делали|дедал[аи]?м|создал|создала|создали|создавал|создавала|создавали|добавил|добавила|добавили|добавлял|добавляли|поставил|поставили|нарисовал|нарисовали|озвучил|озвучили|перевел|перевели|переводил|переводили"

const HALLUCINATION_TRAILERS = [
  // Trailing punctuation must include the comma too — otherwise
  // "Спасибо за просмотр, пока" -> ", пока" and the leftover comma ships.
  // NB: no \b around Cyrillic — in JS \b is ASCII-only and never matches at a
  // Cyrillic letter, so a word boundary here would silently disable the rule.
  // NB: the "продолжение следует" rule below also matches the reversed word
  // order, and it MUST stay listed before any bracketed variant — rules run in
  // array order and the first match wins.
  /(спасибо\s+за\s+(просмотр|внимание))[.,!…?\s]*/gi,
  // NB: the bare forms must NOT eat the verb when it is followed by
  // "на канал" — otherwise "подписывайтесь на канал" gets split and the
  // leftover "на канал" ships as a message. Longer phrase wins.
  /подписывайтесь(?!\s+на\s+канал)[.,!…?\s]*/gi,
  /подпишитесь(?!\s+на\s+канал)[.,!…?\s]*/gi,
  /оставляйте\s+комментарии[.,!…?\s]*/gi,
  // More "keep watching" fillers whisper appends, incl. the marker in square
  // brackets and the "in the next episode" variant.
  /смотрите\s+продолжение\s+в\s+следующей\s+серии[.,!…?\s]*/gi,
  /продолжение\s+в\s+следующей\s+серии[.,!…?\s]*/gi,
  // The brackets are part of THIS entry, not a separate later one: rules run in
  // array order, so a bare "продолжение следует" listed first consumed the
  // words and left an empty "[ ]" behind.
  // TAIL-ANCHORED on purpose: whisper only ever APPENDS this filler, so it is
  // always at the end. Without the anchor it ate the user's own words while
  // they talked about this bug ("продолжение следует там пишешь" → "там пишешь").
  /[\[(]?\s*(продолжение\s+следует|следует\s+продолжение)\s*[\])]?[.,!…?]*\s*$/gi,
  /[\[(]?\s*серия\s+продолжается\s*[\])]?[.,!…?\s]*/gi,
  /не\s+пропускайте\s+следующие\s+(серии|выпуски)[.,!…?\s]*/gi,
  // Anchored TAIL fillers: whisper drops the "продолжение" half and leaves a
  // bare «...следует» / «...в следующей серии» at the end of a real sentence.
  // Anchoring is what keeps this safe — «продолжение следует там пишешь» is the
  // user talking about this very bug and must survive untouched.
  // NB: a bare "следует" is only filler when it follows an ordinal ("если второе
  // следует…"). On its own it is a real Russian verb — "я думаю он следует"
//  must keep it, so the ordinal is required. The `[\\s,.]\\s*` before the
  // phrase matters: without it the engine starts the match at the space and
  // leaves the comma ("всё готово, в следующей серии" -> "всё готово,").
  // Lookbehind instead of consuming the ordinal: "если второе следует…" must
  // lose only "следует", keeping the user's own "второе".
  /(?<=второе|вторая|второй|третье|третья|третий|следующее|следующая|следующий|часть)\s+следует\s*[.!?…]*\s*$/i,
  /(?:^|[\s,.])\s*в\s+следующей\s+серии\s*[.!?…]*\s*$/i,
  /(?:^|[\s,.])\s*до\s+следующей\s+(серии|части)\s*[.!?…]*\s*$/i,
  /подписывайтесь\s+на\s+канал[.,!…?\s]*/gi,
  /подпишитесь\s+на\s+канал[.,!…?\s]*/gi,
  /\bthanks\s+for\s+watching\b[.,!…?\s]*/gi, // latin — \b is fine here
  // The "DimaTorzok" meme in the shapes whisper actually emits. It rides ALONG
  // with real speech ("Добавил субтитры DimaTorzok Понял. Мужик."), so it has
  // to be removable as a fragment — a whole-message check let it through
  // together with the user's real words.
  //   • «субтитры сделал X»        — the canonical form
  //   • «добавил/сделал субтитры X» — verb in front, which the original
  //   •                                `/субтитры\s+сделал/` never matched
  //   • latin spellings of «торчок» — /торч/i is Cyrillic-only and blind to
  //                                "DimaTorzok" / "Dimatork"
  // Only the meme shape counts: a verb next to «субтитры» plus a name. A bare
  // «про субтитры в видео» is ordinary speech and must survive untouched.
  // Past-tense stems only, with an optional imperfective suffix (-вал/-вали) —
  // whisper emits "субтитры создавал" as readily as "субтитры сделал".
  // NB: new RegExp(), not a template string — these entries interpolate
  // HALLUC_VERBS, and a plain string in this array makes String.replace()
  // search for the literal text and silently match nothing.
  // [^\s] rather than [\w]: \w excludes hyphens and dots, so "субтитры делали
  // кто-то" had the name half-eaten ("-то" survived) and shipped that.
  new RegExp(`(?:(?:${HALLUC_VERBS})\\s+)?субтитры\\s+(?:${HALLUC_VERBS})\\s+[^\\s]+`, "gi"),
  // «добавил субтитры Алексею Дубровскому» — the name is in the DATIVE case, so
  // the tail after «субтитры» is TWO words; the single-token version shipped the
  // surname to the chat. Capped at 2 and barred from crossing a sentence end,
//  or "… Дубровскому Понял. Мужик." would eat the user's real words too.
  new RegExp(`(?:${HALLUC_VERBS})\\s+субтитры(?:\\s+(?!Понял|[^\\s.,!?…]*[.,!?…])[^\\s.,!?…]+){0,2}`, "gi"),
  // Same shape after "спасибо за": «спасибо за субтитры Алексею Дубровскому».
  /(спасибо\s+за)\s+субтитры(?:\s+[^\s.,!?…]+){0,2}/gi,
  // Verbless forms ("субтитры ДимаТорчок", "субтитры DimaTorzok"). Two guards
  // keep ordinary speech intact: the match must START the message or follow a
  // sentence break (a mid-sentence «субтитры» is the user talking), and every
  // following token must begin with a CAPITAL letter — that's what separates
  // the name "Дима Торчок" from the phrase "субтитры в видео".
  /(?:^|[.!?…]\s*)субтитры(?:\s+[A-ZЀ-ӿ][^\s.!?…]*)*\s*[.!?…]*\s*$/,
  // Latin spellings vary too much to enumerate (Dimatork / DimaTorzok /
  // Dimatortchok) — match the stem and swallow whatever tail follows.
  /dimator\w*/gi,
  /[\wЀ-ӿ]*дима\s*тор(?:чок|чок|zok|zok)/gi,
  /[\wЀ-ӿ]*торч(?:ок|ок)[\wЀ-ӿ]*/gi,
]

const HALLUCINATION_STANDALONE = [
  // Only the meme's fixed shapes. NB: a bare /субтитры/i would flag "я хочу
  // поговорить про субтитры в видео" and silently drop the user's real message.
  new RegExp(`субтитры\\s+(?:${HALLUC_VERBS})`, "i"),
  new RegExp(`(?:${HALLUC_VERBS})\\s+субтитры`, "i"),
  /dimator/i,
  /торч(ок|ок)/i,
  /^\s*[\[(]?\s*(музыка|music)\s*[\])]?\s*$/i,
]

// Remove whisper's appended filler; real content survives intact.
function stripHallucinationTrailers(text) {
  let t = (text || "")
  for (const re of HALLUCINATION_TRAILERS) t = t.replace(re, " ")
  return t.replace(/\s+/g, " ").trim()
}

// Bare courtesy/phrasing fillers that whisper emits on its own when it hears
// a blip. They ARE valid Russian words, so the punctuation-only check can't
// catch them — they need their own rule. Kept separate from the trailers above
// because "спасибо" alone only makes sense as a whole-message discard, while
// "спасибо за просмотр" must be stripped even inside a real sentence.
const FILLER_ONLY_MESSAGE =
  /^\s*(спасибо|благодарю|спс|пока|да|нет|ок|окей|ага|угу|угу(?!м)|хм|м(?!м)|эм|вот|так|алло|привет|здравствуй(те)?|добрый\s+(день|вечер)|извини|прости|ладно|хорошо|отлично|прекрасно|понятно|ага)\s*[.!,…]*\s*$/i

// True when the text carries at least one letter or digit. whisper answers
// noise blips with "." / ".." / "—" — punctuation only, zero words — and
// those must never be sent as a message.
function hasWords(text) {
  return /[\p{L}\p{N}]/u.test(text || "")
}

// True only when NOTHING real is left (pure filler) or what remains is itself
// a whole-message meme — i.e. there is nothing worth auto-sending.
function isStandaloneHallucination(text) {
  const t = (text || "").trim()
  if (!t) return true
  return HALLUCINATION_STANDALONE.some((re) => re.test(t))
}

// Bare "спасибо." with nothing around it is a whole-message filler; keep it
// out of HALLUCINATION_STANDALONE (that array is about the meme shapes).
function isFillerOnlyMessage(text) {
  const t = (text || "").trim()
  // Leftover from the verbless meme rule: "Субтитры ДимаТорчок" had the name
  // stripped first, leaving the bare word on its own — still a hallucination.
  if (/^субтитры\s*[.!…?]*$/i.test(t)) return true
  return FILLER_ONLY_MESSAGE.test(t)
}

function wavFromPcm(pcm, rate) {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Peak amplitude (0..32767) of s16le PCM, sampled every 4th frame.
function pcmPeak(pcm) {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 4) {
    const v = Math.abs(pcm.readInt16LE(i))
    if (v > peak) peak = v
  }
  return peak
}

function wrapRawToWav(rawPath, wavPath, rate) {
  fs.writeFileSync(wavPath, wavFromPcm(fs.readFileSync(rawPath), rate))
}

export default Plugin.define({
  id: "voice",
  setup(context) {
    log("setup: plugin initialized, checking runtime")

    // This plugin is TUI-only. The server runtime also discovers plugins under
    // ~/.config/opencode/plugins but has no TUI APIs — no-op there.
    if (!context?.keymap || !context?.ui || !context?.storage) {
      log("setup: skipping - no TUI API")
      log("setup: available keys: " + JSON.stringify(Object.keys(context ?? {})))
      return
    }

    log("setup: TUI runtime, registering commands")
    const o = context.options ?? {}
    log(`TUI options keys: ${JSON.stringify(Object.keys(o))} (sttLanguage=${o.sttLanguage ?? "unset"}, cudaBin=${o.cudaBin ?? "unset"}, whisperCli=${o.whisperCli ?? "unset"}, whisperDevice=${o.whisperDevice ?? "unset"}, llmModel=${o.llmModel ?? "unset"}, llmKeepAlive=${o.llmKeepAlive ?? "unset"})`)
    const soxBin = o.sox || "sox"
    const whisperCli = o.whisperCli || "whisper-cli"
    const whisperModel = o.whisperModel || ""
    // Small model for background scans. Falls back to the big one if unset or
    // missing on disk, so a bad path can never break transcription entirely.
    const whisperModelFastRaw = String(o.whisperModelFast || "")
    const whisperModelFast = whisperModelFastRaw && fs.existsSync(whisperModelFastRaw) ? whisperModelFastRaw : ""
    // Live preview cadence. It had NO amplitude gate at all, so whisper ran on
    // pure silence between phrases — thousands of wasted calls in the log.
    const liveIntervalRaw = Number(o.liveInterval)
    const liveIntervalMs = Number.isFinite(liveIntervalRaw) && liveIntervalRaw >= 1 ? liveIntervalRaw * 1000 : 3000
    const livePeakRaw = Number(o.livePeak)
    // 1200, not SPEECH_PEAK: the preview had NO gate before, so gating it at the
    // segment threshold (2500) made quiet speech vanish from the preview. This
    // keeps the load down without costing sensitivity.
    const livePeak = Number.isFinite(livePeakRaw) && livePeakRaw > 0 ? livePeakRaw : 550
    // Capture gain in dB. Was hardcoded to 10 on top of the Windows mic level,
    // and the recorded peaks were hitting the 32767 ceiling (99th percentile
    // 31789) — clipped audio is what whisper transcribes worst, which reads as
    // "it doesn't hear me". Lower it here; 3 dB leaves headroom for loud speech
    // while keeping quiet words well above the detection thresholds.
    const micGainRaw = Number(o.micGainDb)
    const micGainDb = Number.isFinite(micGainRaw) ? micGainRaw : 3
    // CUDA bin dir prepended to PATH for the whisper process (cublas DLLs);
    // the OpenCode server may predate the CUDA install and have a stale PATH.
    const cudaBin = o.cudaBin || ""
    // GPU device index for whisper-cli (-dev); 0 = first CUDA device, etc.
    const whisperDevice = o.whisperDevice
    const piperBin = o.piper || "piper"
    const voiceOnnx = o.voice || ""
    const sttLanguage = o.sttLanguage || "ru"
    const llmEndpoint = o.llmEndpoint || ""
    const llmModel = o.llmModel || ""
    // Ollama keep_alive for the normalize model (-1 = stay resident, warm ~0.2s)
    const llmKeepAlive = o.llmKeepAlive ?? -1
    const tmpDir = o.tmpDir || os.tmpdir()
    const autoSubmit = o.autoSubmit === true
    const trimSilence = o.trimSilence !== false
    // Hands-free: seconds of silence that end an utterance (sox trailing trim).
    // This is the single largest contributor to "I spoke and then waited" — it
    // gates the segment close, and therefore everything downstream of it. 1s is
    // the floor the validation below allows, and the practical limit given the
    // 500ms VAD tick: the segment can't close sooner than the first tick past
    // the threshold, so the real pause lands at 1.0-1.5s. Going lower only
    // buys resolution we can't use and starts cutting phrases mid-thought at
    // natural clause boundaries.
    const hfSilenceRaw = Number(o.handsFreeSilence)
    const hfSilence = Number.isFinite(hfSilenceRaw) && hfSilenceRaw >= 1 ? hfSilenceRaw : 1.0
    // Amplitude thresholds for sox silence detection (leading onset / trailing
    // stop). A higher hands-free threshold keeps room noise from triggering
    // phantom segments that whisper would transcribe into hallucinations.
    const silenceThreshold = o.silenceThreshold || "1%"
    const hfThreshold = o.handsFreeThreshold || "1%"
    // Peak amplitude (0..32767) that counts as user speech while the TTS voice
    // is playing (barge-in). The mic picks up speaker echo at a much lower
    // level than close speech, so a higher threshold keeps the bot from
    // interrupting itself; headphones make echo a non-issue entirely.
    const bargePeakRaw = Number(o.bargeInPeak)
    const bargePeak = Number.isFinite(bargePeakRaw) && bargePeakRaw > 0 ? bargePeakRaw : 4000
    // Half-duplex (default): while the assistant speaks, the mic contributes
    // NOTHING to the segment — the speakers feed straight back into the
    // capture device and every loud peak is our own voice, not the user. The
    // wake-word detector keeps running on its own path, so saying «мужик»
    // still cuts playback and starts dictation even with this on.
    // Set "bargeIn": true to get the old talk-over behaviour back, but expect
    // the bot to interrupt itself whenever echo peaks above bargePeak.
    const bargeInEnabled = o.bargeIn === true
    // TTS speaking rate: piper length_scale (1.0 = default speed; lower is
    // faster) and the silence piper inserts between sentences, in seconds.
    // Measured on ru_RU-dmitri-medium, 85-char sentence, real clip durations:
    //   1.00 -> 5.16s (1.00x)   0.85 -> 4.92s (1.05x)
    //   0.70 -> 4.23s (1.22x)   0.60 -> 3.87s (1.33x)
    //   0.50 -> 3.66s (1.41x)
    // Returns flatten below 0.6 while artefacts grow, so that is the knee.
    // NOTE: cli.json sets ttsLengthScale explicitly and OVERRIDES this default —
    // keep the two in sync or the value here silently does nothing.
    const ttsLengthScaleRaw = Number(o.ttsLengthScale)
    const ttsLengthScale = Number.isFinite(ttsLengthScaleRaw) && ttsLengthScaleRaw >= 0.3 && ttsLengthScaleRaw <= 2 ? ttsLengthScaleRaw : 1.05
    const ttsSentenceSilenceRaw = Number(o.ttsSentenceSilence)
    const ttsSentenceSilence = Number.isFinite(ttsSentenceSilenceRaw) && ttsSentenceSilenceRaw >= 0 ? ttsSentenceSilenceRaw : 0.05
    // Trailing silence (seconds) appended to every generated clip. On Windows,
    // waveaudio lets sox exit as soon as a SHORT clip fits in the device buffer,
    // discarding the not-yet-played tail — that's exactly why a two-word step
    // announcement lost its second word. Padding the clip so it outgrows the
    // buffer forces sox to keep the device open and drain it; the unavoidable
    // cutoff then lands in the silence, after the speech.
    const TTS_TAIL_SEC = 1.0
    // Echo tail after the speaker stops: the last words still ring in the room
    // and the mic would hear them as fresh speech. Ignore the mic for this long
    // after playback ends so the echo can't close a phantom segment.
    const TTS_ECHO_COOLDOWN_MS = 800
    // Post-TTS listen window. When the dictation finishes, the mic had been
    // deaf for the whole playback (half-duplex), so nothing marked "speech"
    // and the segment either closed at random or not at all. Re-open the mic
    // for this long after the voice stops: any real speech starts a segment,
    // silence closes it after the usual hfSilence.
    const postListenRaw = Number(o.postTtsListen)
    const postTtsListen = Number.isFinite(postListenRaw) && postListenRaw >= 0 ? postListenRaw : 3
    // Lower than SPEECH_PEAK: right after playback the room is still ringing,
    // so speech is quieter here than in a quiet room. Still far above noise.
    const postListenPeakRaw = Number(o.postTtsPeak)
    const postListenPeak = Number.isFinite(postListenPeakRaw) && postListenPeakRaw > 0 ? postListenPeakRaw : 530
    // Max characters spoken in one Piper call. 0 disables joining. Short chunks
    // (<~150 chars) sound natural; very long ones start to lose intonation on
    // their own, so this merges 2-3 sentences rather than whole paragraphs.
    const speakJoinRaw = Number(o.speakJoin)
    const speakJoin = Number.isFinite(speakJoinRaw) && speakJoinRaw >= 0 ? speakJoinRaw : 220
    const maxJoinRaw = Number(o.maxSpeakJoin)
    const maxSpeakJoin = Number.isFinite(maxJoinRaw) && maxJoinRaw >= 1 ? maxJoinRaw : 3
    // Announce the agent's working steps ("сейчас подумаю", "читаю файл x")
    // while it runs. Off by default only when explicitly set to false.
    const stepsTTS = o.stepsTTS !== false
    // Spoken right after the user's message is accepted (execution.started),
    // before the reply streams. Set to "" to disable.
    // A list of phrases (separated by "|") is picked at random each time, so the
    // acknowledgment doesn't sound like a stuck record.
    //
    // WHY THESE ARE ALL ONE SHORT WORD: the ack holds the whole answer behind it
    // (see ackBusy below), so its length IS added to the wait before the
    // narrator starts speaking. Measured on ru_RU-dmitri-medium at scale 1.05:
    //   "Принял, обрабатываю"  1407ms   <- the old set averaged ~1.4s
    //   "ага" 374  "ок" 351  "угу" 363  "так" 328  "да" 316  "жду" 339
    //   "вижу" 734  "ясно" 734  "понял" 711  "принял" 722  "ладно" 781
    //   "хорошо" 781  "окей" 746
    // Nothing can go below ~300ms: that is piper loading the voice model, and it
    // happens per speak() call. So ~350ms is effectively the floor, not zero.
    //
    // CAVEAT: the shortest entries are also the most common Russian words. If
    // you dictate a bare "да"/"ага" right after sending a message, the echo
    // filter (isEchoOfSelf, which drops transcripts matching what we just voiced)
    // can score it as our own echo and discard a real utterance. Raise
    // ECHO_MATCH or shorten the spoken-TTL if you ever see that.
    const ACK_DEFAULT = [
      "ага",
      "ок",
      "окей",
      "угу",
      "так",
      "да",
      "жду",
      "вижу",
      "ясно",
      "понял",
      "принял",
      "ладно",
      "хорошо",
    ]
    // "Принял, обрабатываю" is the historical sentinel value in cli.json that
    // selects this built-in list. Kept as a literal so existing configs keep
    // resolving to the defaults even though the phrase itself is gone.
    const ACK_LIST_SENTINEL = "Принял, обрабатываю"
    const ackPhrases = (() => {
      const raw = String(o.ackPhrase ?? "").trim()
      if (raw === "") return []
      const list = (raw === ACK_LIST_SENTINEL ? ACK_DEFAULT.join("|") : raw).split("|").map((p) => p.trim()).filter(Boolean)
      return list
    })()
    // Wake words that stop TTS playback when spoken during it. Comma-separated.
    // Empty string disables the feature. Detection runs whisper on short windows
    // of mic audio captured while the assistant is speaking.
    const wakeWordsRaw = String(o.wakeWords ?? "стоп, тихо, хватит, мужик")
    const wakeWords = wakeWordsRaw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
    // Keywords that may wake the bot from standby. Long words only, so a short
    // common word guessed from noise cannot restart listening on its own.
    const standbyWordsRaw = String(o.standbyWords ?? "")
    const standbyWords = (standbyWordsRaw
      ? standbyWordsRaw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
      : wakeWords
    ).filter((w) => w.length >= 5)
    // Say a wake word together with one of these and the bot stops talking AND
    // stops listening. Comma-separated; empty string disables the feature.
    // Checked only AFTER a wake word matched, so "заткнись" alone does nothing
    // and can never be triggered by the bot's own voice.
    // NB: "стоп"/"тихо"/"хватить" are deliberately NOT here — they are wake words,
    // and listing them twice made a bare "стоп" mute the bot instead of waking
    // it, so a noise-induced "стоп" silenced dictation instead of opening it.
    const muteWordsRaw = String(o.muteWords ?? "заткнись, помолчи, замолчи, отмена, молчи, заткнись уже, не надо")
    const muteWords = muteWordsRaw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
    // Mute verbs unmistakable enough to work WITHOUT a wake word in front. The
    // everyday ones ("стоп", "тихо", "хватить") stay out: noise produces them,
    // and acting on a phantom "стоп" would silence the bot mid-answer.
    const strongMuteRaw = String(o.strongMuteWords ?? "заткнись, заткнись уже, помолчи, замолчи, молчи, отмена, не надо, хватит хватит")
    const strongMuteList = strongMuteRaw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
    const strongStems = strongMuteList
      .map((w) => w.replace(/(ись|ите|и|у|а|ой)$/u, ""))
      .filter((w) => w.length >= 4)
    const strongRe = new RegExp(
      `(?:^|[^\\p{L}])(?:${strongMuteList.concat(strongStems).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`,
      "iu",
    )
    const strongMuteWord = (t) => strongRe.test(t)
    // Whisper transcribes loosely — "мужчик" for "мужик", "затхнись" for
    // "заткнись". Match stems, but ONLY as whole words: a plain includes()
    // would fire on "мужик, я хватаю…" since "хват" is the stem of "хватит".
    const muteStems = muteWords
      .map((w) => w.replace(/(ись|ите|и|у|а|ой)$/u, ""))
      .filter((w) => w.length >= 4)
    const muteAlternatives = muteWords.concat(muteStems)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")
    // Capture only the word — a lookahead/behind alternative would return the
    // preceding comma too ("мужик, хватит" -> ", хватит" in the toast).
    const muteRe = new RegExp(`(?:^|[^\\p{L}])(?:${muteAlternatives})(?![\\p{L}])`, "iu")
    const muteWordRe = new RegExp(`(?:${muteAlternatives})`, "iu")
    const findMuteWord = (t) => (t.match(muteRe) ? (t.match(muteWordRe)?.[0] ?? "").toLowerCase() : null)

    fs.mkdirSync(tmpDir, { recursive: true })

    const [state, setState] = context.storage.store("voice", {
      initial: { tts: false, hfWanted: false },
    })

    let recording = false
    let soxProc = null
    let rawFile = null
    let playback = null
    let lastSpoken = null
    // ---- Persistent Piper -------------------------------------------------
    // Every speak() used to spawn piper, which loads the voice model before it
    // makes any sound: measured 300ms before the first sample, independent of
    // utterance length, and paid again for every spoken fragment. Piper does
    // read newline-separated utterances from stdin and keeps running, so one
    // long-lived process can amortise that to once per session.
    //
    // The hard part is boundaries: a pipe carries bytes, not records, so there
    // is nothing telling us where one utterance stops and the next starts. We
    // solve it with a marker line that is NEVER played — after each text we
    // write a marker, so the marker is always the final bytes of the reply, and
    // we strip it. Its length is calibrated at runtime rather than hardcoded
    // (it measured 8820 bytes for the ru voice, but that is a property of the
    // build, not a contract).
    //
    // piperBroken is a one-way latch: any failure at all disables this path for
    // the rest of the session and speak() reverts to one process per utterance.
    // Voice that is slower is strictly better than no voice.
    let piperProc = null
    let piperBroken = false
    let piperMarkerBytes = 0      // calibrated on first use
    let piperCalibrating = null   // in-flight calibration promise
    let piperInFlight = false     // one utterance at a time; requests are queued
    let piperWaiters = []
    let piperBuf = []             // stdout chunks for the current utterance
    let piperBufLen = 0
    let piperLastDataAt = 0
    let piperQuietTimer = null
    let currentPiperAbandon = null
    // ---- Pause-on-loud-sound ------------------------------------------------
    // When the mic hears something loud while the narrator is talking, stop the
    // clip for a moment and resume it from the same offset instead of playing
    // over the noise. Volume control was rejected on purpose: sox --interactive
    // refuses a piped stdin ("Standard input has to be a terminal"), and the
    // CoreAudio route needs a long-lived PowerShell helper. Stopping and
    // restarting from a trim offset is the only option that works with no
    // external dependency.
    //
    // CAVEAT, and it matters: through speakers the narrator hears ITSELF. The
    // code elsewhere records speaker-echo peaks of 20000-30000, so a threshold
    // low enough to catch a real noise is also reachable by the bot's own voice
    // and it will pause itself. Use headphones, or set the threshold well above
    // your echo floor.
    let pauseHook = null          // set by the active speak() to pause its clip
    let pauseTicks = 0            // consecutive loud VAD ticks before pausing
    const ttsPauseOnLoudRaw = o.ttsPauseOnLoud
    const ttsPauseOnLoud = ttsPauseOnLoudRaw !== false
    const ttsPauseMsRaw = Number(o.ttsPauseMs)
    const ttsPauseMs = Number.isFinite(ttsPauseMsRaw) && ttsPauseMsRaw >= 200 ? ttsPauseMsRaw : 2000
    const ttsPausePeakRaw = Number(o.ttsPausePeak)
    const ttsPausePeak = Number.isFinite(ttsPausePeakRaw) && ttsPausePeakRaw > 0 ? ttsPausePeakRaw : 20000
    const ttsPauseTicksRaw = Number(o.ttsPauseTicks)
    const ttsPauseTicks = Number.isFinite(ttsPauseTicksRaw) && ttsPauseTicksRaw >= 1 ? ttsPauseTicksRaw : 3
    // Calibration needs a much longer settle than normal synthesis. The marker is
    // only ~200ms of audio but piper emits it in more than one burst, so the
    // normal 120ms quiet fires part-way through and measures a TRUNCATED marker
    // (observed: 2204B instead of 8820B). Under-stripping is not fatal — the
    // leftover is silence, so clips just gain a little trailing padding — but
    // measuring the real size keeps the stream in sync and the gap tight.
    let piperCalibQuietMs = 600
    const PIPER_MARKER = "."
    // Echo gate: ttsActive is true from the moment speak() starts until playback
    // fully ends; ttsEndAt adds a short cooldown after so the tail of the last
    // word (still ringing in the room) can't be heard as fresh speech. While
    // either is live the normal VAD threshold is closed — only a loud, sustained
    // barge-in can interrupt.
    let ttsActive = false
    let ttsEndAt = 0
    // End of the post-TTS listen window (epoch ms); 0 = not in one.
    let postListenUntil = 0
    // Standby ("мужик заткнись"): the mic still listens for the wake word, but
    // NOTHING is transcribed into the composer or sent. Needed because the wake
    // detector has to stay alive — killing it with stopHandsFree() made the
    // next «мужик» unreachable, so the bot could never be woken again.
    let standby = false
    // True when hands-free was armed by an explicit keypress (toggleHandsFree),
    // false when it was woken by the wake word. Deliberate arming is sticky —
    // it survives until the user turns it off, so the idle watchdog must not
    // quietly release the mic a few seconds after the hotkey. A wake word is
    // only a momentary "I'm back" and still releases on silence, otherwise the
    // capture device stays open indefinitely after a stray «мужик».
    let hfManual = false
    // Did anyone actually speak inside the post-TTS window? If the window runs
    // out untouched, the bot goes to standby instead of waiting for a segment
    // that will never contain a word.
    let postListenSpeech = false
    // Set for one tick when the post-listen window times out.
    let postListenExpired = false
    // Idle watchdog: after this many seconds with no detected speech the mic
    // gives up and waits for the wake word, instead of holding the capture
    // device open on an empty room. Counts from the last detected speech, so
    // it never fires mid-dictation. Only applies to wake-word arming — see
    // hfManual; a deliberate hotkey press is exempt. 0 disables it entirely.
    // Segments still finalize on their own via the VAD silence gate below;
    // this only governs going to standby.
    const idleStopRaw = Number(o.idleStop)
    const idleStop = Number.isFinite(idleStopRaw) && idleStopRaw >= 0 ? idleStopRaw : 5
    // Wake-word latency knobs. These are the dominant cost in "мужик" -> heard:
    // a tick has to fire before the word is even looked at, so the cadence is
    // a direct addend to the response time (worst case = one full interval).
    // Lower = snappier but more frequent file reads; whisper only runs when the
    // peak gate passes, so the cost stays small. Keep the window (below) larger
    // than the cadence or a short word can fall between two windows.
    const wakeScanRaw = Number(o.wakeScanMs)
    const wakeScanMs = Number.isFinite(wakeScanRaw) && wakeScanRaw >= 150 ? wakeScanRaw : 200
    const wakeScanStandbyRaw = Number(o.wakeScanStandbyMs)
    const wakeScanStandbyMs = Number.isFinite(wakeScanStandbyRaw) && wakeScanStandbyRaw >= 150 ? wakeScanStandbyRaw : 250
    // Audio window handed to whisper for the wake check.
    // Measured: whisper latency is FLAT in window length (0.7s and 3s of audio
    // both take ~590ms with the base model) because whisper.cpp pads to a fixed
    // 30s context. So a short window buys no speed — only robustness, by
    // keeping consecutive windows overlapping. That overlap is the real
    // constraint: window must stay well above the cadence or a word can start
    // after one window ends and finish before the next begins, falling
    // outside both (this is what used to swallow «заткнись»).
    const wakeWindowRaw = Number(o.wakeWindowSec)
    const wakeWindowSec = Number.isFinite(wakeWindowRaw) && wakeWindowRaw >= 0.8 ? wakeWindowRaw : 2
    // Peak amplitude required before whisper is run at all. See the long note
    // at its definition below — the value is wrong in either direction if you
    // pick it by intuition.
    const wakePeakMinRaw = Number(o.wakePeakMin)
    // Cadence for sampling the streaming assistant text. Half the old 500ms,
    // which halves the average detection delay for a finished sentence.
    const streamPollRaw = Number(o.streamPollMs)
    const streamPollMs = Number.isFinite(streamPollRaw) && streamPollRaw >= 100 ? streamPollRaw : 250
    // Persistent piper. Saves ~300ms of model load per spoken fragment, but it
    // replaces the synthesis path, so it is opt-in: set "ttsPersistentPiper":
    // true to try it. Any runtime failure latches it off for the session and
    // falls back to one process per utterance.
    const ttsPersistentPiper = o.ttsPersistentPiper === true
    // Quiet gap that marks the end of an utterance in the persistent stream.
    // Measured on the ru voice: piper emits every chunk of an utterance in one
    // burst, so intra-utterance gaps were 0ms and the text->marker seam was
    // 0-4ms. 120ms therefore has ~30x margin over the real maximum, while the
    // obvious 300ms would have eaten the entire ~300ms model-load saving this
    // path exists to avoid. Do not raise it casually: a value at or below the
    // largest intra-utterance gap truncates mid-sentence.
    const piperQuietRaw = Number(o.ttsPiperQuietMs)
    const piperQuietMs = Number.isFinite(piperQuietRaw) && piperQuietRaw >= 60 ? piperQuietRaw : 120
    // Grace period after killing the detector's own sox before re-opening the mic.
    // Split from the process-exit wait: the old code slept a fixed 400ms because
    // killing the process does NOT release the device. Waiting for the actual
    // 'close' event (killAndWait) covers the process itself in tens of ms, and
    // all that is left is this short driver-release grace.
    // Set wakeDeviceMs: 0 to sleep blind instead (the old behaviour) if your
    // device really does need the longer settle, e.g. if you see "Микрофон
    // недоступен" after lowering wakeGraceMs.
    const wakeGraceMsRaw = Number(o.wakeGraceMs)
    const wakeGraceMs = Number.isFinite(wakeGraceMsRaw) && wakeGraceMsRaw >= 0 ? wakeGraceMsRaw : 100
    // Upper bound on the process-exit wait, so a stuck sox degrades to a short
    // delay rather than freezing dictation for the full 2s hang guard.
    const wakeExitMsRaw = Number(o.wakeExitMs)
    const wakeExitMs = Number.isFinite(wakeExitMsRaw) && wakeExitMsRaw >= 50 ? wakeExitMsRaw : 500
    // Legacy: explicit blind sleep. >0 makes the wake path use it verbatim.
    const wakeDeviceMsRaw = Number(o.wakeDeviceMs)
    const wakeDeviceMs = Number.isFinite(wakeDeviceMsRaw) && wakeDeviceMsRaw >= 0 ? wakeDeviceMsRaw : 0
    // Blip tone. The pitch sits ABOVE the main formant region on purpose now: the
    // brief asked for a bright/ringing cue, and intelligibility-critical energy
    // sits at F1 300-800 Hz and F2 800-2500 Hz, so 900/1400 keeps the tone out
    // of the most sensitive part of the band while still reading as "звонкий".
    // It is not silence-proof: the wake detector can still transcribe it if it
    // is loud when a scan lands. If you see stray words in a transcript after a
    // blip, lower "blipLevel" rather than the pitch.
    const blipFreqLoRaw = Number(o.blipFreqLo)
    const blipFreqLo = Number.isFinite(blipFreqLoRaw) && blipFreqLoRaw >= 40 ? blipFreqLoRaw : 900
    const blipFreqHiRaw = Number(o.blipFreqHi)
    const blipFreqHi = Number.isFinite(blipFreqHiRaw) && blipFreqHiRaw >= 40 ? blipFreqHiRaw : 1400
    // Fraction of full scale, as the amplitude ceiling for the tone before the
    // fade/decay envelope is applied. 1.0 = hard clipping, so stay below.
    // Deliberately loud by default: the tone is well under F1 now, so the
    // interference that motivated lowering it came from the PITCH, not the
    // level. Lower it if you hear the blip bleed into a transcript.
    const blipLevelRaw = Number(o.blipLevel)
    const blipLevel = Number.isFinite(blipLevelRaw) && blipLevelRaw > 0 && blipLevelRaw <= 1 ? blipLevelRaw : 0.95
    let lastVoiceAt = Date.now()
    // When the capture segment started and when playback last ended. Anything
    // recorded BETWEEN those two was the assistant's own voice coming back
    // through the speakers — it must be cut off before transcription, or the
    // bot transcribes itself and sends its own words to the chat.
    let recStartedAt = 0
    let ttsEndedAt = 0
    // VAD state. Declared HERE, not next to startVad() further down: the
    // post-TTS listen window below touches these, and keeping them in one
    // block avoids a temporal-dead-zone trap for the next editor.
    let vadTimer = null
    let vadLastSpeechAt = 0
    let vadSpeechSeen = false
    // Wake-word detector state: while TTS plays, a separate sox captures the mic
    // and whisper scans the audio for the configured stop words.
    let wakeProc = null
    let wakeFile = null
    let wakeTimer = null
    let wakeBusy = false
    // Tick counter, used only to throttle the per-tick log lines. At a short
    // cadence those fire several times a second, and each one is a synchronous
    // appendFileSync inside the hot path — enough I/O and log spam to distort
    // the very timings this loop exists to minimise.
    let wakeTick = 0
    // Hands-free mode: mic stays armed, sox stops itself after hfSilence of
    // silence, the segment is transcribed+sent automatically, mic re-arms.
    const [hf, setHf] = context.storage.memory("voice-hf", { initial: { on: false } })
    // Segment pipeline: sequential queue so overlapping segments never race.
    let processing = false
    const segQueue = []
    let segSeq = 0
    let hfFail = 0
    // Set by cleanup: this plugin generation is dead. Every async continuation
    // (sox close/error handlers, VAD ticks, respawn timers) checks it. Without
    // this flag a hot-reload resurrects the old generation: cleanup kills its
    // sox, the async close event fires AFTER the new generation already set
    // hf.on=true again (shared store), the old handler sees auto=true and
    // re-arms its own mic — zombie generations accumulate, all grabbing the
    // capture device and the live slot (the "two mic icons" symptom).
    let dead = false

    // Live preview: partial transcripts shown in the prompt footer while recording.
    let liveClaim = null
    let liveTimer = null
    let liveBusy = false
    let liveSeq = 0
    const [live, setLive] = context.storage.memory("voice-live", { initial: { text: "" } })

    function toast(message, variant = "info", duration = 4000) {
      log(`toast(${variant}): ${message}`)
      context.ui.toast.show({ message, variant, duration })
    }

    // Re-open the mic for postTtsListen seconds after the voice stops. Marks
    // the start of a real utterance so VAD treats what follows as speech and
    // closes the segment on genuine silence rather than on a stale timer.
    function openPostListen() {
      if (postTtsListen <= 0) return
      const now = Date.now()
      postListenUntil = now + postTtsListen * 1000
      // Seed the "speech seen" flag with the end of playback: without this the
      // window is pointless, because the very next tick still sees no speech
      // and VAD can finalize on whatever silence it happens to see first.
      if (!vadSpeechSeen || now - vadLastSpeechAt >= hfSilence * 1000) {
        vadSpeechSeen = true
        vadLastSpeechAt = now
      }
      // Deadline = postTtsListen seconds AFTER THE VOICE ENDS, not after the call.
      // Opened by the pre-roll it used to count the pre-roll seconds too, so a
      // 3s window with a 2s pre-roll left only 1s of actual listening after the
      // narrator stopped — the mic closed almost instantly. Anchor to the known
      // end of playback when we have it.
      const endOfVoice = playEndsAt > Date.now() ? playEndsAt : Date.now()
      postListenUntil = endOfVoice + postTtsListen * 1000
      // NB: ttsEndedAt is NOT set here. This can now run BEFORE playback ends
      // (pre-roll), and ttsEndedAt is the boundary where recorded audio stops
      // being the bot's voice — setting it early would cut the user's words.
      postListenSpeech = false
      lastVoiceAt = Date.now()
      // Audible cue that the mic is open again. Only while hands-free is armed:
      // with recording off the window does nothing, so a blip would lie.
      if (hf.on || recording) playBlip("on")
    }

    // Silence after the voice → same standby as «мужик заткнись»: the bot stops
    // recording and waits for the wake word. Without this the mic kept
    // transcribing everything the user said afterwards, and the segment closed
    // on the seeded "speech seen" flag rather than on anything actually said.
    function enterStandby(reason) {
      log(`hf: ожидание — ${reason}`)
      standby = true
      cancelAnswer()
      stopPlaybackSilently()
      playBlip("off")
      toast(`Тишина. Жду слово "мужик".`, "info")
      if (hf.on || recording) stopHandsFree({ discard: true })
      setTimeout(() => {
        if (dead || !standby) return
        startWakeDetector()
        log(`wake: режим ожидания после "${reason}"`)
      }, 300)
    }

    // stopPlayback() opens a new post-listen window; entering standby must not.
    function stopPlaybackSilently() {
      abandonPiperUtterance()
      pauseHook = null
      pauseTicks = 0
      if (!playback) return
      try { playback.piper.kill() } catch {}
      try { playback.sox.kill() } catch {}
      ttsEndAt = Date.now() + TTS_ECHO_COOLDOWN_MS
      postListenUntil = 0
      playback = null
    }

    function stopPlayback() {
      abandonPiperUtterance()
      // A pending resume would restart sox after the clip was already killed.
      pauseHook = null
      pauseTicks = 0
      if (!playback) return
      try { playback.piper.kill() } catch {}
      try { playback.sox.kill() } catch {}
      // Echo gate: playback is dead, but the last word still rings in the room.
      // Keep the mic deaf for a short cooldown so the echo tail can't be heard
      // as fresh speech.
      ttsEndAt = Date.now() + TTS_ECHO_COOLDOWN_MS
      // …then open the listen window so the mic picks the user up again.
      openPostListen()
      playback = null
      // NB: the wake-word detector stays armed — it must listen before, during
      // and after playback so "стоп"/"мужик" works at any moment. Stopping it
      // here left the detector dead after every TTS reply.
    }

    // Wake-word detector: always-on when the mic is armed. Captures the mic into
    // a rolling file and scans it with whisper for the configured stop words.
    // If TTS is playing, a match cuts playback; otherwise it starts dictation.
    // Uses the same rawFile as VAD when recording is active to avoid mic conflicts.
    function startWakeDetector() {
      if (!wakeWords.length || wakeTimer) return
      wakeFile = path.join(tmpDir, "opencode-voice-wake.raw")
      try { fs.unlinkSync(wakeFile) } catch {}
      // Only spawn our own sox if VAD isn't already recording
      if (!recording) {
        wakeProc = spawn(soxBin, [
          "-t", "waveaudio", "-d",
          "-r", String(SAMPLE_RATE), "-c", "1", "-b", "16", "-e", "signed-integer",
          "-t", "raw", wakeFile,
          "gain", String(micGainDb),
        ], { windowsHide: true })
        wakeProc.on("error", (e) => {
          log(`wake: sox error: ${e.message}`)
          stopWakeDetector()
        })
        wakeProc.on("close", (code) => {
          log(`wake: sox closed code=${code}`)
          wakeProc = null
        })
        wakeProc.stderr.on("data", (d) => {
          const msg = d.toString().trim()
          if (msg && !msg.includes("[piper]")) log(`wake: sox stderr: ${msg.slice(0, 200)}`)
        })
      }
      log(`wake: detector started (words: ${wakeWords.join(", ")}, ownSox=${!recording})`)
      // Cadence bounds the wake latency: a word can land just after a tick and then
      // wait a whole interval before anyone looks. The pcmPeak gate in
      // scanWakeAudio() rejects silence BEFORE whisper runs, so a short cadence
      // costs a file read, not a GPU call. `wakeBusy` keeps ticks from piling up
      // when a slow whisper scan overruns the interval.
      wakeTimer = setInterval(scanWakeAudio, standby ? wakeScanStandbyMs : wakeScanMs)
    }

    function stopWakeDetector() {
      if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = null }
      if (wakeProc) {
        try { wakeProc.kill() } catch {}
        wakeProc = null
      }
      if (wakeFile) { try { fs.unlinkSync(wakeFile) } catch {} }
      wakeBusy = false
    }

    async function scanWakeAudio() {
      if (wakeBusy) return
      // Sampled, not per-tick: see wakeTick.
      const logTick = ++wakeTick % 40 === 0
      if (logTick) {
        log(`wake: scan tick #${wakeTick} (recording=${recording}, hf.on=${hf.on}, wakeFile=${wakeFile ? "set" : "null"}, rawFile=${rawFile ? "set" : "null"})`)
      }
      // Prefer the VAD raw file when recording is active AND has data,
      // otherwise use our own wake file. A 0-byte rawFile means sox hasn't
      // started writing yet — fall back to wakeFile so we don't stall.
      let targetFile = null
      if (recording && rawFile && fs.existsSync(rawFile)) {
        const rst = fs.statSync(rawFile)
        if (rst.size >= MIN_SEGMENT_BYTES) targetFile = rawFile
      }
      if (!targetFile && wakeFile && fs.existsSync(wakeFile)) {
        const wst = fs.statSync(wakeFile)
        if (wst.size >= MIN_SEGMENT_BYTES) targetFile = wakeFile
      }
      if (!targetFile) {
        if (logTick) {
          log(`wake: no data (rawFile=${rawFile && fs.existsSync(rawFile) ? fs.statSync(rawFile).size : "missing"}, wakeFile=${wakeFile && fs.existsSync(wakeFile) ? fs.statSync(wakeFile).size : "missing"})`)
        }
        return
      }
      wakeBusy = true
      try {
        const st = fs.statSync(targetFile)
        // Read the tail window (default 2s). Must stay comfortably LONGER than the
        // scan cadence: otherwise a word can start just after the previous
        // window ended and finish just before the next one begins, landing
        // wholly outside both — that is what made short commands like
        // «заткнись» get missed.
        const len = Math.min(Math.floor(SAMPLE_RATE * 2 * wakeWindowSec), st.size)
        const buf = Buffer.alloc(len)
        const fd = fs.openSync(targetFile, "r")
        try { fs.readSync(fd, buf, 0, len, st.size - len) } finally { fs.closeSync(fd) }
        const peak = pcmPeak(buf)
        // Skip if too quiet (echo is usually much quieter than a real voice).
        // Low threshold: mic peaks measured low (3-50) even on real speech,
        // so require only a minimal level above the digital-noise floor.
        if (peak < SPEECH_PEAK_MIN) {
          log(`wake: peak=${peak} below threshold=${SPEECH_PEAK_MIN}, skipping transcription`)
          return
        }
        log(`wake: peak=${peak} above threshold, transcribing...`)
        const wavPath = path.join(tmpDir, `opencode-voice-wake-${Date.now()}.wav`)
        fs.writeFileSync(wavPath, wavFromPcm(buf, SAMPLE_RATE))
        const res = await transcribe(wavPath, { fast: true })
        try { fs.unlinkSync(wavPath) } catch {}
        if (!res.ok || !res.text) return
        const text = res.text.toLowerCase()
        log(`wake: heard "${text.trim()}" (peak=${peak})`)
        // The wake word is checked BEFORE the echo filter: during playback the
        // window is mostly the bot's own voice, and isEchoOfSelf() would
        // happily discard the user's "мужик" along with it. The bot never says
        // its own wake words, so a match here is the user, not echo.
        // In standby the mic must wake ONLY on the deliberate keyword. The wake list
        // also holds short words ("стоп", "тихо") that whisper happily invents
        // from noise — each false hit dropped the bot out of standby and
        // restarted dictation, which is exactly the "микрогон blinked and it
        // started listening again" symptom. Short words still work while
        // recording; they are just not allowed to wake the bot from standby.
        const activeWakeWords = standby ? standbyWords : wakeWords
        const hitEarly = standby
          // From standby the keyword must LEAD the utterance — people address a
          // wake word first ("мужик, сделай…"). A keyword landing mid-sentence
          // is noise that whisper turned into a word, not a deliberate call.
          ? activeWakeWords.find((w) => new RegExp(`^\\s*(?:(?:ну|эй|эх|хм|алло|слушай)\\s*,?\\s*)?${w}`).test(text))
          : activeWakeWords.find((w) => text.includes(w))
        if (!hitEarly && isEchoOfSelf(text)) {
          log(`wake: echo of own speech, ignored`)
          return
        }
        const hit = hitEarly
        if (hit) {
          // "мужик заткнись" / "мужик помолчи" / "мужчик отмена" — stop the
          // voice AND stop listening. Distinct from a bare wake word, which
          // silences the voice and then starts dictation.
          // The mute word is checked on its own, NOT only after a wake word.
        // The scan window is 3s of rolling audio, so a scan can land on the tail
        // of "мужик заткнись" and transcribe only "заткнись." — the log showed
        // exactly that, and because the branch required a wake word first the
        // command was dropped entirely and the bot kept listening.
        //
        // Safety: without a wake word only the UNAMBIGUOUS verbs are accepted.
        // "стоп"/"тихо"/"хватить" are everyday words that noise produces, so
        // they still need the wake word to fire.
        const mute = findMuteWord(text)
        const strongMute = mute && strongMuteWord(text)
        if (mute && (hit || strongMute)) {
            log(`wake: "${hit} ${mute}" — озвучка стоп, ожидание только слова`)
            cancelAnswer()
            // Silent variant: stopPlayback() would open a post-listen window and
            // fire the "listening on" blip, so muting would produce two sounds.
            stopPlaybackSilently()
            // Drop the queued reply BEFORE the falling blip, otherwise the next
            // pumpSpeech() restarts the voice right after we muted it.
            playBlip("off")
            toast(`Выключено: "${hit} ${mute}". Жду слово "${hit}".`, "info")
            if (hf.on || recording) stopHandsFree({ discard: true })
            // Standby keeps ONLY the wake-word detector alive — no capture, no
            // transcription. stopHandsFree() already stopped the segment VAD;
            // re-arm just the detector so «мужик» can wake us again.
            standby = true
            setTimeout(() => {
              if (dead || !standby) return
              startWakeDetector()
              log(`wake: режим ожидания (слушаю только "${wakeWords.join(", ")}")`)
            }, 300)
            return
          }
          const playing = ttsActive || Date.now() < ttsEndAt
          const wasStandby = standby
          standby = false
          // A wake word is a transient wake, not a standing order to record:
          // the idle watchdog applies again so a stray «мужик» doesn't hold the
          // capture device open forever. An explicit hotkey arming sets this
          // back to true.
          hfManual = false
          log(`wake: ключевое слово "${hit}" (playing=${playing}, standby=${wasStandby}) — останавливаю озвучку и начинаю диктовку`)
          // Short confirmation blip so the user knows the keyword was detected.
          playBlip("on")
          // Speaking the wake word IS intent to talk. Without this the idle
          // watchdog, which no longer resets per segment, would fire on the very
          // next tick whenever the wake word came after a long silence.
          lastVoiceAt = Date.now()
          if (playing) {
            cancelAnswer()
            // Silent: dictation starts right below, so the "listening on" blip
            // from the post-listen window would double up with the one above.
            stopPlaybackSilently()
          }
          // Coming out of standby: hands-free was switched off by the mute, so
          // turn it back on — otherwise the wake word would restart the
          // detector and immediately wait for another «мужик».
          if (wasStandby) {
            setState((draft) => { draft.hfWanted = true })
            setHf((d) => { d.on = true })
          }
          // After the keyword, start listening immediately so the user can
          // dictate the next message. If hands-free is already recording we
          // restart the segment so VAD captures the fresh speech; if HF is off
          // we start a manual recording.
          if (hf.on) {
            if (recording) {
              const proc = soxProc
              const rf = rawFile
              recording = false
              soxProc = null
              stopVad()
              killAndWait(proc).then(() => {
                if (dead) return
                startRecording({ hfMode: true }).catch((e) => log(`wake: restart error: ${e?.stack || e}`))
              })
            } else {
              // Leaving standby: the detector's own sox holds the capture
              // device, so it must be gone before the segment recorder can
              // open it. Grab the handle BEFORE stopWakeDetector() nulls it,
              // then wait for the real 'close' event instead of sleeping a
              // fixed 400ms — a killed sox exits in tens of ms, so the fixed
              // sleep was pure dead time on the user's first syllable. Only a
              // short driver-release grace remains on top.
              const wakeProcToKill = wakeProc
              stopWakeDetector()
              const wakeDetectedAt = Date.now()
              const beginRecording = () => {
                setTimeout(() => {
                  if (dead || recording) return
                  log(`wake: микрофон открываю через ${Date.now() - wakeDetectedAt}мс от распознавания`)
                  startRecording({ hfMode: true }).catch((e) => log(`wake: start error: ${e?.stack || e}`))
                }, wakeDeviceMs > 0 ? wakeDeviceMs : wakeGraceMs)
              }
              if (wakeDeviceMs > 0) {
                // Explicit legacy blind sleep requested.
                beginRecording()
              } else if (wakeProcToKill) {
                killAndWait(wakeProcToKill, wakeExitMs).then(beginRecording)
              } else {
                beginRecording()
              }
            }
          } else {
            startRecording({ hfMode: false }).catch((e) => log(`wake: manual start error: ${e?.stack || e}`))
          }
        }
      } catch (e) {
        log(`wake: scan error: ${e?.message || e}`)
      } finally {
        wakeBusy = false
      }
    }

    // Confirmation blip: two short tones of different pitch played the same way
    // TTS is played (raw file -> sox -> waveaudio), so it uses the session's
    // audio device. Tones are concatenated in one file to avoid device races.
    function playBlip(kind = "on") {
      try {
        const sr = 44100
        // Soft low thud instead of a chime. Pitch sits under F1 so the open mic
        // barely picks it up, level is a fraction of full scale so it cannot
        // colour the transcript, and the pure sine has no harmonic structure to
        // resemble a syllable. Rising pair = listening ON, falling pair =
        // listening OFF, so the two are distinguishable without looking.
        const parts = kind === "off"
          ? [{ freq: blipFreqHi, dur: 0.12 }, { freq: blipFreqLo, dur: 0.22 }]
          : [
          { freq: blipFreqLo, dur: 0.13 },
          { freq: blipFreqHi, dur: 0.20 },
        ]
        const amplitude = Math.floor(32767 * blipLevel)
        // Bell-like partial stack. A bare sine at these pitches reads as a flat
        // beep; stacking a few harmonics is what makes it "ring". Ratios are
        // slightly stretched off the harmonic series (1 : 2.02 : 3.06) because
        // exactly-integer partials sound like an organ, not a struck bell.
        // Summed amplitudes are normalised to 1.0 so the stack does not raise
        // the peak by 1+0.45+0.2 and clip.
        const PARTIALS = [
          { mult: 1.0, amp: 0.62 },
          { mult: 2.02, amp: 0.26 },
          { mult: 3.06, amp: 0.12 },
        ]
        const norm = PARTIALS.reduce((s, p) => s + p.amp, 0)
        // Makeup gain. Partials at incommensurate ratios rarely align in phase, so the
        // summed waveform peaks well below the nominal amplitude — measured at
        // ~0.59x, which made the blip about 6dB quieter than the previous
        // single-sine version. This brings the peak back to ~88% FS (where the
        // old one sat) while keeping clear headroom: at 1.55 the peak measured
        // 95% FS, uncomfortably close to hard clipping.
        const SHAPE = 1.45
        const chunks = []
        for (const { freq, dur } of parts) {
          const samples = Math.floor(sr * dur)
          const pcm = Buffer.alloc(samples * 2)
          // Fade must scale with the tone: the old fixed 4000-sample ramp was
          // ~90ms, which on a shorter tone ate most of its body and left a
          // click rather than a thud.
          const fadeSamples = Math.max(1, Math.min(1500, Math.floor(samples / 3)))
          for (let i = 0; i < samples; i++) {
            const t = i / samples
            // Smooth attack/release + exponential decay across the tone
            const fade = Math.min(1, i / fadeSamples, (samples - i) / fadeSamples)
            const decay = 0.65 + 0.35 * (1 - t)
            let s = 0
            for (const { mult, amp } of PARTIALS) {
              // Upper partials die faster, which is what a struck object sounds
              // like — without this the tail stays as bright as the attack and
              // reads as a buzz.
              const d = mult === 1 ? 1 : Math.exp(-3.2 * mult * t)
              s += Math.sin((2 * Math.PI * freq * mult * i) / sr) * amp * d
            }
            s /= norm
            const v = Math.floor(s * amplitude * fade * decay * SHAPE)
            pcm.writeInt16LE(v, i * 2)
          }
          chunks.push(pcm)
          // Small gap between tones
          chunks.push(Buffer.alloc(Math.floor(sr * 0.05) * 2))
        }
        const pcm = Buffer.concat(chunks)
        // SoundPlayer needs a real RIFF/WAV file — a raw .raw gave it no header,
        // so it exited 0 and stayed silent. Always wrap the PCM into a WAV.
        const stamp = Date.now()
        const wavPath = path.join(tmpDir, `opencode-voice-blip-${stamp}.wav`)
        fs.writeFileSync(wavPath, wavFromPcm(pcm, sr))
        log(`blip: wav written ${wavPath} (${fs.statSync(wavPath).size}B)`)
        const cleanup = () => { try { fs.unlinkSync(wavPath) } catch {} }

        // Primary: same sox -> waveaudio path the TTS voice uses, i.e. the device
        // the user already hears Piper on.
        const cleanupAll = () => {
          cleanup()
          try { fs.unlinkSync(psPath) } catch {}
        }
        let psPath = path.join(tmpDir, `opencode-blip-${stamp}.ps1`)
        try {
          const sox = spawn(soxBin, [
            "-t", "wav", wavPath,
            "-t", "waveaudio", "-d",
          ], { windowsHide: true })
          let soxErr = ""
          sox.stderr.on("data", (d) => { soxErr += d.toString() })
          sox.on("error", (e) => log(`blip: sox error: ${e.message}`))
          sox.on("close", (code) => {
            log(`blip: sox closed code=${code}${soxErr ? ` err=${soxErr.slice(-200)}` : ""}`)
            cleanup()
          })
          return
        } catch (e2) {
          log(`blip: sox method failed: ${e2?.message || e2}`)
        }

        // Fallback: PowerShell SoundPlayer — now with a proper .wav path.
        try {
          fs.writeFileSync(psPath, `
$audio = New-Object System.Media.SoundPlayer '${wavPath}'
$audio.PlaySync()
`)
          const ps = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", psPath], { windowsHide: true });
          ps.on("error", (e) => log(`blip: powershell error: ${e.message}`));
          ps.on("close", (code) => {
            log(`blip: powershell closed code=${code}`)
            cleanupAll()
          })
        } catch (e3) {
          log(`blip: fallback WAV method failed: ${e3?.message || e3}`)
        }
      } catch (e) {
        log(`blip: error: ${e?.message || e}`)
      }
    }

    async function normalize(text, system) {
      if (!llmEndpoint || !llmModel || !text.trim()) return text
      const t0 = Date.now()
      try {
        const res = await fetch(`${llmEndpoint.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: llmModel,
            temperature: 0.1,
            max_tokens: 2000,
            keep_alive: llmKeepAlive,
            messages: [
              { role: "system", content: system },
              { role: "user", content: text },
            ],
          }),
          signal: AbortSignal.timeout(45000),
        })
        if (!res.ok) {
          log(`normalize: http ${res.status} in ${Date.now() - t0}ms`)
          return text
        }
        const json = await res.json()
        const out = json?.choices?.[0]?.message?.content?.trim()
        log(`normalize ok in ${Date.now() - t0}ms`)
        return out || text
      } catch (e) {
        log(`normalize failed in ${Date.now() - t0}ms: ${e?.message || e}`)
        return text
      }
    }

    // --- Echo filter ----------------------------------------------------
    // The mic hears the bot's own voice through the speakers; whisper then
    // "recognizes" it as user speech. We remember the last phrases we voiced
    // and drop transcripts that are (mostly) our own words.
    const recentSpoken = [] // { t: epochMs, text: normalized }
    // Must outlive the longest answer: while a long reply is playing, each
    // chunk's echo arrives seconds after it was voiced. 12s lost the tail of a
    // long reply, letting the echo of the final sentences through.
    const SPOKEN_ECHO_TTL_MS = 60000
    // Gate for running whisper on the wake window, in s16 amplitude units (0..32767).
    // History, because this number has been wrong in both directions:
    //  - 1500 was tried and was too HIGH: a quiet «заткнись» measured below it,
    //    the scan was skipped, the mute never fired, and the command went to
    //    the chat as a normal message.
    //  - 300 let through nearly everything: across 12385 real (peak, transcript)
    //    pairs only 330 were genuine wake-word speech, 12055 were whisper
    //    hallucinations ("музыка", "спасибо", ...) — so 97% of model invocations
    //    were spent on noise.
    // 1000 sits above the quiet-but-real band while still rejecting ~21% of the
    // noise. Deliberately modest: amplitude cannot separate these two
    // populations, since hallucination p95 peak (~17000) is far ABOVE the median
    // genuine peak (~9200). A higher gate deletes real words before it removes
    // much garbage. Tune with "wakePeakMin".
    const SPEECH_PEAK_MIN = Number.isFinite(wakePeakMinRaw) && wakePeakMinRaw >= 0 ? wakePeakMinRaw : 1000
    // Fraction of heard words that must be ones WE just said before the window
    // counts as our own voice. 0.6 missed echoes where acoustic decay clipped
    // the start of the word; 0.5 still keeps a real interruption safe, since the
    // user speaks different words than the bot is saying at that moment.
    const ECHO_WORD_RATIO = 0.5

    function normForEcho(s) {
      return s.toLowerCase().replace(/[^a-zа-яё0-9 ]+/gi, " ").replace(/\s+/g, " ").trim()
    }

    function rememberSpoken(text) {
      const n = normForEcho(text)
      if (!n) return
      recentSpoken.push({ t: Date.now(), text: n })
      if (recentSpoken.length > 40) recentSpoken.shift()
    }

    // True when `heard` is substantially our own recent speech.
    function isEchoOfSelf(heard) {
      const h = normForEcho(heard)
      if (!h || h.length < 3) return false
      const now = Date.now()
      // Drop expired entries.
      while (recentSpoken.length && now - recentSpoken[0].t > SPOKEN_ECHO_TTL_MS) recentSpoken.shift()
      if (!recentSpoken.length) return false
      const hw = h.split(" ").filter((w) => w.length > 1)
      if (!hw.length) return false
      for (const s of recentSpoken) {
        // Substring either way covers short echoes ("спасибо", "понял").
        if (s.text.includes(h) || h.includes(s.text)) return true
        const sw = new Set(s.text.split(" "))
        const hit = hw.filter((w) => sw.has(w)).length
        // Majority of the heard words were just spoken by us = echo.
        if (hit / hw.length >= ECHO_WORD_RATIO) return true
      }
      return false
    }

    // `fast: true` picks the small model. Background work — the wake-word scan and
    // the live preview — never needs the big model: they only look for one word
    // in a couple of seconds of audio. Measured on this machine, 3s of audio:
// 554 ms with ggml-base vs 739 ms with large-v3-turbo, and 4x less RAM/VRAM.
    // Final segments keep the big model, where accuracy actually matters.
    function transcribe(wavPath, { fast = false } = {}) {
      return new Promise((resolve) => {
        const t0 = Date.now()
        const model = fast && whisperModelFast ? whisperModelFast : whisperModel
        const args = ["-m", model, "-f", wavPath, "-np", "-nt"]
        if (sttLanguage && sttLanguage !== "auto") args.push("-l", sttLanguage)
        if (whisperDevice !== undefined && whisperDevice !== null && `${whisperDevice}` !== "") {
          args.push("-dev", `${whisperDevice}`)
        }
        let spawnEnv = process.env
        if (cudaBin) {
          spawnEnv = { ...process.env }
          // Windows env keys may be spelled "Path"/"PATH"; reuse the existing
          // key so the child env block never contains PATH duplicates.
          const pathKey = Object.keys(spawnEnv).find((k) => k.toUpperCase() === "PATH") || "PATH"
          spawnEnv[pathKey] = `${cudaBin};${spawnEnv[pathKey] || ""}`
        }
        const proc = spawn(whisperCli, args, { windowsHide: true, env: spawnEnv })
        let out = ""
        let err = ""
        proc.stdout.on("data", (d) => { out += d.toString() })
        proc.stderr.on("data", (d) => { err += d.toString() })
        proc.on("error", (e) => resolve({ ok: false, error: String(e) }))
        proc.on("close", (code) => {
          if (code === 0) {
            log(`whisper ok in ${Date.now() - t0}ms, ${out.trim().length} chars${fast ? " (fast)" : ""}`)
            resolve({ ok: true, text: out.trim() })
          } else {
            log(`whisper failed in ${Date.now() - t0}ms`)
            resolve({ ok: false, error: err.slice(-500) })
          }
        })
      })
    }

    function currentSessionID() {
      const route = context.ui.router.current()
      if (route && route.type === "session") return route.sessionID
      return null
    }

    async function submit(text) {
      const sessionID = currentSessionID()
      if (!sessionID) {
        toast("Открой сессию, чтобы отправить голосовой ввод", "warning")
        return
      }
      await context.client.session.prompt({ sessionID, text })
    }

    // There is no official API to write into the composer, so we copy the text
    // to the Windows clipboard and invoke the built-in prompt.paste command.
    async function setClipboard(text) {
      const clipFile = path.join(tmpDir, "opencode-voice-clip.txt")
      fs.writeFileSync(clipFile, text, "utf8")
      await new Promise((resolve) => {
        let done = false
        const fin = () => { if (!done) { done = true; resolve() } }
        try {
          const ps = spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `[IO.File]::ReadAllText('${clipFile}',[Text.Encoding]::UTF8) | Set-Clipboard`,
            ],
            { windowsHide: true },
          )
          ps.on("close", fin)
          ps.on("error", fin)
        } catch {
          fin()
        }
        setTimeout(fin, 4000)
      })
      try { fs.unlinkSync(clipFile) } catch {}
    }

    async function insertIntoComposer(text) {
      const t0 = Date.now()
      try {
        await setClipboard(text)
        context.keymap.dispatch("prompt.paste")
        log(`insertIntoComposer: dispatched prompt.paste in ${Date.now() - t0}ms`)
        return true
      } catch (e) {
        log(`insertIntoComposer failed after ${Date.now() - t0}ms: ${e?.stack || e}`)
        return false
      }
    }

    async function startLive() {
      if (liveClaim) return
      // JSX lives in live.tsx (TUI-side transpile only); index.js stays plain
      // JS for the server runtime and the plugin source reader.
      let renderLive
      try {
        const mod = await import("./live.tsx")
        renderLive = mod.liveRender
      } catch (e) {
        log(`live: live.tsx import failed: ${e?.message || e}`)
        return
      }
      if (typeof renderLive !== "function") {
        log("live: liveRender export missing")
        return
      }
      try {
        liveClaim = context.ui.slot({
          append: "prompt.footer.status",
          render: () => renderLive(live),
        })
        log("live: slot claimed on prompt.footer.status")
      } catch (e) {
        log(`live: slot claim failed: ${e?.stack || e}`)
        liveClaim = null
        return
      }
      setLive((d) => { d.text = "…" })
      // 3s instead of 2s: the preview is a rough hint, and it was one of the two
    // biggest consumers of whisper time (6028 of 14834 calls in the log).
      liveTimer = setInterval(() => { liveTick().catch((e) => log(`live: tick error ${e?.message || e}`)) }, liveIntervalMs)
    }

    function endLive() {
      if (liveTimer) {
        clearInterval(liveTimer)
        liveTimer = null
      }
    }

    function releaseLive() {
      endLive()
      if (liveClaim) {
        try { liveClaim() } catch {}
        liveClaim = null
        log("live: slot released")
      }
      if (live.text) setLive((d) => { d.text = "" })
    }

    // Partial transcript of the audio recorded so far; runs at most one
    // whisper pass at a time (skip ticks while one is in flight).
    async function liveTick() {
      if (liveBusy || !recording || !rawFile) return
      let pcm
      try {
        // LAST 8 seconds, not the whole file. Transcribing the entire capture
        // made the preview grow into a long paragraph and cost seconds of GPU
        // per tick. The preview is a partial of what is being said RIGHT now;
        // the full segment is transcribed later for the actual message.
        const st = fs.statSync(rawFile)
        const want = SAMPLE_RATE * 2 * 8
        if (st.size <= want) {
          pcm = fs.readFileSync(rawFile)
        } else {
          pcm = Buffer.alloc(want)
          const fd = fs.openSync(rawFile, "r")
          try { fs.readSync(fd, pcm, 0, want, st.size - want) } finally { fs.closeSync(fd) }
        }
      } catch (e) {
        log(`live: raw read failed: ${e?.message || e}`)
        return
      }
      if (pcm.length < SAMPLE_RATE * 2 * 1.5) return // <1.5s of audio
      // Amplitude gate BEFORE spawning whisper. The preview used to transcribe
      // even dead silence between phrases, which is where most of the 6028
      // preview calls came from.
      if (pcmPeak(pcm) < livePeak) return
      // Half-duplex: while the assistant talks, the capture file is mostly
      // SPEAKER ECHO. Transcribing it showed the bot's own answer in the
      // composer and grew a long phantom phrase there. The echo filter alone
      // wasn't enough — between TTS chunks ttsActive is briefly false, so the
      // echo passed through the `ttsActive` guard and stuck.
      if (!bargeInEnabled && (ttsActive || Date.now() < ttsEndAt)) {
        log("live: озвучка идёт, превью не обновляю (эхо)")
        return
      }
      liveBusy = true
      const wav = path.join(tmpDir, `opencode-voice-live-${++liveSeq}.wav`)
      try {
        fs.writeFileSync(wav, wavFromPcm(pcm, SAMPLE_RATE))
        const res = await transcribe(wav, { fast: true })
        if (recording && res.ok) {
          const text = res.text.replace(/\s+/g, " ").trim()
          // Echo filter stays as a second line of defence — with bargeIn on,
          // or right after playback ends while the room is still ringing.
          if (text && isEchoOfSelf(text)) {
            log(`live: echo of own speech, preview unchanged`)
          } else if (text) {
            setLive((d) => {
              // Skip identical text: rewriting the same string re-renders the
              // TUI for nothing, and in a quiet pause whisper keeps echoing
              // the previous fragment back unchanged.
              if (d.text === text) return
              d.text = text
            })
            log(`live: preview updated (${text.length} chars)`)
          }
        }
      } finally {
        try { fs.unlinkSync(wav) } catch {}
        liveBusy = false
      }
    }

    // Hands-free end-of-utterance detection in JS: sox only trims the leading
    // silence; this watcher reads the tail of the raw file every 500ms and
    // closes the segment after hfSilence seconds with no speech above the
    // peak threshold.
    // (vadTimer / vadLastSpeechAt / vadSpeechSeen live near the TTS gate above,
    // because the post-TTS listen window writes them too.)
    // Barge-in echo rejection: speaker bounce-back shows up as isolated loud
    // ticks, while a real human interrupting is sustained. Require two
    // consecutive loud ticks and ignore the first400ms of playback (the lead-in
    // attack echoes hardest) before we cut the voice off mid-word.
    let bargeLoudTicks = 0
    let playingSince = 0
    // When the current clip finishes playing (epoch ms), 0 when nothing plays.
    let playEndsAt = 0
    // Armed the listen window early; guards against re-arming every tick.
    let preArmed = false
    // Whether the clip currently playing is the last one of this reply.
    let isLastFragmentActive = false
    // Seconds of playback left when the listen window is opened, so the mic is
    // already live the instant the voice stops and the first word isn't lost to
    // the VAD cadence. Keep it to roughly one word (~600ms): the old 2s opened
    // the mic, seeded "speech seen" and played the listening blip while the
    // narrator was still talking, which is why dictation started picking up the
    // tail of the answer. Lower bound is the 500ms VAD tick — pre-roll is only
    // evaluated there, so anything under that can't reliably fire before the
    // end and silently degrades to the post-playback path.
    const preRollRaw = Number(o.preRoll)
    const preRollMs = Number.isFinite(preRollRaw) && preRollRaw >= 0 ? preRollRaw * 1000 : 600
    // Guards the echo-confirmation pass so overlapping ticks can't queue up
    // several whisper runs against the same playback window.
    let bargeVerifyBusy = false

    // Decide whether loud audio during playback is the user talking or the
    // speakers talking. Levels alone can't tell them apart, so transcribe the
    // window and run it through the same echo filter used elsewhere: text that
    // matches what we just voiced is our own voice coming back.
    async function verifyBargeIn(isPlaying) {
      if (dead || (!isPlaying && !(ttsActive || Date.now() < ttsEndAt))) return false
      let target = null
      try {
        if (recording && rawFile && fs.existsSync(rawFile)) {
          const st = fs.statSync(rawFile)
          if (st.size >= SAMPLE_RATE * 2) target = rawFile
        }
        if (!target && wakeFile && fs.existsSync(wakeFile)) {
          const st = fs.statSync(wakeFile)
          if (st.size >= SAMPLE_RATE * 2) target = wakeFile
        }
      } catch (e) {
        log(`barge: stat failed: ${e?.message || e}`)
        return false
      }
      if (!target) return false
      let buf
      try {
        const st = fs.statSync(target)
        // Last 2.5s is enough for a word or two of real speech.
        const len = Math.min(Math.floor(SAMPLE_RATE * 2.5) * 2, st.size)
        buf = Buffer.alloc(len)
        const fd = fs.openSync(target, "r")
        try { fs.readSync(fd, buf, 0, len, st.size - len) } finally { fs.closeSync(fd) }
      } catch (e) {
        log(`barge: read failed: ${e?.message || e}`)
        return false
      }
      if (pcmPeak(buf) < SPEECH_PEAK) return false
      const wav = path.join(tmpDir, `opencode-voice-barge-${Date.now()}.wav`)
      try {
        fs.writeFileSync(wav, wavFromPcm(buf, SAMPLE_RATE))
        const res = await transcribe(wav)
        if (!res.ok || !res.text) {
          log("barge: пустая расшифровка — считаем эхо, не прерываем")
          return false
        }
        const text = res.text.trim()
        const echo = isEchoOfSelf(text) || isStandaloneHallucination(text)
        log(`barge: слышно "${text.slice(0, 60)}" → ${echo ? "эхо озвучки, НЕ прерываю" : "реальная речь, прерываю"}`)
        return !echo
      } catch (e) {
        log(`barge: verify failed: ${e?.message || e}`)
        // Can't confirm — stay silent rather than cut off the answer.
        return false
      } finally {
        try { fs.unlinkSync(wav) } catch {}
      }
    }

    function startVad() {
      stopVad()
      vadLastSpeechAt = Date.now()
      vadSpeechSeen = false
      let vadTick = 0
      // Wake-word detector runs whenever the mic is armed
      startWakeDetector()
      vadTimer = setInterval(() => {
        try {
          if (dead) return
          if (!recording || !rawFile || !hf.on || !fs.existsSync(rawFile)) return
          const st = fs.statSync(rawFile)
          if (st.size < 3200) return // nothing recorded yet (still trimming lead-in)
          const len = Math.min(16384, st.size)
          const buf = Buffer.alloc(len)
          const fd = fs.openSync(rawFile, "r")
          try {
            fs.readSync(fd, buf, 0, len, st.size - len)
          } finally {
            fs.closeSync(fd)
          }
          const peak = pcmPeak(buf)
          // Diagnostic: log VAD state every 10 seconds to understand why
          // segments may not be closing (e.g. speech never detected, or
          // playback gate stuck open).
          if (++vadTick % 20 === 0) {
            const playing = ttsActive || Date.now() < ttsEndAt
            log(`vad: state size=${st.size} peak=${peak} speech=${vadSpeechSeen} playing=${playing} silentFor=${((Date.now() - vadLastSpeechAt) / 1000).toFixed(1)}s hfSilence=${hfSilence}s`)
          }
          // Barge-in: loud speech while the assistant is talking stops the
          // playback. Speaker echo (the mic picking up the TTS voice) shows up
          // as isolated loud ticks, so require two consecutive loud ticks and
          // skip the first400ms of playback before cutting the voice off.
          // `playing` now covers the whole TTS window: from speak() start until
          // playback ends + a short echo cooldown, so gaps between chunks and
          // the ringing tail of the last word are also gated.
          const playing = ttsActive || Date.now() < ttsEndAt
          // Pause-on-loud-sound. Runs before the barge-in branch and is
          // independent of bargeInEnabled: this is about yielding the floor to
          // a loud noise, not about being interrupted. Requires several
          // consecutive loud ticks so a single bang does not stall the reply.
          if (ttsPauseOnLoud && pauseHook && playing) {
            if (peak >= ttsPausePeak) {
              pauseTicks++
              if (pauseTicks >= ttsPauseTicks) {
                pauseTicks = 0
                pauseHook()
              }
            } else {
              pauseTicks = 0
            }
          } else if (!playing) {
            pauseTicks = 0
          }
          let bargeIn = false
          if (!bargeInEnabled && playing) {
            // Half-duplex: mic is deaf for the whole TTS window. Nothing can
            // mark "speech" here, so a segment can't close on the bot's own
            // voice. The wake-word path is independent (see scanWakeAudio) and
            // still reacts to «мужик» mid-sentence.
          } else if (playing && peak >= bargePeak && Date.now() - playingSince > 400) {
            bargeLoudTicks++
            if (bargeLoudTicks >= 2) {
              bargeLoudTicks = 0
              // Amplitude can't separate the user from speaker echo — the mic
              // measures the bot's own voice just as high as close speech (peaks
              // of 20000-30000 were seen from the speakers alone). So confirm
              // with whisper BEFORE cutting playback: if the window transcribes
              // to our own recent text it is echo and must be ignored.
              if (!bargeVerifyBusy) {
                bargeVerifyBusy = true
                const candPlaying = playing
                verifyBargeIn(candPlaying)
                  .then((isReal) => {
                    if (!isReal) return
                    cancelAnswer() // clear ansQueue FIRST — stopPlayback() alone leaves
                    stopPlayback() // queued old text, which pumpSpeech() would resume
                    bargeIn = true // a real interrupter — capture what they said
                    log(`hf: прерывание подтверждено голосом (не эхо), стоп плеера + сброс очереди`)
                  })
                  .catch((e) => log(`hf: barge verify error: ${e?.message || e}`))
                  .finally(() => { bargeVerifyBusy = false })
              }
            }
          } else {
            bargeLoudTicks = 0
          }
          // Half-duplex echo gate. While the assistant is speaking the mic mostly
          // hears SPEAKER ECHO; if that could mark "speech", a segment would close
          // on the bot's own voice and be sent back as a user message. So during
          // playback ONLY a real barge-in (loud + sustained, caught above) counts
          // as speech — echo is ignored at any volume. Once playback stops the
          // quiet SPEECH_PEAK threshold resumes, so speech spoken over the tail of
          // the reply is still captured.
          // Post-TTS window: the mic was deaf during playback, so accept speech at the
          // lower post-echo threshold. Without this the tick right after the
          // voice stops sees nothing, the segment closes on a stale timer and
          // the user is not picked up at all.
          const now = Date.now()
          // Pre-roll: arm the listen window while the last words are still
          // playing, so the mic is already open the instant the voice stops.
          if (ttsActive && isLastFragmentActive && playEndsAt && !preArmed && playEndsAt - now <= preRollMs) {
            preArmed = true
            log(`hf: озвучка кончится через ${((playEndsAt - now) / 1000).toFixed(1)}с — открываю микрофон заранее`)
            openPostListen()
          }
          const inPostListen = now < postListenUntil
          // Detect the moment the window closes, while its deadline is still known.
          if (!inPostListen && postListenUntil && now - postListenUntil >= 0 && now - postListenUntil < 1000) {
            postListenExpired = true
            postListenUntil = 0
          }
          if (inPostListen && peak >= postListenPeak) {
            // Pre-roll runs while the voice is still playing; that audio is the
            // bot's, so only count speech once playback has actually stopped.
            if (ttsActive) return
            postListenSpeech = true
            vadSpeechSeen = true
            vadLastSpeechAt = now
            lastVoiceAt = now
            return
          }
          if (inPostListen) {
            // Silence inside the window: keep waiting until it expires.
            if (++vadTick % 8 === 0) {
              log(`hf: окно прослушивания, тишина (peak=${peak} < ${postListenPeak}), осталось ${((postListenUntil - now) / 1000).toFixed(1)}с`)
            }
            return
          }
          // The window just closed and nobody spoke in it — go back to standby
          // instead of transcribing the room for the rest of the session.
          if (!postListenSpeech && postListenExpired) {
            postListenExpired = false
            enterStandby("тишина после озвучки")
            return
          }
          // Idle watchdog. Placed AFTER the post-listen branches so a freshly opened
          // window is never cut short, and before segment finalization so an
          // empty room doesn't keep a capture process alive indefinitely.
          // hfManual arms are exempt — releasing the mic seconds after an
          // explicit hotkey press reads as "the toggle didn't take".
          if (idleStop > 0 && !hfManual && !playing && !standby && now - lastVoiceAt >= idleStop * 1000) {
            enterStandby(`нет речи ${idleStop}с`)
            return
          }
          if (bargeIn || (!playing && peak >= SPEECH_PEAK)) {
            vadSpeechSeen = true
            vadLastSpeechAt = now
            lastVoiceAt = now
            return
          }
          // Never finalize a segment while the speaker is live — a half-heard
          // stretch is either echo (ignore) or a barge-in whose real tail is
          // captured after playback stops. Closing waits for true silence.
          if (!playing && vadSpeechSeen && Date.now() - vadLastSpeechAt >= hfSilence * 1000) {
            log("hf: VAD — конец фразы (пауза без речи), закрываю сегмент")
            const proc = soxProc
            const rf = rawFile
            recording = false
            soxProc = null
            stopVad()
            killAndWait(proc).then(() => {
              if (dead) return
              finishSegment({ file: rf, auto: hf.on }).catch((e) => log(`finishSegment error: ${e?.stack || e}`))
              if (hf.on) armNextSegment()
            })
          }
        } catch (e) {
          log(`vad: ${e?.message || e}`)
        }
      }, 500)
    }

    function stopVad() {
      if (vadTimer) {
        clearInterval(vadTimer)
        vadTimer = null
      }
      stopWakeDetector()
    }

    async function startRecording({ hfMode = false } = {}) {
      if (dead) return
      rawFile = path.join(tmpDir, "opencode-voice.raw")
      recStartedAt = Date.now()
      // NB: lastVoiceAt is deliberately NOT reset here. Segments re-arm
      // automatically after each pause, so resetting on every new segment gave
      // the idle watchdog a fresh 5s budget each time and it never fired —
      // the mic stayed open indefinitely while the room was silent.
      // It advances only on real detected speech (and when TTS hands back).
      // Manual push-to-talk is an explicit intent to speak — abandon any queued
      // answer (so old text can't resume behind the new input) and cut the TTS
      // voice. cancelAnswer() runs even if nothing is currently playing, because
      // ansQueue can hold pending text between chunks while playback is null.
      if (!hfMode) {
        cancelAnswer()
        if (playback) {
          log("stopping playback: manual recording started (barge-in)")
          stopPlayback()
        }
      }
      try { fs.unlinkSync(rawFile) } catch {}
      const args = [
        "-t", "waveaudio",
        "-d",
        "-r", String(SAMPLE_RATE),
        "-c", "1",
        "-b", "16",
        "-e", "signed-integer",
        "-t", "raw",
        rawFile,
        "gain", String(micGainDb),
      ]
      if (hfMode) {
        // No silence gate — sox writes everything, our VAD detects speech.
        // The silence filter kept rawFile at 0 bytes until a loud sound
        // arrived, which starved the wake-word detector.
      } else if (trimSilence) {
        args.push("silence", "1", "0.1", silenceThreshold)
      }
      soxProc = spawn(soxBin, args, { windowsHide: true })
      log(`sox spawned: ${soxBin} ${args.join(" ")}, pid=${soxProc.pid}`)
      const spawnedAt = Date.now()
      let soxErr = ""
      soxProc.stderr.on("data", (d) => { soxErr += d.toString() })
      soxProc.on("error", (e) => {
        if (dead) return
        log(`sox spawn error: ${e.message}, stderr: ${soxErr.slice(-300)}`)
        recording = false
        soxProc = null
        stopVad()
        releaseLive()
        toast(`sox не запустился: ${e.message}`, "error")
        if (hf.on) armNextSegment(true)
      })
      soxProc.on("close", (code, signal) => {
        if (dead || !recording) return
        recording = false
        soxProc = null
        stopVad()
        const auto = hf.on
        const alive = Date.now() - spawnedAt
        log(`sox closed code=${code} signal=${signal ?? "-"} alive=${alive}ms${soxErr ? ` err=${soxErr.slice(-200)}` : ""}`)
        if (alive > 3000) hfFail = 0
        finishSegment({ auto, quiet: auto }).catch((e) => log(`finishSegment error: ${e?.stack || e}`))
        if (auto) armNextSegment(alive < 1200)
        if (!auto && soxErr) toast(`sox: ${soxErr.slice(-200)}`, "warning")
      })
      recording = true
      if (hfMode) startVad()
      startLive().catch((e) => log(`live: startLive rejected: ${e?.stack || e}`))
      if (!hfMode) toast("Запись... Ctrl+R — остановить", "info")
    }

    // Re-arm the mic for the next hands-free segment. If the mic is
    // unavailable (device errors, fast sox deaths) the user's intent
    // (state.hfWanted) is kept and we keep retrying with a long backoff
    // instead of giving up.
    function armNextSegment(failed = false) {
      if (dead || !hf.on) return
      if (failed) {
        hfFail++
        if (hfFail === 1) toast("Микрофон недоступен — пробую снова", "warning")
        log(`hf: микрофон недоступен, попытка ${hfFail}, повтор через 15 с`)
        setTimeout(() => {
          if (dead || !hf.on || recording) return
          startRecording({ hfMode: true }).catch((e) => log(`hf respawn error: ${e?.stack || e}`))
        }, 15000)
        return
      }
      setTimeout(() => {
        if (dead || !hf.on || recording) return
        startRecording({ hfMode: true }).catch((e) => log(`hf respawn error: ${e?.stack || e}`))
      }, 600)
    }

    function stopHandsFree({ discard = false } = {}) {
      // Called only on explicit user action (toggle / Ctrl+R) — clear the
      // auto-resume intent along with the actual state.
      setState((draft) => { draft.hfWanted = false })
      setHf((d) => { d.on = false })
      // Next hands-free session starts as a wake-word session until the user
      // presses the hotkey, so the idle watchdog governs it.
      hfManual = false
      toast("Hands-free выключен", "info")
      const proc = soxProc
      const rf = rawFile
      recording = false
      soxProc = null
      endLive()
      stopVad()
      // Finalize whatever was being recorded (manual mode: insert, no auto-send).
      killAndWait(proc).then(() => {
        finishSegment({ file: rf, quiet: true, discard }).catch((e) => log(`finishSegment error: ${e?.stack || e}`))
      })
    }

    function toggleHandsFree(source = "?") {
      log(`command voice.hf triggered via ${source}, hf=${hf.on}, recording=${recording}, standby=${standby}`)
      if (hf.on) {
        // Explicit user intent to stop — stopHandsFree clears hfWanted.
        stopHandsFree()
        return
      }
      // A manual toggle also leaves standby, otherwise the wake detector would
      // keep competing with the recording we are about to start.
      standby = false
      stopWakeDetector()
      // Deliberate arming: sticky, exempt from the idle watchdog.
      hfManual = true
      setState((draft) => { draft.hfWanted = true })
      setHf((d) => { d.on = true })
      toast(`Hands-free: говорите, пауза ${hfSilence} с → авто-отправка в чат. Ctrl+Alt+Space — выкл`, "success")
      startRecording({ hfMode: true }).catch((e) => log(`hf start error: ${e?.stack || e}`))
    }

    function killAndWait(proc, timeoutMs = 2000) {
      return new Promise((resolve) => {
        if (!proc) return resolve()
        proc.once("close", resolve)
        try { proc.kill() } catch { resolve() }
        // Hang guard only — the "close" event normally lands within tens of ms.
        setTimeout(resolve, timeoutMs)
      })
    }

    // Snapshot the just-finished segment and hand it to the pipeline. In
    // hands-free mode the mic re-arms BEFORE the slow transcription so no
    // speech is lost between segments.
    async function finishSegment({ file, auto = false, quiet = false, discard = false } = {}) {
      // Standby ("мужик заткнись"): throw the buffer away. Finalizing it would
      // transcribe the speaker echo still sitting in the capture file and paste
      // that junk into the composer — which looked exactly like the plugin
      // restarting and listening again.
      if (discard) {
        endLive()
        if (rawFile) try { fs.unlinkSync(rawFile) } catch {}
        if (file) try { fs.unlinkSync(file) } catch {}
        releaseLive()
        log("finishSegment: discard — сегмент выброшен (режим ожидания)")
        return
      }
      endLive()
      const rf = file ?? rawFile
      let wav = null
      if (rf && fs.existsSync(rf) && fs.statSync(rf).size >= MIN_SEGMENT_BYTES) {
        try {
          let pcm = fs.readFileSync(rf)
          // Cut everything recorded while the assistant was speaking. The raw
          // capture is continuous, so the bot's own voice is sitting in this
          // buffer; transcribing it made the bot speak to itself in chat.
          const cutMs = ttsEndedAt - recStartedAt
          if (cutMs > 0) {
            const bytesPerSec = SAMPLE_RATE * 2 // 16 kHz, mono, s16
            // After a cut, a sub-second remainder is the echo tail, not speech:
            // MIN_SEGMENT_BYTES alone (0.4s) still let loud echo reach whisper.
            const minAfterCut = Math.floor(bytesPerSec * 1.2)
            const cut = Math.min(Math.floor((cutMs / 1000) * bytesPerSec), Math.max(0, pcm.length - minAfterCut))
            if (cut > 0 && pcm.length - cut >= minAfterCut) {
              log(`finishSegment: отрезаю ${(cut / bytesPerSec).toFixed(1)}с озвучки из начала сегмента`)
              pcm = pcm.subarray(cut)
            } else if (cut > 0) {
              // Nothing but playback tail — no user speech at all.
              log(`finishSegment: сегмент целиком записан во время озвучки, отброшен (bytes=${pcm.length})`)
              pcm = Buffer.alloc(0)
            }
          }
          const peak = pcm.length ? pcmPeak(pcm) : 0
          if (pcm.length < MIN_SEGMENT_BYTES || peak < SPEECH_PEAK) {
            log(`finishSegment: тишина, сегмент отброшен (peak=${peak}, bytes=${pcm.length})`)
          } else {
            wav = path.join(tmpDir, `opencode-voice-seg-${Date.now()}-${segSeq++}.wav`)
            fs.writeFileSync(wav, wavFromPcm(pcm, SAMPLE_RATE))
          }
        } catch (e) {
          log(`finishSegment: snapshot failed: ${e?.message || e}`)
          wav = null
        }
      }
      if (rf) try { fs.unlinkSync(rf) } catch {}
      releaseLive()
      if (!wav) {
        if (!quiet) toast("Ничего не записано (микрофон молчит?)", "warning")
        return
      }
      await processSegment(wav, auto)
    }

    // Sequential processing so a new segment never overlaps the previous one.
    async function processSegment(wav, auto) {
      segQueue.push({ wav, auto })
      if (processing) return
      processing = true
      try {
        while (segQueue.length) {
          const { wav: w, auto: a } = segQueue.shift()
          try {
            await runSegmentPipeline(w, a)
          } catch (e) {
            log(`segment pipeline error: ${e?.stack || e}`)
            try { fs.unlinkSync(w) } catch {}
          }
        }
      } finally {
        processing = false
      }
    }

    async function runSegmentPipeline(wav, auto) {
      try {
        const res = await transcribe(wav)
        if (!res.ok || !res.text) {
          if (auto) log(`hf: пустой сегмент пропущен (${res.error || "no text"})`)
          else toast(`Распознавание не удалось: ${res.error || "пусто"}`, "error")
          return
        }
        // No LLM "prompt preparation" pass: send exactly what was said.
        // stripHallucinationTrailers only removes whisper's known filler
        // trailer, it never rewrites the user's words.
        const cleaned = res.text
        // Strip whisper's appended trailer ("Продолжение следует…") FIRST, so a
        // real message isn't discarded just because filler rode along with it.
        // NB: no `|| stripHallucinationTrailers(res.text)` fallback — when
        // cleaning empties the string, re-running it on the raw text would
        // resurrect the very filler we just removed.
        const finalText = stripHallucinationTrailers(cleaned)
        if (!finalText) {
          log(`hf: после очистки не осталось содержания, отброшено: "${res.text.slice(0, 60)}"`)
          if (!auto) toast("Распознан только шум — сообщение не отправлено", "warning")
          return
        }
        // A wake/mute command that reached the transcript must NEVER be sent as a
        // message. The wake-word detector polls the same audio, so it can miss
        // the word (peak under threshold, window boundary, wakeBusy) while the
        // segment still transcribes it — and "заткнись" then lands in the chat
        // as a user message. This is the last line of defence for that.
        //
        // The old test was `onlyWake.startsWith(w + " ")` with NO length bound,
        // so speaking the wake word and then continuing in the same breath —
        // "мужик как дела" — matched it and the WHOLE message was silently
        // dropped. A wake word is now peeled off the front instead; only what
        // remains decides whether this was a bare command.
        const onlyWake = finalText.replace(/[.,!?…\s]/g, " ").trim()
        let messageText = finalText.trim()
        let peeled = null
        for (const w of wakeWords) {
          const safe = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          // NB: NOT \b. In JS \b is ASCII-only ([A-Za-z0-9_]), so it never
          // matches at a Cyrillic letter: "^мужик\b" does NOT match "мужик как",
          // because "к" and the space are both non-word characters. That makes
          // the rule silently never fire — measured, not assumed. The same trap
          // is called out near HALLUCINATION_TRAILERS above.
          // (?![\p{L}\p{N}]) is the Unicode-aware equivalent.
          const m = messageText.match(new RegExp(`^${safe}(?![\\p{L}\\p{N}])[\\s,.:;\\-—–]*`, "i"))
          if (m) { peeled = w; messageText = messageText.slice(m[0].length).replace(/\s+/g, " ").trim(); break }
        }
        const restOnly = messageText.replace(/[.,!?…\s]/g, " ").trim()
        const restWords = restOnly ? restOnly.split(/\s+/).length : 0
        // Nothing of substance left after peeling => it really was just the
        // command. Two or more real words => the user was talking, send it.
        const isBareCommand = !hasWords(restOnly) || restWords <= 1
        const bareMute = findMuteWord(onlyWake) !== null && onlyWake.split(/\s+/).length <= 3
        if ((peeled && isBareCommand) || bareMute) {
          log(`hf: команда "${finalText.slice(0, 40)}" — не отправляю в чат`)
          if (!auto) toast("Голосовая команда — в чат не отправлена", "info")
          return
        }
        if (peeled) {
          log(`hf: снял слово-активатор "${peeled}", в чат уйдёт "${messageText.slice(0, 60)}"`)
        }
        // whisper often answers a noise blip with punctuation only (".", "..", "—",
        // "..."). Those carry no words but pass the !finalText check and get
        // sent to the model as a message of pure punctuation.
        if (!hasWords(messageText)) {
          log(`hf: только пунктуация без слов, отброшено: "${res.text.slice(0, 60)}"`)
          if (!auto) toast("Распознан только шум — сообщение не отправлено", "warning")
          return
        }
        if (isStandaloneHallucination(messageText) || isFillerOnlyMessage(messageText)) {
          log(`hf: галлюцинация/пустышка отброшена: "${res.text.slice(0, 60)}"`)
          return
        }
        // The whole segment is our own TTS bouncing back through the speakers
        // — not the user speaking. Don't submit it as a message.
        if (auto && isEchoOfSelf(messageText)) {
          log(`hf: эхо собственной озвучки отброшено: "${finalText.slice(0, 60)}"`)
          return
        }
        if (auto) {
          const sessionID = currentSessionID()
          if (!sessionID) {
            if (await insertIntoComposer(messageText)) toast("Нет активной сессии — текст в поле ввода", "warning")
            return
          }
          // Fire the turn without awaiting the LLM response.
          toast(`Отправил: ${messageText.slice(0, 80)}`, "success", 2500)
          context.client.session.prompt({ sessionID, text: messageText })
            .catch((e) => log(`hf: prompt failed: ${e?.message || e}`))
          return
        }
        if (autoSubmit) {
          await submit(messageText)
        } else if (await insertIntoComposer(messageText)) {
          toast("Готово! Текст в поле ввода — Enter, чтобы отправить", "success")
        } else {
          const edited = await context.ui.dialog.prompt({
            title: "Голосовой ввод (Enter — отправить, Esc — отмена)",
            value: messageText,
          })
          if (edited && edited.trim()) await submit(edited.trim())
        }
      } finally {
        try { fs.unlinkSync(wav) } catch {}
      }
    }

    async function stopAndTranscribe() {
      const proc = soxProc
      const rf = rawFile
      recording = false
      soxProc = null
      endLive()
      await killAndWait(proc)
      await finishSegment({ file: rf })
    }

    // ---- Persistent piper helpers --------------------------------------------
    // One-way kill switch. Every failure path funnels through here so the
    // fallback is a single decision made in one place.
    function disablePersistentPiper(reason) {
      if (piperBroken) return
      piperBroken = true
      log(`tts: постоянный piper ОТКЛЮЧЁН — ${reason}; далее отдельный процесс на фразу`)
      killPersistentPiper()
      // Release anyone waiting; they retry on the fallback path.
      const waiters = piperWaiters
      piperWaiters = []
      piperInFlight = false
      for (const w of waiters) w.reject(new Error(reason))
    }

    function killPersistentPiper() {
      if (piperQuietTimer) { clearTimeout(piperQuietTimer); piperQuietTimer = null }
      piperBuf = []
      piperBufLen = 0
      piperCalibrating = null
      const p = piperProc
      piperProc = null
      if (p) { try { p.kill() } catch {} }
    }

    function ensurePersistentPiper() {
      if (!ttsPersistentPiper || piperBroken) return null
      if (piperProc && !piperProc.killed && piperProc.exitCode === null) return piperProc
      piperBuf = []
      piperBufLen = 0
      let proc
      try {
        proc = spawn(piperBin, [
          "-m", voiceOnnx,
          "--output_raw",
          "--length_scale", String(ttsLengthScale),
          "--sentence_silence", String(ttsSentenceSilence),
        ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      } catch (e) {
        disablePersistentPiper(`spawn: ${e?.message}`)
        return null
      }
      piperProc = proc
      proc.stdout.on("data", (d) => {
        piperBuf.push(d)
        piperBufLen += d.length
        piperLastDataAt = Date.now()
        if (piperQuietTimer) { clearTimeout(piperQuietTimer); piperQuietTimer = null }
        if (piperInFlight) schedulePiperBoundary()
      })
      let procErr = ""
      proc.stderr.on("data", (d) => { procErr += d.toString() })
      proc.on("error", (e) => disablePersistentPiper(`error: ${e?.message}`))
      proc.on("close", (code) => {
        if (piperProc !== proc) return
        piperProc = null
        const wasIdle = !piperInFlight
        // An unexpected exit with work outstanding is fatal for this path; an
        // idle exit (plugin cleanup) is just the end of the session.
        if (!wasIdle) disablePersistentPiper(`unexpected close code=${code}${procErr ? ` err=${procErr.slice(-120)}` : ""}`)
      })
      log(`tts: постоянный piper pid=${proc.pid} готов`)
      return proc
    }

    function schedulePiperBoundary() {
      if (piperQuietTimer) return
      piperQuietTimer = setTimeout(() => {
        piperQuietTimer = null
        // Not enough data to contain a whole marker yet — wait rather than cut.
        if (piperMarkerBytes && piperBufLen < piperMarkerBytes) {
          schedulePiperBoundary()
          return
        }
        finishPiperUtterance()
      }, piperCalibrating ? piperCalibQuietMs : piperQuietMs)
    }

    function finishPiperUtterance() {
      const waiter = piperWaiters.shift()
      const buf = piperBufLen ? Buffer.concat(piperBuf, piperBufLen) : Buffer.alloc(0)
      piperBuf = []
      piperBufLen = 0
      piperInFlight = piperWaiters.length > 0
      if (!waiter) return
      // This utterance was interrupted after being sent to piper. Its audio is
      // already in flight and cannot be recalled, so swallow it here instead of
      // letting it land on the NEXT request.
      if (waiter.drain) { waiter.resolve(null); return }
      if (!piperMarkerBytes) {
        // Calibration round: the bytes we just got ARE the marker.
        piperMarkerBytes = buf.length
        log(`tts: маркер откалиброван = ${piperMarkerBytes}B`)
        waiter.resolve(Buffer.alloc(0))
        return
      }
      if (buf.length <= piperMarkerBytes) {
        // No audio beyond the marker — malformed or empty. Let the caller retry
        // on the fallback rather than play silence.
        waiter.reject(new Error("persistent piper produced no audio"))
        return
      }
      // Marker is always the LAST bytes: we wrote text then marker.
      waiter.resolve(buf.subarray(0, buf.length - piperMarkerBytes))
    }

    // Calibrate the marker length once per process, by asking piper to render
    // the marker alone and measuring what comes back. Hardcoding 8820 would tie
    // us to one build and one voice.
    function calibratePersistentPiper(proc) {
      if (piperMarkerBytes) return Promise.resolve(piperMarkerBytes)
      if (piperCalibrating) return piperCalibrating
      piperCalibrating = new Promise((resolve, reject) => {
        piperWaiters.push({
          resolve: (v) => { piperCalibrating = null; resolve(piperMarkerBytes || v.length) },
          reject: (e) => { piperCalibrating = null; reject(e) },
        })
        piperInFlight = true
        piperBuf = []
        piperBufLen = 0
        try {
          proc.stdin.write(`${PIPER_MARKER}\n`)
        } catch (e) {
          disablePersistentPiper(`calibrate write: ${e?.message}`)
          reject(e)
        }
      })
      return piperCalibrating
    }

    // Synthesise one utterance on the shared process. Resolves raw PCM, or
    // rejects so the caller can fall back.
    function synthesizePersistent(text) {
      const proc = ensurePersistentPiper()
      if (!proc) return Promise.reject(new Error("persistent piper unavailable"))
      return calibratePersistentPiper(proc).then(() => {
        if (piperBroken || !piperProc) throw new Error("persistent piper died during calibration")
        return new Promise((resolve, reject) => {
          const waiter = { resolve, reject, drain: false }
          piperWaiters.push(waiter)
          piperInFlight = true
          piperBuf = []
          piperBufLen = 0
          // If this request is abandoned (wake word, mute, new message) the
          // audio is already rendering, so flag it to be discarded on arrival.
          currentPiperAbandon = () => { waiter.drain = true }
          try {
            // text first, marker LAST, so the marker is the trailing bytes
            proc.stdin.write(`${text}\n${PIPER_MARKER}\n`)
          } catch (e) {
            disablePersistentPiper(`write: ${e?.message}`)
            reject(e)
          }
        })
      })
    }

    // Called when playback is cut while synthesis is still in flight, so the
    // abandoned audio is dropped instead of landing on the next speaker.
    function abandonPiperUtterance() {
      if (currentPiperAbandon) {
        currentPiperAbandon()
        currentPiperAbandon = null
      }
    }

    async function speak(text, { direct = false, isLast = false } = {}) {
      if (!text.trim()) return
      log(`speak: requested (${text.length} chars)`)
      if (!fs.existsSync(voiceOnnx)) {
        toast("Голосовая модель Piper не найдена", "warning")
        return
      }
      stopPlayback()
      // Нормализация отключена — используем текст как есть
      const spoken = text
      const stripped = spoken
        .replace(/```[\s\S]*?```/g, " код на экране ")
        .replace(/\s+/g, " ")
        .trim()
      if (!stripped) return
      // Remember what we're about to say so the echo filter can recognize it
      // when it bounces back through the mic.
      rememberSpoken(stripped)

      let rate = 22050
      try {
        const meta = JSON.parse(fs.readFileSync(`${voiceOnnx}.json`, "utf8"))
        rate = meta?.audio?.sample_rate || rate
      } catch {}

      // Each speak() owns a playback token. stopPlayback() kills the current
      // token's processes and clears the global `playback`; by comparing our
      // token against the global we detect "we were interrupted" and bail out
      // instead of starting the next phase.
      const mine = { piper: null, sox: null }
      // True when nothing more will be spoken after this clip. Pre-roll arms the
      // mic early ONLY for the final fragment: fragments are ~3s long, so a 2s
      // pre-roll matched almost every one of them and the mic opened/closed
      // between sentences all the way through a reply.
      const isLastFragment = isLast === true
      playback = mine
      // Fresh playback: reset the echo-rejection window.
      playingSince = Date.now()
      bargeLoudTicks = 0
      // Echo gate: from now on the mic hears the bot's own voice. Close the
      // normal VAD threshold until playback ends + a short cooldown.
      ttsActive = true
      // New audio starting cancels any pending post-TTS listen window.
      postListenUntil = 0
      // Clear the previous clip's end time while Piper is still generating.
      // Left stale, the pre-roll compared against it against an already-past
      // deadline and fired instantly — a second window opening (and a second
      // blip) on top of the one the previous chunk had already armed.
      playEndsAt = 0
      preArmed = true
      isLastFragmentActive = isLastFragment

      // Resolves when playback fully ends (natural finish or interruption).
      return await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          // Release the half-duplex gate. Without this ttsActive stayed true
          // forever after the FIRST natural finish — cancelAnswer() was the
          // only place clearing it, and it runs only on an interrupt. The mic
          // then never reopened and hands-free dictation died for the session.
          if (ttsActive) {
            ttsActive = false
            // Authoritative end-of-voice timestamp: everything recorded before
            // this is the bot's own voice and gets cut before transcription.
            ttsEndedAt = Date.now()
            // Bridge the 900ms deferral below: the post-listen window is not
            // open yet, and without this the idle watchdog sees "no voice for
            // N seconds" (the user waited through the whole answer) and cut
            // listening the instant the narrator stopped.
            lastVoiceAt = Date.now()
            // Pre-roll already opened the window a moment ago — opening it again
            // here restarted the timer AND played a second "listening" blip.
            // One window per voice end, one sound.
            if (!preArmed) {
              postListenUntil = lastVoiceAt + (postTtsListen + 0.9) * 1000
              // Deferred: a streamed reply calls speak() once per sentence, so this
              // fires between chunks too. Opening the mic there made the
              // post-TTS window flash open 234 times during a reply instead of
              // once at the end. speak() cancels it again if the next chunk
              // starts inside the delay.
              setTimeout(() => {
                if (dead || ttsActive || preArmed) return
                // More fragments queued → this was a gap mid-reply, not the end.
                if (speechPending > 0) {
                  log("speak: озвучка фрагмента завершена, но есть ещё текст — микрофон не открываю")
                  return
                }
                // A step announcement or an ack: work is still coming.
                if (stepSpeaking || ackBusy || !answerSpeaking) {
                  log("speak: промежуточная фраза (шаг/подтверждение) — микрофон не открываю")
                  return
                }
                log("speak: озвучка завершена, открываю микрофон")
                openPostListen()
              }, 900)
            }
          }
          resolve()
        }
        const active = () => playback === mine

        // Phase 1: generate ALL audio with piper into memory. No pipe to sox,
        // so there is no EOF race that drops the tail of the phrase.
        //
        // Preferred path: the shared long-lived piper, which has already loaded
        // the voice model. Every failure here falls through to a dedicated
        // process below, so this can only cost latency, never voice.
        const speakDedicated = () => {
          const piper = spawn(piperBin, [
            "-m", voiceOnnx,
            "--output_raw",
            "--length_scale", String(ttsLengthScale),
            "--sentence_silence", String(ttsSentenceSilence),
          ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
          mine.piper = piper
          log(`speak: piper pid=${piper.pid} (buffering), length_scale=${ttsLengthScale}, ${stripped.length} chars`)
          const chunks = []
          let piperErr = ""
          piper.stdout.on("data", (d) => chunks.push(d))
          piper.stderr.on("data", (d) => { piperErr += d.toString() })
          piper.on("error", (e) => {
            toast(`Piper не запустился: ${e.message}`, "error")
            if (active()) playback = null
            done()
          })
          piper.on("close", (code) => {
            log(`speak: piper closed code=${code}, buffered=${chunks.reduce((n, c) => n + c.length, 0)}B${piperErr ? ` err=${piperErr.slice(-200)}` : ""}`)
            if (!active()) { done(); return } // interrupted during generation
            playBuffer(Buffer.concat(chunks))
          })
          piper.stdin.write(`${stripped}\n`)
          piper.stdin.end()
        }

        if (!ttsPersistentPiper || piperBroken) {
          speakDedicated()
          return
        }
        const tGen = Date.now()
        synthesizePersistent(stripped)
          .then((pcm) => {
            currentPiperAbandon = null
            // null = the utterance was abandoned mid-flight; its audio was
            // dropped on purpose, so play nothing. done() already ran when it
            // was interrupted.
            if (pcm === null) return
            if (!active()) { done(); return } // interrupted while synthesising
            log(`tts: постоянный piper дал ${pcm.length}B за ${Date.now() - tGen}мс`)
            playBuffer(pcm)
          })
          .catch((e) => {
            // Interrupted, or persistent path failed — fall back. piperBroken may
            // already be latched, in which case every later speak() goes direct.
            if (!active()) { done(); return }
            log(`tts: постоянный piper не сработал (${e?.message}) — отдельный процесс`)
            speakDedicated()
          })

        // Phase 2: play the complete buffer from a temp file — sox reads a
        // finished file, so it can't exit early on a transient pipe EOF.
        const playBuffer = (pcm) => {
          if (!active()) { done(); return }
          // Pad trailing silence so a short clip outgrows the waveaudio device
          // buffer (see TTS_TAIL_SEC). The cutoff lands in the silence, never in
          // the last word.
          const tail = Buffer.alloc(Math.round(rate * TTS_TAIL_SEC) * 2)
          const padded = Buffer.concat([pcm, tail])
          const rawPath = path.join(tmpDir, `opencode-voice-tts-${Date.now()}-${Math.round(Math.random() * 1e6)}.raw`)
          try { fs.writeFileSync(rawPath, padded) } catch (e) {
            log(`speak: write tts buffer failed: ${e?.message || e}`)
            playback = null
            done()
            return
          }
          // Один sox на клип. У sox нет демон-режима: без файла и без
          // "-t waveaudio -d" он читает stdin и выбрасывает звук, поэтому
          // держать один процесс и подсовывать ему файлы невозможно.
          // But it CAN resume mid-file via `trim <seconds>`, which is what the
          // pause-on-loud-sound path uses: kill, then restart from the offset.
          const totalSec = (padded.length / 2) / rate
          const cleanup = () => { try { fs.unlinkSync(rawPath) } catch {} }
          // Seconds of the clip already played, counting earlier paused stretches.
          let playedOffset = 0
          let paused = false
          let resumeTimer = null

          const startSoxFrom = (offsetSec) => {
            // sox argument order is [input opts] infile [output opts] outfile
            // [effects] — effects AFTER the output file. Putting trim before it
            // makes sox fail with "Not enough input filenames specified".
            const args = [
              "-t", "raw", "-r", String(rate), "-e", "signed-integer", "-b", "16", "-c", "1",
              rawPath,
              "-t", "waveaudio", "-d",
            ]
            if (offsetSec > 0.05) args.push("trim", offsetSec.toFixed(3))
            const sox = spawn(soxBin, args, { windowsHide: true })
            mine.sox = sox
            playingSince = Date.now()
            // Duration of what sox is about to play, so the mic can be armed a
            // moment before the last word instead of after it. Rebased from the
            // REMAINING audio, which is what keeps the pre-roll honest across
            // a pause: without this the deadline stays where it was and the
            // listen window opens while the narrator is still mid-clip.
            playEndsAt = playingSince + Math.floor((totalSec - offsetSec) * 1000)
            preArmed = false
            isLastFragmentActive = isLastFragment
            bargeLoudTicks = 0
            log(`speak: sox-play pid=${sox.pid} offset=${offsetSec.toFixed(2)}s rate=${rate}`)
            sox.on("close", (code) => {
              // A pause kills sox deliberately. That close is NOT the end of the
              // clip — falling through to cleanup()/done() here would delete the
              // temp file and end the reply mid-sentence.
              if (paused) { log(`speak: sox-play closed (пауза) code=${code}`); return }
              log(`speak: sox-play closed code=${code}`)
              if (pauseHook === pauseClip) pauseHook = null
              if (active()) playback = null
              cleanup()
              done()
            })
            sox.on("error", (e) => {
              if (paused) return
              log(`speak: sox-play error ${e?.message || e}`)
              if (pauseHook === pauseClip) pauseHook = null
              cleanup()
              done()
            })
          }

          // Stop mid-clip and pick up where we left off after `ms`.
          function pauseClip() {
            if (paused || dead || !mine.sox) return
            paused = true
            // Everything played so far: the offset this run started from plus
            // however long this run has been going.
            playedOffset += (Date.now() - playingSince) / 1000
            if (playedOffset >= totalSec - 0.05) { paused = false; return } // already finished
            const proc = mine.sox
            mine.sox = null
            try { proc.kill() } catch {}
            log(`tts: пауза на ${ttsPauseMs}мс, позиция ${playedOffset.toFixed(2)}/${totalSec.toFixed(2)}с`)
            resumeTimer = setTimeout(() => {
              resumeTimer = null
              if (dead || !active()) { paused = false; pauseHook = null; return }
              paused = false
              startSoxFrom(playedOffset)
            }, ttsPauseMs)
          }
          if (ttsPauseOnLoud) pauseHook = pauseClip

          startSoxFrom(0)
        }
      })
    }

    // ---- Streaming answer TTS -------------------------------------------------
    // Speak the reply sentence-by-sentence as it streams in, instead of waiting
    // for the whole response. `message.part.updated` delivers the growing text
    // of each assistant part; we speak complete sentences as they form and let
    // onIdle() flush the trailing remainder. streamOffsets remembers how much of
    // each part was already spoken so the flush never repeats it.
    //
    // Kept robust to a bus that might not forward message.part.*: with no parts,
    // offsets stay empty and onIdle() simply speaks the full reply (the old path).

    // Markdown -> natural speech. Fast regex cleanup, no LLM round-trip, so the
    // first sentence can start speaking with near-zero latency.
    function cleanForSpeech(md) {
      let s = String(md ?? "")
      s = s.replace(/```[\s\S]*?```/g, " ")          // drop code blocks (don't read code aloud)
      s = s.replace(/`([^`]*)`/g, "$1")               // inline code -> content
      s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")  // image -> alt
      s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // link -> anchor text
      s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "")        // headings
      s = s.replace(/^\s{0,3}>\s+/gm, "")             // blockquote
      s = s.replace(/^\s*[-*+]\s+/gm, "")             // bullet list
      s = s.replace(/^\s*\d+\.\s+/gm, "")             // numbered list
      s = s.replace(/(\*\*|__)(.*?)\1/g, "$2")        // bold
      s = s.replace(/(\*|_)(.*?)\1/g, "$2")           // italic
      s = s.replace(/~~(.*?)~~/g, "$1")               // strikethrough
      s = s.replace(/\|/g, " ")                       // table pipes
      s = s.replace(/^\s*([-*_])\s*(\1\s*){2,}$/gm, " ") // hr
      s = s.replace(/\s+/g, " ").trim()
      return s
    }

    // Index just past the LAST sentence terminator at or after `from`, or -1 if
    // no complete sentence exists yet. Raw offsets are tracked so the mapping to
    // part.text stays exact even after whitespace cleanup.
    function speakableEnd(text, from) {
      const re = /[.!?…]["»')\]]?(\s+|$)/g
      re.lastIndex = from
      let end = -1
      let m
      while ((m = re.exec(text))) end = m.index + m[0].length
      return end
    }

    const streamOffsets = new Map() // assistantMessageID -> raw char index already spoken
    const streamAccum = new Map()   // assistantMessageID -> accumulated text from session.text.delta
    let speakingMsgID = null        // message being voiced — a change means a new turn's reply arrived
    let ansQueue = []
    let ansBusy = false
    // Fragments still to be spoken. The post-listen window must not open while
    // this is non-zero: Piper needs ~1s to generate a chunk, longer than the
    // 900ms deferral, so the timer used to fire mid-reply and chirp once per
    // fragment instead of once at the end.
    let speechPending = 0
    let ansFinal = false
    let ackBusy = false // acknowledgment phrase playing — holds steps + answer behind it
    let lastAckAt = 0   // debounce: execution.started should fire once per turn

    function enqueueSpeech(text) {
      if (!text) return
      ansQueue.push(text)
      speechPending++
      // Latch the reply speaker the moment answer text starts: step
      // announcements stay muted and can't kill this playback.
      answerSpeaking = true
      log(`tts: enqueue ${text.length} chars, queue=${ansQueue.length}, ansBusy=${ansBusy}`)
      pumpSpeech()
    }

    function pumpSpeech() {
      if (ansBusy) { log(`tts: pump BLOCKED ansBusy=true queue=${ansQueue.length}`); return }
      if (ackBusy) { log(`tts: pump HELD for ack queue=${ansQueue.length}`); return }
      const next = ansQueue.shift()
      if (next === undefined) {
        if (ansFinal) { ansFinal = false; answerSpeaking = false }
        return
      }
      // Speak 2-3 queued sentences in one go. Piper was called once per
      // sentence, and each call restarts prosody from scratch — the result
      // sounded chopped rather than spoken. Longer chunks also mean fewer
      // process spawns (each reloads the model before saying anything).
      let chunk = next
      let merged = 0
      if (speakJoin) {
        // Hard cap on merged sentences as well as on length: with only a length
        // limit a run of short sentences ("Исправил. Проверяю. Работает.") all
        // merged into a single long utterance, which is harder to interrupt and
        // sounds like one breathless run.
        merged = 1
        while (ansQueue.length && chunk.length < speakJoin && merged < maxSpeakJoin) {
          chunk += " " + ansQueue.shift()
          merged++
        }
      }
      // Last fragment = nothing queued behind it AND the reply is fully known.
      // speechPending is deliberately NOT part of this: it still counts the
      // fragment being spoken right now, so requiring it to be 0 here made
      // isLast was permanently false and the window never opened at all.
      const isLast = ansQueue.length === 0 && ansFinal
      ansBusy = true
      speak(chunk, { direct: true, isLast }).finally(() => {
        speechPending -= merged
        ansBusy = false
        pumpSpeech()
      })
    }

    // Called once the reply is fully known (execution.succeeded): flushes any
    // unspoken trailing text, then clears the latch when the queue drains.
    function finalizeSpeech() { ansFinal = true; pumpSpeech() }

    // Interrupt (barge-in / new recording): drop the whole reply queue so the
    // user's voice wins and nothing keeps playing behind them. Also stop the
    // poller — otherwise it would keep enqueueing new sentences over the user.
    function cancelAnswer() {
      stopStreamPoll()
      ansQueue = []
      speechPending = 0
      ansFinal = false
      answerSpeaking = false
      streamOffsets.clear()
      streamAccum.clear()
      // The mic is about to capture the interrupter's real voice — open the
      // echo gate immediately instead of waiting out the cooldown.
      ttsActive = false
      ttsEndAt = 0
      // Keep the wake-word detector armed: cancelAnswer() runs on every new
      // message, and stopping the detector here killed wake-word listening
      // after the first TTS reply. Only stopVad()/cleanup may stop it.
    }

    // Stop ONLY the previous reply's audio + queued backlog (a new message's
    // response is arriving), preserving the message-keyed streamOffsets/
    // streamAccum — old-message keys are never read again, and keeping them
    // guards a same-message continuation from re-speaking its already-spoken head.
    function stopStaleAnswer() {
      ansQueue = []
      ansFinal = false
      answerSpeaking = false
      stopPlayback()
    }

    // The first reasoning OR text delta of a NEW assistant message marks a new
    // turn's reply arriving on screen. Anything still voicing the PREVIOUS
    // message must stop then, or it keeps reading stale text over the new reply
    // ("still finishing the previous ones"). Scoped to an actual MESSAGE change,
    // so a continuation of the same message never cuts its own audio.
    function noteNewMessage(msgID, sessionID) {
      if (!msgID || !sessionID) return false
      if (sessionID !== currentSessionID()) return false
      if (msgID === speakingMsgID) return false
      if (speakingMsgID !== null) {
        stopStaleAnswer()
        log(`stream: new msg ${msgID} supersedes ${speakingMsgID} — stopped stale answer`)
      }
      speakingMsgID = msgID
      return true
    }

    // Fired on session.execution.started (once per user turn): kill whatever the
    // PREVIOUS turn was still voicing, reset the message boundary so the new
    // message won't kill what follows, then say the acknowledgment. ackBusy holds
    // BOTH announceStep and pumpSpeech so neither the reasoning status nor the
    // answer's first chunk can cut the phrase short — the reply waits behind it.
    function speakAck() {
      const now = Date.now()
      if (now - lastAckAt < 2000) return // safety: never re-ack (or re-kill) on a rapid re-fire
      lastAckAt = now
      stopStaleAnswer()      // drop the previous turn's audio + queued backlog
      speakingMsgID = null   // next message claims cleanly — won't treat this ack as stale
      if (!ackPhrases.length || !state.tts || dead) return
      const ackPhrase = ackPhrases[Math.floor(Math.random() * ackPhrases.length)]
      ackBusy = true         // hold steps + answer until the acknowledgment finishes
      log(`ack: "${ackPhrase}"`)
      // speak() can return undefined (e.g. missing model) or throw synchronously;
      // Promise.resolve + a guarded release guarantees ackBusy ALWAYS clears, or
      // a failed ack would hold pumpSpeech/announceStep forever.
      const release = () => {
        if (!ackBusy) return
        ackBusy = false
        pumpSpeech() // release any answer chunk queued behind the ack
        const step = stepQueued
        stepQueued = null
        if (step && !answerSpeaking) announceStep(step)
      }
      try {
        Promise.resolve(speak(ackPhrase, { direct: true })).finally(release).catch((e) => log(`ack speak error: ${e?.message || e}`))
      } catch (e) {
        release()
        log(`ack speak error: ${e?.message || e}`)
      }
    }

    function onStreamPart(event) {
      if (!state.tts || dead) return
      const d = event?.data ?? event?.properties ?? event
      const part = d?.part
      if (!part || part.type !== "text" || part.synthetic) return
      const sessionID = part.sessionID ?? d?.sessionID
      if (!sessionID || sessionID !== currentSessionID()) return
      // Only stream while the assistant is actually generating — this excludes
      // the user's own prompt text parts.
      try { if (context.data.session.status(sessionID) !== "running") return } catch {}
      const text = part.text || ""
      const pid = part.id
      const off = streamOffsets.get(pid) ?? 0
      if (text.length <= off) return
      const end = speakableEnd(text, off)
      if (end <= off) return
      streamOffsets.set(pid, end)
      const chunk = cleanForSpeech(text.slice(off, end))
      if (chunk) {
        log(`stream: sentence (${chunk.length} chars) part=${pid}`)
        enqueueSpeech(chunk)
      }
    }

    // message.part.updated never fires on the TUI bus (confirmed). Streaming runs
    // from the poller with MESSAGE-keyed offsets; keeping this event path wired
    // would key by part.id (always undefined) and double-speak against it.
    const offPart = () => {}
    const offExecFail = context.data.on("session.execution.failed", () => { cancelAnswer() })
    const offExecInt = context.data.on("session.execution.interrupted", () => { cancelAnswer() })

    // ---- Polling-based streaming (primary path) ------------------------------
    // message.part.updated is declared in the SDK types but NEVER forwarded on
    // the TUI bus (stream: sentence never fired), while the console still shows
    // the reply growing — the store updates internally, the event just never
    // reaches plugins. So drive streaming by polling the in-progress assistant
    // message while the session is "running": sync -> find last assistant msg ->
    // client.session.message.get() (a DIRECT server read, so it returns the
    // CURRENT growing text) -> speak each text part sentence-by-sentence into
    // the SAME streamOffsets/enqueueSpeech pipeline the event path uses. onIdle()
    // flushes only what streamOffsets marks unspoken, so poller + onIdle never
    // double-speak. Gated on state.tts (same toggle onIdle uses), not stepsTTS.
    let streamPoll = null
    let pollLogTicks = 0

    function stopStreamPoll() {
      if (streamPoll) { clearInterval(streamPoll); streamPoll = null }
    }

    function startStreamPoll(sessionID) {
      if (!sessionID || streamPoll || dead) return
      pollLogTicks = 0
      // How often the assistant text is sampled for newly-spoken sentences.
      // This is the cadence floor on "answer appeared -> narrator speaks": a
      // completed sentence is invisible until the next tick, so the wait is
      // uniform 0..streamPollMs, averaging half of it. Pure reads of session
      // state, so the cost is small. Tune with "streamPollMs".
      streamPoll = setInterval(() => { streamPollTick(sessionID).catch(() => {}) }, streamPollMs)
    }

    // Streaming unit is a whole MESSAGE's joined text, keyed by MESSAGE id.
    // (Content parts from .get() carry no `id` — logged part=undefined — so
    // keying by part.id shared ONE bucket across every reply: stale progress on
    // an old message made off exceed a later, shorter reply's length and silenced
    // it. Message id is stable and unique per reply.) Skips already-spoken replies.
    function pollStreamJoined(msgID, text, sessionID) {
      if (!state.tts || dead) return
      if (!text || msgID === lastSpoken) return // never re-voice a finished reply
      if (sessionID !== currentSessionID()) return
      try { if (context.data.session.status(sessionID) !== "running") return } catch {}
      const off = streamOffsets.get(msgID) ?? 0
      if (text.length <= off) return
      const end = speakableEnd(text, off)
      if (end <= off) return
      streamOffsets.set(msgID, end)
      const chunk = cleanForSpeech(text.slice(off, end))
      if (chunk) { log(`stream: poll (${chunk.length} chars) msg=${msgID}`); enqueueSpeech(chunk) }
    }

    async function streamPollTick(sessionID) {
      if (!state.tts || dead) { stopStreamPoll(); return }
      try {
        if (context.data.session.status(sessionID) !== "running") { stopStreamPoll(); return }
        await context.data.session.message.sync(sessionID)
        const list = context.data.session.message.list(sessionID) ?? []
        const a = [...list].reverse().find((x) => x.type === "assistant")
        if (!a) return
        let msg = a
        try {
          const res = await context.client.session.message.get({ sessionID, messageID: a.id })
          msg = res?.data ?? res ?? a
        } catch {}
        const parts = msg.content ?? []
        const text = parts
          .filter((p) => p.type === "text" && !p.synthetic)
          .map((p) => p.text || "")
          .join("\n")
        // Log the first few ticks so a test shows whether `total` actually grows
        // (proves the store exposes partial text) without spamming forever.
        if (pollLogTicks < 8) { pollLogTicks++; log(`poll: ${a.id} parts=${parts.length} total=${text.length}`) }
        pollStreamJoined(a.id, text, sessionID)
      } catch (e) { log(`poll: error ${e?.message || e}`) }
    }

    // ---- Discover the per-session durable event stream ----------------------
    // data.on/listen forward session.*/shell.* but NEVER message.part.*, yet the
    // console renders growing text. client.session.events replays DURABLE events
    // then continues live — the likely home of message.part.updated/delta. This
    // diagnostic opens that stream and logs every distinct type + a sample of any
    // part/delta event, so we can see the real streaming source and its shape.
    let sseIter = null
    let sseSession = null
    let sseUnavailableLogged = false
    const sseTypes = new Set()

    async function openSessionStream(sessionID) {
      if (!sessionID || dead || sseSession === sessionID) return
      sseSession = sessionID
      try {
        const fn = context.client?.session?.events
        if (typeof fn !== "function") {
          if (!sseUnavailableLogged) {
            sseUnavailableLogged = true
            log(`sse: session.events UNAVAILABLE; session keys=[${Object.keys(context.client?.session ?? {}).join(",")}] proto=[${Object.getOwnPropertyNames(Object.getPrototypeOf(context.client?.session ?? {})).join(",")}]`)
          }
          sseSession = null
          return
        }
        const sse = await fn.call(context.client.session, { sessionID })
        const it = sse.stream[Symbol.asyncIterator]()
        sseIter = it
        log(`sse: stream opened for ${sessionID}`)
        while (!dead) {
          const { value: ev, done } = await it.next()
          if (done || dead) break
          const t = ev?.type
          if (!sseTypes.has(t)) {
            sseTypes.add(t)
            log(`sse: type=${t}`)
            if (t && /part|delta|text/i.test(t)) {
              log(`sse: *** STREAMING ${t} sample=${JSON.stringify(ev).slice(0, 600)}`)
            }
          }
        }
      } catch (e) {
        log(`sse: err ${e?.message || e}`)
      }
    }

    const offExecStart = context.data.on("session.execution.started", (event) => {
      try {
        const sid = event?.data?.sessionID
        if (sid && state.tts) { speakAck(); startStreamPoll(sid); openSessionStream(sid).catch(() => {}) }
      } catch {}
    })

    // ---- Event-driven streaming (the real zero-latency source) ---------------
    // The bus DOES deliver growing text — under session.text.delta, not the
    // message.part.updated the SDK types advertise (that name never fired). Each
    // event carries data.delta = an incremental chunk plus assistantMessageID.
    // Accumulate per message and speak complete sentences into the SAME
    // message-keyed streamOffsets the poller and onIdle use, so all three paths
    // cooperate without double-speaking. onIdle() still flushes the tail.
    let deltaSampleLogged = false

    function streamFromDelta(d) {
      if (!state.tts || dead || !d) return
      if (!deltaSampleLogged) {
        deltaSampleLogged = true
        log(`delta: first sample keys=[${Object.keys(d).join(",")}] sample=${JSON.stringify(d).slice(0, 300)}`)
      }
      const sessionID = d.sessionID
      const msgID = d.assistantMessageID
      const delta = d.delta || ""
      if (!sessionID || !msgID || !delta) return
      if (sessionID !== currentSessionID()) return
      noteNewMessage(msgID, sessionID) // on message change, stop the prior reply's audio first
      const accum = (streamAccum.get(msgID) || "") + delta
      streamAccum.set(msgID, accum)
      const off = streamOffsets.get(msgID) ?? 0
      const end = speakableEnd(accum, off)
      if (end <= off) return
      streamOffsets.set(msgID, end)
      const chunk = cleanForSpeech(accum.slice(off, end))
      if (chunk) { log(`stream: delta (${chunk.length} chars) msg=${msgID}`); enqueueSpeech(chunk) }
    }

    // Diagnostic + streaming feed: log each DISTINCT event type once, flag any
    // streaming-looking name, and route session.text.delta straight to the TTS.
    const busSeen = new Set()
    const offListen = context.data.listen(({ details }) => {
      try {
        const t = details?.type
        if (!t) return
        if (t === "session.text.delta") { streamFromDelta(details?.data); return }
        // Reasoning arrives BEFORE text — its first delta is the earliest sign a
        // NEW message is responding, so the stale previous reply stops right when
        // the new "thinking" becomes visible. (Falls back to the text.delta
        // boundary in noteNewMessage if a turn has no reasoning.)
        if (t === "session.reasoning.delta" && state.tts && !dead) {
          const rd = details?.data
          if (rd) noteNewMessage(rd.assistantMessageID, rd.sessionID)
        }
        if (busSeen.has(t)) return
        busSeen.add(t)
        if (busSeen.size <= 40) log(`bus: type=${t}`)
        if (/part|delta|text|content|chunk|stream/i.test(t)) log(`bus: STREAMING-CANDIDATE type=${t}`)
      } catch {}
    })

    async function speakLastResponse() {
      const sessionID = currentSessionID()
      if (!sessionID) {
        toast("Нет активной сессии", "warning")
        return
      }
      // Manual re-read speaks the whole reply from the top — drop any streaming
      // state so it starts clean and doesn't resume mid-sentence.
      cancelAnswer()
      try {
        await context.data.session.message.sync(sessionID)
      } catch {}
      const list = context.data.session.message.list(sessionID) ?? []
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (m.type !== "assistant") continue
        let msg = m
        try {
          const res = await context.client.session.message.get({ sessionID, messageID: m.id })
          msg = res?.data ?? res ?? m
        } catch {}
        const text = (msg.content ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim()
        if (text) {
          lastSpoken = m.id
          answerSpeaking = true
          try {
            await speak(text)
          } finally {
            answerSpeaking = false
          }
          return
        }
      }
      toast("Нет ответа ассистента для озвучки", "warning")
    }

    // Step announcements: while the agent works, speak short status phrases
    // ("сейчас подумаю", "читаю файл x"). Driven by session.* events (the TUI
    // bus does not forward message.part.*). The queue keeps only the newest
    // phrase — status should never stack up behind slow TTS.
    //
    // Priority: the final answer always wins. answerSpeaking latches while the
    // reply is playing; steps are muted and never call stopPlayback() during
    // it, otherwise a queued step's speak() would kill the reply mid-word and
    // the two would fight over the single `playback` handle.
    let stepSpeaking = false
    let stepQueued = null
    let answerSpeaking = false

    let stepShapeLogged = 0
    // The TUI event bus routes the session.* family but NOT message.part.*
    // (that one never fired). Use the direct session events instead:
    //   session.reasoning.started -> "Сейчас подумаю"
    //   session.tool.called       -> a phrase mapped from the tool name
    function logStepShape(tag, event) {
      if (stepShapeLogged >= 4) return
      stepShapeLogged++
      try {
        log(`steps: ${tag}#${stepShapeLogged} ${JSON.stringify(event)?.slice(0, 700)}`)
      } catch {
        log(`steps: ${tag}#${stepShapeLogged} keys=[${Object.keys(event ?? {}).join(",")}]`)
      }
    }

    function stepExtractTool(event) {
      const d = event?.data ?? event?.properties ?? event
      const input = d?.input ?? d?.args ?? d?.parameters ?? d?.toolInput ?? null
      return { d, input }
    }

    // session.tool.called carries NO tool-name field — only the input. Infer
    // the tool from the input's shape (matches this CLI's schemas). Order
    // matters: grep/glob carry `pattern` and must be matched BEFORE the bare
    // `path` (read) fallback, or a grep would be misread as a file read.
    function stepInferTool(input) {
      if (!input || typeof input !== "object") return null
      if ("command" in input) return "bash"
      if ("todos" in input) return "todowrite"
      if ("edits" in input) return "edit"
      if ("pattern" in input && ("path" in input || "file" in input || "directory" in input)) return "grep"
      if ("pattern" in input) return "glob"
      if ("content" in input && ("filePath" in input || "file_path" in input || "path" in input)) return "write"
      if ("filePath" in input || "file_path" in input) return "read"
      if ("query" in input || "topic" in input) return "websearch"
      if ("url" in input) return "webfetch"
      if ("prompt" in input && "description" in input) return "task"
      // read: this CLI's read tool passes a bare `path` (no filePath). It's the
      // dominant path-only tool, so treat any remaining path/file/offset shape
      // as a read. (ls also uses `path`, but is rare and harmless to voice as a
      // read — far better than dropping the step, which was the old bug.)
      if ("path" in input || "file" in input || "filename" in input || "offset" in input || "limit" in input) return "read"
      return null
    }

    function stepFileFrom(input) {
      if (!input || typeof input !== "object") return ""
      const raw = input.filePath ?? input.file_path ?? input.path ?? input.file ?? input.filename ?? ""
      return raw ? String(raw).split(/[\\/]/).pop() : ""
    }

    const STEP_TOOL_PHRASES = {
      read: (name) => name ? `Читаю файл ${name}` : "Читаю файлы",
      edit: (name) => name ? `Правлю файл ${name}` : "Правлю файлы",
      patch: (name) => name ? `Правлю файл ${name}` : "Правлю файлы",
      write: (name) => name ? `Записываю файл ${name}` : "Записываю файл",
      multiedit: (name) => name ? `Правлю файл ${name}` : "Правлю файлы",
      bash: () => "Выполняю команду",
      shell: () => "Выполняю команду",
      exec: () => "Выполняю команду",
      grep: () => "Ищу в файлах",
      glob: () => "Ищу файлы",
      ls: () => "Смотрю папку",
      webfetch: () => "Открываю страницу",
      websearch: () => "Ищу в интернете",
      task: () => "Запускаю подзадачу",
      agent: () => "Запускаю подзадачу",
      todowrite: () => "Обновляю список задач",
      todoread: () => "Смотрю список задач",
    }

    function announceStep(text) {
      if (!text) return
      if (answerSpeaking) return // the reply owns the speaker — mute status
      if (ackBusy) { stepQueued = text; return } // hold status until the ack finishes
      if (stepSpeaking) {
        stepQueued = text // newest wins — older status is stale
        return
      }
      stepSpeaking = true
      // A step announcement is always followed by more work/reply, so it must not
      // open the listen window — that produced a blip mid-turn.
      speak(text, { direct: true }).finally(() => {
        stepSpeaking = false
        // If the reply took the speaker while this step played (it killed our
        // sox), do NOT chain the queued phrase — that speak() would kill the
        // reply mid-word. Just drop it.
        if (answerSpeaking) { stepQueued = null; return }
        const next = stepQueued
        stepQueued = null
        if (next) announceStep(next)
      }).catch((e) => log(`step speak error: ${e?.message || e}`))
    }

    // Called when the final answer starts speaking: drop stale queued status.
    function dropStepQueue() {
      stepQueued = null
    }

    // In push-to-talk, stay silent while recording. In hands-free the mic is
    // ALWAYS armed (recording=true between segments), so only duck when the
    // user actually spoke very recently — otherwise the announcements would
    // be permanently muted in exactly the mode they're wanted most.
    function stepUserBusy() {
      if (hf.on) return vadSpeechSeen && Date.now() - vadLastSpeechAt < 1200
      return recording
    }

    // reasoning.started -> "Сейчас подумаю", at most once per thinking burst.
    let lastReasoningAt = 0
    const offReasoning = context.data.on("session.reasoning.started", (event) => {
      try {
        logStepShape("reasoning", event)
        if (!state.tts || !stepsTTS || dead) return
        if (stepUserBusy()) return
        const now = Date.now()
        if (now - lastReasoningAt < 2500) return // one phrase per thinking burst
        lastReasoningAt = now
        announceStep("Сейчас подумаю")
      } catch (e) {
        log(`steps: reasoning error: ${e?.message || e}`)
      }
    })

    // tool.called -> mapped phrase. Dedupe by tool call id.
    const stepSeenTools = new Set()
    const offTool = context.data.on("session.tool.called", (event) => {
      try {
        if (!state.tts || !stepsTTS || dead) return
        if (stepUserBusy()) return // the user is speaking — don't talk over them
        const { d, input } = stepExtractTool(event)
        const tool = stepInferTool(input)
        const phraseFn = tool ? STEP_TOOL_PHRASES[tool] : null
        // Log every event with the resolved phrase so a mis-mapping is visible,
        // not just the first4 raw shapes.
        const cid = d?.id ?? d?.callID ?? d?.toolCallID ?? `${d?.sessionID ?? ""}:${tool ?? "?"}`
        log(`steps: tool=${tool ?? "NONE"} phrase="${phraseFn ? phraseFn(stepFileFrom(input)) : "-"}" keys=[${input && typeof input === "object" ? Object.keys(input).join(",") : typeof input}] cid=${cid}`)
        if (!tool || !phraseFn) return
        if (stepSeenTools.size > 300) stepSeenTools.clear()
        if (cid && stepSeenTools.has(cid)) return
        if (cid) stepSeenTools.add(cid)
        announceStep(phraseFn(stepFileFrom(input)))
      } catch (e) {
        log(`steps: tool error: ${e?.message || e}`)
      }
    })

    async function onIdle(event) {
      if (!state.tts) return
      dropStepQueue() // the final answer supersedes any queued status phrase
      stopStreamPoll() // generation is over — the poller's own tick would also self-stop
      const sessionID = event?.data?.sessionID
      log(`tts: execution.succeeded, sessionID=${sessionID ?? "MISSING"}${sessionID ? "" : ` keys=${Object.keys(event ?? {}).join(",")}`}`)
      if (!sessionID) return
      if (sessionID !== currentSessionID()) return
      try {
        await context.data.session.message.sync(sessionID)
      } catch {}
      const list = context.data.session.message.list(sessionID) ?? []
      log(`tts: onIdle scan, ${list.length} msgs, lastSpoken=${lastSpoken ?? "none"}`)
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (m.type !== "assistant") continue
        if (m.id === lastSpoken) { log(`tts: skip ${m.id} (already spoken)`); return }
        let msg = m
        try {
          const res = await context.client.session.message.get({ sessionID, messageID: m.id })
          msg = res?.data ?? res ?? m
        } catch {}
        const parts = (msg.content ?? []).filter((p) => p.type === "text")
        log(`tts: assistant ${m.id}, ${parts.length} text parts, lens=[${parts.map((p) => (p.text || "").length).join(",")}]`)
        lastSpoken = m.id
        // Flush only what streaming hasn't spoken yet. Offsets are keyed by
        // MESSAGE id over the joined text — content parts carry no `id`, so a
        // part-keyed map shared one bucket across every reply and let stale
        // progress on an old message silence later, shorter ones.
        const joined = parts.map((p) => p.text || "").join("\n")
        const off = streamOffsets.get(m.id) ?? 0
        const rem = cleanForSpeech(joined.slice(off))
        log(`tts: flush msg=${m.id} off=${off} textLen=${joined.length} remLen=${rem.length} ansBusy=${ansBusy}`)
        if (rem) enqueueSpeech(rem)
        streamOffsets.set(m.id, joined.length) // fully consumed — never re-speak this reply
        // Clears the answerSpeaking latch once the queue drains.
        finalizeSpeech()
        return
      }
      log(`tts: no assistant message with text found`)
    }

    // Fired when an assistant turn completes in the server protocol.
    // (The previous "session.idle" event never existed — that's why auto-TTS
    // was silent.)
    const offIdle = context.data.on("session.execution.succeeded", (event) => {
      onIdle(event).catch((e) => log(`tts: onIdle ERROR: ${e?.stack || e?.message || e}`))
    })

    try {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "voice.record",
            title: "Голос: начать/остановить запись",
            bind: "ctrl+r",
            palette: true,
            slash: { name: "voice" },
            run() {
              log(`command voice.record triggered, recording=${recording}, hf=${hf.on}`)
              if (hf.on) {
                stopHandsFree()
                return
              }
              if (recording) stopAndTranscribe().catch((e) => log(`stopAndTranscribe error: ${e?.stack || e}`))
              else startRecording().catch((e) => log(`startRecording error: ${e?.stack || e}`))
            },
          },
          {
            // Ctrl+Alt+Space is the combo that survives RU layout and doesn't
            // collide with terminal/OS defaults (ctrl+alt+H arrives as a bare
            // backspace and never matches; ctrl+alt+Space delivers reliably).
            id: "voice.hf",
            title: `Голос: hands-free (пауза ${hfSilence} с → авто-отправка)`,
            bind: "ctrl+alt+space",
            palette: true,
            slash: { name: "voice-hf" },
            run: () => toggleHandsFree("ctrl+alt+space"),
          },
          {
            // RU-layout convenience alias: Alt+Р (Cyrillic Er on the physical
            // H position of ЙЦУКЕН). Hidden from the palette.
            id: "voice.hf3",
            bind: "alt+р",
            run: () => toggleHandsFree("alt+р"),
          },
          {
            id: "voice.tts",
            title: "Голос: вкл/выкл озвучку ответов",
            bind: "ctrl+alt+v",
            palette: true,
            slash: { name: "voice-tts" },
            run() {
              const next = !state.tts
              setState((draft) => { draft.tts = next })
              toast(next ? "Озвучка ответов: вкл" : "Озвучка ответов: выкл", "success")
            },
          },
          {
            id: "voice.speak",
            title: "Голос: озвучить последний ответ",
            palette: true,
            slash: { name: "voice-speak" },
            run() { speakLastResponse().catch(() => {}) },
          },
          {
            id: "voice.stop",
            title: "Голос: остановить озвучку",
            palette: true,
            slash: { name: "voice-stop" },
            run() {
              stopPlayback()
              toast("Озвучка остановлена", "info")
            },
          },
        ],
      }))
      log("keymap layer registered: ctrl+r=record, ctrl+alt+space=handsfree, ctrl+alt+v=tts")
      try {
        const ids = context.keymap.commands().map((c) => c.id)
        log(`prompt.paste registered: ${ids.includes("prompt.paste")}; total commands: ${ids.length}`)
      } catch (e) {
        log(`keymap.commands() failed: ${e?.message || e}`)
      }
    } catch (e) {
      log(`keymap.layer FAILED: ${e?.stack || e}`)
    }

    // Purge orphans: generations loaded by older plugin code have no `dead`
    // flag and would resurrect on their sox close event. Kill every sox.exe
    // while hf.on is still false, so their close handlers see auto=false and
    // terminate instead of re-arming. (Our own TUI setup time never has a
    // legit sox — the previous generation's cleanup killed its own.)
    try {
      const r = spawnSync("taskkill", ["/F", "/IM", "sox.exe"], { windowsHide: true, stdio: "ignore" })
      log(`purge: taskkill sox.exe status=${r.status}`)
    } catch (e) {
      log(`purge: ${e?.message || e}`)
    }

    // Auto-resume: if hands-free was on when the plugin hot-reloaded or the
    // TUI restarted, bring the mic back without asking. Flipping hf.on is
    // deferred so the async close events of the purged orphans observe
    // hf.on=false first and cannot respawn.
    if (state.hfWanted && !hf.on) {
      toast("Hands-free восстановлен", "info")
      setTimeout(() => {
        if (dead || !state.hfWanted) return
        setHf((d) => { d.on = true })
        startRecording({ hfMode: true }).catch((e) => log(`hf auto-start error: ${e?.message || e}`))
      }, 600)
    }

    // TEMP: test blip on every plugin load to verify playback path.
    setTimeout(() => playBlip(), 1000)

    return () => {
      log("cleanup: plugin deactivating")
      // Dead first — before killing sox. The close event fires asynchronously,
      // after this function returns; with dead=true the old handlers become
      // no-ops instead of resurrecting the generation (see `dead` above).
      dead = true
      // The shared piper outlives individual speak() calls on purpose, so it
      // MUST be reaped here or it survives as an orphan holding the voice model.
      killPersistentPiper()
      offIdle()
      try { offPart() } catch {}
      try { offExecFail() } catch {}
      try { offExecInt() } catch {}
      try { offExecStart() } catch {}
      try { offListen() } catch {}
      try { sseIter?.return?.() } catch {}
      sseSession = null
      try { offReasoning() } catch {}
      try { offTool() } catch {}
      try { stopStreamPoll() } catch {}
      try { cancelAnswer() } catch {}
      try { setHf((d) => { d.on = false }) } catch {}
      stopVad()
      releaseLive()
      if (soxProc) { try { soxProc.kill() } catch {} }
      stopPlayback()
    }
  },
})
