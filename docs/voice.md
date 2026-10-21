# Dictation and read-aloud

Both features run locally and require no account or API key. The first use
downloads weights over HTTPS; audio/text is never sent to a speech service.
Only the final transcript is sent through the existing chat model when requested.
Settings stay in this browser, outside chat/Drive snapshots.

## Dictation

Tap the microphone to configure/activate, then tap again to record. Tap **Revisar**
to put the transcript in the draft, or the send arrow to transcribe and send.
The initial draft is preserved. Messages are limited to five minutes and 25 MB.
Whisper base (default, about 77 MB), tiny (about 42 MB) and small (about 250 MB)
use pinned multilingual model revisions. The shared runtime is about 22 MB.
The default language is Spanish; automatic detection is available.

Inference runs in a cancellable worker. A failed load retains the recording in
memory for retry. Changing chats/cancelling destroys the worker and ignores stale
results. Leaving the app stops recording and prepares text for review, never
automatic sending. Android requires APK 1.0.3+ for runtime microphone permission.

## Reading

Use **Escuchar** below a tutor response. Profile → **Voces de lectura** selects a
voice for each language and playback speed. Automatic language selection runs per
sentence, with an optional manual override. Defaults: Spanish Carmen, English Lucy.
The exact Supertonic 3 voices and inference/PCM engine come from Inhouse Read;
see `vendor/inhouse-read/README.md`. Model pack ~210 MB, runtime ~15 MB, all cached.
The player prepares two chunks before starting and keeps up to three queued,
scheduling successive chunks on the audio clock. Slow devices may still underrun.
Pause/resume/stop work during loading and playback. Only one speech task runs:
dictation stops playback, and playback cancels dictation.

Models stay in browser Cache Storage until the browser/site data is cleared.
Runtime and page assets use HTTP caching; this is not a full offline web shell.
On-device latency and accuracy depend on hardware, noise and chosen model.

## Verification

Serve the repository on port 8765. `node tests/web/voice.cjs` exercises real browser
recording with controlled recognition/synthesis results, cancellation, retry,
send-once, voice defaults, language switching, pause and mobile layout.
`node tests/web/voice-real.cjs` is opt-in: downloads real models (~310 MB), runs
Carmen and Lucy through the real worker/ONNX/Rust engine, and transcribes generated
Spanish PCM with Whisper base. It is an integration smoke test, not a microphone
accuracy benchmark or a guarantee of physical-phone performance.
