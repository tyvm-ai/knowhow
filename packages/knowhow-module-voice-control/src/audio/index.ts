/**
 * Continuous capture, split by concern:
 *
 *   types           PcmFrame, ContinuousAudioBackend, UtteranceRecognizer, options, diagnostics
 *   vad             frame RMS + ambient noise-floor summary (pure)
 *   wav             PCM → WAV encoding (pure)
 *   transcriptText  "is this a meaningful utterance?" / recogniser-artifact stripping (pure)
 *   eventQueue      async event queue + abort helpers
 *   source          ContinuousTranscriptSource — the VAD/endpointing/wake-word loop
 *   sox             SoxAudioBackend (microphone capture through SoX)
 *   recognizer      CommandUtteranceRecognizer (whisper-cli etc.)
 *   preflight       `--preflight` checks
 */

export * from "./types";
export * from "./vad";
export * from "./wav";
export * from "./transcriptText";
export * from "./eventQueue";
export * from "./source";
export * from "./sox";
export * from "./recognizer";
export * from "./preflight";
