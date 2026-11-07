import type { KnowhowSimpleClient } from "../../KnowhowClient";
import type { AgentChannel } from "./AgentSession";
import { AgentFsChannel } from "./AgentFsChannel";
import { KnowhowWebChannel } from "./KnowhowWebChannel";
import { WorkingSetSyncChannel } from "./WorkingSetSyncChannel";

/** Remote task ids are UUIDs; local filesystem ids are timestamped slugs. */
export function isUuid(value: string | undefined): value is string {
  return (
    !!value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export interface AgentChannelsOptions {
  taskId: string;
  /** Create a NEW remote task from this chat message. */
  messageId?: string;
  /** Existing remote task UUID. Never inferred from the local taskId. */
  remoteTaskId?: string;
  /** Remote message id recorded as a link when attaching to `remoteTaskId`. */
  remoteMessageId?: string;
  /**
   * Filesystem sync flag. The fs channel is always present, so this no longer
   * changes channel selection. It used to force fs-only when a messageId was
   * also given, which silently dropped remote sync for subagents started with
   * `{ messageId, syncFs: true }` (their tasks never appeared on the message).
   */
  syncFs?: boolean;
  /** Push to the existing `remoteTaskId` (UUID) instead of creating one. */
  syncRemote?: boolean;
  /**
   * Remote task (UUID) of the agent that spawned this one. With a messageId the
   * new remote task is created as its child (backend `parentTaskId`), so the
   * parent can find / message it and the child's replyToParent reaches it.
   */
  parentRemoteTaskId?: string;
  client?: KnowhowSimpleClient;
  baseDir?: string;
  pollMs?: number;
}

/**
 * Channel selection (replaces SyncerService.createTask):
 *  - the filesystem channel is always present;
 *  - a messageId creates a fresh remote task (syncFs does not suppress it);
 *  - otherwise syncRemote + a valid remote UUID attaches to that task.
 */
export function agentChannels(o: AgentChannelsOptions): AgentChannel[] {
  const channels: AgentChannel[] = [
    new AgentFsChannel({ taskId: o.taskId, baseDir: o.baseDir, pollMs: o.pollMs }),
  ];
  if (o.messageId) {
    const parent = o.parentRemoteTaskId?.replace(/^remote:/i, "");
    channels.push(KnowhowWebChannel.create({
      messageId: o.messageId,
      client: o.client,
      ...(isUuid(parent) ? { parentTaskId: parent } : {}),
    }));
  } else if (o.syncRemote && !o.messageId && isUuid(o.remoteTaskId)) {
    channels.push(KnowhowWebChannel.existing(o.remoteTaskId, {
        client: o.client,
        remoteMessageId: o.remoteMessageId,
      }));
  }
  // working-set auto-sync rides along with every remote-synced task
  // (a no-op outside git repos / when disabled; see WorkingSetSync.ts)
  if (channels.some((c) => c.id === "web")) {
    channels.push(new WorkingSetSyncChannel({ client: o.client, baseDir: o.baseDir }));
  }
  return channels;
}
