# Modalities Manual Tests

Manual integration tests for audio, image, vision, and video generation across all supported AI providers.

## Overview

These tests exercise every output/input modality supported by each provider:

| Modality             | OpenAI       | Google             | XAI          |
|----------------------|--------------|--------------------|--------------|
| Audio Generation     | TTS-1 / TTS-1-HD | Gemini 2.0 Flash TTS | ❌ Not supported |
| Audio Transcription  | Whisper-1    | ❌ Not supported   | ❌ Not supported |
| Image Generation     | DALL-E 3     | Imagen 3 / Gemini 2.0 Flash | Aurora |
| Vision (image input) | GPT-4o       | Gemini 2.0 Flash   | Grok-2-Vision |
| Video Generation     | Sora (stub)  | Veo 2              | ❌ Not supported |

---

## Prerequisites

Set the appropriate API keys in your environment before running tests:

```bash
export OPENAI_KEY="sk-..."
export GEMINI_API_KEY="AIza..."
export XAI_API_KEY="xai-..."
```

---

## Running the Tests

### Run all modality tests

```bash
npx jest tests/manual/modalities --testTimeout=300000 --runInBand
```

> **`--runInBand`** is recommended so tests within a file run sequentially (some tests depend on outputs from prior tests in the same file).

### Run a single provider

```bash
# OpenAI only
npx jest tests/manual/modalities/openai.modalities.test.ts --testTimeout=120000 --runInBand

# Google only
npx jest tests/manual/modalities/google.modalities.test.ts --testTimeout=300000 --runInBand

# XAI only
npx jest tests/manual/modalities/xai.modalities.test.ts --testTimeout=120000 --runInBand
```

### Run a single test by name

```bash
npx jest tests/manual/modalities/openai.modalities.test.ts \
  --testNamePattern="DALL-E 3" \
  --testTimeout=60000
```

---

## Output Files

All generated artifacts are saved under `tests/manual/modalities/outputs/<provider>/` so they can be reviewed after the tests run.

### OpenAI (`outputs/openai/`)

| File | Test | Description |
|------|------|-------------|
| `tts-output.mp3` | Test 1 | TTS-1 generated speech audio |
| `transcription.json` | Test 2 | Whisper transcription of the TTS audio |
| `dalle3-output.png` | Test 3 | DALL-E 3 generated image |
| `dalle3-output-url.txt` | Test 3 | URL fallback if b64_json not returned |
| `vision-description.txt` | Test 4 | GPT-4o description of the DALL-E image |

### Google (`outputs/google/`)

| File | Test | Description |
|------|------|-------------|
| `tts-output.wav` | Test 1 | Gemini 2.0 Flash TTS audio |
| `gemini-flash-image.png` | Test 2 | Gemini 2.0 Flash inline image |
| `gemini-flash-image-url.txt` | Test 2 | URL fallback |
| `imagen3-output.png` | Test 3 | Imagen 3 generated image |
| `imagen3-output-url.txt` | Test 3 | URL fallback |
| `vision-description.txt` | Test 4 | Gemini description of the Imagen 3 image |
| `veo2-output.mp4` | Test 5 | Veo 2 generated video |
| `veo2-output-url.txt` | Test 5 | URL fallback |

### XAI (`outputs/xai/`)

| File | Test | Description |
|------|------|-------------|
| `aurora-output.png` | Test 1 | Aurora generated image |
| `aurora-output-url.txt` | Test 1 | URL fallback |
| `vision-description.txt` | Test 2 | Grok-2-Vision description of Aurora image |

---

## Test Dependency Order

Several tests depend on output from a previous test **within the same file**. Always run tests sequentially (`--runInBand`):

- **OpenAI**: Test 2 (Whisper) needs `tts-output.mp3` from Test 1
- **OpenAI**: Test 4 (Vision) needs `dalle3-output.png` from Test 3
- **Google**: Test 4 (Vision) needs `imagen3-output.png` from Test 3
- **XAI**: Test 2 (Vision) needs `aurora-output.png` from Test 1

If a dependency file is missing, the dependent test will be skipped with a clear log message.

---

## Provider Notes

### OpenAI

- **TTS models**: `tts-1` (faster, lower quality) and `tts-1-hd` (higher quality). Voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.
- **Whisper**: Supports `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`. Response formats: `json`, `text`, `srt`, `verbose_json`, `vtt`.
- **DALL-E 3**: Sizes `1024x1024`, `1792x1024`, `1024x1792`. Quality: `standard` or `hd`.
- **Sora**: Not yet implemented in the client. See Test 5 for the intended API.

### Google

- **Gemini TTS**: Uses `gemini-2.0-flash-preview-tts` model. Supports multi-speaker synthesis.
- **Gemini 2.0 Flash image**: Native inline image generation using the `gemini-2.0-flash-preview-image-generation` model.
- **Imagen 3**: High-quality image generation via the Vertex-style Gemini API.
- **Veo 2**: Video generation via `veo-2.0-generate-001`. Generation is asynchronous and polls for completion — allow up to 5 minutes.

### XAI

- **Aurora**: XAI's image generation model. Uses the OpenAI-compatible `/images/generations` endpoint.
- **Grok-2-Vision**: Vision model for image understanding (`grok-2-vision-1212`).
- **Audio**: XAI does not support audio generation or transcription. Tests 3 and 4 verify these throw errors.
- **Video**: XAI has no public video generation API yet. Test 5 is a documented placeholder.

---

## Adding New Tests

1. Create a new file: `tests/manual/modalities/<provider>.modalities.test.ts`
2. Save all outputs to `path.join(__dirname, "outputs", "<provider>", "<filename>")`
3. Guard each test with an API key check and skip gracefully if not set
4. Add `--runInBand` if tests depend on each other's outputs
5. Update this README with the new provider and output files

---

## Troubleshooting

**Tests time out**: Increase `--testTimeout`. Video generation (Veo 2) can take 2–5 minutes.

**"API key not set" skip**: Export the relevant environment variable before running.

**Dependency file missing**: Run tests in order with `--runInBand` rather than in parallel.

**TypeScript errors**: Run `npm run compile` from `packages/knowhow/` to check for type issues.
