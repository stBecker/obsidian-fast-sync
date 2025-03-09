import { App, ButtonComponent, FuzzySuggestModal, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, Vault } from 'obsidian';

export interface FileContent {
	fileId: string;
	hash: string;
	mtime: number;
	deleted: boolean;
	content: string;
}

// implements an interface for the remote state API
// the API returns a map of fileId -> {hash, mtime, deleted}
interface FileMetadata {
	hash: string;
	mtime: number;
	deleted: boolean;
}

interface RemoteState {
	[fileId: string]: FileMetadata;
}


interface HistoryEntry extends FileContent {
	version_time: string;
}

export class FileHistoryModal extends FuzzySuggestModal<string> {
	plugin: SimpleSyncPlugin;
	files: string[] = [];

	constructor(app: App, plugin: SimpleSyncPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("Select a file to view history");
		this.loadFiles();
	}

	async loadFiles() {
		try {
			this.files = await this.plugin.getAllFilesFromServer();
			this.setInstructions([
				{ command: "↑↓", purpose: "to navigate" },
				{ command: "↵", purpose: "to select" },
				{ command: "esc", purpose: "to dismiss" }
			]);
		} catch (error) {
			new Notice("Failed to load files: " + error);
			this.close();
		}
	}

	getItems(): string[] {
		return this.files;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
		new FileVersionsModal(this.app, this.plugin, item).open();
	}
}

export class FileVersionsModal extends Modal {
	plugin: SimpleSyncPlugin;
	fileId: string;
	versions: HistoryEntry[] = [];
	contentEl: HTMLElement;

	constructor(app: App, plugin: SimpleSyncPlugin, fileId: string) {
		super(app);
		this.plugin = plugin;
		this.fileId = fileId;
	}

	async onOpen() {
		const { contentEl } = this;
		this.contentEl = contentEl;

		contentEl.createEl("h2", { text: "Version History" });
		contentEl.createEl("p", { text: `File: ${this.fileId}` });

		const loadingEl = contentEl.createEl("p", { text: "Loading versions..." });

		try {
			this.versions = await this.plugin.getFileHistory(this.fileId);
			loadingEl.remove();
			this.displayVersions();
		} catch (error) {
			loadingEl.setText("Failed to load versions: " + error);
		}
	}

	displayVersions() {
		if (this.versions.length === 0) {
			this.contentEl.createEl("p", { text: "No history found for this file." });
			return;
		}

		const container = this.contentEl.createDiv({ cls: "history-container" });

		container.createEl("style", {
			text: `
                .history-container {
                    max-height: 400px;
                    overflow-y: auto;
                }
                .version-item {
                    border-bottom: 1px solid var(--background-modifier-border);
                    padding: 10px 0;
                    margin-bottom: 10px;
                }
                .version-header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 5px;
                }
                .version-content {
                    border: 1px solid var(--background-modifier-border);
                    padding: 10px;
                    margin-top: 10px;
                    max-height: 200px;
                    overflow-y: auto;
                    display: none;
                }
                .version-content.active {
                    display: block;
                }
            `
		});

		// Create items for each version
		this.versions.forEach((version, index) => {
			const item = container.createDiv({ cls: "version-item" });

			const header = item.createDiv({ cls: "version-header" });
			const date = new Date(version.version_time);

			header.createEl("div", {
				text: `Version ${index + 1} - ${date.toLocaleString()}`
			});

			const buttonRow = header.createDiv();

			// Toggle content button
			const toggleBtn = new ButtonComponent(buttonRow)
				.setButtonText("View")
				.onClick(() => {
					const content = item.querySelector(".version-content");
					if (content) {
						content.classList.toggle("active");
					}
					toggleBtn.setButtonText(
						content?.classList.contains("active") ? "Hide" : "View"
					);
				});

			// Restore button
			if (index > 0) { // Don't allow restoring the most recent version
				new ButtonComponent(buttonRow)
					.setButtonText("Restore")
					.onClick(async () => {
						try {
							await this.restoreVersion(version);
							new Notice("Version restored successfully");
							this.close();
						} catch (error) {
							new Notice("Failed to restore version: " + error);
						}
					});
			}

			// Version content (initially hidden)
			const content = item.createDiv({ cls: "version-content" });
			content.createEl("pre", { text: version.content });
		});
	}

