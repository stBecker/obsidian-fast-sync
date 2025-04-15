export const ENCRYPTION_VALIDATION_PAYLOAD = "FastSyncVaultEncryptionCheck_v1.0";

export const ENCRYPTION_VALIDATION_IV = new Uint8Array([83, 105, 109, 112, 108, 101, 83, 121, 110, 99, 73, 86]);

export const UPLOAD_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_CHUNK_FILE_COUNT = 100;

import { FastSyncPluginSettings } from "./types";

export const DEFAULT_SETTINGS: FastSyncPluginSettings = {
  serverUrl: "",
  apiKey: "",
  syncInterval: 60,
  lastSync: 0,
  deletionQueue: [],
  vaultId: "",
  fullRehashInterval: 15,
  maxFileSizeMB: 100,
  syncPlugins: false,
  encryptionPassword: "",
  enableVerboseLogging: false,
};
