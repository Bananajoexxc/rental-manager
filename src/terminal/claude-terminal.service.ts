/**
 * Claude Terminal Service — manages a persistent PTY session for Claude CLI.
 *
 * Single-session (dashboard is single-user). When the WebSocket disconnects,
 * the PTY keeps running. On reconnect, the scrollback buffer is replayed.
 *
 * Based on project-hub's lib/claude-bridge.js pattern.
 */
import { Logger } from '@nestjs/common';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

const MAX_SCROLLBACK_BYTES = 256 * 1024; // 256KB
const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours idle → kill
const ORPHAN_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours detached → kill

interface Session {
  pty: pty.IPty;
  ws: WebSocket | null;
  scrollback: string[];
  scrollbackBytes: number;
  status: 'active' | 'idle' | 'detached' | 'exited';
  lastActivity: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  exitCode: number | null;
}

export class ClaudeTerminalService {
  private readonly logger = new Logger('ClaudeTerminal');
  private session: Session | null = null;

  private appendScrollback(data: string): void {
    if (!this.session) return;
    this.session.scrollback.push(data);
    this.session.scrollbackBytes += Buffer.byteLength(data);
    while (this.session.scrollbackBytes > MAX_SCROLLBACK_BYTES && this.session.scrollback.length > 1) {
      const removed = this.session.scrollback.shift()!;
      this.session.scrollbackBytes -= Buffer.byteLength(removed);
    }
  }

  private sendToClient(msg: any): void {
    if (this.session?.ws && this.session.ws.readyState === 1) {
      try { this.session.ws.send(JSON.stringify(msg)); } catch { /* disconnected */ }
    }
  }

  private resetInactivityTimer(): void {
    if (!this.session) return;
    this.session.lastActivity = Date.now();
    if (this.session.inactivityTimer) clearTimeout(this.session.inactivityTimer);
    this.session.inactivityTimer = setTimeout(() => {
      this.logger.log('Session timed out after 4h inactivity');
      this.sendToClient({ type: 'exit', exitCode: null, message: 'Session killed — 4 hours idle' });
      this.kill();
    }, SESSION_TIMEOUT_MS);
  }

  private resetIdleTimer(): void {
    if (!this.session) return;
    if (this.session.idleTimer) clearTimeout(this.session.idleTimer);
    this.session.idleTimer = setTimeout(() => {
      if (this.session && this.session.status === 'active') {
        this.session.status = 'idle';
      }
    }, 10_000);
  }

  private spawn(): void {
    const shell = '/bin/bash';
    const claudeCmd = 'cd /home/ubuntu/rental-manager && claude --dangerously-skip-permissions';

    const ptyProcess = pty.spawn(shell, ['-l', '-c', claudeCmd], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: '/home/ubuntu/rental-manager',
      env: {
        TERM: 'xterm-256color',
        HOME: '/home/ubuntu',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        USER: 'ubuntu',
        LANG: process.env.LANG || 'C.UTF-8',
      },
    });

    this.session = {
      pty: ptyProcess,
      ws: null,
      scrollback: [],
      scrollbackBytes: 0,
      status: 'active',
      lastActivity: Date.now(),
      inactivityTimer: null,
      orphanTimer: null,
      idleTimer: null,
      exitCode: null,
    };

    this.resetInactivityTimer();
    this.resetIdleTimer();

    // PTY output → scrollback + WebSocket
    ptyProcess.onData((data: string) => {
      if (!this.session) return;
      this.resetInactivityTimer();
      this.appendScrollback(data);

      if (this.session.status === 'idle' && this.session.ws) {
        this.session.status = 'active';
      }
      this.resetIdleTimer();
      this.sendToClient({ type: 'output', data });
    });

    // PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      if (!this.session) return;
      this.session.exitCode = exitCode;
      this.session.status = 'exited';
      this.logger.log(`Claude CLI exited code=${exitCode} signal=${signal}`);

      if (this.session.inactivityTimer) clearTimeout(this.session.inactivityTimer);
      if (this.session.idleTimer) clearTimeout(this.session.idleTimer);
      if (this.session.orphanTimer) clearTimeout(this.session.orphanTimer);

      this.sendToClient({ type: 'exit', exitCode, signal, message: `Session ended (exit: ${exitCode})` });

      // Keep session for 30s so client can read scrollback, then clean up
      setTimeout(() => {
        if (this.session?.status === 'exited') {
          this.session = null;
        }
      }, 30_000);
    });

    this.logger.log(`Claude PTY spawned pid=${ptyProcess.pid}`);
  }

  /**
   * Attach a WebSocket client. Spawns a new session or reattaches to existing.
   */
  attach(ws: WebSocket): void {
    if (!this.session || this.session.status === 'exited') {
      // No session or exited → spawn fresh
      this.spawn();
      this.session!.ws = ws;
      this.sendToClient({ type: 'spawned' });
    } else {
      // Existing session → reattach
      this.session.ws = ws;
      if (this.session.orphanTimer) {
        clearTimeout(this.session.orphanTimer);
        this.session.orphanTimer = null;
      }
      // Replay scrollback
      if (this.session.scrollback.length > 0) {
        const scrollbackData = this.session.scrollback.join('');
        try { ws.send(JSON.stringify({ type: 'scrollback', data: scrollbackData })); } catch { /* */ }
      }
      this.session.status = 'active';
      this.sendToClient({ type: 'reattached' });
      this.logger.log('Client reattached to existing session');
    }
  }

  /**
   * Detach WebSocket but keep PTY alive.
   */
  detach(): void {
    if (!this.session) return;
    if (this.session.status === 'exited') return;

    this.session.ws = null;
    this.session.status = 'detached';

    if (this.session.orphanTimer) clearTimeout(this.session.orphanTimer);
    this.session.orphanTimer = setTimeout(() => {
      this.logger.log('Session orphaned for 4h, killing');
      this.kill();
    }, ORPHAN_TIMEOUT_MS);

    this.logger.log('Client detached, PTY still running');
  }

  /**
   * Write data to PTY stdin (keyboard input from client).
   */
  write(data: string): void {
    if (!this.session || this.session.status === 'exited') return;
    this.session.lastActivity = Date.now();
    this.resetInactivityTimer();
    this.session.pty.write(data);
  }

  /**
   * Resize PTY.
   */
  resize(cols: number, rows: number): void {
    if (!this.session || this.session.status === 'exited') return;
    const safeCols = Math.max(40, Math.min(400, cols || 120));
    const safeRows = Math.max(10, Math.min(200, rows || 40));
    this.session.pty.resize(safeCols, safeRows);
  }

  /**
   * Kill the PTY session entirely.
   */
  kill(): void {
    if (!this.session) return;
    if (this.session.inactivityTimer) clearTimeout(this.session.inactivityTimer);
    if (this.session.orphanTimer) clearTimeout(this.session.orphanTimer);
    if (this.session.idleTimer) clearTimeout(this.session.idleTimer);
    try { this.session.pty.kill(); } catch { /* */ }
    this.session = null;
    this.logger.log('Session killed');
  }

  /**
   * Check if a session exists and is not exited.
   */
  hasActiveSession(): boolean {
    return this.session !== null && this.session.status !== 'exited';
  }
}
