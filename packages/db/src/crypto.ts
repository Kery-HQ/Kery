import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SENSITIVE_KEYS = ["password", "token", "apiKey", "refresh_token", "secret"];

function getEncryptionKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return buf;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(encoded: string, key: Buffer): string {
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

/** Encrypt sensitive fields in a config object before DB storage */
export function encryptConfigJson(config: Record<string, any>): Record<string, any> {
  const key = getEncryptionKey();
  if (!key) return config; // No encryption key — store plaintext (backwards compatible)

  const result = { ...config };
  for (const k of SENSITIVE_KEYS) {
    if (typeof result[k] === "string" && result[k].length > 0) {
      result[k] = `enc:${encrypt(result[k], key)}`;
    }
  }
  return result;
}

/** Decrypt sensitive fields in a config object after DB read */
export function decryptConfigJson(config: Record<string, any>): Record<string, any> {
  const key = getEncryptionKey();
  if (!key) return config; // No encryption key — return as-is

  const result = { ...config };
  for (const k of SENSITIVE_KEYS) {
    if (typeof result[k] === "string" && result[k].startsWith("enc:")) {
      result[k] = decrypt(result[k].slice(4), key);
    }
  }
  return result;
}
