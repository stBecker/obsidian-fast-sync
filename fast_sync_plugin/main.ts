import { Notice, Plugin, TFile, addIcon } from "obsidian";

import * as FastSyncApi from "./api";
import { DEFAULT_SETTINGS, DOWNLOAD_CHUNK_FILE_COUNT, UPLOAD_CHUNK_SIZE_BYTES } from "./constants";
import { DerivedKey, decryptText, deriveEncryptionKey, encryptText } from "./encryption";
import { FastSyncSettingTab } from "./settings";
import {
  ApiClientOptions,
  HistoryEntry as ClientHistoryEntry,
  DownloadedFileContent,
  FastSyncPluginSettings,
  FileListEntry,
  RemoteVaultState,
  StableFileId,
  UploadPayloadEntry,
  VaultAdapter,
  VaultFileState,
} from "./types";
import { FileHistoryModal } from "./ui/FileHistoryModal";
import { FileVersionsModal } from "./ui/FileVersionsModal";
import { LogViewerModal } from "./ui/LogViewerModal";

import { base64ToArrayBuffer } from "./utils/encodingUtils";
import { cleanEmptyFolders, ensureFoldersExist, getAllUserFiles, getFileContent, getPluginFiles } from "./utils/fileUtils";
import { ContentHashCache, hashFileContentFast, hashStringSHA256 } from "./utils/hashUtils";
import { setupConsoleLogCapture } from "./utils/logging";

