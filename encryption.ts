import { ENCRYPTION_VALIDATION_IV, ENCRYPTION_VALIDATION_PAYLOAD } from "./constants";

export type DerivedKey = CryptoKey | null;

/**
 * Derives an AES-GCM key from a password using PBKDF2.
 */
export async function deriveEncryptionKey(password: string): Promise<DerivedKey> {
  if (!password) {
    return null;
  }
  try {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, [
      "deriveBits",
      "deriveKey",
    ]);

    const salt = encoder.encode("FastSyncSalt_v1");

    return await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 150000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    console.error("Failed to derive encryption key:", error);

    throw new Error("Failed to initialize encryption. Check password or browser support.");
  }
}

/**
 * Encrypts text using AES-GCM with a derived key and a **random IV**.
 * Prepends the IV to the ciphertext. Used for general file content.
 */
export async function encryptText(text: string, encryptionKey: DerivedKey): Promise<string> {
  if (!encryptionKey) throw new Error("Encryption key is not available.");
  if (text === null || text === undefined) throw new Error("Cannot encrypt null or undefined text.");

  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encodedText = encoder.encode(text);

    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, encryptionKey, encodedText);

    const encryptedArray = new Uint8Array(encrypted);

    const combinedArray = new Uint8Array(iv.length + encryptedArray.length);
    combinedArray.set(iv, 0);
    combinedArray.set(encryptedArray, iv.length);

    return btoa(
      Array.from(combinedArray)
        .map((byte) => String.fromCharCode(byte))
        .join(""),
    );
  } catch (error) {
    console.error("Encryption failed:", error);
    throw new Error("Failed to encrypt data.");
  }
}

/**
 * Decrypts text encrypted with encryptText (which uses a **random IV**).
 * Expects IV prepended to the base64 encoded ciphertext. Used for general file content.
 */
export async function decryptText(base64Ciphertext: string, encryptionKey: DerivedKey): Promise<string> {
  if (!encryptionKey) throw new Error("Decryption key is not available.");
  if (!base64Ciphertext) throw new Error("Cannot decrypt empty ciphertext.");

  try {
    const combinedArray = Uint8Array.from(atob(base64Ciphertext), (c) => c.charCodeAt(0));

    if (combinedArray.length < 12) {
      throw new Error("Invalid ciphertext format (too short).");
    }

    const iv = combinedArray.slice(0, 12);
    const encrypted = combinedArray.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, encryptionKey, encrypted);

    return new TextDecoder().decode(decrypted);
  } catch (error) {
    console.error("Decryption failed:", error);

    if (error instanceof DOMException && error.name === "OperationError") {
      throw new Error("Decryption failed. Key mismatch or data corrupted?");
    }
    throw new Error("Failed to decrypt data.");
  }
}

/**
 * Encrypts the standard validation payload using a **fixed IV**.
 * The IV is NOT prepended to the output.
 */
export async function encryptValidationPayload(encryptionKey: DerivedKey): Promise<string> {
  if (!encryptionKey) throw new Error("Encryption key not available for validation payload.");
  try {
    const encoder = new TextEncoder();
    const encodedPayload = encoder.encode(ENCRYPTION_VALIDATION_PAYLOAD);

    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ENCRYPTION_VALIDATION_IV }, encryptionKey, encodedPayload);

    const encryptedArray = new Uint8Array(encrypted);

    return btoa(
      Array.from(encryptedArray)
        .map((byte) => String.fromCharCode(byte))
        .join(""),
    );
  } catch (error) {
    console.error("Failed to encrypt validation payload:", error);
    throw new Error("Could not prepare encryption validation.");
  }
}

/**
 * Decrypts and verifies the validation payload, assuming it was encrypted with the **fixed IV**.
 * Expects a base64 encoded ciphertext *without* a prepended IV.
 * Throws an error if decryption fails or the payload doesn't match.
 */
export async function verifyEncryptionValidationPayload(
  encryptedPayload: string | undefined | null,
  encryptionKey: DerivedKey,
): Promise<boolean> {
  if (!encryptionKey) throw new Error("Decryption key not available for validation.");
  if (!encryptedPayload) {
    console.error("Server did not provide encryption validation marker, but client expects encryption.");
    throw new Error(
      "Encryption Mismatch: Server state appears unencrypted or uses an older format. Please Force Push to encrypt or disable client encryption.",
    );
  }

  try {
    const encryptedArray = Uint8Array.from(atob(encryptedPayload), (c) => c.charCodeAt(0));

    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ENCRYPTION_VALIDATION_IV }, encryptionKey, encryptedArray);

    const decryptedValidation = new TextDecoder().decode(decrypted);

    if (decryptedValidation !== ENCRYPTION_VALIDATION_PAYLOAD) {
      console.error("Decrypted validation payload mismatch!", {
        expected: ENCRYPTION_VALIDATION_PAYLOAD,
        got: decryptedValidation,
      });
      throw new Error("Encryption Key Mismatch! Please verify your password.");
    }
    console.info("Encryption validation successful.");
    return true;
  } catch (error) {
    console.error("Failed to decrypt or validate server encryption marker:", error);

    if (error instanceof Error && error.message.includes("Encryption Key Mismatch")) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "OperationError") {
      throw new Error("Encryption Key Mismatch! Please verify your password.");
    }
    if (error instanceof Error && error.message.includes("Decryption failed")) {
      throw new Error("Encryption Key Mismatch! Please verify your password.");
    }

    throw new Error("Encryption Key Mismatch or Corrupted Data! Please verify your password.");
  }
}
