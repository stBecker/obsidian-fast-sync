import { App, ButtonComponent, Modal } from "obsidian";

import { LogStore } from "../utils/logging";

export class LogViewerModal extends Modal {
  private logContainer: HTMLElement;
  private updateCallback: () => void;
  private logStore: LogStore;
  private isAutoScrollActive: boolean = true;
  private autoScrollButton: ButtonComponent;

  constructor(app: App) {
    super(app);
    this.logStore = LogStore.getInstance();
    this.updateCallback = this.refreshLogs.bind(this);
    this.modalEl.addClass("fast-sync-modal");
    this.modalEl.addClass("fast-sync-log-viewer-modal");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Fast Sync Log" });

    const controlsContainer = contentEl.createDiv("fast-sync-log-controls");
    const buttonContainer = controlsContainer.createDiv("button-container");

    new ButtonComponent(buttonContainer)
      .setButtonText("Clear Logs")
      .setTooltip("Clear all currently displayed logs")
      .onClick(() => {
        this.logStore.clear();
        this.refreshLogs();
      });

    this.autoScrollButton = new ButtonComponent(buttonContainer)
      .setButtonText("Auto-Scroll")
      .setTooltip("Toggle automatic scrolling to the latest log entry")
      .setClass("auto-scroll-toggle")
      .onClick(() => {
        this.isAutoScrollActive = !this.isAutoScrollActive;
        this.autoScrollButton.buttonEl.toggleClass("is-active", this.isAutoScrollActive);
        if (this.isAutoScrollActive) {
          this.scrollToBottom();
        }
      });

    this.autoScrollButton.buttonEl.toggleClass("is-active", this.isAutoScrollActive);
    this.logContainer = contentEl.createDiv("fast-sync-log-viewer-container");
    this.refreshLogs();
    this.logStore.addListener(this.updateCallback);
  }

  refreshLogs() {
    if (!this.logContainer || !this.logContainer.isConnected) {
      this.logStore.removeListener(this.updateCallback);
      return;
    }

    const shouldScroll =
      this.isAutoScrollActive && this.logContainer.scrollHeight - this.logContainer.scrollTop - this.logContainer.clientHeight < 50;

    this.logContainer.empty();
    const logs = this.logStore.getMessages();

    if (logs.length === 0) {
      this.logContainer.createEl("p", {
        text: "Log is empty.",
        cls: "empty-log-message",
      });
      return;
    }

    const fragment = document.createDocumentFragment();
    logs.forEach((log) => {
      const entryEl = fragment.createDiv({ cls: "fast-sync-log-entry" });
      entryEl.createSpan({
        cls: "log-timestamp",
        text: `[${new Date(log.timestamp).toLocaleTimeString()}]`,
      });

      entryEl.createSpan({
        cls: `log-level log-level-${log.level.toUpperCase()}`,
        text: `[${log.level.toUpperCase()}]`,
      });
      entryEl.createSpan({ cls: "log-message", text: ` ${log.message}` });
    });
    this.logContainer.appendChild(fragment);

    if (shouldScroll) {
      this.scrollToBottom();
    }
  }

  scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this.logContainer && this.logContainer.isConnected) {
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
      }
    });
  }

  onClose() {
    this.logStore.removeListener(this.updateCallback);
    const { contentEl } = this;
    contentEl.empty();
  }
}