const SYNC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M3 12a9 9 0 0 1 15-6.74"/><path d="M3 8v5h5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/></svg>`;

export default class FastSyncPlugin extends Plugin {
  settings: FastSyncPluginSettings;
  statusBarItemEl: HTMLElement;
  syncPaused: boolean = false;
  syncing: boolean = false;

  contentHashCache: ContentHashCache;
  private lastFullRehash: number = 0;
  private syncIntervalId: number | null = null;
  private encryptionKey: DerivedKey = null;
  private vaultAdapter: VaultAdapter;

  private currentRemoteState: RemoteVaultState | null = null;

  async onload() {
    console.info("Loading Fast Sync Plugin...");
    await this.loadSettings();
    setupConsoleLogCapture(this.settings.enableVerboseLogging);

    this.contentHashCache = new ContentHashCache();
    this.vaultAdapter = this.app.vault.adapter;

    await this.loadSettings();

    if (!this.settings.vaultId) {
      this.settings.vaultId = this.app.vault.getName();
      await this.saveSettings();
      console.info(`Vault ID initialized to: ${this.settings.vaultId}`);
    }

    if (this.settings.encryptionPassword) {
      try {
        this.encryptionKey = await deriveEncryptionKey(this.settings.encryptionPassword);
        console.info("Encryption key derived successfully.");
      } catch (error) {
        console.error("Failed to initialize encryption on load:", error);
        new Notice(`Error initializing encryption: ${error.message}. Sync might fail.`, 10000);
      }
    }

    this.statusBarItemEl = this.addStatusBarItem();
    this.updateStatusBar();
    addIcon("fast-sync-icon", SYNC_ICON);
    this.addRibbonIcon("fast-sync-icon", "Fast Sync: Sync Now", () => this.requestSync());
    this.addRibbonIcon("history", "Fast Sync: View File History", () => this.openFileHistoryModal());

    // Only add log viewer ribbon icon if verbose logging is enabled
    if (this.settings.enableVerboseLogging) {
      this.addRibbonIcon("clipboard-list", "Fast Sync: View Logs", () => this.openLogViewerModal());
    }
    this.addSettingTab(new FastSyncSettingTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync Now",
      callback: () => this.requestSync(),
    });
    this.addCommand({
      id: "open-file-history-modal",
      name: "Open File History Browser",
      callback: () => this.openFileHistoryModal(),
    });
    this.addCommand({
      id: "view-current-file-history",
      name: "View History for Current File",
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          if (!checking) {
            this.openFileVersionsModalForPath(activeFile.path);
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "open-sync-log",
      name: "Open Sync Log Viewer",
      checkCallback: (checking) => {
        if (this.settings.enableVerboseLogging) {
          if (!checking) {
            this.openLogViewerModal();
          }
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "toggle-sync-pause",
      name: "Toggle Sync Pause/Resume",
      callback: () => {
        /* ... */ this.syncPaused = !this.syncPaused;
        new Notice(this.syncPaused ? "Sync paused" : "Sync resumed");
        this.updateStatusBar();
        if (!this.syncPaused && !this.syncing) {
          this.requestSync();
        }
      },
    });

    this.registerEvent(this.app.vault.on("modify", this.handleFileModify.bind(this)));
    this.registerEvent(this.app.vault.on("delete", this.handleFileDelete.bind(this)));
    this.registerEvent(this.app.vault.on("rename", this.handleFileRename.bind(this)));

    this.rescheduleSync();

    await this.runCleanEmptyFolders();
    setTimeout(() => this.requestSync(), 5000);

    console.info("Fast Sync Plugin loaded successfully.");
  }

  onunload() {
    console.info("Unloading Fast Sync Plugin...");
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  rescheduleSync() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
    }
    if (this.settings.syncInterval > 0) {
      this.syncIntervalId = window.setInterval(() => this.requestSync(), this.settings.syncInterval * 1000);
      this.registerInterval(this.syncIntervalId);
      console.info(`Sync scheduled every ${this.settings.syncInterval} seconds.`);
    } else {
      console.info("Sync interval is 0, automatic sync disabled.");
      this.syncIntervalId = null;
    }
  }
  async requestSync() {
    if (this.syncPaused) {
      console.info("Sync requested but currently paused.");
      this.updateStatusBar("Sync paused");
      return;
    }
    if (this.syncing) {
      console.info("Sync requested but already in progress.");
      return;
    }
    this.syncing = true;
    this.updateStatusBar("Syncing...");
    try {
      console.info(`Sync started at ${new Date().toLocaleTimeString()}`);
      const syncStart = performance.now();
      await this.executeSync();
      this.settings.lastSync = Date.now();
      await this.saveSettings();
      const duration = (performance.now() - syncStart) / 1000;
      console.info(`Sync finished successfully in ${duration.toFixed(2)}s`);
      this.updateStatusBar();
    } catch (error) {
      console.error("Sync failed:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Sync failed: ${errorMessage}`, 10000);
      this.updateStatusBar("Sync failed!");
    } finally {
      this.syncing = false;
      if (this.syncPaused) {
        this.updateStatusBar("Sync paused");
      }
    }
  }

  /** Performs the actual synchronization steps using stableId. */
  private async executeSync() {
    if (!this.settings.serverUrl || !this.settings.apiKey) throw new Error("Server URL or API Key is not configured.");
    if (this.settings.encryptionPassword && !this.encryptionKey) throw new Error("Encryption is enabled, but the key is not initialized.");

    const now = Date.now();

    if (now - this.lastFullRehash > this.settings.fullRehashInterval * 60 * 1000) {
      console.info("Performing periodic full rehash...");
      this.contentHashCache.clear();
      this.lastFullRehash = now;
      await this.runCleanEmptyFolders();
    }

    const apiOptions: ApiClientOptions = {
      settings: this.settings,
      encryptionKey: this.encryptionKey,
    };

    if (this.settings.deletionQueue.length > 0) {
      await this.processDeletions(apiOptions);
    }

    console.info("Downloading remote state...");

    this.currentRemoteState = await FastSyncApi.downloadRemoteState(apiOptions);
    const remoteStateMap = this.currentRemoteState.state;
    const remoteStableIds = Object.keys(remoteStateMap);
    console.info(`Found ${remoteStableIds.length} stable IDs in remote state.`);

    console.info("Scanning local files...");
    const localFilePaths = await getAllUserFiles(this.app.vault);
    if (this.settings.syncPlugins) {
      const pluginFiles = await getPluginFiles(this.app.vault);
      console.info(`Including ${pluginFiles.length} plugin files.`);
      localFilePaths.push(...pluginFiles);
    }
    console.info(`Found ${localFilePaths.length} local files to consider.`);

    console.info("Comparing local and remote states using stableId...");
    const comparisonStart = performance.now();

    const uploadEntries: UploadPayloadEntry[] = [];
    const filesToDownloadStableIds = new Set<StableFileId>();
    const processedLocalPaths = new Set<string>();

    const maxFileSizeBytes = this.settings.maxFileSizeMB * 1024 * 1024;

    for (const localPath of localFilePaths) {
      processedLocalPaths.add(localPath);
      try {
        const stat = await this.vaultAdapter.stat(localPath);
        if (!stat) continue;
        if (stat.size > maxFileSizeBytes) {
          console.debug(`Skipping large file: ${localPath}`);
          continue;
        }

        const stableId = await hashStringSHA256(localPath);
        let localContentHash = this.contentHashCache.get(localPath);
        let fileContentData: { content: string; isBinary: boolean } | null = null;
        if (!localContentHash) {
          fileContentData = await getFileContent(this.vaultAdapter, localPath);
          localContentHash = await hashFileContentFast(fileContentData.content);
          this.contentHashCache.set(localPath, localContentHash);
        }

        const remoteMeta = remoteStateMap[stableId];
        const localMtime = stat.mtime;

        if (!remoteMeta) {
          console.debug(`[UPLOAD] New local file (StableID: ${stableId.substring(0, 10)}): ${localPath}`);

          if (!fileContentData) fileContentData = await getFileContent(this.vaultAdapter, localPath);
          uploadEntries.push(
            await this.prepareUploadEntry(localPath, stableId, fileContentData, localContentHash, localMtime, false, apiOptions),
          );
        } else if (remoteMeta.deleted) {
          if (localMtime > remoteMeta.currentMtime) {
            console.warn(
              `[UPLOAD/UNDELETE] Local file '${localPath}' (StableID: ${stableId.substring(0, 10)}) modified after server deletion. Uploading.`,
            );
            if (!fileContentData) fileContentData = await getFileContent(this.vaultAdapter, localPath);

            uploadEntries.push(
              await this.prepareUploadEntry(localPath, stableId, fileContentData, localContentHash, localMtime, false, apiOptions),
            );
          } else {
            console.warn(
              `[DELETE LOCAL] Server marked '${localPath}' (StableID: ${stableId.substring(0, 10)}) as deleted more recently. Will delete local file.`,
            );
          }
        } else if (remoteMeta.currentContentHash !== localContentHash) {
          console.debug(`[DIFF] Hash mismatch for ${localPath} (StableID: ${stableId.substring(0, 10)})`);
          if (localMtime > remoteMeta.currentMtime) {
            console.debug(`[UPLOAD] Local file newer: ${localPath}`);
            if (!fileContentData) fileContentData = await getFileContent(this.vaultAdapter, localPath);
            uploadEntries.push(
              await this.prepareUploadEntry(localPath, stableId, fileContentData, localContentHash, localMtime, false, apiOptions),
            );
          } else if (localMtime < remoteMeta.currentMtime) {
            console.debug(`[DOWNLOAD] Remote file newer: ${localPath}`);
            filesToDownloadStableIds.add(stableId);
          } else {
            console.warn(`[CONFLICT/UPLOAD] Hash mismatch, same mtime for ${localPath}. Uploading local.`);
            if (!fileContentData) fileContentData = await getFileContent(this.vaultAdapter, localPath);
            uploadEntries.push(
              await this.prepareUploadEntry(localPath, stableId, fileContentData, localContentHash, localMtime, false, apiOptions),
            );
          }
        }
      } catch (error) {
        console.error(`Error processing local file ${localPath} during comparison:`, error);
      }
    }

    for (const remoteStableId of remoteStableIds) {
      const remoteMeta = remoteStateMap[remoteStableId];

      let potentialLocalPath: string | null = null;
      if (this.settings.encryptionPassword && this.encryptionKey && remoteMeta.currentEncryptedFilePath) {
        try {
          potentialLocalPath = await decryptText(remoteMeta.currentEncryptedFilePath, this.encryptionKey);
        } catch {
          /* ignore decryption error */
        }
      } else if (!this.settings.encryptionPassword) {
        potentialLocalPath = remoteMeta.currentEncryptedFilePath;
      }

      if (potentialLocalPath && !processedLocalPaths.has(potentialLocalPath) && !remoteMeta.deleted) {
        const isPluginFile = potentialLocalPath.startsWith(this.app.vault.configDir + "/plugins/");
        if (!this.settings.syncPlugins && isPluginFile) {
          console.debug(`[SKIP DOWNLOAD] Plugin file ${potentialLocalPath} (StableID: ${remoteStableId.substring(0, 10)}) skipped.`);
          continue;
        }

        console.debug(`[DOWNLOAD] New remote file (StableID: ${remoteStableId.substring(0, 10)}): ${potentialLocalPath}`);
        filesToDownloadStableIds.add(remoteStableId);
      }
    }

    console.info(
      `Comparison complete in ${(performance.now() - comparisonStart).toFixed(2)}ms. ` +
        `Uploads: ${uploadEntries.length}, Downloads: ${filesToDownloadStableIds.size}`,
    );

    if (uploadEntries.length > 0) {
      console.info(`Starting upload of ${uploadEntries.length} entries...`);
      await this.processFileUploads(uploadEntries, apiOptions);
    } else {
      console.info("No files to upload.");
    }

    if (filesToDownloadStableIds.size > 0) {
      console.info(`Starting download for ${filesToDownloadStableIds.size} stable IDs...`);
      await this.processFileDownloads([...filesToDownloadStableIds], apiOptions);
    } else {
      console.info("No files to download.");
    }

    this.currentRemoteState = null;
  }

  /** Helper to prepare a single entry for the upload payload. */
  private async prepareUploadEntry(
    plaintextPath: string,
    stableId: StableFileId,
    fileData: { content: string; isBinary: boolean },
    contentHash: string,
    mtime: number,
    deleted: boolean,
    apiOptions: ApiClientOptions,
  ): Promise<UploadPayloadEntry> {
    let finalPath = plaintextPath;
    let finalContent = fileData.content;

    if (apiOptions.settings.encryptionPassword && apiOptions.encryptionKey) {
      finalPath = await encryptText(plaintextPath, apiOptions.encryptionKey);

      finalContent = deleted ? "" : await encryptText(fileData.content, apiOptions.encryptionKey);
    } else if (deleted) {
      finalContent = "";
    }

    return {
      stableId: stableId,
      filePath: finalPath,
      content: finalContent,
      mtime: mtime,
      contentHash: contentHash,
      isBinary: fileData.isBinary,
      deleted: deleted,
    };
  }

  /** Processes the queue of locally deleted files by notifying the server. */
  private async processDeletions(apiOptions: ApiClientOptions) {
    const deletionsStart = performance.now();
    const deletionEntries: UploadPayloadEntry[] = [];
    const pathsToDelete = [...this.settings.deletionQueue];

    console.info(`Processing ${pathsToDelete.length} local deletions...`);

    for (const plaintextPath of pathsToDelete) {
      try {
        const stableId = await hashStringSHA256(plaintextPath);

        const deletionEntry = await this.prepareUploadEntry(
          plaintextPath,
          stableId,
          { content: "", isBinary: false },
          "",
          Date.now(),
          true,
          apiOptions,
        );
        deletionEntries.push(deletionEntry);
      } catch (error) {
        console.error(`Error preparing deletion entry for ${plaintextPath}:`, error);
      }
    }

    if (deletionEntries.length === 0) {
      console.info("No valid deletion entries prepared.");

      this.settings.deletionQueue = [];
      await this.saveSettings();
      return;
    }

    try {
      await FastSyncApi.uploadFileChanges(deletionEntries, apiOptions);

      this.settings.deletionQueue = [];
      await this.saveSettings();
      console.info(`Deletions processed successfully in ${(performance.now() - deletionsStart).toFixed(2)}ms`);
    } catch (error) {
      console.error("Failed to process deletions:", error);

      throw new Error(`Failed to inform server about deletions: ${error.message}`);
    }
  }

  /** Sends prepared upload entries in chunks. */
  private async processFileUploads(uploadEntries: UploadPayloadEntry[], apiOptions: ApiClientOptions) {
    console.info(`Uploading ${uploadEntries.length} prepared entries...`);
    const uploadStart = performance.now();

    let chunk: UploadPayloadEntry[] = [];
    let currentChunkSize = 0;

    for (let i = 0; i < uploadEntries.length; i++) {
      const entry = uploadEntries[i];
      chunk.push(entry);

      currentChunkSize += entry.content.length;

      if (currentChunkSize >= UPLOAD_CHUNK_SIZE_BYTES || i === uploadEntries.length - 1) {
        console.info(
          `Uploading chunk ${Math.ceil((i + 1) / chunk.length)}: ${chunk.length} entries (${(currentChunkSize / (1024 * 1024)).toFixed(2)} MB estimated)...`,
        );
        try {
          await FastSyncApi.uploadFileChanges(chunk, apiOptions);
        } catch (error) {
          console.error(`Failed to upload chunk: ${error}`);

          throw new Error(`Failed to upload chunk: ${error.message}`);
        }

        chunk = [];
        currentChunkSize = 0;
      }
    }
    console.info(`File uploads completed in ${(performance.now() - uploadStart).toFixed(2)}ms`);
  }

  /** Downloads file content for specified stable IDs in chunks and saves them locally. */
  private async processFileDownloads(stableIdsToDownload: StableFileId[], apiOptions: ApiClientOptions) {
    console.info(`Requesting downloads for ${stableIdsToDownload.length} stable IDs...`);
    const downloadStart = performance.now();

    if (!this.currentRemoteState) {
      console.error("Cannot process downloads: Remote state is missing.");
      throw new Error("Internal error: Remote state not available for download process.");
    }
    const remoteStateMap = this.currentRemoteState.state;

    const encryptedPathsToRequest: string[] = [];
    for (const stableId of stableIdsToDownload) {
      const remoteMeta = remoteStateMap[stableId];
      if (remoteMeta && !remoteMeta.deleted) {
        encryptedPathsToRequest.push(remoteMeta.currentEncryptedFilePath);
      } else {
        console.warn(`Skipping download for stableId ${stableId.substring(0, 10)}: Not found in remote state or marked deleted.`);
      }
    }

    if (encryptedPathsToRequest.length === 0) {
      console.info("No valid encrypted paths found to request download.");
      return;
    }

    console.info(`Requesting content for ${encryptedPathsToRequest.length} encrypted file paths...`);

    for (let i = 0; i < encryptedPathsToRequest.length; i += DOWNLOAD_CHUNK_FILE_COUNT) {
      const chunkPaths = encryptedPathsToRequest.slice(i, i + DOWNLOAD_CHUNK_FILE_COUNT);
      console.info(
        `Requesting download chunk ${Math.floor(i / DOWNLOAD_CHUNK_FILE_COUNT) + 1}: ${chunkPaths.length} paths (starting with ${chunkPaths[0].substring(0, 20)}...).`,
      );

      try {
        const downloadedFilesData = await FastSyncApi.downloadFilesContent(chunkPaths, apiOptions);

        if (downloadedFilesData.length === 0 && chunkPaths.length > 0) {
          console.warn(`Server returned no content for requested chunk starting with ${chunkPaths[0].substring(0, 20)}.`);
          continue;
        }

        console.info(`Processing downloaded chunk of ${downloadedFilesData.length} files...`);
        for (const fileData of downloadedFilesData) {
          await this.saveDownloadedFile(fileData, apiOptions);
        }
      } catch (error) {
        console.error(`Error downloading or processing chunk starting with ${chunkPaths[0].substring(0, 20)}:`, error);
        new Notice(`Error downloading files: ${error.message}. Check logs.`, 8000);
      }
    }

    console.info(`File downloads completed in ${(performance.now() - downloadStart).toFixed(2)}ms`);
  }

  /** Saves a single downloaded file (with encrypted path/content) to the local vault. */
  private async saveDownloadedFile(fileData: DownloadedFileContent, apiOptions: ApiClientOptions) {
    let plaintextPath: string | null = null;
    try {
      if (apiOptions.settings.encryptionPassword && apiOptions.encryptionKey) {
        plaintextPath = await decryptText(fileData.encryptedFilePath, apiOptions.encryptionKey);
      } else if (!apiOptions.settings.encryptionPassword) {
        plaintextPath = fileData.encryptedFilePath;
      } else {
        throw new Error("Encryption key missing while trying to decrypt downloaded file path.");
      }

      if (!plaintextPath) {
        throw new Error(`Failed to determine plaintext path for encrypted path ${fileData.encryptedFilePath.substring(0, 20)}...`);
      }

      console.debug(`Saving downloaded file: ${plaintextPath} (mtime: ${new Date(fileData.mtime).toISOString()})`);
      await ensureFoldersExist(this.vaultAdapter, plaintextPath);

      let finalContent: string | ArrayBuffer;
      if (apiOptions.settings.encryptionPassword && apiOptions.encryptionKey) {
        const decryptedBase64OrText = await decryptText(fileData.encryptedContent, apiOptions.encryptionKey);
        if (fileData.isBinary) {
          finalContent = base64ToArrayBuffer(decryptedBase64OrText);
        } else {
          finalContent = decryptedBase64OrText;
        }
      } else if (!apiOptions.settings.encryptionPassword) {
        if (fileData.isBinary) {
          finalContent = base64ToArrayBuffer(fileData.encryptedContent);
        } else {
          finalContent = fileData.encryptedContent;
        }
      } else {
        throw new Error("Encryption key missing while trying to decrypt downloaded file content.");
      }

      const writeOptions = { mtime: fileData.mtime };
      if (fileData.isBinary && finalContent instanceof ArrayBuffer) {
        await this.vaultAdapter.writeBinary(plaintextPath, finalContent, writeOptions);
      } else if (!fileData.isBinary && typeof finalContent === "string") {
        await this.vaultAdapter.write(plaintextPath, finalContent, writeOptions);
      } else {
        throw new Error(`Type mismatch during save: isBinary=${fileData.isBinary}, content type=${typeof finalContent}`);
      }

      this.contentHashCache.set(plaintextPath, fileData.contentHash);
    } catch (error) {
      const pathIdentifier = plaintextPath || `encrypted:${fileData.encryptedFilePath.substring(0, 20)}`;
      console.error(`Error saving downloaded file ${pathIdentifier}:`, error);
      new Notice(`Failed to save downloaded file: ${pathIdentifier}. Check logs.`, 5000);
    }
  }

  private handleFileModify(file: TFile | null) {
    if (!(file instanceof TFile)) return;
    console.debug(`File modified: ${file.path}, invalidating content cache.`);
    this.contentHashCache.invalidate(file.path);
  }

  private async handleFileDelete(file: TFile | null) {
    if (!(file instanceof TFile)) return;
    console.info(`File deleted locally: ${file.path}, adding to deletion queue.`);
    this.contentHashCache.invalidate(file.path);
    if (!this.settings.deletionQueue.includes(file.path)) {
      this.settings.deletionQueue.push(file.path);
      await this.saveSettings();
      setTimeout(() => this.requestSync(), 3000);
    }
  }

  private async handleFileRename(file: TFile | null, oldPath: string) {
    if (!(file instanceof TFile)) return;
    console.info(`File renamed: ${oldPath} -> ${file.path}`);
    this.contentHashCache.invalidate(oldPath);
    this.contentHashCache.invalidate(file.path);
    if (!this.settings.deletionQueue.includes(oldPath)) {
      this.settings.deletionQueue.push(oldPath);
      await this.saveSettings();
    }
    setTimeout(() => this.requestSync(), 3000);
  }

  /**
   * Force Push: Resets server state, then calculates stable IDs and uploads all local files.
   */
  async forcePushStateToServer() {
    if (this.syncing) {
      new Notice("Sync already in progress...");
      return;
    }
    if (this.syncPaused) {
      new Notice("Sync is paused...");
      return;
    }
    if (this.settings.encryptionPassword && !this.encryptionKey) {
      new Notice("Encryption key not initialized.", 10000);
      return;
    }

    console.warn("Starting FORCE PUSH operation!");
    new Notice("Starting Force Push...");
    this.syncing = true;
    this.updateStatusBar("Force Pushing...");
    const apiOptions: ApiClientOptions = {
      settings: this.settings,
      encryptionKey: this.encryptionKey,
    };
    try {
      console.info("Step 1: Resetting server state...");
      await FastSyncApi.resetServerStateForForcePush(apiOptions);
      console.info("Server state reset successfully.");

      console.info("Step 2: Clearing local deletion queue and cache...");
      this.settings.deletionQueue = [];
      this.contentHashCache.clear();
      this.lastFullRehash = Date.now();

      console.info("Step 3: Scanning all local files for push...");
      const localFilePaths = await getAllUserFiles(this.app.vault);
      if (this.settings.syncPlugins) {
        const pluginFiles = await getPluginFiles(this.app.vault);
        localFilePaths.push(...pluginFiles);
      }
      console.info(`Found ${localFilePaths.length} local files to force push.`);

      console.info("Step 4: Preparing upload entries...");
      const uploadEntries: UploadPayloadEntry[] = [];
      const maxFileSizeBytes = this.settings.maxFileSizeMB * 1024 * 1024;
      for (const localPath of localFilePaths) {
        try {
          const stat = await this.vaultAdapter.stat(localPath);
          if (!stat || stat.size > maxFileSizeBytes) continue;

          const stableId = await hashStringSHA256(localPath);
          const fileData = await getFileContent(this.vaultAdapter, localPath);
          const contentHash = await hashFileContentFast(fileData.content);

          this.contentHashCache.set(localPath, contentHash);

          uploadEntries.push(await this.prepareUploadEntry(localPath, stableId, fileData, contentHash, stat.mtime, false, apiOptions));
        } catch (error) {
          console.error(`Error preparing file ${localPath} for force push:`, error);
          new Notice(`Skipping ${localPath} during force push due to error.`, 3000);
        }
      }

      console.info("Step 5: Uploading all local files...");
      if (uploadEntries.length > 0) {
        await this.processFileUploads(uploadEntries, apiOptions);
      } else {
        console.warn("No valid local files found to upload during force push.");
      }

      console.warn("FORCE PUSH complete.");
      new Notice("Force Push complete. Server state overwritten.");
      this.settings.lastSync = Date.now();
      await this.saveSettings();
      this.updateStatusBar();
    } catch (error) {
      console.error("FORCE PUSH failed:", error);
      new Notice(`Force Push failed: ${error.message}`, 10000);
      this.updateStatusBar("Sync failed!");
    } finally {
      this.syncing = false;
      if (this.syncPaused) this.updateStatusBar("Sync paused");
      else this.updateStatusBar();
    }
  }

  /**
   * Force Pull: Fetches remote state, deletes local files not matching, downloads required files.
   */
  async forcePullStateFromServer() {
    if (this.syncing) {
      new Notice("Sync already in progress...");
      return;
    }
    if (this.syncPaused) {
      new Notice("Sync is paused...");
      return;
    }
    if (this.settings.encryptionPassword && !this.encryptionKey) {
      new Notice("Encryption key not initialized.", 10000);
      return;
    }

    console.warn("Starting FORCE PULL operation!");
    new Notice("Starting Force Pull...");
    this.syncing = true;
    this.updateStatusBar("Force Pulling...");
    const apiOptions: ApiClientOptions = {
      settings: this.settings,
      encryptionKey: this.encryptionKey,
    };
    try {
      console.info("Step 1: Clearing local deletion queue and cache...");
      this.settings.deletionQueue = [];
      this.contentHashCache.clear();
      this.lastFullRehash = 0;

      console.info("Step 2: Fetching remote state...");
      const remoteState = await FastSyncApi.downloadRemoteState(apiOptions);
      const remoteStateMap = remoteState.state;
      const remoteStableIds = Object.keys(remoteStateMap);
      console.info(`Found ${remoteStableIds.length} stable IDs in remote state.`);

      const stableIdsToDownload: StableFileId[] = [];
      const remoteFilesMap = new Map<StableFileId, { meta: VaultFileState; plaintextPath: string | null }>();

      for (const stableId of remoteStableIds) {
        const meta = remoteStateMap[stableId];
        if (!meta || meta.deleted) continue;

        let plaintextPath: string | null = null;
        try {
          if (this.settings.encryptionPassword && this.encryptionKey) {
            plaintextPath = await decryptText(meta.currentEncryptedFilePath, this.encryptionKey);
          } else if (!this.settings.encryptionPassword) {
            plaintextPath = meta.currentEncryptedFilePath;
          } else continue;

          remoteFilesMap.set(stableId, { meta, plaintextPath });

          const isPluginFile = plaintextPath.startsWith(this.app.vault.configDir + "/plugins/");
          if (!this.settings.syncPlugins && isPluginFile) {
            console.debug(`Force Pull: Skipping plugin file ${plaintextPath}`);
            continue;
          }
          stableIdsToDownload.push(stableId);
        } catch (e) {
          console.error(
            `Force Pull: Failed to decrypt path for stableId ${stableId.substring(0, 10)}... Skipping download. Error: ${e.message}`,
          );
          new Notice(`Failed to decrypt path for a remote file. Skipping download. Check logs/password.`);
        }
      }
      console.info(`Identified ${stableIdsToDownload.length} files to potentially download.`);

      console.info("Step 4: Scanning local files for deletion comparison...");
      const localFilePaths = await getAllUserFiles(this.app.vault);
      if (this.settings.syncPlugins) {
        const pluginFiles = await getPluginFiles(this.app.vault);
        localFilePaths.push(...pluginFiles);
      }
      const localFilesToDelete: string[] = [];
      for (const localPath of localFilePaths) {
        try {
          const stableId = await hashStringSHA256(localPath);
          const remoteEntry = remoteFilesMap.get(stableId);

          if (!remoteEntry || remoteEntry.meta.deleted || remoteEntry.plaintextPath !== localPath) {
            localFilesToDelete.push(localPath);
          }
        } catch (hashError) {
          console.error(`Failed to hash local path ${localPath} during force pull deletion check: ${hashError}`);
        }
      }
      console.info(`Identified ${localFilesToDelete.length} local files for deletion.`);

      console.info("Step 5: Deleting local files not present or deleted on server...");
      let deletionErrors = 0;
      for (const filePath of localFilesToDelete) {
        try {
          if (await this.vaultAdapter.exists(filePath)) {
            console.debug(`Deleting local file: ${filePath}`);
            await this.vaultAdapter.remove(filePath);
          }
          this.contentHashCache.invalidate(filePath);
        } catch (error) {
          console.error(`Failed to delete local file ${filePath}:`, error);
          deletionErrors++;
        }
      }
      if (deletionErrors > 0) {
        new Notice(`Force Pull: Failed to delete ${deletionErrors} local files. Check logs.`, 5000);
      }
      await this.runCleanEmptyFolders();

      console.info("Step 6: Downloading files from server...");
      if (stableIdsToDownload.length > 0) {
        await this.processFileDownloads(stableIdsToDownload, apiOptions);
      } else {
        console.info("No files to download from server.");
      }

      console.warn("FORCE PULL complete.");
      new Notice("Force Pull complete. Local state overwritten.");
      this.settings.lastSync = Date.now();
      await this.saveSettings();
      this.updateStatusBar();
    } catch (error) {
      console.error("FORCE PULL failed:", error);
      new Notice(`Force Pull failed: ${error.message}`, 10000);
      this.updateStatusBar("Sync failed!");
    } finally {
      this.syncing = false;
      if (this.syncPaused) this.updateStatusBar("Sync paused");
      else this.updateStatusBar();
    }
  }

  /** Runs the empty folder cleanup utility. */
  async runCleanEmptyFolders() {
    /* ... */ try {
      await cleanEmptyFolders(this.vaultAdapter, "/");
    } catch (error) {
      console.error("Error during empty folder cleanup:", error);
    }
  }

  updateStatusBar(text?: string) {
    if (!this.statusBarItemEl) return;
    let statusText = "";
    if (text) {
      statusText = text;
    } else if (this.syncPaused) {
      statusText = "Sync paused";
    } else {
      const lastSyncTime = this.settings.lastSync ? new Date(this.settings.lastSync).toLocaleTimeString("de") : "Never";
      statusText = `Last sync ${lastSyncTime}`;
    }
    this.statusBarItemEl.setText(statusText);
  }

  openFileHistoryModal() {
    if (!this.settings.serverUrl || !this.settings.apiKey) {
      new Notice("Please configure Server URL and API Key.");
      return;
    }
    if (this.settings.encryptionPassword && !this.encryptionKey) {
      new Notice("Encryption key not initialized.", 5000);
      return;
    }
    new FileHistoryModal(this.app, this).open();
  }

  openLogViewerModal() {
    if (!this.settings.enableVerboseLogging) {
      new Notice("Log viewer is disabled. Enable verbose logging in settings.");
      return;
    }
    new LogViewerModal(this.app).open();
  }

  /** Helper to open FileVersionsModal using stableId calculated from path */
  async openFileVersionsModalForPath(plaintextPath: string) {
    if (!this.settings.serverUrl || !this.settings.apiKey) {
      new Notice("Please configure Server URL and API Key.");
      return;
    }
    if (this.settings.encryptionPassword && !this.encryptionKey) {
      new Notice("Encryption key not initialized.", 5000);
      return;
    }

    try {
      const stableId = await hashStringSHA256(plaintextPath);
      console.debug(`Opening history for path: ${plaintextPath}, stableId: ${stableId.substring(0, 10)}...`);

      new FileVersionsModal(this.app, this, stableId, plaintextPath).open();
    } catch (error) {
      console.error(`Could not calculate stableId for ${plaintextPath}:`, error);
      new Notice(`Could not open history for ${plaintextPath}.`);
    }
  }

  /** Provides access to the getFileHistory API call using stableId. */
  async getFileHistory(stableId: StableFileId): Promise<ClientHistoryEntry[]> {
    const apiOptions: ApiClientOptions = {
      settings: this.settings,
      encryptionKey: this.encryptionKey,
    };
    return FastSyncApi.getFileHistoryFromServer(stableId, apiOptions);
  }

  /** Provides access to the getAllServerFilesList API call. Caller needs to decrypt paths. */
  async getAllFilesFromServer(): Promise<FileListEntry[]> {
    const apiOptions: ApiClientOptions = {
      settings: this.settings,
      encryptionKey: this.encryptionKey,
    };

    return FastSyncApi.getAllServerFilesList(apiOptions);
  }

  /** Decrypts a file path if encryption is enabled */
  async tryDecryptPath(encryptedPath: string): Promise<string | null> {
    if (this.settings.encryptionPassword && this.encryptionKey) {
      try {
        return await decryptText(encryptedPath, this.encryptionKey);
      } catch (e) {
        console.warn(`Failed to decrypt path ${encryptedPath.substring(0, 20)}... : ${e.message}`);
        return null;
      }
    }
    return encryptedPath;
  }

  /** Handles changes to the encryption password from the settings tab */
  async handleEncryptionPasswordChange(oldPassword: string | null, newPassword: string): Promise<void> {
    console.info("Encryption password setting changed.");
    this.encryptionKey = null;
    if (newPassword) {
      console.info("Attempting to derive new encryption key...");
      try {
        this.encryptionKey = await deriveEncryptionKey(newPassword);
        console.info("New encryption key derived successfully.");
        new Notice("Encryption key updated. A Force Push/Pull may be required.", 15000);
      } catch (error) {
        console.error("Failed to derive new encryption key:", error);
        this.encryptionKey = null;
        throw new Error(`Failed to initialize encryption with new password: ${error.message}`);
      }
    } else {
      console.info("Encryption disabled.");
      new Notice("Encryption disabled. A Force Push/Pull may be required.", 15000);
    }
    this.contentHashCache.clear();
  }
}
