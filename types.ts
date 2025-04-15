import { Vault } from "obsidian";

import { DerivedKey } from "./encryption";

/** Stable identifier derived from the plaintext file path (e.g., SHA-256 hash) */
export type StableFileId = string;

/** Represents the content and metadata for upload/download/history, potentially encrypted. */
export interface VersionData {
  filePath: string;

  content: string;

  mtime: number;
  isBinary: boolean;

  contentHash: string;

  deleted?: boolean;

  version_time?: string;
}

/** Represents the logical file state on the server, keyed by stableId. */
export interface VaultFileState {
  currentEncryptedFilePath: string;

  currentMtime: number;
  currentContentHash: string;
  isBinary: boolean;
  deleted: boolean;
}

/** Server's overall state response. */
export interface RemoteVaultState {
  state: { [stableId: StableFileId]: VaultFileState };

  encryptionValidation?: string | null;
}

/** Data structure for uploading changes to the server. */
export interface UploadPayloadEntry extends VersionData {
  stableId: StableFileId;
  deleted: boolean;
  filePath: string;
  content: string;
}

/** Data structure returned for file history. */
export interface HistoryEntry extends VersionData {
  filePath: string;
  content: string;
  version_time: string;
}

/** Data structure for requesting file content download. Client sends encryptedFilePaths. */
export interface DownloadFilesRequest {
  encryptedFilePaths: string[];
}

/** Data structure returned by file content download. */
export interface DownloadedFileContent {
  encryptedFilePath: string;

  encryptedContent: string;

  mtime: number;
  contentHash: string;
  isBinary: boolean;
}

/** Data structure for the file list returned by /allFiles (for history browser). */
export interface FileListEntry {
  stableId: StableFileId;

  currentEncryptedFilePath: string;
}

export interface FastSyncPluginSettings {
  serverUrl: string;
  apiKey: string;
  syncInterval: number;
  lastSync: number;
  deletionQueue: string[];
  vaultId: string;
  fullRehashInterval: number;
  maxFileSizeMB: number;
  syncPlugins: boolean;
  encryptionPassword: string;
  enableVerboseLogging: boolean;
}

export interface LogMessage {
  timestamp: number;
  level: "info" | "error" | "debug";
  message: string;
}

export interface ApiClientOptions {
  settings: FastSyncPluginSettings;
  encryptionKey: DerivedKey;
}

export interface ForcePushResetResponse {
  status: string;
}

export type VaultAdapter = Vault["adapter"];
