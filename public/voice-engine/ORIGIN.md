# Vendored sherpa-onnx WebAssembly engine

These two files are redistributed unchanged, byte for byte, as part of
StaySee's on-device Russian voice dictation. They are served from
`/voice-engine/` and loaded by `src/lib/voiceRecognitionWorker.ts`, in this
order: `sherpa-onnx-asr.js` first (it defines `createOnlineRecognizer`),
then `sherpa-onnx-wasm-main-asr.js` (the Emscripten runtime, which reads
the `Module` object the worker has already placed on the global scope).

| File | Bytes | Source |
| --- | --- | --- |
| `sherpa-onnx-asr.js` | 41274 | k2-fsa/sherpa-onnx v1.12.20, WebAssembly ASR JavaScript wrapper |
| `sherpa-onnx-wasm-main-asr.js` | 92139 | k2-fsa/sherpa-onnx v1.12.20, Emscripten glue for the SIMD WASM ASR build |

Engine: https://github.com/k2-fsa/sherpa-onnx — Apache License 2.0.
Model (downloaded at runtime, not stored here): `alphacep/vosk-model-streaming-ru`,
revision `83bbf6f`, Large INT8 variant — Apache License 2.0.

Apache 2.0 requires that this attribution travel with the redistributed
files. The user-facing licence notice is added by the chat-integration plan
(Part 2); this file is the in-repository record.

Do not edit, minify, reformat or lint these two files. Replacing them means
a new engine build: update the byte counts here and in
`scripts/verify-prod-bundle.mjs`, and re-run the recognition comparison
described in the design document before shipping.
