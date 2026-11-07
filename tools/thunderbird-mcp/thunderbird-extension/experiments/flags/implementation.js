var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs",
);

const moduleCache = new Map();

function importModule(paths) {
  for (const path of paths) {
    try {
      const module = ChromeUtils.importESModule
        ? ChromeUtils.importESModule(path)
        : ChromeUtils.import(path, {});
      if (module) return module;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function mailServices() {
  if (typeof MailServices !== "undefined") {
    return { MailServices };
  }
  if (!moduleCache.has("mail")) {
    moduleCache.set(
      "mail",
      importModule([
        "resource:///modules/MailServices.sys.mjs",
        "resource:///modules/MailServices.jsm",
      ]),
    );
  }
  return moduleCache.get("mail");
}

function ioUtils() {
  if (typeof IOUtils !== "undefined") {
    return { IOUtils };
  }
  if (!moduleCache.has("io")) {
    moduleCache.set(
      "io",
      importModule([
        "resource://gre/modules/IOUtils.sys.mjs",
        "resource://gre/modules/IOUtils.jsm",
      ]),
    );
  }
  return moduleCache.get("io");
}

function errorText(error) {
  const name = error && error.name ? error.name : "Error";
  const message = error && error.message ? error.message : String(error);
  return `${name}: ${message}`;
}

function profileDir() {
  return Services.dirsvc.get("ProfD", Components.interfaces.nsIFile).clone();
}

function bridgeRoot() {
  const dir = profileDir();
  dir.append("thunderbird-mcp-bridge");
  return dir.path;
}

function bridgeSubdirectory(kind) {
  const dir = profileDir();
  dir.append("thunderbird-mcp-bridge");
  dir.append(kind);
  return dir.path;
}

function ensureDirectory(directory) {
  const file = Components.classes["@mozilla.org/file/local;1"].createInstance(
    Components.interfaces.nsIFile,
  );
  file.initWithPath(directory);
  if (!file.exists()) {
    file.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
  }
}

const SOCKET_NAMES = ["mcp.sock", "s"];
const SOCKET_BACKLOG = 8;
const MAX_REQUEST_BUFFER = 8 * 1024 * 1024;
const SOCKET_PREF = "extensions.thunderbird-mcp.socket";

let socketServer = null;
let socketPath = null;
let socketError = null;
let socketStartedAt = 0;
let connectionSeq = 0;
let requestSeq = 0;
const connections = new Map();
const requestQueue = [];

function generateQI(interfaces) {
  if (typeof ChromeUtils !== "undefined" && ChromeUtils.generateQI) {
    return ChromeUtils.generateQI(interfaces);
  }
  return Components.utils.generateQI(interfaces);
}

function bridgeFile(name) {
  const dir = profileDir();
  dir.append("thunderbird-mcp-bridge");
  ensureDirectory(dir.path);
  dir.append(name);
  return dir;
}

function asciiJson(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/[\u0080-\uffff]/g, (match) => {
    return "\\u" + match.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

let markLogQueue = Promise.resolve();

function appendMarkLog(entry) {
  markLogQueue = markLogQueue
    .then(async () => {
      const io = ioUtils();
      if (!io || !io.IOUtils) return;
      ensureDirectory(bridgeRoot());
      const line = `${JSON.stringify({
        time: new Date().toISOString(),
        ...entry,
      })}\n`;
      const file = `${bridgeRoot()}/mark-log.jsonl`;
      try {
        await io.IOUtils.write(file, line, { mode: "append" });
      } catch {
        let existing = "";
        try {
          existing = await io.IOUtils.read(file, "utf8");
        } catch {
          // File does not exist yet.
        }
        await io.IOUtils.write(file, `${existing}${line}`, {
          tmpPath: `${file}.tmp`,
        });
      }
    })
    .catch(() => {});
  return markLogQueue;
}

function isWouldBlock(error) {
  const code = error && (error.result !== undefined ? error.result : error.errorCode);
  if (code === 0x80470007 || code === -2147024880) return true;
  const text = error && error.message ? String(error.message) : String(error);
  return /WOULD_BLOCK|NS_BASE_STREAM_WOULD_BLOCK/i.test(text);
}

function socketStatusValue() {
  return {
    ok: Boolean(socketServer),
    path: socketPath,
    connections: connections.size,
    queued: requestQueue.length,
    lastError: socketError,
    startedAt: socketStartedAt,
  };
}

async function writeSocketInfo() {
  const io = ioUtils();
  if (!io || !io.IOUtils || !socketPath) return;
  await io.IOUtils.writeJSON(`${bridgeRoot()}/socket.json`, {
    path: socketPath,
    time: Date.now(),
  });
}

function closeConnection(conn, reason) {
  if (!conn || conn.closed) return;
  conn.closed = true;
  connections.delete(conn.id);
  for (let index = requestQueue.length - 1; index >= 0; index -= 1) {
    if (requestQueue[index].connectionId === conn.id) requestQueue.splice(index, 1);
  }
  try {
    if (conn.out) conn.out.close();
  } catch {
    // Already closed.
  }
  try {
    conn.transport.close(Components.results.NS_BINDING_ABORTED);
  } catch {
    // Already closed.
  }
  if (reason && reason !== "eof" && reason !== "stopped") {
    socketError = String(reason);
  }
}

function waitWritable(conn) {
  if (conn.closed || !conn.out || conn.waiting) return;
  conn.waiting = true;
  const callback = {
    QueryInterface: generateQI(["nsIOutputStreamCallback"]),
    onOutputStreamReady() {
      conn.waiting = false;
      pumpWrites(conn);
    },
  };
  try {
    conn.out.asyncWait(callback, 0, 0, null);
  } catch (error) {
    closeConnection(conn, errorText(error));
  }
}

function pumpWrites(conn) {
  if (conn.closed || conn.writing || !conn.out || !conn.writeQueue.length) return;
  conn.writing = true;
  const chunk = conn.writeQueue[0];
  try {
    const written = conn.out.write(chunk, chunk.length);
    if (written >= chunk.length) {
      conn.writeQueue.shift();
      conn.writing = false;
      pumpWrites(conn);
    } else {
      conn.writeQueue[0] = chunk.slice(written);
      conn.writing = false;
      waitWritable(conn);
    }
  } catch (error) {
    conn.writing = false;
    if (isWouldBlock(error)) {
      waitWritable(conn);
    } else {
      closeConnection(conn, errorText(error));
    }
  }
}

function queueWrite(conn, text) {
  if (!conn || conn.closed) return false;
  conn.writeQueue.push(text);
  pumpWrites(conn);
  return true;
}

function processRequests(conn) {
  if (conn.buffer.length > MAX_REQUEST_BUFFER) {
    closeConnection(conn, "Request buffer exceeded limit");
    return;
  }
  let newline = conn.buffer.indexOf("\n");
  while (newline >= 0) {
    const line = conn.buffer.slice(0, newline).trim();
    conn.buffer = conn.buffer.slice(newline + 1);
    newline = conn.buffer.indexOf("\n");
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      queueWrite(conn, asciiJson({ ok: false, error: "Invalid JSON request" }) + "\n");
      continue;
    }
    if (!request || typeof request !== "object") continue;
    const id = request.id !== undefined ? request.id : `srv-${++requestSeq}`;
    request.id = id;
    if (request.command === "ping") {
      queueWrite(
        conn,
        asciiJson({
          id,
          ok: true,
          result: { socket: true, path: socketPath },
        }) + "\n",
      );
      continue;
    }
    requestQueue.push({ connectionId: conn.id, request });
  }
}

function acceptConnection(transport) {
  const id = ++connectionSeq;
  const conn = {
    id,
    transport,
    buffer: "",
    writeQueue: [],
    writing: false,
    waiting: false,
    closed: false,
    out: null,
  };
  connections.set(id, conn);
  try {
    const input = transport.openInputStream(0, 0, 0);
    const output = transport.openOutputStream(0, 0, 0);
    conn.out = output.QueryInterface(Components.interfaces.nsIAsyncOutputStream);
    const pump = Components.classes["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Components.interfaces.nsIInputStreamPump,
    );
    pump.init(input, 0, 0, true);
    pump.asyncRead({
      QueryInterface: generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        try {
          const sis = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance(
            Components.interfaces.nsIScriptableInputStream,
          );
          sis.init(stream);
          conn.buffer += sis.read(count);
          processRequests(conn);
        } catch (error) {
          closeConnection(conn, errorText(error));
        }
      },
      onStopRequest() {
        closeConnection(conn, "eof");
      },
    });
  } catch (error) {
    closeConnection(conn, errorText(error));
  }
}

const serverSocketListener = {
  QueryInterface: generateQI(["nsIServerSocketListener"]),
  onSocketAccepted(server, transport) {
    acceptConnection(transport);
  },
  onStopListening() {
    socketServer = null;
  },
};

function socketEnabled() {
  try {
    return Services.prefs.getBoolPref(SOCKET_PREF, false);
  } catch {
    return false;
  }
}

async function startSocketServer() {
  if (socketServer) return { ok: true, path: socketPath, already: true };
  if (!socketEnabled()) {
    const disabledIo = ioUtils();
    if (disabledIo && disabledIo.IOUtils) {
      for (const name of SOCKET_NAMES) {
        try {
          await disabledIo.IOUtils.remove(bridgeFile(name).path, {
            ignoreAbsent: true,
          });
        } catch {
          // Ignore stale socket cleanup failures.
        }
      }
      try {
        await disabledIo.IOUtils.remove(`${bridgeRoot()}/socket.json`, {
          ignoreAbsent: true,
        });
      } catch {
        // Ignore.
      }
    }
    socketError = `Unix socket disabled (set ${SOCKET_PREF}=true to enable)`;
    return { ok: false, disabled: true, error: socketError };
  }
  const io = ioUtils();
  if (!io || !io.IOUtils) {
    socketError = "IOUtils module not available";
    return { ok: false, error: socketError };
  }
  let lastError = null;
  for (const name of SOCKET_NAMES) {
    const file = bridgeFile(name);
    try {
      await io.IOUtils.remove(file.path, { ignoreAbsent: true });
    } catch {
      // Best effort: a stale socket may not be removable.
    }
    let server;
    try {
      server = Components.classes["@mozilla.org/network/server-socket;1"].createInstance(
        Components.interfaces.nsIServerSocket,
      );
      server.initWithFilename(file, 0o600, SOCKET_BACKLOG);
      server.asyncListen(serverSocketListener);
      socketServer = server;
      socketPath = file.path;
      socketError = null;
      socketStartedAt = Date.now();
      await writeSocketInfo();
      return { ok: true, path: socketPath };
    } catch (error) {
      lastError = errorText(error);
      try {
        if (server) server.close();
      } catch {
        // Ignore.
      }
    }
  }
  socketError = lastError || "Unable to create Unix socket";
  return { ok: false, error: socketError };
}

async function stopSocketServer() {
  if (socketServer) {
    try {
      socketServer.close();
    } catch {
      // Ignore.
    }
  }
  socketServer = null;
  for (const conn of Array.from(connections.values())) {
    closeConnection(conn, "stopped");
  }
  connections.clear();
  requestQueue.length = 0;
  const previousPath = socketPath;
  socketPath = null;
  socketStartedAt = 0;
  const io = ioUtils();
  if (io && io.IOUtils) {
    if (previousPath) {
      try {
        await io.IOUtils.remove(previousPath, { ignoreAbsent: true });
      } catch {
        // Ignore.
      }
    }
    try {
      await io.IOUtils.remove(`${bridgeRoot()}/socket.json`, { ignoreAbsent: true });
    } catch {
      // Ignore.
    }
  }
  return { ok: true };
}

var mcpFlags = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      mcpFlags: {
        async ping() {
          const mail = mailServices();
          const io = ioUtils();
          return {
            ok: true,
            profile: bridgeRoot(),
            modules: {
              mailServices: Boolean(mail && mail.MailServices),
              ioUtils: Boolean(io && io.IOUtils),
            },
          };
        },

        async markMessage(messageId, read, answered, accountKey, priority) {
          try {
            const mail = mailServices();
            if (!mail || !mail.MailServices) {
              return { ok: false, error: "MailServices module not available" };
            }
            const { MailServices } = mail;
            const id = String(messageId || "")
              .replace(/^<|>$/g, "")
              .replace(/\s+/g, "");
            if (!id) {
              await appendMarkLog({
                action: "mark",
                messageId: String(messageId || ""),
                accountKey: accountKey || null,
                ok: false,
                error: "messageId is required",
              });
              return { ok: false, error: "messageId is required" };
            }

            let found;
            const accountsApi = MailServices.accounts;
            let servers;
            if (accountKey) {
              const account =
                accountsApi.getAccount(String(accountKey)) ||
                accountsApi.allServers.find((server) => server.key === String(accountKey));
              servers = account
                ? [account.incomingServer || account]
                : [];
              if (!servers.length) {
                await appendMarkLog({
                  action: "mark",
                  messageId: id,
                  accountKey: accountKey || null,
                  ok: false,
                  error: `Account not found: ${accountKey}`,
                });
                return { ok: false, error: `Account not found: ${accountKey}` };
              }
            } else {
              servers = accountsApi.allServers;
            }
            for (const server of servers) {
              const root = server.rootFolder;
              if (!root) continue;
              for (const folder of [root, ...root.descendants]) {
                let db;
                try {
                  db = folder.msgDatabase;
                } catch {
                  continue;
                }
                if (!db) continue;
                const hdr = db.getMsgHdrForMessageID(id);
                if (hdr) {
                  found = { folder, hdr, db };
                  break;
                }
              }
              if (found) break;
            }

            if (!found) {
              await appendMarkLog({
                action: "mark",
                messageId: id,
                accountKey: accountKey || null,
                ok: false,
                error: `Message not found: ${id}`,
              });
              return { ok: false, error: `Message not found: ${id}` };
            }

            const { folder, hdr, db } = found;
            if (typeof read === "boolean") {
              folder.markMessagesRead([hdr], read);
            }
            if (answered === true) {
              folder.addMessageDispositionState(
                hdr,
                Components.interfaces.nsIMsgFolder.nsMsgDispositionState_Replied,
              );
            }
            if (typeof priority === "number") {
              hdr.priority = priority;
            }
            db.commit(Components.interfaces.nsMsgDBCommitType.kLargeCommit);

            const result = {
              folder: folder.URI,
              messageKey: hdr.messageKey,
              read: Boolean(hdr.flags & 0x1),
              answered: Boolean(hdr.flags & 0x2),
              priority: hdr.priority,
            };
            await appendMarkLog({
              action: "mark",
              messageId: id,
              accountKey: accountKey || null,
              folder: result.folder,
              messageKey: result.messageKey,
              subject: String(hdr.mime2DecodedSubject || hdr.subject || ""),
              from: String(hdr.mime2DecodedAuthor || hdr.author || ""),
              requestedRead: typeof read === "boolean" ? read : null,
              requestedAnswered: typeof answered === "boolean" ? answered : null,
              requestedPriority: typeof priority === "number" ? priority : null,
              ok: true,
              resultRead: result.read,
              resultAnswered: result.answered,
              resultPriority: result.priority,
            });
            return { ok: true, result };
          } catch (error) {
            await appendMarkLog({
              action: "mark",
              messageId: String(messageId || ""),
              accountKey: accountKey || null,
              ok: false,
              error: errorText(error),
            });
            return { ok: false, error: errorText(error) };
          }
        },

        async diagnose() {
          const result = {
            profile: bridgeRoot(),
            modules: {
              mailServices: Boolean(mailServices()),
              ioUtils: Boolean(ioUtils()),
            },
          };
          try {
            ensureDirectory(bridgeRoot());
            result.bridgeCreated = true;
          } catch (error) {
            result.ensureError = errorText(error);
          }
          try {
            const io = ioUtils();
            if (!io || !io.IOUtils) throw new Error("IOUtils not available");
            await io.IOUtils.writeJSON(`${bridgeRoot()}/diagnose.json`, {
              time: Date.now(),
            });
            result.write = true;
          } catch (error) {
            result.writeError = errorText(error);
          }
          return result;
        },

        async touchStatus() {
          try {
            const io = ioUtils();
            if (!io || !io.IOUtils) {
              return { ok: false, error: "IOUtils module not available" };
            }
            ensureDirectory(bridgeRoot());
            await io.IOUtils.writeJSON(`${bridgeRoot()}/status.json`, {
              time: Date.now(),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: errorText(error) };
          }
        },

        async takeCommands() {
          try {
            const io = ioUtils();
            if (!io || !io.IOUtils) {
              return { ok: false, error: "IOUtils module not available" };
            }
            const directory = bridgeSubdirectory("commands");
            ensureDirectory(directory);
            const entries = await io.IOUtils.getChildren(directory);
            const commands = [];
            for (const file of entries) {
              if (!file.endsWith(".json")) continue;
              try {
                commands.push(await io.IOUtils.readJSON(file));
              } catch (error) {
                console.error(`[thunderbird-mcp] cannot read ${file}: ${errorText(error)}`);
              }
              try {
                await io.IOUtils.remove(file, { ignoreAbsent: true });
              } catch (error) {
                console.error(`[thunderbird-mcp] cannot remove ${file}: ${errorText(error)}`);
              }
            }
            return { ok: true, commands };
          } catch (error) {
            return { ok: false, error: errorText(error) };
          }
        },

        async writeResult(payload) {
          try {
            const io = ioUtils();
            if (!io || !io.IOUtils) {
              return { ok: false, error: "IOUtils module not available" };
            }
            const directory = bridgeSubdirectory("results");
            ensureDirectory(directory);
            const parsed = JSON.parse(String(payload || "{}"));
            const rawId = String(parsed && parsed.id ? parsed.id : Date.now());
            const id = rawId.replace(/[^a-zA-Z0-9_.-]/g, "_");
            await io.IOUtils.writeJSON(`${directory}/${id}.json`, parsed);
            return { ok: true };
          } catch (error) {
            return { ok: false, error: errorText(error) };
          }
        },

        async socketStart() {
          try {
            return JSON.stringify(await startSocketServer());
          } catch (error) {
            socketError = errorText(error);
            return JSON.stringify({ ok: false, error: socketError });
          }
        },

        async socketStop() {
          try {
            return JSON.stringify(await stopSocketServer());
          } catch (error) {
            return JSON.stringify({ ok: false, error: errorText(error) });
          }
        },

        async socketStatus() {
          return JSON.stringify(socketStatusValue());
        },

        async takeRequest() {
          if (!requestQueue.length) return "null";
          return JSON.stringify(requestQueue.shift());
        },

        async sendResponse(connectionId, payload) {
          const conn = connections.get(Number(connectionId));
          if (!conn) {
            return JSON.stringify({ ok: false, error: "Connection is closed" });
          }
          try {
            const text = asciiJson(String(payload || "{}")) + "\n";
            const queued = queueWrite(conn, text);
            return JSON.stringify({ ok: queued });
          } catch (error) {
            return JSON.stringify({ ok: false, error: errorText(error) });
          }
        },
      },
    };
  }
};