	async restoreVersion(version: HistoryEntry) {
		// First check if the file exists locally
		const file = this.app.vault.getFileByPath(this.fileId);

		if (file) {
			// File exists, modify it
			await this.app.vault.modify(file, version.content);
		} else {
			// File doesn't exist, create it
			// First ensure all parent folders exist
			const path = this.fileId.split('/');
			const fileName = path.pop();
			let folderPath = '';

			for (const folder of path) {
				folderPath += folder;
				const exists = this.app.vault.getAbstractFileByPath(folderPath);
				if (!exists) {
					await this.app.vault.createFolder(folderPath);
				}
				folderPath += '/';
			}

			await this.app.vault.create(this.fileId, version.content);
		}

		// Force a sync
		await this.plugin.sync();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}


export async function hashFile(file: TFile): Promise<string> {
	const content = await file.vault.read(file);
	const msgBuffer = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getAllFiles(vault: Vault): Promise<TFile[]> {
	return vault.getAllLoadedFiles()
		.filter(file => file instanceof TFile &&
			(file.extension === 'md' || isImageFile(file.extension))) as TFile[];
}

export function isImageFile(extension: string): boolean {
	return ['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(extension.toLowerCase());
}


interface SimpleSyncPluginSettings {
	serverUrl: string;
	apiKey: string;
	syncInterval: number; // in seconds
	lastSync: number;
	deletionQueue: string[];
	vaultId: string;
	fullRehashInterval: number; // in minutes
}

const DEFAULT_SETTINGS: SimpleSyncPluginSettings = {
	serverUrl: '',
	apiKey: '',
	syncInterval: 60, // in seconds
	lastSync: 0,
	deletionQueue: [],
	vaultId: '',
	fullRehashInterval: 15 // 15 minutes default
}

interface HashCacheEntry {
	hash: string;
	timestamp: number;
}

class HashCache {
	private cache: Map<string, HashCacheEntry> = new Map();
	private readonly CACHE_LIFETIME = 3600000; // 1 hour in milliseconds

	set(path: string, hash: string) {
		this.cache.set(path, {
			hash: hash,
			timestamp: Date.now()
		});
	}

	get(path: string): string | null {
		const entry = this.cache.get(path);
		if (!entry) return null;

		// Return null if cache entry is too old
		if (Date.now() - entry.timestamp > this.CACHE_LIFETIME) {
			this.cache.delete(path);
			return null;
		}

		return entry.hash;
	}

	invalidate(path: string) {
		this.cache.delete(path);
	}

	clear() {
		this.cache.clear();
	}
}

export default class SimpleSyncPlugin extends Plugin {
	settings: SimpleSyncPluginSettings;
	statusBarItemEl: HTMLElement;
	syncPaused: boolean = false;
	private hashCache: HashCache;
	private lastFullRehash: number = 0;
	private syncing: boolean = false;

	async onload() {
		this.hashCache = new HashCache();
		await this.loadSettings();
		if (!this.settings.vaultId) {
			this.settings.vaultId = this.app.vault.getName();
			await this.saveSettings();
		}

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.setText('Last sync: Never');

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SimpleSyncSettingTab(this.app, this));

		// Register event to handle file deletions
		this.registerEvent(this.app.vault.on('delete', this.handleFileDeletion.bind(this)));
		this.registerEvent(this.app.vault.on('rename', this.handleFileRename.bind(this)));

		// Register event to invalidate hash cache on file modification
		this.registerEvent(
			this.app.vault.on('modify', file => {
				if (file instanceof TFile) {
					this.hashCache.invalidate(file.path);
				}
			})
		);

		// Start the sync loop
		this.registerInterval(window.setInterval(() => this.sync(), this.settings.syncInterval * 1000));

		this.addRibbonIcon('clock', 'View File History', () => {
			new FileHistoryModal(this.app, this).open();
		});

		this.addCommand({
			id: 'open-file-history-modal',
			name: 'Open File History Browser',
			callback: () => {
				new FileHistoryModal(this.app, this).open();
			}
		});
		this.addCommand({
			id: 'view-current-file-history',
			name: 'View History for Current File',
			checkCallback: (checking) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					if (!checking) {
						new FileVersionsModal(this.app, this, activeFile.path).open();
					}
					return true;
				}
				return false;
			}
		});
	}

