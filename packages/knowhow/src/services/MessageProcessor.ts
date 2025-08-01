import { Message } from "../clients/types";

export type ProcessorLifecycle =
  | "initial_call"
  | "pre_call"
  | "post_call"
  | "per_tool"
  | "post_tools";

export type MessageProcessorFunction = (
  originalMessages: Message[],
  modifiedMessages: Message[]
) => Promise<void> | void;

export interface ProcessorRegistration {
  processor: MessageProcessorFunction;
  priority: number;
}

export class MessageProcessor {
  private processors: Map<ProcessorLifecycle, ProcessorRegistration[]> =
    new Map();

  constructor() {
    // Initialize lifecycle maps
    this.clearProcessors();
  }

  setProcessors(
    lifecycle: ProcessorLifecycle,
    processors: MessageProcessorFunction[]
  ): void {
    const registrations: ProcessorRegistration[] = processors.map((proc) => ({
      processor: proc,
      priority: 0, // Default priority
    }));

    // Sort by priority (higher priority first)
    registrations.sort((a, b) => b.priority - a.priority);

    this.processors.set(lifecycle, registrations);
  }

  registerProcessor(
    lifecycle: ProcessorLifecycle,
    processor: MessageProcessorFunction,
    priority: number = 0
  ): void {
    const registrations = this.processors.get(lifecycle) || [];
    registrations.push({ processor, priority });

    // Sort by priority (higher priority first)
    registrations.sort((a, b) => b.priority - a.priority);

    this.processors.set(lifecycle, registrations);
  }

  removeProcessor(
    lifecycle: ProcessorLifecycle,
    processor: MessageProcessorFunction
  ): void {
    const registrations = this.processors.get(lifecycle) || [];
    const filtered = registrations.filter((reg) => reg.processor !== processor);
    this.processors.set(lifecycle, filtered);
  }

  async processMessages(
    messages: Message[],
    lifecycle: ProcessorLifecycle
  ): Promise<Message[]> {
    const registrations = this.processors.get(lifecycle) || [];

    if (registrations.length === 0) {
      return messages;
    }

    // Create a deep copy of the messages to avoid modifying the original
    const modifiedMessages = JSON.parse(JSON.stringify(messages));

    // Execute processors in priority order
    for (const registration of registrations) {
      try {
        await registration.processor(messages, modifiedMessages);
      } catch (error) {
        console.error(`Message processor error in ${lifecycle}:`, error);
        // Continue with other processors even if one fails
      }
    }

    return modifiedMessages;
  }

  getProcessorsForLifecycle(
    lifecycle: ProcessorLifecycle
  ): MessageProcessorFunction[] {
    const registrations = this.processors.get(lifecycle) || [];
    return registrations.map((reg) => reg.processor);
  }

  clearProcessors(lifecycle?: ProcessorLifecycle): void {
    if (lifecycle) {
      this.processors.set(lifecycle, []);
    } else {
      this.processors.clear();
      this.processors.set("initial_call", []);
      this.processors.set("pre_call", []);
      this.processors.set("post_call", []);
      this.processors.set("per_tool", []);
      this.processors.set("post_tools", []);
    }
  }
}
