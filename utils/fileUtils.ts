import { Vault } from "obsidian";

import { VaultAdapter } from "../types";
import { arrayBufferToBase64 } from "./encodingUtils";
import { Logger } from "./logging";

export function isImageFile(extension: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(extension.toLowerCase());
}

export function isTextFile(extension: string): boolean {
  return ["md", "txt", "json", "yaml", "yml", "js", "ts", "css", "html", "xml", "csv", "log"].includes(extension.toLowerCase());
}

export async function getFileContent(adapter: VaultAdapter, filePath: string): Promise<{ content: string; isBinary: boolean }> {
  const extension = filePath.split(".").pop()?.toLowerCase() || "";
  const isBinary = isImageFile(extension);

  if (isBinary) {
    const buffer = await adapter.readBinary(filePath);
    return { content: arrayBufferToBase64(buffer), isBinary: true };
  } else {
    const content = await adapter.read(filePath);
    return { content, isBinary: false };
  }
}

export async function getFileMTime(adapter: VaultAdapter, filePath: string): Promise<number> {
  try {
    const stat = await adapter.stat(filePath);
    return stat ? stat.mtime : 0;
  } catch (e) {
    Logger.warn(`Could not get mtime for ${filePath}:`, e);
    return 0;
  }
}

/**
 * Gets all relevant user files (markdown, images, etc.) from the vault.
 */
export async function getAllUserFiles(vault: Vault): Promise<string[]> {
  return vault
    .getFiles()
    .filter((file) => {
      const ext = file.extension.toLowerCase();

      const isSupportedType = isTextFile(ext) || isImageFile(ext);

      const isHidden = file.path.split("/").some((part) => part.startsWith("."));

      const isInObsidianDir = file.path.startsWith(vault.configDir);

      return isSupportedType && !isHidden && !isInObsidianDir;
    })
    .map((file) => file.path);
}

/**
 * Recursively gets specific plugin-related files (main.js, manifest.json, styles.css).
 */
export async function getPluginFiles(vault: Vault): Promise<string[]> {
  const files: string[] = [];
  const pluginDir = vault.configDir + "/plugins";

  async function recursivelyGetFiles(adapter: VaultAdapter, path: string): Promise<string[]> {
    const dirFiles: string[] = [];
    try {
      const contents = await adapter.list(path);

      for (const file of contents.files) {
        const basename = file.split("/").pop()?.toLowerCase() || "";
        if (["main.js", "manifest.json", "styles.css"].includes(basename)) {
          dirFiles.push(file);
        }
      }
      for (const subFolder of contents.folders) {
        const subFiles = await recursivelyGetFiles(adapter, subFolder);
        dirFiles.push(...subFiles);
      }
    } catch (error) {
      Logger.warn(`Error accessing path ${path} during plugin scan:`, error);
    }
    return dirFiles;
  }

  try {
    if (await vault.adapter.exists(pluginDir)) {
      const pluginFiles = await recursivelyGetFiles(vault.adapter, pluginDir);
      files.push(...pluginFiles);
    } else {
      Logger.info("Plugin directory not found, skipping plugin file scan.");
    }
  } catch (error) {
    Logger.error("Error scanning for plugin files:", error);
  }

  return files;
}

/**
 * Cleans up empty folders recursively within the vault.
 */
export async function cleanEmptyFolders(adapter: VaultAdapter, basePath: string = "/") {
  const isEmpty = async (folder: string): Promise<boolean> => {
    try {
      const listResult = await adapter.list(folder);
      if (!listResult) return true;

      if (listResult.files.length > 0) return false;

      for (const subFolder of listResult.folders) {
        if (!(await isEmpty(subFolder))) return false;
      }
      return true;
    } catch (e) {
      Logger.warn(`Error checking if folder is empty ${folder}:`, e);
      return false;
    }
  };

  const deleteIfEmpty = async (folder: string) => {
    if (folder === "/") return;
    if (await isEmpty(folder)) {
      try {
        await adapter.rmdir(folder, true);
        Logger.info(`Deleted empty folder: ${folder}`);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("ENOENT"))) {
          Logger.error(`Failed to delete folder ${folder}:`, error);
        }
      }
    }
  };

  const processFolder = async (folder: string) => {
    try {
      const contents = await adapter.list(folder);
      if (!contents) return;

      for (const subFolder of contents.folders) {
        const fullSubFolderPath = subFolder.startsWith("/") ? subFolder : `${folder === "/" ? "" : folder}/${subFolder}`;
        await processFolder(fullSubFolderPath);
      }

      await deleteIfEmpty(folder);
    } catch (e) {
      Logger.warn(`Error processing folder ${folder} for cleanup:`, e);
    }
  };

  Logger.info("Starting empty folder cleanup...");
  await processFolder(basePath);
  Logger.info("Folder cleanup complete.");
}

/**
 * Ensures parent directories exist for a given file path.
 */
export async function ensureFoldersExist(adapter: VaultAdapter, filePath: string): Promise<void> {
  const pathSegments = filePath.split("/");
  if (pathSegments.length <= 1) return;

  let currentPath = "";

  for (let i = 0; i < pathSegments.length - 1; i++) {
    currentPath += (i > 0 ? "/" : "") + pathSegments[i];
    if (currentPath === "") continue;

    try {
      if (!(await adapter.exists(currentPath))) {
        Logger.info("Creating folder:", currentPath);
        await adapter.mkdir(currentPath);
      }
    } catch (error) {
      Logger.error(`Failed to create folder ${currentPath}:`, error);

      throw new Error(`Failed to ensure folder structure for ${filePath}`);
    }
  }
}
