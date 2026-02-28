import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { execAsync, ask } from "./utils";
import { convertToText, convertAudioToText } from "./conversion";

interface MicrophoneConfig {
  defaultMic: string | null;
  micCommand?: string;
}

const CONFIG_DIR = ".knowhow/tools/microphone";
const CONFIG_FILE = "config.json";
const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE);

function ensureConfigDirectoryExists() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readMicrophoneConfig(): MicrophoneConfig {
  ensureConfigDirectoryExists();
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig: MicrophoneConfig = { defaultMic: null };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  const configContent = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(configContent);
}

function writeMicrophoneConfig(config: MicrophoneConfig) {
  ensureConfigDirectoryExists();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getDefaultMic(): string | null {
  const config = readMicrophoneConfig();
  return config.defaultMic;
}

export function setDefaultMic(micName: string) {
  const config = readMicrophoneConfig();
  config.defaultMic = micName;
  writeMicrophoneConfig(config);
}

export function getMicCommand(): string | undefined {
  const config = readMicrophoneConfig();
  return config.micCommand;
}

export function setMicCommand(command: string) {
  const config = readMicrophoneConfig();
  config.micCommand = command;
  writeMicrophoneConfig(config);
}

export async function listMicrophones() {
  const regex = /\n\s{8}(\w.*):\n\n/gm;

  const output = await execAsync(
    `system_profiler SPAudioDataType | grep "Input Source: " -B 7 -A 1`
  );

  const matches = output.stdout.match(regex) || [];

  const options = matches.map((m) => m.trim().slice(0, -1));
  console.log({ options });

  return options;
}

// This isn't likely to work for everyone
export async function recordAudio() {
  const filePath = "/tmp/knowhow.wav";
  const audioFile = fs.createWriteStream(filePath, { encoding: "binary" });
  const defaultMic = getDefaultMic();
  const hasSox = await execAsync("which sox").catch(() => false);

  if (!hasSox && !defaultMic) {
    console.error("Sox is required to record audio");
    console.log(`
For Mac OS
brew install sox

For most linux disto's
sudo apt-get install sox libsox-fmt-all
`);
    process.exit(1);
  }

  if (!defaultMic) {
    const options = await listMicrophones();
    const mic = await ask(
      `Select a microphone (${options.join()})  : `,
      options
    );
    setDefaultMic(mic);
  }

  const currentDefaultMic = getDefaultMic();

  const defaultCommand = `sox -t coreaudio "$1" -r 16000 -c 1 /tmp/knowhow.wav`;
  const micCommand = getMicCommand();
  const defaulted = micCommand || defaultCommand;
  const recordCommand = defaulted.replace("$1", currentDefaultMic);

  if (!micCommand) {
    setMicCommand(defaultCommand);
  }

  const task = exec(recordCommand);

  return { stop: () => task.kill() };
}

export async function voiceToText() {
  // Allow user to type commands to exit voice mode or press Enter to record
  const startInput = await ask("Press Enter to Start Recording (or type a command to exit): ", []);
  
  // If user typed anything other than empty string, return it (e.g., /voice, /exit, etc.)
  if (startInput.trim() !== "") {
    return startInput;
  }
  
  const recording = await recordAudio();
  console.log("Recording audio...");
  
  const stopInput = await ask("Press Enter to Stop Recording (or type a command to cancel): ", []);
  recording.stop();
  console.log("Stopped recording");
  
  // If user typed anything during recording, return it instead of transcribing
  if (stopInput.trim() !== "") {
    return stopInput;
  }
  
  return convertAudioToText("/tmp/knowhow.wav", false);
}