	onunload() {
		// Clear any intervals or listeners
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async resync() {
		console.info('Starting resync...');

		// Get local and remote state
		console.info('Fetching remote state...');
		const remoteState = await this.downloadState();
		const remoteFiles = Object.keys(remoteState);
		console.info(`Found ${remoteFiles.length} files on remote`);

		console.info('Getting local files...');
		const localFiles = await getAllFiles(this.app.vault);
		console.info(`Found ${localFiles.length} files locally`);

		// Mark all remote-only files for deletion
		const remoteOnly = remoteFiles.filter(file => !localFiles.map(file => file.path).includes(file));
		console.info(`Found ${remoteOnly.length} files to delete from remote`);

		for (const fileId of remoteOnly) {
			console.debug(`Marking ${fileId} for deletion`);
			this.settings.deletionQueue.push(fileId);
		}
		await this.saveSettings();

		// Upload all local files
		console.info('Preparing to upload all local files...');
		const uploads: FileContent[] = [];
		for (const file of localFiles) {
			console.debug(`Processing ${file.path}`);
			const hash = await hashFile(file);
			uploads.push({
				fileId: file.path,
				hash: hash,
				mtime: file.stat.mtime,
				content: await this.app.vault.read(file),
				deleted: false
			});
		}

		// Upload changes
		console.info(`Uploading ${uploads.length} files...`);
		await this.uploadChanges(uploads);
		console.info('File upload complete');

		// Process deletions
		if (this.settings.deletionQueue.length > 0) {
			console.info(`Processing ${this.settings.deletionQueue.length} deletions...`);
			await this.uploadChanges(this.settings.deletionQueue.map(fileId => ({
				fileId: fileId,
				hash: '',
				mtime: Date.now(),
				content: '',
				deleted: true
			})));
			this.settings.deletionQueue = [];
			await this.saveSettings();
			console.info('Deletions complete');
		}

		console.info('Resync complete');
		new Notice('Resync complete');
		this.statusBarItemEl.setText('Last sync: ' + new Date().toLocaleTimeString());
	}

	async sync() {
		if (this.syncPaused) {
			this.statusBarItemEl.setText('Sync paused');
			return;
		}

		if (this.syncing) {
			console.info('Sync already in progress, skipping...');
			return;
		}

		this.syncing = true;
		try {
			// Check if we need to do a full rehash
			if (Date.now() - this.lastFullRehash > this.settings.fullRehashInterval * 60000) {
				console.info('Performing periodic full rehash...');
				this.hashCache.clear();
				this.lastFullRehash = Date.now();
			}

			this.statusBarItemEl.setText('Syncing...');
			console.info('Syncing...');
			const files = await getAllFiles(this.app.vault);

			console.info('Number of files:', files.length);
			console.debug('Files:', files.map(file => file.path));
			console.debug('Deletion queue:', this.settings.deletionQueue);

			if (this.settings.deletionQueue.length > 0) {
				await this.uploadChanges(this.settings.deletionQueue.map(fileId => ({
					fileId: fileId,
					hash: '',
					mtime: Date.now(),
					content: '',
					deleted: true
				})));
				this.settings.deletionQueue = [];
				await this.saveSettings();
			}

			console.info('Downloading remote changes...');
			const remoteChanges = await this.downloadState();

			const toUpload: FileContent[] = [];
			const toDownload: string[] = [];

			console.info('Checking for changes...');
			const checkStart = performance.now();
			for (const file of files) {
				let hash = this.hashCache.get(file.path);
				if (!hash) {
					hash = await hashFile(file);
					this.hashCache.set(file.path, hash);
				}

				const remoteFile = remoteChanges[file.path];
				if (!remoteFile) {
					// File does not exist on server
					toUpload.push({
						fileId: file.path,
						hash: hash,
						mtime: file.stat.mtime,
						content: await this.app.vault.read(file),
						deleted: false
					});

				}
				else if (remoteFile.hash !== hash) {
					// File has changed
					// Rehash the file
					hash = await hashFile(file);
					this.hashCache.set(file.path, hash);

					if (remoteFile.hash !== hash) {
						// Check if the remote or local file is newer
						if (remoteFile.mtime > file.stat.mtime) {
							// Remote file is newer
							toDownload.push(file.path);
						} else {
							// Local file is newer		
							toUpload.push({
								fileId: file.path,
								hash: hash,
								mtime: file.stat.mtime,
								content: await this.app.vault.read(file),
								deleted: false
							});
						}
					}
				}
			}
			const totalCheckTime = performance.now() - checkStart;
			console.info(`Change detection completed in ${totalCheckTime.toFixed(2)}ms`);
			console.info('Found local changes:', toUpload.length, 'remote changes:', toDownload.length);
			console.info('Checking for remote-only files...');
			const remoteFiles = Object.keys(remoteChanges);
			const localFiles = files.map(file => file.path);
			const remoteOnly = remoteFiles.filter(file => !localFiles.includes(file));
			for (const fileId of remoteOnly) {
				const remoteFile = remoteChanges[fileId];
				if (!remoteFile.deleted) {
					toDownload.push(fileId);
				}
			}

			console.info('Uploading changes:', toUpload.length);
			if (toUpload.length > 0) {
				await this.uploadChanges(toUpload);
			}

			console.info('Downloading remote files:', toDownload.length);
			if (toDownload.length > 0) {
				const remoteFiles = await this.downloadFiles(toDownload);
				console.debug(remoteFiles);
				console.info('Processing remote files...');
				for (const file of remoteFiles) {
					// check if the file was marked as deleted
					if (file.deleted) {
						// delete the file locally
						console.info('Deleting file:', file.fileId);
						const localFile = this.app.vault.getFileByPath(file.fileId);
						if (localFile) {
							await this.app.vault.delete(localFile);
						}
					} else {
						// update the file locally
						const localFile = this.app.vault.getFileByPath(file.fileId);
						// if the file does not exist locally, create it recursively
						if (!localFile) {
							console.info('Creating file:', file.fileId);
							// check if folders exist, if not create them
							const path = file.fileId.split('/');
							let folderPath = '';
							for (let i = 0; i < path.length - 1; i++) {
								folderPath += path[i];
								const folder = this.app.vault.getFileByPath(folderPath);
								if (!folder) {
									console.info('Creating folder:', folderPath);
									await this.app.vault.createFolder(folderPath);
								}
								folderPath += '/';
							}
							// create the file	
							await this.app.vault.create(file.fileId, file.content);
						} else {
							console.info('Updating file:', file.fileId);
							await this.app.vault.modify(localFile, file.content);
						}
					}
				}
			}

			this.settings.lastSync = Date.now();
			await this.saveSettings();
			console.info('Sync complete');
			this.statusBarItemEl.setText('Last sync: ' + new Date().toLocaleTimeString());
		} catch (error) {
			this.statusBarItemEl.setText('Sync failed');
			console.error('Sync error:', error);
		} finally {
			this.syncing = false;
		}
	}

	private async uploadChanges(toUpload: FileContent[]) {
		const response = await fetch(`${this.settings.serverUrl}/v1/${this.settings.vaultId}/uploadChanges`, {
			method: 'POST',
			headers: {
				'Accept-Encoding': 'gzip',
				'Content-Type': 'application/json',
				'X-API-Key': this.settings.apiKey
			},
			body: JSON.stringify({ "data": toUpload })
		});

		if (!response.ok) {
			throw new Error(`Upload failed: ${response.statusText}`);
		}
	}

	private async handleFileDeletion(file: TFile) {
		this.settings.deletionQueue.push(file.path);
		this.hashCache.invalidate(file.path);
		await this.saveSettings();
	}

	private async handleFileRename(file: TFile, oldPath: string) {
		this.settings.deletionQueue.push(oldPath);
		this.hashCache.invalidate(file.path);
		await this.saveSettings();
	}

	private async downloadState(): Promise<RemoteState> {
		const response = await fetch(
			`${this.settings.serverUrl}/v1/${this.settings.vaultId}/state`,
			{
				headers: {
					'Accept-Encoding': 'gzip',
					'X-API-Key': this.settings.apiKey,
					'Content-Encoding': 'gzip',
				}
			}
		);

		if (!response.ok) {
			throw new Error(`Download failed: ${response.statusText}`);
		}

		return await response.json().then((data) => {
			console.debug(data);
			return data.state;
		});
	}

	private async downloadFiles(files: string[]): Promise<FileContent[]> {
		const response = await fetch(`${this.settings.serverUrl}/v1/${this.settings.vaultId}/downloadFiles`, {
			method: 'POST',
			headers: {
				'Accept-Encoding': 'gzip',
				'Content-Encoding': 'gzip',
				'Content-Type': 'application/json',
				'X-API-Key': this.settings.apiKey
			},
			body: JSON.stringify({ files })
		});

		if (!response.ok) {
			throw new Error(`Download failed: ${response.statusText}`);
		}

		return await response.json().then((data) => {
			console.debug(data);
			return data.files;
		});
	}

	async getAllFilesFromServer(): Promise<string[]> {
		const response = await fetch(
			`${this.settings.serverUrl}/v1/${this.settings.vaultId}/allFiles`,
			{
				headers: {
					'Accept-Encoding': 'gzip',
					'Content-Encoding': 'gzip',
					'X-API-Key': this.settings.apiKey
				}
			}
		);

		if (!response.ok) {
			throw new Error(`Failed to get files: ${response.statusText}`);
		}

		return await response.json();
	}

	async getFileHistory(fileId: string): Promise<HistoryEntry[]> {
		const encodedFileId = encodeURIComponent(fileId);
		const response = await fetch(
			`${this.settings.serverUrl}/v1/${this.settings.vaultId}/fileHistory/${encodedFileId}`,
			{
				headers: {
					'Accept-Encoding': 'gzip',
					'Content-Encoding': 'gzip',
					'X-API-Key': this.settings.apiKey
				}
			}
		);

		if (!response.ok) {
			throw new Error(`Failed to get file history: ${response.statusText}`);
		}

		return await response.json();
	}
}


class SimpleSyncSettingTab extends PluginSettingTab {
	plugin: SimpleSyncPlugin;

