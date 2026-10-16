import { OpenAIUtteranceRecognizer } from "../src/adapters";

describe("OpenAIUtteranceRecognizer", () => {
  test("uses the configured OpenAI client with an in-memory WAV", async () => {
    const createAudioTranscription = jest.fn().mockResolvedValue({ text: "  hello voice  " });
    const recognizer = new OpenAIUtteranceRecognizer(
      { createAudioTranscription },
      "whisper-1",
      "Hey Knowhow."
    );
    const signal = new AbortController().signal;

    await expect(recognizer.recognize(Buffer.from("RIFF"), signal)).resolves.toBe(
      "hello voice"
    );
    expect(createAudioTranscription).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        file: Buffer.from("RIFF"),
        fileName: expect.stringMatching(/^knowhow-voice-.*\.wav$/),
        model: "whisper-1",
        prompt: "Hey Knowhow.",
        signal,
      })
    );
  });

  test("explains remote transcription configuration failures", async () => {
    const recognizer = new OpenAIUtteranceRecognizer({
      createAudioTranscription: jest.fn().mockRejectedValue(new Error("missing key")),
    });

    await expect(
      recognizer.recognize(Buffer.from("RIFF"), new AbortController().signal)
    ).rejects.toThrow("Configure an OpenAI client/API key");
  });
});
