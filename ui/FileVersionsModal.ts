import { App, ButtonComponent, Modal, Notice, TFile } from "obsidian";
import { base64ToArrayBuffer } from "utils/encodingUtils";

import FastSyncPlugin from "../main";
import { HistoryEntry, StableFileId } from "../types";
import { ensureFoldersExist } from "../utils/fileUtils";
import { Logger } from "../utils/logging";

export class FileVersionsModal extends Modal {
  plugin: FastSyncPlugin;
  stableId: StableFileId;
  displayPath: string;
  versions: HistoryEntry[] = [];
  isLoading: boolean = true;
  historyContainer: HTMLElement;

  constructor(app: App, plugin: FastSyncPlugin, stableId: StableFileId, displayPath: string) {
    super(app);
    this.plugin = plugin;
    this.stableId = stableId;
    this.displayPath = displayPath;
    this.modalEl.addClass("fast-sync-modal");
    this.modalEl.addClass("fast-sync-file-versions-modal");
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Version history" });
    contentEl.createEl("p", { text: `File: ${this.displayPath}` });
    contentEl.createEl("p", {
      text: `(StableID: ${this.stableId.substring(0, 10)}...)`,
      cls: "setting-item-description",
    });

    this.historyContainer = contentEl.createDiv({
      cls: "fast-sync-history-container",
    });
    this.displayLoading();

    try {
      this.versions = await this.plugin.getFileHistory(this.stableId);
      this.isLoading = false;
      this.displayVersions();
    } catch (error) {
      Logger.error(`Failed to load history for stableId ${this.stableId.substring(0, 10)} (${this.displayPath}):`, error);
      this.displayError(`Failed to load versions: ${error.message}`);
    }
  }

  displayLoading() {
    this.historyContainer.empty();
    this.historyContainer.createEl("p", { text: "Loading version history..." });
  }

  displayError(errorMessage: string) {
    this.historyContainer.empty();
    this.historyContainer.createEl("p", {
      text: errorMessage,
      cls: "error-message",
    });
  }

  displayVersions() {
    this.historyContainer.empty();

    if (this.versions.length === 0) {
      this.historyContainer.createEl("p", {
        text: "No history found for this file on the server.",
      });
      return;
    }

    this.versions.sort((a, b) => new Date(b.version_time).getTime() - new Date(a.version_time).getTime());

    this.versions.forEach((version, index) => {
      const itemEl = this.historyContainer.createDiv({
        cls: "fast-sync-version-item",
      });
      const headerEl = itemEl.createDiv({ cls: "fast-sync-version-header" });

      const infoEl = headerEl.createDiv({
        cls: "fast-sync-version-header-info",
      });
      const date = new Date(version.version_time);
      infoEl.setText(`Version from ${date.toLocaleString()}`);

      if (index === 0) {
        infoEl.appendText(" (current server version)");
      }

      const buttonContainer = headerEl.createDiv({
        cls: "fast-sync-version-buttons",
      });

      const contentEl = itemEl.createDiv({ cls: "fast-sync-version-content" });
      if (version.isBinary) {
        contentEl.setText("[Binary content - cannot be previewed directly]");
      } else if (!version.content) {
        contentEl.setText("[Content seems empty]");
      } else {
        contentEl.setText(version.content);
      }

      let isContentVisible = false;
      const toggleContent = () => {
        isContentVisible = !isContentVisible;
        contentEl.toggleClass("active", isContentVisible);
      };
      headerEl.onClickEvent((ev) => {
        if (!(ev.target instanceof Element && ev.target.closest(".clickable-icon, button"))) {
          toggleContent();
        }
      });

      new ButtonComponent(buttonContainer)
        .setButtonText("Restore")
        .setTooltip(`Restore vault file to this version from ${date.toLocaleString()}`)
        .onClick(async (evt) => {
          evt.stopPropagation();
          const button = evt.target as HTMLButtonElement;
          button.disabled = true;
          button.setText("Restoring...");
          try {
            await this.restoreVersion(version);
            new Notice(`Restored '${this.displayPath}' to version from ${date.toLocaleString()}`);
            this.close();
          } catch (error) {
            Logger.error("Failed to restore version:", error);
            new Notice(`Failed to restore version: ${error.message}`, 5000);
            button.disabled = false;
            button.setText("Restore");
          }
        });
    });
  }

  async restoreVersion(version: HistoryEntry) {
    const adapter = this.app.vault.adapter;

    const targetPath = version.filePath;

    Logger.info(`Attempting to restore to path: ${targetPath}`);
    Logger.debug(`Restoring version data: mtime=${version.mtime}, isBinary=${version.isBinary}, contentHash=${version.contentHash}`);

    try {
      await ensureFoldersExist(adapter, targetPath);

      const writeOptions = { mtime: version.mtime };

      if (version.isBinary) {
        if (!version.content) throw new Error("Binary content is missing for restore.");
        const buffer = base64ToArrayBuffer(version.content);
        await adapter.writeBinary(targetPath, buffer, writeOptions);
      } else {
        await adapter.write(targetPath, version.content ?? "", writeOptions);
      }

      this.plugin.contentHashCache.set(targetPath, version.contentHash);

      const abstractFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (abstractFile instanceof TFile) {
        Logger.info(`Version of ${targetPath} restored locally. Triggering modify event.`);

        this.app.metadataCache.trigger("changed", abstractFile);
        this.app.vault.trigger("modify", abstractFile);
      } else {
        const newlyCreatedFile = this.app.vault.getAbstractFileByPath(targetPath);
        if (newlyCreatedFile) {
          Logger.info(`File ${targetPath} created during restore. Triggering create event.`);
          this.app.vault.trigger("create", newlyCreatedFile);
        } else {
          Logger.warn(`Could not find abstract file for ${targetPath} after restore to trigger events.`);
        }
      }

      Logger.info(`Next sync will upload the restored version of ${targetPath}.`);
    } catch (error) {
      Logger.error(`Error during restore operation for ${targetPath}:`, error);
      throw new Error(`Could not write restored file: ${error.message}`);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
