#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as pty from "node-pty";
import * as os from "os";

const DEBUG = process.env.SHELLKEEPER_DEBUG === "true" || process.env.SHELLKEEPER_DEBUG === "1";

function debugLog(...args: any[]) {
  if (DEBUG) {
    console.error("[ShellKeeper:DEBUG]", ...args);
  }
}

interface TerminalSession {
  id: string;
  ptyProcess: pty.IPty;
  outputBuffer: string;
  rawOutputBuffer: string;
  isReady: boolean;
  lastCommand: string;
  createdAt: Date;
  isRelayMode: boolean;
  lastOutputTime: number;
}

const sessions = new Map<string, TerminalSession>();

const server = new Server(
  {
    name: "mcp-shellkeeper",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][0-9;]*\x07/g, "")
    .replace(/\x1b\][0-9;]*;[^\x07]*\x07/g, "")
    .replace(/\x1b[><=]/g, "")
    .replace(/\[\?[0-9]+[hl]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\[READY\]\$ /g, "")
    .replace(/^%\s*$/gm, "")
    .replace(/^❯\s*$/gm, "")
    .replace(/^~\s*$/gm, "")
    .replace(/^\$\s*$/gm, "")
    .replace(/^>\s*$/gm, "")
    .replace(/^#\s*$/gm, "")
    .replace(/^[❯$>#]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createSession(sessionId: string, shell?: string): TerminalSession {
  const shellPath = shell || (os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash");
  debugLog(`Creating session ${sessionId} with shell: ${shellPath}`);

  const ptyProcess = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: process.env.HOME || process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      PS1: "[READY]\\$ ",
      SSH_ASKPASS: "",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERMINFO: "/usr/share/terminfo",
    },
  });

  const session: TerminalSession = {
    id: sessionId,
    ptyProcess,
    outputBuffer: "",
    rawOutputBuffer: "",
    isReady: true,
    lastCommand: "",
    createdAt: new Date(),
    isRelayMode: false,
    lastOutputTime: Date.now(),
  };

  ptyProcess.onData((data) => {
    const now = Date.now();
    session.rawOutputBuffer += data;
    session.outputBuffer += data;
    session.lastOutputTime = now;
    
    debugLog(`[${sessionId}] onData: ${data.length} bytes`);
    debugLog(`[${sessionId}] hex:`, data.split('').map(c => c.charCodeAt(0).toString(16)).join(' '));
    debugLog(`[${sessionId}] Content:`, JSON.stringify(data.substring(0, 300)));
    
    if (data.includes("relay") || data.includes("Relay") || data.includes("KIM") || 
        data.includes("堡垒机") || data.includes("@relay") || data.includes("@dev-") ||
        data.includes("root@") || data.includes("#")) {
      session.isRelayMode = true;
      debugLog(`[${sessionId}] Relay/nested mode detected`);
    }
    
    if (session.rawOutputBuffer.length > 100000) {
      session.rawOutputBuffer = session.rawOutputBuffer.slice(-50000);
    }
    if (session.outputBuffer.length > 100000) {
      session.outputBuffer = session.outputBuffer.slice(-50000);
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    console.error(`[ShellKeeper] Session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, session);
  debugLog(`Session ${sessionId} created`);
  return session;
}

async function sendRawCommand(
  session: TerminalSession,
  command: string,
  waitTime: number = 2000
): Promise<string> {
  debugLog(`[${session.id}] Sending raw command: ${command}`);
  
  session.outputBuffer = "";
  session.lastCommand = command;
  session.isReady = false;
  
  session.ptyProcess.write(command + "\r");
  
  await sleep(waitTime);
  
  session.isReady = true;
  
  const output = session.outputBuffer;
  debugLog(`[${session.id}] Captured output (${output.length} bytes)`);
  
  return output;
}

async function executeCommand(
  session: TerminalSession,
  command: string,
  timeout: number = 30000
): Promise<string> {
  session.lastCommand = command;
  session.isReady = false;
  session.outputBuffer = "";
  debugLog(`[${session.id}] Executing: ${command}`);

  if (session.isRelayMode) {
    debugLog(`[${session.id}] Using Relay mode execution`);
    session.ptyProcess.write(command + "\r");
    
    await sleep(500);
    
    const startTime = Date.now();
    let lastLen = 0;
    let stableCount = 0;
    
    while (Date.now() - startTime < timeout) {
      const currentLen = session.outputBuffer.length;
      const timeSinceLastOutput = Date.now() - session.lastOutputTime;
      
      if (timeSinceLastOutput > 2000) {
        debugLog(`[${session.id}] Output stable for ${timeSinceLastOutput}ms`);
        break;
      }
      
      if (currentLen === lastLen) {
        stableCount++;
        if (stableCount > 20) {
          debugLog(`[${session.id}] Buffer stable`);
          break;
        }
      } else {
        stableCount = 0;
        lastLen = currentLen;
      }
      
      await sleep(100);
    }
    
    session.isReady = true;
    return cleanOutput(session.outputBuffer);
  }

  const timestamp = Date.now();
  const startMarker = `__START_${timestamp}__`;
  const endMarker = `__END_${timestamp}__`;
  const exitMarker = `__EXIT_${timestamp}__`;

  session.ptyProcess.write(`echo '${startMarker}'\n`);
  await sleep(50);
  session.ptyProcess.write(`${command}\n`);
  await sleep(50);
  session.ptyProcess.write(`__EXIT_CODE=$?; echo '${exitMarker}'$__EXIT_CODE; echo '${endMarker}'\n`);

  const startTime = Date.now();
  let lastBufferLen = 0;
  let stableCount = 0;

  while (Date.now() - startTime < timeout) {
    const output = session.outputBuffer;
    
    if (output.includes(endMarker)) {
      debugLog(`[${session.id}] Found end marker`);
      await sleep(100);
      break;
    }
    
    if (output.length === lastBufferLen) {
      stableCount++;
      if (stableCount > 20) {
        debugLog(`[${session.id}] Buffer stable`);
        break;
      }
    } else {
      stableCount = 0;
      lastBufferLen = output.length;
    }

    await sleep(100);
  }

  session.isReady = true;
  const output = session.outputBuffer;
  debugLog(`[${session.id}] Output: ${output.length} bytes`);

  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    return cleanOutput(output);
  }

  let exitCode = 0;
  const exitMatch = output.match(new RegExp(`${exitMarker}(\\d+)`));
  if (exitMatch) {
    exitCode = parseInt(exitMatch[1], 10);
  }

  let result = output.substring(startIdx + startMarker.length, endIdx);
  
  const lines = result.split("\n");
  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;
    if (trimmed.includes(startMarker)) return false;
    if (trimmed.includes(endMarker)) return false;
    if (trimmed.includes(exitMarker)) return false;
    if (trimmed.startsWith("echo ")) return false;
    if (trimmed === command) return false;
    if (trimmed.startsWith("__EXIT_CODE=")) return false;
    return true;
  });

  result = filteredLines.join("\n");
  const cleanedResult = cleanOutput(result);

  if (exitCode !== 0) {
    throw new Error(
      `Command exited with code ${exitCode}\nCommand: ${command}\nOutput: ${cleanedResult || "(no output)"}`
    );
  }

  return cleanedResult;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "terminal_execute",
        description:
          "Execute a command in a persistent terminal session. " +
          "This tool maintains shell context across calls, making it perfect for: " +
          "1) Running local commands on the user's machine, " +
          "2) SSH into servers and maintaining that SSH connection, " +
          "3) Running commands within SSH sessions (nested SSH supported). " +
          "The session persists until explicitly closed or the server restarts. " +
          "Use the same session_id to maintain context (default: 'default').",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command to execute. Examples: 'ls -la', 'ssh user@server', 'top -bn1', 'cd /var/log && tail -50 app.log'",
            },
            session_id: {
              type: "string",
              description: "Session identifier to maintain context across commands (default: 'default')",
              default: "default",
            },
            timeout: {
              type: "number",
              description: "Command timeout in milliseconds (default: 30000, max: 120000)",
              default: 30000,
            },
          },
          required: ["command"],
        },
      },
      {
        name: "terminal_send",
        description:
          "Send a command to terminal without waiting for markers. " +
          "Useful for Relay/special terminals that don't work well with standard execute. " +
          "Returns the buffer content after waiting specified time.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The command to send",
            },
            session_id: {
              type: "string",
              description: "Session identifier (default: 'default')",
              default: "default",
            },
            wait_time: {
              type: "number",
              description: "Time to wait for output in milliseconds (default: 2000)",
              default: 2000,
            },
          },
          required: ["command"],
        },
      },
      {
        name: "terminal_new_session",
        description:
          "Create a new isolated terminal session. " +
          "Useful when you want to maintain multiple separate contexts.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Unique identifier for the new session",
            },
            shell: {
              type: "string",
              description: "Shell to use (optional, defaults to system default)",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "terminal_list_sessions",
        description: "List all active terminal sessions with their status",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "terminal_close_session",
        description: "Close and cleanup a specific terminal session",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID to close",
            },
          },
          required: ["session_id"],
        },
      },
      {
        name: "terminal_get_buffer",
        description:
          "Get the output buffer from a session. " +
          "Returns both clean and raw buffers for debugging.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID (default: 'default')",
              default: "default",
            },
            raw: {
              type: "boolean",
              description: "Return raw buffer without cleaning (default: false)",
              default: false,
            },
          },
        },
      },
      {
        name: "terminal_clear_buffer",
        description: "Clear the output buffer for a session",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID (default: 'default')",
              default: "default",
            },
          },
        },
      },
      {
        name: "terminal_probe",
        description:
          "Send a probe command to detect current terminal state and prompt. " +
          "Useful for nested SSH/kcsctl sessions where output might not be captured normally.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID (default: 'default')",
              default: "default",
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "terminal_execute": {
        const { command, session_id = "default", timeout = 30000 } = args as any;
        const validTimeout = Math.min(Math.max(timeout, 1000), 120000);

        let session = sessions.get(session_id);
        if (!session) {
          console.error(`[ShellKeeper] Creating new session: ${session_id}`);
          session = createSession(session_id);
          await sleep(500);
        }

        if (!session.isReady) {
          throw new Error(
            `Session ${session_id} is busy executing: ${session.lastCommand}`
          );
        }

        console.error(`[ShellKeeper] Execute: ${command}`);
        const output = await executeCommand(session, command, validTimeout);

        return {
          content: [{ type: "text", text: output || "(no output)" }],
        };
      }

      case "terminal_send": {
        const { command, session_id = "default", wait_time = 2000 } = args as any;

        let session = sessions.get(session_id);
        if (!session) {
          console.error(`[ShellKeeper] Creating new session: ${session_id}`);
          session = createSession(session_id);
          await sleep(500);
        }

        console.error(`[ShellKeeper] Send: ${command}`);
        const output = await sendRawCommand(session, command, wait_time);

        return {
          content: [{ type: "text", text: cleanOutput(output) || "(no output)" }],
        };
      }

      case "terminal_new_session": {
        const { session_id, shell } = args as any;

        if (sessions.has(session_id)) {
          throw new Error(`Session ${session_id} already exists`);
        }

        console.error(`[ShellKeeper] Creating new session: ${session_id}`);
        createSession(session_id, shell);
        await sleep(500);

        return {
          content: [{
            type: "text",
            text: `Created session: ${session_id}${shell ? ` (shell: ${shell})` : ""}`,
          }],
        };
      }

      case "terminal_list_sessions": {
        const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
          id,
          ready: session.isReady,
          relayMode: session.isRelayMode,
          lastCommand: session.lastCommand || "(none)",
          bufferLen: session.outputBuffer.length,
          uptime: Math.floor((Date.now() - session.createdAt.getTime()) / 1000),
        }));

        if (sessionList.length === 0) {
          return { content: [{ type: "text", text: "No active sessions" }] };
        }

        const formatted = sessionList
          .map((s) => `  • ${s.id}\n    Ready: ${s.ready}, Relay: ${s.relayMode}\n    Buffer: ${s.bufferLen} bytes, Uptime: ${s.uptime}s\n    Last: ${s.lastCommand}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: `Active sessions (${sessionList.length}):\n\n${formatted}` }],
        };
      }

      case "terminal_close_session": {
        const { session_id } = args as any;
        const session = sessions.get(session_id);
        if (!session) {
          throw new Error(`Session ${session_id} not found`);
        }

        console.error(`[ShellKeeper] Closing session: ${session_id}`);
        session.ptyProcess.kill();
        sessions.delete(session_id);

        return {
          content: [{ type: "text", text: `Closed session: ${session_id}` }],
        };
      }

      case "terminal_get_buffer": {
        const { session_id = "default", raw = false } = args as any;
        const session = sessions.get(session_id);
        if (!session) {
          throw new Error(`Session ${session_id} not found`);
        }

        const buffer = raw ? session.rawOutputBuffer : session.outputBuffer;
        const result = cleanOutput(buffer);
        
        let info = `\n\n--- Session Info ---\nID: ${session_id}\nRelayMode: ${session.isRelayMode}\nCleanBufferLen: ${session.outputBuffer.length}\nRawBufferLen: ${session.rawOutputBuffer.length}\nReady: ${session.isReady}\nLastCmd: ${session.lastCommand}`;

        return {
          content: [{ type: "text", text: result || "(empty)" + info }],
        };
      }

      case "terminal_clear_buffer": {
        const { session_id = "default" } = args as any;
        const session = sessions.get(session_id);
        if (!session) {
          throw new Error(`Session ${session_id} not found`);
        }

        session.outputBuffer = "";
        session.rawOutputBuffer = "";
        debugLog(`[${session_id}] Buffer cleared`);

        return {
          content: [{ type: "text", text: `Buffer cleared for session: ${session_id}` }],
        };
      }

      case "terminal_probe": {
        const { session_id = "default" } = args as any;
        const session = sessions.get(session_id);
        if (!session) {
          throw new Error(`Session ${session_id} not found`);
        }

        const beforeLen = session.rawOutputBuffer.length;
        const probeMarker = `PROBE_${Date.now()}`;
        
        session.ptyProcess.write(`echo "${probeMarker}"; pwd; whoami; echo "ENDPROBE"\n`);
        
        await sleep(3000);
        
        const afterLen = session.rawOutputBuffer.length;
        const newOutput = session.rawOutputBuffer.slice(beforeLen);
        
        debugLog(`[${session_id}] Probe: before=${beforeLen}, after=${afterLen}, diff=${afterLen - beforeLen}`);
        debugLog(`[${session_id}] Probe output:`, JSON.stringify(newOutput));
        
        return {
          content: [{
            type: "text",
            text: `Probe sent.\nBuffer before: ${beforeLen} bytes\nBuffer after: ${afterLen} bytes\nNew data: ${afterLen - beforeLen} bytes\n\nNew output:\n${cleanOutput(newOutput) || "(none captured)"}\n\nFull raw buffer (${session.rawOutputBuffer.length} bytes):\n${session.rawOutputBuffer.slice(-2000)}`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    console.error(`[ShellKeeper] Error:`, error);
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

process.on("SIGINT", () => {
  console.error("[ShellKeeper] Shutting down...");
  sessions.forEach((session) => session.ptyProcess.kill());
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("[ShellKeeper] Shutting down...");
  sessions.forEach((session) => session.ptyProcess.kill());
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ShellKeeper] MCP Server started");
  console.error("[ShellKeeper] Debug mode:", DEBUG ? "ON" : "OFF");
}

main().catch((error) => {
  console.error("[ShellKeeper] Fatal error:", error);
  process.exit(1);
});
