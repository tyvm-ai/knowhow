/**
 * Deprecated shim: the fs / web watchers are now MirrorAgentWatcher subclasses
 * (stateful/agent/agentMirror.ts) over ProcessMirror + agentProjection.
 */
export {
  FsSyncedAgentWatcher,
  WebSyncedAgentWatcher,
} from "../stateful/agent/agentMirror";
