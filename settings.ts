import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import FastSyncPlugin from "./main";

export class FastSyncSettingTab extends PluginSettingTab {
  plugin: FastSyncPlugin;

  constructor(app: App, plugin: FastSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Fast Sync Settings" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The base URL of your Fast Sync server (e.g., http://localhost:32400)")
      .addText((text) =>
        text
          .setPlaceholder("Enter server URL")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim().replace(/\/$/, "");
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("The secret API key for authentication with the server.")
      .addText((text) =>
        text
          .setPlaceholder("Enter API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Identifier for this vault on the server. Defaults to vault name.")
      .addText((text) =>
        text
          .setPlaceholder("Enter vault ID")
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            const trimmedValue = value.trim();
            if (trimmedValue) {
              this.plugin.settings.vaultId = trimmedValue;
            } else {
              this.plugin.settings.vaultId = this.app.vault.getName();
              text.setValue(this.plugin.settings.vaultId);
              new Notice("Vault ID cannot be empty. Reset to vault name.");
            }
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Sync Interval")
      .setDesc("How often to automatically sync (in seconds). Minimum 5 seconds.")
      .addText((text) =>
        text
          .setPlaceholder("e.g., 60")
          .setValue(this.plugin.settings.syncInterval.toString())
          .onChange(async (value) => {
            let interval = parseInt(value);
            if (isNaN(interval) || interval < 5) {
              interval = 5;
              new Notice("Sync interval must be at least 5 seconds.");
            }
            this.plugin.settings.syncInterval = interval;
            text.setValue(interval.toString());
            await this.plugin.saveSettings();
            this.plugin.rescheduleSync();
          }),
      );

    new Setting(containerEl)
      .setName("Full Rehash Interval")
      .setDesc(
        "How often (in minutes) to clear the local hash cache and re-check all files against the server. Helps catch inconsistencies. Minimum 5 minutes.",
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g., 15")
          .setValue(this.plugin.settings.fullRehashInterval.toString())
          .onChange(async (value) => {
            let interval = parseInt(value);
            if (isNaN(interval) || interval < 5) {
              interval = 5;
              new Notice("Full rehash interval must be at least 5 minutes.");
            }
            this.plugin.settings.fullRehashInterval = interval;
            text.setValue(interval.toString());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum File Size (MB)")
      .setDesc("Files larger than this size (in megabytes) will be skipped during sync. Minimum 1 MB.")
      .addText((text) =>
        text
          .setPlaceholder("e.g., 100")
          .setValue(this.plugin.settings.maxFileSizeMB.toString())
          .onChange(async (value) => {
            let size = parseInt(value);
            if (isNaN(size) || size < 1) {
              size = 1;
              new Notice("Maximum file size must be at least 1 MB.");
            }
            this.plugin.settings.maxFileSizeMB = size;
            text.setValue(size.toString());
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync Plugins")
      .setDesc("Enable syncing of installed plugin files (main.js, manifest.json, styles.css). Requires Obsidian restart after changing.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncPlugins).onChange(async (value) => {
          this.plugin.settings.syncPlugins = value;
          await this.plugin.saveSettings();
          new Notice("Plugin sync setting changed. Please restart Obsidian for it to take full effect.", 5000);
        }),
      );

    containerEl.createEl("h3", { text: "Encryption" });

    new Setting(containerEl)
      .setName("Encryption Password")
      .setDesc(
        'Password used to encrypt your data before sending it to the server. Setting or changing this requires a "Force Push" to encrypt existing data or re-encrypt with the new password. Losing this password means losing access to your encrypted data! Leave blank to disable encryption.',
      )
      .addText((text) =>
        text
          .setPlaceholder("Leave blank for no encryption")
          .setValue(this.plugin.settings.encryptionPassword)
          .onChange(async (value) => {
            text.inputEl.onblur = async () => {
              const newPassword = text.getValue();
              if (this.plugin.settings.encryptionPassword !== newPassword) {
                const oldPassword = this.plugin.settings.encryptionPassword;
                this.plugin.settings.encryptionPassword = newPassword;
                await this.plugin.saveSettings();

                try {
                  await this.plugin.handleEncryptionPasswordChange(oldPassword, newPassword);
                  if (newPassword && !oldPassword) {
                    new Notice('Encryption enabled. Please perform a "Force Push" to encrypt your vault on the server.', 10000);
                  } else if (!newPassword && oldPassword) {
                    new Notice('Encryption disabled. Please perform a "Force Push" to store decrypted data on the server.', 10000);
                  } else if (newPassword && oldPassword) {
                    new Notice('Encryption password changed. Please perform a "Force Push" to re-encrypt your vault on the server.', 10000);
                  }
                } catch (error) {
                  new Notice(`Error initializing encryption: ${error.message}`, 10000);
                }
              }
            };
          }),
      );

    containerEl.createEl("h3", { text: "Manual Actions & Status" });

    new Setting(containerEl)
      .setName("Sync Status")
      .setDesc("Pause or resume automatic background synchronization.")
      .addToggle((toggle) => {
        const updateStatus = () => {
          toggle.setValue(!this.plugin.syncPaused);

          const descEl = toggle.toggleEl.querySelector(".setting-item-description");
          if (descEl) {
            descEl.textContent = this.plugin.syncPaused ? "Sync is currently PAUSED." : "Sync is currently ACTIVE.";
          }
        };
        toggle.onChange(async (value) => {
          this.plugin.syncPaused = !value;
          updateStatus();
          new Notice(value ? "Sync resumed" : "Sync paused");

          this.plugin.updateStatusBar();
        });

        updateStatus();
      });

    new Setting(containerEl)
      .setName("Force Push State")
      .setDesc("Overwrite server state with local state. Deletes files on server not present locally. Use with caution!")
      .addButton((button) =>
        button
          .setButtonText("Force Push")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Pushing...");
            try {
              await this.plugin.forcePushStateToServer();
              new Notice("Force push initiated. Check logs for details.");
            } catch (e) {
              new Notice(`Force push failed: ${e.message}`, 10000);
            } finally {
              button.setDisabled(false).setButtonText("Force Push");
            }
          }),
      );

    new Setting(containerEl)
      .setName("Force Pull State")
      .setDesc("Overwrite local state with server state. Deletes local files not present on server. Use with caution!")
      .addButton((button) =>
        button
          .setButtonText("Force Pull")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Pulling...");
            try {
              await this.plugin.forcePullStateFromServer();
              new Notice("Force pull initiated. Check logs for details.");
            } catch (e) {
              new Notice(`Force pull failed: ${e.message}`, 10000);
            } finally {
              button.setDisabled(false).setButtonText("Force Pull");
            }
          }),
      );

    containerEl.createEl("h3", { text: "Troubleshooting & Logging" });

    new Setting(containerEl)
      .setName("Verbose Logging")
      .setDesc("Enable detailed logging with access to the log viewer. When disabled, only error logs are emitted to the console.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableVerboseLogging).onChange(async (value) => {
          const oldValue = this.plugin.settings.enableVerboseLogging;
          this.plugin.settings.enableVerboseLogging = value;
          await this.plugin.saveSettings();

          if (oldValue !== value) {
            new Notice(`Verbose logging ${value ? "enabled" : "disabled"}. Plugin reload required for this change to take effect.`, 5000);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Clean Empty Folders")
      .setDesc("Manually run the process to remove empty folders within your vault.")
      .addButton((button) =>
        button.setButtonText("Clean Now").onClick(async () => {
          button.setDisabled(true).setButtonText("Cleaning...");
          try {
            await this.plugin.runCleanEmptyFolders();
            new Notice("Empty folder cleanup complete.");
          } catch (e) {
            new Notice(`Folder cleanup failed: ${e.message}`, 5000);
          } finally {
            button.setDisabled(false).setButtonText("Clean Now");
          }
        }),
      );
  }
}