	constructor(app: App, plugin: SimpleSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Server URL')
			.setDesc('The URL of the sync server')
			.addText(text => text
				.setPlaceholder('Enter server URL')
				.setValue(this.plugin.settings.serverUrl)
				.onChange(async (value) => {
					this.plugin.settings.serverUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('The API key for authentication')
			.addText(text => text
				.setPlaceholder('Enter API key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Interval')
			.setDesc('The interval (in seconds) at which to sync')
			.addText(text => text
				.setPlaceholder('Enter sync interval')
				.setValue(this.plugin.settings.syncInterval.toString())
				.onChange(async (value) => {
					this.plugin.settings.syncInterval = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Pause Sync')
			.setDesc('Pause the sync process')
			.addButton(button => button
				.setButtonText('Pause')
				.setCta()
				.onClick(async () => {
					this.plugin.syncPaused = true;
					new Notice('Sync paused');
				}));

		new Setting(containerEl)
			.setName('Resume Sync')
			.setDesc('Resume the sync process')
			.addButton(button => button
				.setButtonText('Resume')
				.setCta()
				.onClick(async () => {
					this.plugin.syncPaused = false;
					new Notice('Sync resumed');
				}));

		new Setting(containerEl)
			.setName('Force Resync')
			.setDesc('Push local state to the remote server')
			.addButton(button => button
				.setButtonText('Resync')
				.setCta()
				.onClick(async () => {
					await this.plugin.resync();
					new Notice('Resync initiated');
				}));

		new Setting(containerEl)
			.setName('Vault ID')
			.setDesc('The ID of the vault to sync')
			.addText(text => text
				.setPlaceholder('Enter vault ID')
				.setValue(this.plugin.settings.vaultId)
				.onChange(async (value) => {
					this.plugin.settings.vaultId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Full Rehash Interval')
			.setDesc('How often (in minutes) to perform a full rehash of all files')
			.addText(text => text
				.setPlaceholder('Enter full rehash interval')
				.setValue(this.plugin.settings.fullRehashInterval.toString())
				.onChange(async (value) => {
					const interval = parseInt(value);
					if (!isNaN(interval) && interval > 0) {
						this.plugin.settings.fullRehashInterval = interval;
						await this.plugin.saveSettings();
					}
				}));
	}
}
