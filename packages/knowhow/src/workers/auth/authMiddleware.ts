import { WebSocket } from "ws";
import { WorkerPasskeyAuthService } from "./WorkerPasskeyAuth";
import { WsMiddlewareFn } from "./WsMiddleware";

/**
 * WebSocket middleware that gates all messages behind passkey auth.
 *
 * This middleware is applied to the TUNNEL WebSocket only — NOT the worker
 * MCP WebSocket. The MCP path keeps the existing unlock/lock tool-based approach.
 *
 * Auth protocol (out-of-band, not MCP):
 *
 *   Client → Worker:  { type: "auth:getChallenge" }
 *   Worker → Client:  { type: "auth:challenge", challenge: "<base64url>", credentialId: "..." }
 *   Client → Worker:  { type: "auth:response", challenge, signature, credentialId,
 *                        authenticatorData, clientDataJSON }
 *   Worker → Client:  { type: "auth:success", expiresAt: "<iso>" }
 *                  or { type: "auth:failure", reason: "..." }
 *
 * While locked, all non-auth messages receive { type: "auth:locked" }.
 * Once unlocked, isLocked() is re-checked on every message to enforce session expiry.
 *
 * The authService passed here is the SAME singleton used by the MCP unlock tool,
 * so unlocking via either path opens both the tunnel and MCP tool access.
 */
export function makeAuthMiddleware(
  authService: WorkerPasskeyAuthService
): WsMiddlewareFn {
  return async (ws: WebSocket, data: Buffer | string, next) => {
    // Re-check on every message to enforce session expiry
    if (!authService.isLocked()) {
      return next();
    }

    // Parse the raw message
    let parsed: any;
    try {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      parsed = JSON.parse(raw);
    } catch {
      ws.send(
        JSON.stringify({
          type: "auth:locked",
          message: "Worker is locked. Send { type: 'auth:getChallenge' } first.",
        })
      );
      return; // don't call next()
    }

    // auth:getChallenge — issue a challenge
    if (parsed.type === "auth:getChallenge") {
      const challenge = authService.generateChallenge();
      ws.send(
        JSON.stringify({
          type: "auth:challenge",
          challenge,
          credentialId: authService.getCredentialId(),
          timestamp: Math.floor(Date.now() / 1000),
        })
      );
      return;
    }

    // auth:response — verify the assertion
    if (parsed.type === "auth:response") {
      const result = await authService.unlock({
        signature: parsed.signature,
        credentialId: parsed.credentialId,
        authenticatorData: parsed.authenticatorData,
        clientDataJSON: parsed.clientDataJSON,
        challenge: parsed.challenge,
      });

      if (result.success) {
        const info = authService.getSessionInfo();
        ws.send(
          JSON.stringify({
            type: "auth:success",
            expiresAt: info.expiresAt,
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "auth:failure",
            reason: result.reason ?? "unknown",
          })
        );
      }
      // Auth protocol message — don't pass to tunnel handler
      return;
    }

    // Any other message while locked — block it
    ws.send(
      JSON.stringify({
        type: "auth:locked",
        message:
          "Worker is locked. Send { type: 'auth:getChallenge' } to authenticate.",
      })
    );
    // don't call next()
  };
}
