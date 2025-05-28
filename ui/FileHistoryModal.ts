import { App, FuzzyMatch, FuzzySuggestModal, Notice } from "obsidian";

import FastSyncPlugin from "../main";
import { FileListEntry, StableFileId } from "../types";
import { FileVersionsModal } from "./FileVersionsModal";
import { Logger } from "../utils/logging";

interface HistoryFileItem {
  stableId: StableFileId;
  plaintextPath: string;
}

export class FileHistoryModal extends FuzzySuggestModal<HistoryFileItem> {
  plugin: FastSyncPlugin;
  fileItems: HistoryFileItem[] = [];
  isLoading: boolean = true;

  constructor(app: App, plugin: FastSyncPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Loading files from server...");
    this.loadFiles();
    this.scope.register([], "Escape", this.close.bind(this));
  }

  async loadFiles() {
    this.isLoading = true;
    this.fileItems = [];

    try {
      const serverFiles: FileListEntry[] = await this.plugin.getAllFilesFromServer();

      const decryptedItems: HistoryFileItem[] = [];
      for (const entry of serverFiles) {
        const plaintextPath = await this.plugin.tryDecryptPath(entry.currentEncryptedFilePath);
        if (plaintextPath) {
          decryptedItems.push({
            stableId: entry.stableId,
            plaintextPath: plaintextPath,
          });
        } else {
          Logger.warn(`Could not decrypt path for stableId ${entry.stableId.substring(0, 10)}...`);
        }
      }

      this.fileItems = decryptedItems.sort((a, b) => a.plaintextPath.localeCompare(b.plaintextPath));

      this.isLoading = false;
      this.setPlaceholder("Select a file to view its history");
    } catch (error) {
      Logger.error("Failed to load files for history:", error);
      new Notice(`Failed to load files: ${error.message}`);
      this.close();
    }
  }

  getItems(): HistoryFileItem[] {
    return this.fileItems;
  }

  getItemText(item: HistoryFileItem): string {
    return item.plaintextPath;
  }

  renderSuggestion(item: FuzzyMatch<HistoryFileItem>, el: HTMLElement): void {
    el.setText(item.item.plaintextPath);
  }

  onOpen() {
    super.onOpen();
    if (!this.isLoading) {
      this.setInstructions([
        { command: "↑↓", purpose: "to navigate" },
        { command: "↵", purpose: "to select" },
        { command: "esc", purpose: "to dismiss" },
      ]);
    }
    this.inputEl.focus();
  }

  onChooseItem(item: HistoryFileItem, evt: MouseEvent | KeyboardEvent): void {
    if (this.isLoading) return;

    new FileVersionsModal(this.app, this.plugin, item.stableId, item.plaintextPath).open();
  }
}
