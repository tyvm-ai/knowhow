import type { KnowhowSimpleClient } from "../../KnowhowClient";
import type { AgentChannel } from "./AgentSession";
import { AgentFsChannel } from "./AgentFsChannel";
import { KnowhowWebChannel } from "./KnowhowWebChannel";

/** Remote task ids are UUIDs; local filesystem ids are timestamped slugs. */
export function isUuid(value: string | undefined): value is string {
  return (
    !!value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export interface AgentChannelsOptions {
  taskId: string;
  /** Create a NEW remote task from this chat message (unless syncFs forces fs-only). */
  messageId?: string;
  /** Existing remote task UUID. Never inferred from the local taskId. */
  remoteTaskId?: string;
  /** Force fs-only even if messageId is provided. */
  syncFs?: boolean;
  /** Push to the existing `remoteTaskId` (UUID) instead of creating one. */
  syncRemote?: boolean;
  client?: KnowhowSimpleClient;
  baseDir?: string;
  pollMs?: number;
}

/**
 * Channel selection (replaces SyncerService.createTask):
 *  - the filesystem channel is always present;
 *  - a messageId (and not syncFs) creates a fresh remote task;
 *  - otherwise syncRemote + a valid remote UUID attaches to that task.
 */
export function agentChannels(o: AgentChannelsOptions): AgentChannel[] {
  const channels: AgentChannel[] = [
    new AgentFsChannel({ taskId: o.taskId, baseDir: o.baseDir, pollMs: o.pollMs }),
  ];
  if (o.messageId && !o.syncFs) {
    channels.push(KnowhowWebChannel.create({ messageId: o.messageId, client: o.client }));
  } else if (o.syncRemote && !o.messageId && isUuid(o.remoteTaskId)) {
    channels.push(KnowhowWebChannel.existing(o.remoteTaskId, { client: o.client }));
  }
  return channels;
}
