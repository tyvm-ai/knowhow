/**
 * Auth message types for the worker WebSocket authentication protocol.
 */

// Worker → Client: challenge
export interface AuthChallengeMessage {
  type: "auth:challenge";
  challenge: string;   // base64-encoded 32 random bytes
  timestamp: number;   // epoch seconds
}

// Client → Worker: response
export interface AuthResponseMessage {
  type: "auth:response";
  challenge: string;            // echo back
  signature: string;            // base64-encoded WebAuthn assertion signature
  credentialId: string;         // base64-encoded credential ID
  authenticatorData: string;    // base64-encoded authenticator data
  clientDataJSON: string;       // base64-encoded client data JSON
}

// Worker → Client: success
export interface AuthSuccessMessage {
  type: "auth:success";
  token: string;       // opaque session token
  expiresAt: number;   // epoch seconds
}

// Worker → Client: failure
export interface AuthFailureMessage {
  type: "auth:failure";
  reason: "invalid_signature" | "expired" | "unknown_credential";
}

export type AuthMessage =
  | AuthChallengeMessage
  | AuthResponseMessage
  | AuthSuccessMessage
  | AuthFailureMessage;

// Passkey credential stored in config
export interface PasskeyCredential {
  publicKey: string;     // base64-encoded public key
  credentialId: string;  // base64-encoded credential ID
  algorithm: string;     // e.g. "ES256"
}

// Setup session returned by knowhow-web
export interface PasskeySetupSession {
  sessionId: string;
  browserUrl: string;
}

// Status of a passkey setup session
export interface PasskeySetupStatus {
  status: "pending" | "complete" | "expired";
  credential?: PasskeyCredential;
}
