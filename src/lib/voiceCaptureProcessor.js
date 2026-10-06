/**
 * AudioWorkletProcessor for StaySee on-device voice dictation.
 *
 * Replaces the prototype's deprecated ScriptProcessorNode, which ran its
 * callback on the main thread and so competed with React rendering.
 *
 * Deliberately mechanical: it accumulates the render quanta the audio
 * thread hands it into 4096-frame blocks -- the same block size the
 * prototype used, and about 85 ms at 48 kHz, instead of 128 frames every
 * 2.7 ms -- and posts each full block to the main thread with its buffer
 * transferred. It measures nothing, decides nothing and keeps no history.
 *
 * Not type-checked (tsconfig.app.json has no allowJs) and not linted
 * (eslint.config.js covers only .ts/.tsx). Verified by `node --check`,
 * by src/lib/localVoiceDictation.cases.test.ts through the injected
 * AudioContext fake, and by scripts/verify-prod-bundle.mjs in the build.
 */
const CAPTURE_BLOCK_FRAMES = 4096;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(CAPTURE_BLOCK_FRAMES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.block[this.filled] = channel[index];
      this.filled += 1;
      if (this.filled === CAPTURE_BLOCK_FRAMES) {
        const full = this.block;
        this.block = new Float32Array(CAPTURE_BLOCK_FRAMES);
        this.filled = 0;
        this.port.postMessage(full, [full.buffer]);
      }
    }
    // The output buffer is left untouched, so this node is silent and
    // connecting it to the destination causes no echo. Returning true keeps
    // the processor alive for as long as the node is connected.
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
