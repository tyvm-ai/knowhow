import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MlxSpeechOutput } from "../src/mlxSpeech";

async function executable(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("MlxSpeechOutput", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mlx-speech-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("synthesizes with MLX-Audio arguments and plays the joined WAV", async () => {
    const argsFile = join(directory, "args.txt");
    const playedFile = join(directory, "played.txt");
    const python = await executable(join(directory, "python"), `
      printf '%s\\n' "$@" > "${argsFile}"
      while [ "$#" -gt 0 ]; do
        if [ "$1" = "--output_path" ]; then shift; output="$1"; fi
        shift
      done
      printf RIFF > "$output/speech.wav"
    `);
    const player = await executable(join(directory, "player"), `printf '%s' "$1" > "${playedFile}"`);
    const speech = new MlxSpeechOutput({
      python,
      player,
      model: "/models/Kokoro-82M-bf16",
      voice: "af_heart",
      speed: 1.1,
    });

    const handle = await speech.play("Hello locally", {
      generationId: "generation-1",
      signal: new AbortController().signal,
    });

    await expect(handle.done).resolves.toEqual(expect.objectContaining({
      text: "Hello locally",
      completed: true,
    }));
    await expect(require("fs/promises").readFile(argsFile, "utf8")).resolves.toContain("Hello locally");
    await expect(require("fs/promises").readFile(argsFile, "utf8")).resolves.toContain("af_heart");
    await expect(require("fs/promises").readFile(playedFile, "utf8")).resolves.toMatch(/speech\.wav$/);
    await speech.close();
  });

  test("rejects when synthesis does not produce audio", async () => {
    const python = await executable(join(directory, "python"), "exit 0");
    const player = await executable(join(directory, "player"), "exit 0");
    const speech = new MlxSpeechOutput({ python, player, model: "model" });
    const handle = await speech.play("No output", {
      generationId: "generation-2",
      signal: new AbortController().signal,
    });

    await expect(handle.done).rejects.toThrow("did not create the expected audio file");
  });

  test("stops synthesis during barge-in", async () => {
    const python = await executable(join(directory, "python"), "exec sleep 30");
    const player = await executable(join(directory, "player"), "exit 0");
    const speech = new MlxSpeechOutput({ python, player, model: "model" });
    const controller = new AbortController();
    const handle = await speech.play("Interrupted", {
      generationId: "generation-3",
      signal: controller.signal,
    });

    controller.abort();

    await expect(handle.done).resolves.toEqual(expect.objectContaining({
      text: "Interrupted",
      completed: false,
    }));
    await speech.close();
  });
});
