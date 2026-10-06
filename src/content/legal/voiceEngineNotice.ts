/**
 * Attribution for the two Apache-2.0 components behind on-device voice
 * dictation, as the licence requires when they are redistributed.
 *
 * The in-repository record is `public/voice-engine/ORIGIN.md`; this file is
 * the user-facing half of it, rendered in the Конфиденциальность screen.
 * If either component is ever replaced, update both files and the byte
 * counts in `scripts/verify-prod-bundle.mjs` together.
 */

export interface VoiceEngineCredit {
  title: string;
  detail: string;
  licence: string;
  url: string;
}

export const VOICE_ENGINE_NOTICE_TITLE = 'Распознавание речи на устройстве';

export const VOICE_ENGINE_NOTICE_BODY =
  'Речь распознаётся прямо в браузере, на твоём устройстве. Аудио не отправляется ни на какой сервер — ни наш, ни чужой. Для этого один раз скачивается голосовой пакет; он хранится в браузере отдельно от аккаунта, бесед и памяти.';

export const VOICE_ENGINE_CREDITS: VoiceEngineCredit[] = [
  {
    title: 'Модель распознавания речи',
    detail: 'alphacep/vosk-model-streaming-ru, ревизия 83bbf6f, вариант Large INT8',
    licence: 'Apache License 2.0',
    url: 'https://huggingface.co/alphacep/vosk-model-streaming-ru',
  },
  {
    title: 'Движок распознавания',
    detail: 'k2-fsa/sherpa-onnx v1.12.20, сборка WebAssembly SIMD',
    licence: 'Apache License 2.0',
    url: 'https://github.com/k2-fsa/sherpa-onnx',
  },
];

export const VOICE_ENGINE_LICENCE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

export const VOICE_ENGINE_LICENCE_NOTE =
  'Оба компонента распространяются по лицензии Apache License 2.0 и используются без изменений. Полный текст лицензии: apache.org/licenses/LICENSE-2.0';
