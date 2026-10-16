import { Command } from "commander";
import voiceControlModule from "../src";

describe("voice control module", () => {
  test("registers voice-agent and voice-control idempotently", async () => {
    const program = new Command();
    const params: any = {
      config: {},
      cwd: process.cwd(),
      context: { Program: program } as any,
    };

    await voiceControlModule.register?.(params);
    await voiceControlModule.register?.(params);
    await voiceControlModule.init(params);

    const commands = program.commands.filter((command) => command.name() === "voice-agent");
    expect(commands).toHaveLength(1);
    const eyeCommands = program.commands.filter((command) => command.name() === "eye-tracking");
    expect(eyeCommands).toHaveLength(1);
    expect(eyeCommands[0].alias()).toBe("gaze-control");
    expect(eyeCommands[0].getOptionValue("port")).toBe("7465");
    expect(eyeCommands[0].options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--port", "--host", "--model", "--no-open", "--json"])
    );
    expect(commands[0].alias()).toBe("voice-control");
    expect(commands[0].getOptionValue("agent")).toBe("ComputerUseAgent");
    expect(commands[0].getOptionValue("wakeWord")).toBe("hey knowhow");
    expect(commands[0].getOptionValue("wakeWindowMs")).toBe("30000");
    expect(commands[0].options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--agent",
        "--model",
        "--provider",
        "--once",
        "--text",
        "--continuous",
        "--wake-word",
        "--wake-window-ms",
        "--local-stt-command",
        "--local-stt-model",
        "--device",
        "--vad-threshold",
        "--vad-silence-ms",
        "--speak",
        "--tts",
        "--tts-model",
        "--tts-voice",
        "--tts-python",
        "--tts-speed",
        "--json",
        "--preflight",
      ])
    );
  });

  test("uses voice-control TTS configuration as CLI defaults", async () => {
    const program = new Command();
    await voiceControlModule.register?.({
      config: {
        voiceControl: {
          tts: {
            provider: "mlx",
            model: "/models/kokoro",
            voice: "af_bella",
            python: "/venv/bin/python",
            speed: 1.2,
          },
          eyeTracking: {
            port: 8123,
            host: "localhost",
            model: "/models/face.task",
          },
        },
      } as any,
      cwd: process.cwd(),
      context: { Program: program },
    } as any);

    const command = program.commands.find((entry) => entry.name() === "voice-agent") as any;
    expect(command.getOptionValue("tts")).toBe("mlx");
    expect(command.getOptionValue("ttsModel")).toBe("/models/kokoro");
    expect(command.getOptionValue("ttsVoice")).toBe("af_bella");
    expect(command.getOptionValue("ttsPython")).toBe("/venv/bin/python");
    expect(command.getOptionValue("ttsSpeed")).toBe("1.2");
    const eye = program.commands.find((entry) => entry.name() === "eye-tracking") as any;
    expect(eye.getOptionValue("port")).toBe("8123");
    expect(eye.getOptionValue("host")).toBe("localhost");
    expect(eye.getOptionValue("model")).toBe("/models/face.task");
  });
});
