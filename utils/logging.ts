import { LogMessage, LogLevel } from "../types";

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

  addMessage(level: LogLevel, message: string) {
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

export class Logger {
  private static verboseLoggingEnabled: boolean = false;
  private static logStore = LogStore.getInstance();

  static setup(verboseLogging: boolean): void {
    Logger.verboseLoggingEnabled = verboseLogging;
    Logger.info("Logger initialized.");
  }

  private static log(level: LogLevel, ...args: any[]): void {
    const shouldEmitMessage = level === "error" || Logger.verboseLoggingEnabled;
    if (!shouldEmitMessage) return;

    const message = args.map(String).join(" ");
    Logger.logStore.addMessage(level, message);
    // Also output to the actual console
    switch (level) {
      case "info":
        console.info(...args);
        break;
      case "error":
        console.error(...args);
        break;
      case "debug":
        console.debug(...args);
        break;
      case "warn":
        console.warn(...args);
        break;
      default:
        console.log(...args);
    }
  }

  static info(...args: any[]): void {
    Logger.log("info", ...args);
  }

  static error(...args: any[]): void {
    Logger.log("error", ...args);
  }

  static debug(...args: any[]): void {
    Logger.log("debug", ...args);
  }

  static warn(...args: any[]): void {
    Logger.log("warn", ...args);
  }
}
