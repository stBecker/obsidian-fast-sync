import { decryptText, encryptValidationPayload, verifyEncryptionValidationPayload } from "./encryption";
import {
  ApiClientOptions,
  HistoryEntry as ClientHistoryEntry,
  DownloadFilesRequest,
  DownloadedFileContent,
  FileListEntry,
  ForcePushResetResponse,
  RemoteVaultState,
  StableFileId,
  UploadPayloadEntry,
  VaultFileState,
} from "./types";
import { Logger } from "./utils/logging";

function getApiHeaders(apiKey: string): Record<string, string> {
  /* ... */
  return {
    "Accept-Encoding": "gzip",
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 1): Promise<Response> {
  /* ... */
  try {
    const response = await fetch(url, options);
    if (!response.ok && response.status >= 500 && retries > 0) {
      Logger.warn(`Request to ${url} failed with status ${response.status}. Retrying (${retries} left)...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }
    return response;
  } catch (error) {
    if (retries > 0 && error instanceof TypeError) {
      Logger.warn(`Request to ${url} failed with network error. Retrying (${retries} left)...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fetchWithRetry(url, options, retries - 1);
    }
    Logger.error(`Request to ${url} failed after retries or with non-retryable error:`, error);
    throw error;
  }
}

/**
 * Downloads the current logical vault state from the server.
 * Handles decryption of file paths if needed.
 * Returns the state keyed by stableId.
 */
export async function downloadRemoteState(options: ApiClientOptions): Promise<RemoteVaultState> {
  const { settings, encryptionKey } = options;
  const start = performance.now();
  const url = `${settings.serverUrl}/v1/${settings.vaultId}/state`;
  const headers = getApiHeaders(settings.apiKey);

  try {
    const response = await fetchWithRetry(url, { headers });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Could not read error body");
      Logger.error(`State download failed: ${response.status} ${response.statusText}`, errorBody);
      throw new Error(`State download failed: ${response.statusText} (Status: ${response.status})`);
    }

    const result: RemoteVaultState = await response.json();
    Logger.info(`State download completed in ${(performance.now() - start).toFixed(2)}ms`);

    const processedState: { [stableId: StableFileId]: VaultFileState } = result.state || {};

    if (settings.encryptionPassword && encryptionKey) {
      const startDecryption = performance.now();
      Logger.info("Client expects encryption, validating server state...");

      try {
        await verifyEncryptionValidationPayload(result.encryptionValidation, encryptionKey);

        Logger.info(`Validated server state for ${Object.keys(processedState).length} stable IDs.`);
      } catch (error) {
        Logger.error("Encryption validation failed:", error);
        throw error;
      }

      Logger.info(`State validation completed in ${(performance.now() - startDecryption).toFixed(2)}ms`);
    } else if (settings.encryptionPassword && !encryptionKey) {
      throw new Error("Encryption key not initialized. Cannot process potentially encrypted state.");
    } else if (!settings.encryptionPassword && result.encryptionValidation) {
      Logger.warn("Server has encryption validation marker, but client encryption is disabled. State reflects encrypted paths.");
      throw new Error(
        "Encryption Mismatch: Server data seems encrypted, but client encryption is disabled. Enable encryption or Force Push.",
      );
    }

    return {
      state: processedState,
      encryptionValidation: result.encryptionValidation,
    };
  } catch (error) {
    Logger.error("Error during downloadRemoteState:", error);
    if (
      error instanceof Error &&
      (error.message.includes("Encryption Mismatch") ||
        error.message.includes("Encryption Key Mismatch") ||
        error.message.includes("Decryption failed"))
    ) {
      throw error;
    }
    throw new Error(`Failed to download or process remote state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Uploads file changes (creations, updates, deletions) to the server.
 * Expects data prepared with stableId and encrypted fields. Handles encryption validation marker.
 */
export async function uploadFileChanges(uploadEntries: UploadPayloadEntry[], options: ApiClientOptions): Promise<void> {
  const { settings, encryptionKey } = options;
  if (uploadEntries.length === 0) {
    Logger.debug("No changes to upload.");
    return;
  }

  const start = performance.now();
  const url = `${settings.serverUrl}/v1/${settings.vaultId}/uploadChanges`;
  const headers = getApiHeaders(settings.apiKey);

  const payload: { data: UploadPayloadEntry[]; encryptionValidation?: string } = { data: uploadEntries };

  try {
    if (settings.encryptionPassword && encryptionKey) {
      payload.encryptionValidation = await encryptValidationPayload(encryptionKey);
    } else {
      delete payload.encryptionValidation;
    }

    const uploadStart = performance.now();
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Could not read error body");
      let detail = `Upload failed: ${response.statusText} (Status: ${response.status})`;
      if (response.status === 409) {
        try {
          detail = (await response.json()).detail || detail;
        } catch (e) {
          /* ignore json parse error */
        }
      }
      Logger.error(detail, errorBody);
      throw new Error(detail);
    }

    Logger.info(
      `Uploaded ${payload.data.length} changes in ${(performance.now() - start).toFixed(2)}ms (Upload request: ${(performance.now() - uploadStart).toFixed(2)}ms)`,
    );
  } catch (error) {
    Logger.error("Error during uploadFileChanges:", error);
    if (error instanceof Error && (error.message.includes("Encryption Mismatch") || error.message.includes("Encryption Key Mismatch"))) {
      throw error;
    }
    throw new Error(`Failed to upload changes: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Downloads the encrypted content of specific file versions from the server,
 * identified by their exact encrypted file paths.
 * Returns a list of objects containing the encrypted path and content.
 */
export async function downloadFilesContent(encryptedFilePaths: string[], options: ApiClientOptions): Promise<DownloadedFileContent[]> {
  const { settings } = options;
  if (encryptedFilePaths.length === 0) {
    return [];
  }

  const start = performance.now();
  const url = `${settings.serverUrl}/v1/${settings.vaultId}/downloadFiles`;
  const headers = getApiHeaders(settings.apiKey);
  const requestPayload: DownloadFilesRequest = { encryptedFilePaths };

  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Could not read error body");
      Logger.error(`File download request failed: ${response.status} ${response.statusText}`, errorBody);
      throw new Error(`File download failed: ${response.statusText} (Status: ${response.status})`);
    }

    const result: { files: DownloadedFileContent[] } = await response.json();
    Logger.info(`Downloaded content for ${result.files.length} encrypted paths in ${(performance.now() - start).toFixed(2)}ms`);

    return result.files;
  } catch (error) {
    Logger.error("Error during downloadFilesContent:", error);

    throw new Error(`Failed to download file content: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Gets a list of all files that have ever existed from the server.
 * Returns entries containing stableId and the current encryptedFilePath.
 * Handles decryption of the encryptedFilePath if necessary.
 */
export async function getAllServerFilesList(options: ApiClientOptions): Promise<FileListEntry[]> {
  const { settings, encryptionKey } = options;
  const start = performance.now();
  const url = `${settings.serverUrl}/v1/${settings.vaultId}/allFiles`;
  const headers = getApiHeaders(settings.apiKey);
  delete headers["Content-Type"];

  try {
    const response = await fetchWithRetry(url, { headers });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Could not read error body");
      Logger.error(`Failed to get all files list: ${response.status} ${response.statusText}`, errorBody);
      throw new Error(`Failed to get files list: ${response.statusText} (Status: ${response.status})`);
    }

    const result: FileListEntry[] = await response.json();
    Logger.info(`All files list retrieved (${result.length} files raw) in ${(performance.now() - start).toFixed(2)}ms`);

    if (!settings.encryptionPassword && result.length > 0 && result[0].currentEncryptedFilePath.length > 100) {
      Logger.warn("Received file list paths look potentially encrypted, but client encryption is disabled.");
    } else if (settings.encryptionPassword && !encryptionKey) {
      Logger.error("Encryption key not initialized. Cannot decrypt file paths from list if needed later.");
    }

    Logger.info(`Processed all files list contains ${result.length} files.`);
    return result;
  } catch (error) {
    Logger.error("Error during getAllServerFilesList:", error);

    throw new Error(`Failed to retrieve file list from server: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Gets the version history for a specific file from the server using its stableId.
 * Handles decryption of the encryptedFilePath and encryptedContent in the history entries.
 */
export async function getFileHistoryFromServer(stableId: StableFileId, options: ApiClientOptions): Promise<ClientHistoryEntry[]> {
  const { settings, encryptionKey } = options;
  const start = performance.now();

  const encodedStableId = encodeURIComponent(stableId);
  const url = `${settings.serverUrl}/v1/${settings.vaultId}/fileHistory/${encodedStableId}`;
  const headers = getApiHeaders(settings.apiKey);
  delete headers["Content-Type"];

  try {
    const response = await fetchWithRetry(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        Logger.info(`File history not found for stableId ${stableId.substring(0, 10)}...`);
        return [];
      }
      const errorBody = await response.text().catch(() => "Could not read error body");
      Logger.error(
        `Failed to get file history for stableId ${stableId.substring(0, 10)}: ${response.status} ${response.statusText}`,
        errorBody,
      );
      throw new Error(`Failed to get file history: ${response.statusText} (Status: ${response.status})`);
    }

    const result: any[] = await response.json();
    Logger.info(
      `File history retrieved for stableId ${stableId.substring(0, 10)} (${result.length} versions raw) in ${(performance.now() - start).toFixed(2)}ms`,
    );

    let processedHistory: ClientHistoryEntry[] = [];
    if (settings.encryptionPassword && encryptionKey && result.length > 0) {
      const decryptionStart = performance.now();
      Logger.info(`Decrypting content for ${result.length} history entries for stableId ${stableId.substring(0, 10)}...`);
      try {
        for (const entry of result) {
          const decryptedFilePath = await decryptText(entry.filePath, encryptionKey);
          const decryptedContent = entry.content ? await decryptText(entry.content, encryptionKey) : "";
          processedHistory.push({
            filePath: decryptedFilePath,
            content: decryptedContent,
            mtime: entry.mtime,
            contentHash: entry.contentHash,
            isBinary: entry.isBinary,
            version_time: entry.version_time,
          });
        }
        Logger.info(`Decryption of history entries complete in ${(performance.now() - decryptionStart).toFixed(2)}ms`);
      } catch (decErr) {
        Logger.error(`Failed to decrypt history entry for stableId ${stableId.substring(0, 10)}:`, decErr);
        throw new Error("Failed to decrypt file history content. Key mismatch or data corrupted?");
      }
    } else if (!settings.encryptionPassword && result.length > 0) {
      processedHistory = result.map((entry) => ({
        filePath: entry.filePath,
        content: entry.content,
        mtime: entry.mtime,
        contentHash: entry.contentHash,
        isBinary: entry.isBinary,
        version_time: entry.version_time,
      }));
      if (result[0].filePath.length > 100) {
        Logger.warn(
          `Received history for stableId ${stableId.substring(0, 10)} looks potentially encrypted, but client encryption is disabled.`,
        );
      }
    } else if (settings.encryptionPassword && !encryptionKey) {
      throw new Error("Encryption key not initialized. Cannot decrypt file history.");
    }

    return processedHistory;
  } catch (error) {
    Logger.error(`Error during getFileHistoryFromServer for stableId ${stableId.substring(0, 10)}:`, error);
    if (error instanceof Error && (error.message.includes("Key Mismatch") || error.message.includes("Decryption failed"))) {
      throw error;
    }
    throw new Error(
      `Failed to retrieve file history for ${stableId.substring(0, 10)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Calls the server endpoint to reset the vault state before a force push.
 */
export async function resetServerStateForForcePush(options: ApiClientOptions): Promise<void> {
  const { settings, encryptionKey } = options;
  const start = performance.now();
  const url = `${settings.serverUrl}/v1/${settings.vaultId}/forcePushReset`;
  const headers = getApiHeaders(settings.apiKey);

  const payload: { encryptionValidation?: string } = {};

  try {
    if (settings.encryptionPassword && encryptionKey) {
      payload.encryptionValidation = await encryptValidationPayload(encryptionKey);
    } else if (settings.encryptionPassword && !encryptionKey) {
      throw new Error("Encryption key not initialized. Cannot prepare force push reset request.");
    }

    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Could not read error body");
      Logger.error(`Force push reset failed: ${response.status} ${response.statusText}`, errorBody);
      throw new Error(`Force push reset failed: ${response.statusText} (Status: ${response.status})`);
    }

    const result: ForcePushResetResponse = await response.json();
    if (result.status !== "reset_success") {
      throw new Error(`Server reported failure during force push reset: ${result.status}`);
    }
    Logger.warn(`Server state reset successfully for vault ${settings.vaultId} in ${(performance.now() - start).toFixed(2)}ms`);
  } catch (error) {
    Logger.error("Error during resetServerStateForForcePush:", error);
    throw new Error(`Failed to reset server state for force push: ${error instanceof Error ? error.message : String(error)}`);
  }
}
