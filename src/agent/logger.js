/**
 * Centralized structured logger for Jev Chromium.
 * Dispatches logs to stdout and broadcasts via IPC to the frontend renderer.
 */
const { EventEmitter } = require('events');

class AgentLogger extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.maxLogs = 800;
  }

  log(level, category, message, details = null) {
    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false, fractionalSecondDigits: 3 }),
      timeMs: Date.now(),
      level, // 'info' | 'model' | 'action' | 'retry' | 'warn' | 'error'
      category, // 'AGENT' | 'MODEL' | 'BROWSER' | 'CDP' | 'NAV' | 'OBSERVE'
      message: String(message),
      details: details ? (typeof details === 'object' ? details : { raw: details }) : null,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console output for terminal debugging
    const tag = `[${entry.timestamp}] [${entry.category}]`;
    if (level === 'error') {
      console.error(tag, message, details || '');
    } else if (level === 'warn' || level === 'retry') {
      console.warn(tag, message, details || '');
    } else {
      console.log(tag, message, details || '');
    }

    this.emit('log', entry);
    return entry;
  }

  info(category, message, details = null) {
    return this.log('info', category, message, details);
  }

  model(category, message, details = null) {
    return this.log('model', category, message, details);
  }

  action(category, message, details = null) {
    return this.log('action', category, message, details);
  }

  retry(category, message, details = null) {
    return this.log('retry', category, message, details);
  }

  warn(category, message, details = null) {
    return this.log('warn', category, message, details);
  }

  error(category, message, details = null) {
    return this.log('error', category, message, details);
  }

  getLogs() {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
    this.emit('clear');
  }
}

const logger = new AgentLogger();

module.exports = {
  AgentLogger,
  logger,
};
