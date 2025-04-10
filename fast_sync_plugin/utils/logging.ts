import { LogMessage } from "../types";

export class LogStore {
  private static instance: LogStore;
  private messages: LogMessage[] = [];
  private maxMessages = 100;
  private listeners: Set<() => void> = new Set();

  private constructor() {}

  static getInstance(): LogStore {
    if (!LogStore.instance) {
      LogStore.instance = new LogStore();
    }
    return LogStore.instance;
  }

  addMessage(level: "info" | "error" | "debug", message: string) {
    this.messages.push({
      timestamp: Date.now(),
      level,
      message,
    });

    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }

    this.listeners.forEach((listener) => listener());
  }

  addListener(callback: () => void) {
    this.listeners.add(callback);
  }

  removeListener(callback: () => void) {
    this.listeners.delete(callback);
  }

  getMessages(): LogMessage[] {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * Sets up console overrides to capture logs into LogStore.
 * Call this once during plugin initialization.
 * @param {boolean} verboseLogging - Whether to capture all log levels or just errors
 */
export function setupConsoleLogCapture(verboseLogging: boolean): void {
  const logStore = LogStore.getInstance();
  const originalConsole = {
    info: console.info,
    error: console.error,
    debug: console.debug,
    warn: console.warn,
    log: console.log,
  };

  console.log = (...args) => {
    if (verboseLogging) {
      logStore.addMessage("info", args.map(String).join(" "));
      originalConsole.log.apply(console, args);
    }
  };

  console.info = (...args) => {
    if (verboseLogging) {
      logStore.addMessage("info", args.map(String).join(" "));
      originalConsole.info.apply(console, args);
    }
  };

  console.warn = (...args) => {
    if (verboseLogging) {
      logStore.addMessage("error", `WARN: ${args.map(String).join(" ")}`);
      originalConsole.warn.apply(console, args);
    }
  };

  console.error = (...args) => {
    // Always capture errors regardless of verboseLogging setting
    logStore.addMessage("error", args.map(String).join(" "));
    originalConsole.error.apply(console, args);
  };

  console.debug = (...args) => {
    if (verboseLogging) {
      logStore.addMessage("debug", args.map(String).join(" "));
      originalConsole.debug.apply(console, args);
    }
  };

  console.info("Console log capture initialized.");
}
