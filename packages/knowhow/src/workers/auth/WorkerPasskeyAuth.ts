import crypto from "crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

/**
 * Manages the locked/unlocked state of the worker's passkey auth.
 * When the worker has passkey configured, it starts locked.
 * The user must call `unlock` with a valid WebAuthn assertion to unlock.
 * The worker verifies the signature locally using the stored public key.
 */

export interface PasskeyConfig {
  publicKey: string;    // base64url-encoded COSE public key
  credentialId: string; // base64url-encoded credential ID
  algorithm: number;    // e.g. -7 for ES256
}

export interface UnlockParams {
  /** base64url-encoded signature from WebAuthn assertion */
  signature: string;
  /** base64url-encoded credential ID */
  credentialId: string;
  /** base64url-encoded authenticatorData */
  authenticatorData: string;
  /** base64url-encoded clientDataJSON */
  clientDataJSON: string;
  /** The challenge that was signed (base64url) */
  challenge: string;
}

export class WorkerPasskeyAuthService {
  private locked = true;
  private sessionExpiry: number | null = null;
  private sessionDurationMs: number;
  // Pending challenge: base64url
  private pendingChallenge: string | null = null;
  private pendingChallengeExpiry: number | null = null;
  private readonly CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private passkeyConfig: PasskeyConfig,
    sessionDurationHours: number = 3
  ) {
    this.sessionDurationMs = sessionDurationHours * 60 * 60 * 1000;
  }

  isLocked(): boolean {
    if (!this.locked) {
      // Check if session has expired
      if (this.sessionExpiry && Date.now() > this.sessionExpiry) {
        console.log("🔒 Passkey session expired, locking worker");
        this.locked = true;
        this.sessionExpiry = null;
      }
    }
    return this.locked;
  }

  /**
   * Generate a new challenge for the client to sign.
   * Returns base64url-encoded challenge bytes.
   */
  generateChallenge(): string {
    const challengeBytes = crypto.randomBytes(32);
    const challenge = challengeBytes.toString("base64url");
    this.pendingChallenge = challenge;
    this.pendingChallengeExpiry = Date.now() + this.CHALLENGE_TTL_MS;
    return challenge;
  }

  /**
   * Attempt to unlock the worker by verifying a WebAuthn assertion.
   * Returns true if the signature is valid and the worker is now unlocked.
   */
  async unlock(params: UnlockParams): Promise<{ success: boolean; reason?: string }> {
    // Verify the challenge matches what we issued
    if (!this.pendingChallenge) {
      return { success: false, reason: "No pending challenge. Call getChallenge first." };
    }
    if (this.pendingChallengeExpiry && Date.now() > this.pendingChallengeExpiry) {
      this.pendingChallenge = null;
      this.pendingChallengeExpiry = null;
      return { success: false, reason: "Challenge expired. Please request a new challenge." };
    }

    // Verify the challenge in clientDataJSON matches our pending challenge
    let clientData: { type: string; challenge: string; origin: string };
    try {
      const clientDataBytes = Buffer.from(params.clientDataJSON, "base64url");
      clientData = JSON.parse(clientDataBytes.toString("utf8"));
    } catch {
      return { success: false, reason: "Invalid clientDataJSON" };
    }

    // The challenge in clientDataJSON is base64url-encoded
    if (clientData.challenge !== this.pendingChallenge) {
      return { success: false, reason: "Challenge mismatch" };
    }

    if (clientData.type !== "webauthn.get") {
      return { success: false, reason: "Invalid clientData type" };
    }

    // Verify credential ID matches our stored credential
    if (params.credentialId !== this.passkeyConfig.credentialId) {
      return { success: false, reason: "Unknown credential" };
    }

    // Verify the signature using @simplewebauthn/server
    const valid = await this.verifySignature(params, clientData.origin);
    if (!valid) {
      return { success: false, reason: "Invalid signature" };
    }

    // Unlock!
    this.locked = false;
    this.sessionExpiry = Date.now() + this.sessionDurationMs;
    this.pendingChallenge = null;
    this.pendingChallengeExpiry = null;

    const expiresAt = new Date(this.sessionExpiry).toISOString();
    console.log(`🔓 Worker unlocked! Session expires at ${expiresAt}`);
    return { success: true };
  }

  lock(): void {
    this.locked = true;
    this.sessionExpiry = null;
    this.pendingChallenge = null;
    this.pendingChallengeExpiry = null;
    console.log("🔒 Worker locked");
  }

  getSessionInfo() {
    if (this.locked || !this.sessionExpiry) {
      return { locked: true, expiresAt: null };
    }
    return {
      locked: false,
      expiresAt: new Date(this.sessionExpiry).toISOString(),
    };
  }

  /**
   * Returns the credential ID stored in the passkey config.
   */
  getCredentialId(): string {
    return this.passkeyConfig.credentialId;
  }

  // ---------------------------------------------------------------------------
  // Signature verification via @simplewebauthn/server
  // ---------------------------------------------------------------------------

  /**
   * Verify a WebAuthn assertion using @simplewebauthn/server's verifyAuthenticationResponse.
   * This handles all COSE key format complexity automatically.
   */
  private async verifySignature(params: UnlockParams, origin: string): Promise<boolean> {
    try {
      const { verified } = await verifyAuthenticationResponse({
        response: {
          id: params.credentialId,
          rawId: params.credentialId,
          response: {
            authenticatorData: params.authenticatorData,
            clientDataJSON: params.clientDataJSON,
            signature: params.signature,
          },
          type: "public-key",
          clientExtensionResults: {},
        },
        expectedChallenge: this.pendingChallenge!,
        expectedOrigin: origin,
        expectedRPID: new URL(origin).hostname,
        credential: {
          id: this.passkeyConfig.credentialId,
          publicKey: Buffer.from(this.passkeyConfig.publicKey, "base64url"),
          counter: 0,
          transports: undefined,
        },
        requireUserVerification: false,
      });

      return verified;
    } catch (err) {
      console.error("Signature verification error:", err);
      return false;
    }
  }
}
