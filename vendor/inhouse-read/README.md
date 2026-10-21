# Inhouse Read voices reused in Learn

Source: https://github.com/miguelcoxcaballero/inhouse-read
Revision: `422d6ab67e03efa7f01b904a5bc90f428653bc25`.

The six `neural-voice` modules are copied from `src/js/readers/neural-voice/`,
with only the relative Rust-loader import adapted. `rust-loader.js` is copied
unchanged; `rust-voice-core.js` uses the static asset URL instead of Vite.
`language-detect.js` is the source repository's frozen reference implementation
(`tests/unit/helpers/reference-language-detect.js`), with the two language-tag
helpers inlined. It preserves the stop-word, script and per-sentence detection.

The voices and names are the same immutable Supertonic 3 pack, including Lucy
(`F5`, English) and Carmen (`F2`, Spanish). The source's quantized vector estimator,
six-step inference, Rust text preparation, tempo and PCM finishing are retained.
Weight hashes/sizes are checked before caching; model licenses are in `licenses/`.

`inhouse_read_voice.wasm` is built from that revision's `rust-core` with Rust
1.99.1, target `wasm32-unknown-unknown`, `cargo build --release --locked
--no-default-features --features voice`, and
`RUSTFLAGS='-C link-arg=-zstack-size=65536'`. No updater files are copied or changed.

The three ONNX Runtime web files are the npm `onnxruntime-web@1.30.0/dist/`
WASM-only runtime and matching module/binary. Its MIT license is included.

Learn supplies its own small worker, verified download cache and chat playback
controls. No account, remote synthesis endpoint or device speech engine is used.
