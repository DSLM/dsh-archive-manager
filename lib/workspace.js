import { symbols } from "@deepseek-ai/cordis";
import { record, errorMessage, errorCode } from "./contracts.js";
import * as SessionRuntime from "@deepseek-ai/dsh-session";
import { childCatalogFact, prepareAutomationRepair } from "./session-repair.js";
import { repairInputSchema, classifySessionError, detailsInputSchema, countConversationTurns, discoveryInvocations, searchInputSchema, previewInputSchema, extractConversation, findContentMatch, previewConversation } from "./archive-discovery.js";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import { bindTypertRemote, Remote } from "@deepseek-ai/dsh-typert-protocol";
import { sessionDir } from "@deepseek-ai/dsh-spill-local";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { favoriteInputSchema, favoriteStateSchema, favoriteInvocations } from "./archive-organizer.js";
const favoriteDomainSpec = defineDomain({
  name: "archive_manager_favorites",
  version: 1,
  tables: {},
  // 宿主运行时仅调用 parse/safeParse；兼容早期同构 schema，不新增 Zod 运行依赖。
  global: { schema: favoriteStateSchema, initial: { favoriteSessionIds: [] } }
});
function jsonlSessionDirectory(persistence, header, location) {
  if (persistence.name !== "session-persistence-jsonl" || location.kind !== "jsonl")
    return;
  const root = persistence.root ?? persistence.config?.root;
  if (typeof root !== "string" || !isAbsolute(root) || !isAbsolute(location.path))
    return;
  if (!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(
    basename(location.path)
  ))
    return;
  if (typeof header.id !== "string" || header.id.length === 0) return;
  const encode = (text) => text.replace(
    /[^A-Za-z0-9._-]/g,
    (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  );
  const segment = header.id === "." ? "~002E" : header.id === ".." ? "~002E~002E" : encode(header.id);
  let project = "_no-cwd";
  if (header.cwd !== void 0) {
    if (typeof header.cwd !== "string" || header.cwd.length === 0) return;
    const readable = encode(header.cwd.replace(/[\\/:]+/g, "-")).replace(/^-+/, "") || "root";
    project = `--${readable.slice(0, 251)}--`;
  }
  const directory = join(resolve(root), project, segment);
  if (location.path !== join(directory, basename(location.path))) return;
  return directory;
}
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
async function estimatePathSize(path) {
  try {
    const s = await lstat(path);
    if (s.isFile()) return s.size;
    if (s.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            const fileStat = await lstat(join(path, entry.name));
            total += fileStat.size;
          } catch {
          }
        }
      }
      return total;
    }
  } catch {
    return 0;
  }
  return 0;
}
class PersistenceStillPresentError extends Error {
  constructor(sessionId) {
    super(`session "${sessionId}" is still present in persistence after artifact removal`);
    this.name = "PersistenceStillPresentError";
  }
}
function deletionFailureMessage(error) {
  return errorMessage(error).slice(0, 400);
}
function strictCodec(typeSymbol, schema) {
  return {
    mode: "strict",
    typeSymbol,
    create: () => schema,
    schema
  };
}
const ARCHIVE_REMOTE_METHODS = [
  "unarchiveSession",
  "deleteSession",
  "deleteArchivedSessions",
  "archivedSessionMetadata",
  "favoriteSessions",
  "setSessionFavorite",
  "searchArchivedContent",
  "searchSessionContent",
  "previewArchivedSession",
  "sessionDetails",
  "diagnoseSession",
  "repairSession",
  "diagnoseOrphanSubagents",
  "cleanOrphanSubagents"
];
function markRemoteMethod(instance, method) {
  const context = {
    private: false,
    static: false,
    name: method,
    addInitializer(fn) {
      fn.call(instance);
    }
  };
  Remote(method)(function() {
  }, { ...context, kind: "method", access: { has: (value) => method in value, get: (value) => Reflect.get(value, method) }, metadata: void 0 });
}
const sessionIdSchema = {
  parse(value) {
    if (typeof value !== "string" || value.length === 0)
      throw new TypeError(
        `sessionId must be a non-empty string, got ${String(value)}`
      );
    return value;
  }
};
const archivedSetSchema = {
  parse(input) {
    const value = record(input);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("result must be an object");
    const ids = value.archivedSessionIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new TypeError("archivedSessionIds must be a string array");
    return value;
  }
};
const deletedSchema = {
  parse(input) {
    const value = record(input);
    if (typeof value !== "object" || value === null || Array.isArray(value) || value.deleted !== true)
      throw new TypeError("deleted must be true");
    return value;
  }
};
const archivedBatchTargetSchema = {
  parse(input) {
    const value = record(input);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("target must be an object");
    if (value.scope === "all" || value.scope === "ungrouped") return value;
    if (value.scope === "workspace" && typeof value.workspaceId === "string" && value.workspaceId.length > 0)
      return value;
    if (value.scope === "sessions" && Array.isArray(value.sessionIds) && value.sessionIds.length > 0 && value.sessionIds.every((id) => typeof id === "string" && id.length > 0))
      return value;
    throw new TypeError(
      "target.scope must be all, ungrouped, workspace with a non-empty workspaceId, or sessions with non-empty sessionIds"
    );
  }
};
const deletedBatchSchema = {
  parse(input) {
    const value = record(input);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("result must be an object");
    for (const key of [
      "requestedSessionIds",
      "deletedSessionIds",
      "skippedSessionIds"
    ]) {
      if (!Array.isArray(value[key]) || value[key].some((id) => typeof id !== "string"))
        throw new TypeError(`${key} must be a string array`);
    }
    if (!Array.isArray(value.failures) || value.failures.some(
      (failure) => typeof failure !== "object" || failure === null || typeof failure.sessionId !== "string" || typeof failure.message !== "string"
    ))
      throw new TypeError("failures must contain sessionId/message objects");
    return value;
  }
};
const archivedSessionMetadataSchema = {
  parse(input) {
    const value = record(input);
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value.items))
      throw new TypeError("result.items must be an array");
    if (value.items.some(
      (item) => typeof item !== "object" || item === null || typeof item.sessionId !== "string" || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)
    ))
      throw new TypeError("items must contain sessionId/createdAt objects");
    return value;
  }
};
const orphanDiagnosisSchema = {
  parse(value) {
    const val = record(value);
    if (typeof val.count !== "number" || !Array.isArray(val.items) || typeof val.totalSizeBytes !== "number") {
      throw new TypeError("invalid orphan subagent diagnosis");
    }
    return val;
  }
};
const orphanCleanResultSchema = {
  parse(value) {
    const val = record(value);
    if (!Array.isArray(val.cleanedSessionIds) || !Array.isArray(val.skippedSessionIds) || !Array.isArray(val.failures)) {
      throw new TypeError("invalid orphan subagent clean result");
    }
    return val;
  }
};
const ARCHIVE_MANAGER_INVOCATIONS = [
  ...favoriteInvocations(),
  ...discoveryInvocations(),
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/unarchiveSession",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "unarchiveSession",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionId",
        wire: "sessionId",
        source: "json",
        codec: strictCodec("@deepseek-ai/dsh-session/types#SessionId", sessionIdSchema)
      }
    ],
    result: strictCodec("@michengai/dsh-archive-manager/types#ArchivedSessionIds", archivedSetSchema),
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteSession",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "deleteSession",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "sessionId",
        wire: "sessionId",
        source: "json",
        codec: strictCodec("@deepseek-ai/dsh-session/types#SessionId", sessionIdSchema)
      }
    ],
    result: strictCodec("@michengai/dsh-archive-manager/types#Deleted", deletedSchema),
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/deleteArchivedSessions",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "deleteArchivedSessions",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "target",
        wire: "target",
        source: "json",
        codec: strictCodec("@michengai/dsh-archive-manager/types#ArchivedBatchTarget", archivedBatchTargetSchema)
      }
    ],
    result: strictCodec("@michengai/dsh-archive-manager/types#DeletedBatch", deletedBatchSchema),
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/archivedSessionMetadata",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "archivedSessionMetadata",
    invocation: { kind: "direct" },
    parameters: [],
    result: strictCodec("@michengai/dsh-archive-manager/types#ArchivedSessionMetadata", archivedSessionMetadataSchema),
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/diagnoseOrphanSubagents",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "diagnoseOrphanSubagents",
    invocation: { kind: "direct" },
    parameters: [],
    result: strictCodec("@michengai/dsh-archive-manager/types#OrphanSubagentDiagnosis", orphanDiagnosisSchema),
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  },
  {
    id: "@michengai/dsh-archive-manager#workspaceRegistry/cleanOrphanSubagents",
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method: "cleanOrphanSubagents",
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "target",
        wire: "target",
        source: "json",
        codec: strictCodec("@michengai/dsh-archive-manager/types#CleanOrphanTarget", {
          parse: (v) => v ?? {}
        })
      }
    ],
    result: strictCodec("@michengai/dsh-archive-manager/types#CleanOrphanResult", orphanCleanResultSchema),
    sourceLocation: {
      file: "@michengai/dsh-archive-manager/lib/workspace.js",
      line: 1,
      column: 1
    }
  }
];
const ARCHIVE_MANAGER_TYPERT = {
  package: "@michengai/dsh-archive-manager",
  face: "host",
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: ARCHIVE_MANAGER_INVOCATIONS
};
function registerHostRemote(ctx) {
  const existing = ctx.get("typert");
  if (existing !== void 0) {
    existing.register(ARCHIVE_MANAGER_TYPERT);
    return;
  }
  ctx.inject(["typert"], (typertCtx) => {
    typertCtx.typert.register(ARCHIVE_MANAGER_TYPERT);
  });
}
function bindArchiveManagerRemote(ctx) {
  const typert = ctx.get("typert");
  if (typert === void 0 || typeof typert.register !== "function") {
    throw new Error("archive-manager: typert is unavailable");
  }
  try {
    const dispose = typert.register(ARCHIVE_MANAGER_TYPERT);
    return typeof dispose === "function" ? () => {
      dispose();
    } : () => {
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already registered")) throw error;
    return () => {
    };
  }
}
async function hostRepairFormat(format, children = []) {
  if (!format || !Number.isInteger(format.currentVersion) || format.currentVersion < 3) throw new Error("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u6B64\u4FEE\u590D\uFF0C\u8BF7\u5347\u7EA7 DSH \u540E\u91CD\u8BD5");
  if (typeof format.createRestore === "function") return format;
  if (typeof format.encodeHeader !== "function" || typeof format.encodeEvent !== "function") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u6B64\u4FEE\u590D\uFF0C\u8BF7\u5347\u7EA7 DSH \u540E\u91CD\u8BD5");
  const catalog = await import("@deepseek-ai/dsh-session-format-catalog");
  if (typeof catalog.createSessionFormatCatalogWithChildren !== "function") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u6B64\u4FEE\u590D\uFF0C\u8BF7\u5347\u7EA7 DSH \u540E\u91CD\u8BD5");
  const bound = catalog.createSessionFormatCatalogWithChildren(children);
  return { ...format, createRestore(header) {
    return bound.createRestore(header, { recovery: "recoverable", validation: "transformed" });
  } };
}
var ArchiveWorkspaceRegistry = class extends WorkspaceRegistry {
  static inject = [
    "storageDomain",
    "sessionPersistence",
    "sessionProjectionCache",
    "typert"
  ];
  constructor(ctx) {
    super(ctx);
    this.typertRemote = bindTypertRemote(this, this.name);
    for (const method of ARCHIVE_REMOTE_METHODS) markRemoteMethod(this, method);
    registerHostRemote(this.ctx);
  }
  /** 只读取归档日志；已有实时实例读取快照，不调用 prepare、enter 或恢复接口。 */
  async readArchivedConversation(sessionId) {
    const ensureArchived = () => {
      if (!this.requireState().archivedSessionIds.includes(sessionId)) throw new Error("\u4F1A\u8BDD\u5DF2\u4E0D\u5728\u5F52\u6863\u4E2D\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
    };
    ensureArchived();
    const events = await this.readConversationEvents(sessionId);
    ensureArchived();
    return extractConversation(events);
  }
  /** 复用宿主只读接口读取事件，不激活会话。 */
  async readConversationEvents(sessionId) {
    const live = this.ctx.get("sessions")?.get(sessionId);
    if (typeof live?.snapshotEvents === "function") return live.snapshotEvents();
    const persistence = this.ctx.get("sessionPersistence");
    if (!persistence || typeof persistence.open !== "function") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u4E0D\u652F\u6301\u53EA\u8BFB\u4F1A\u8BDD\uFF0C\u8BF7\u6253\u5F00\u5B8C\u6574\u4F1A\u8BDD\u67E5\u770B");
    return (await this.readStoredProjectionSource(persistence, sessionId)).events;
  }
  /** 只读取当前宿主已知会话；路径由宿主定位，不根据错误文本或 ID 拼接。 */
  async sessionDetails(input) {
    const { sessionIds } = detailsInputSchema.parse(input);
    const items = [];
    for (const sessionId of sessionIds) {
      const item = { sessionId, turnCount: null, path: null, error: "" };
      try {
        if (!await this.sessionKnown(sessionId)) throw new Error("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
        const header = await this.readSessionHeader(sessionId);
        if (Number.isSafeInteger(header.createdAt) && header.createdAt >= 0) item.createdAt = header.createdAt;
        const persistence = this.ctx.get("sessionPersistence");
        try {
          const location = typeof persistence?.locate === "function" ? await persistence.locate(header) : void 0;
          if (typeof location?.path === "string") {
            const path = jsonlSessionDirectory(persistence, header, location) ?? location.path;
            await lstat(path);
            item.path = path;
          }
        } catch (error) {
          item.error = "\u8DEF\u5F84\u4E0D\u53EF\u7528\uFF1A" + errorMessage(error).slice(0, 350);
        }
        item.turnCount = countConversationTurns(await this.readConversationEvents(sessionId));
      } catch (error) {
        item.error = errorMessage(error).slice(0, 500);
      }
      items.push(item);
    }
    return { items };
  }
  /** 诊断与执行共用同一工件校验；客户端不能提供文件路径。 */
  async sessionRepairPlan(sessionId) {
    if (!await this.sessionKnown(sessionId)) throw new Error("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
    await this.ensureSessionRepairIdle(sessionId);
    const persistence = this.ctx.get("sessionPersistence");
    const header = await this.readSessionHeader(sessionId);
    const location = await persistence?.locate?.(header);
    const directory = location && jsonlSessionDirectory(persistence, header, location);
    const version = persistence.generationFormat?.currentVersion;
    const currentGeneration = Number.isInteger(version) && version >= 3 ? new RegExp(`^session\\.v${version}\\.jsonl(?:\\.zstd)?$`) : void 0;
    if (!directory || currentGeneration === void 0 || !currentGeneration.test(basename(location.path))) throw new Error("\u5F53\u524D\u5B58\u50A8\u540E\u7AEF\u6216\u683C\u5F0F\u4E0D\u652F\u6301\u81EA\u52A8\u4FEE\u590D");
    const format = await hostRepairFormat(persistence.generationFormat, await this.childCatalogFacts(sessionId));
    return prepareAutomationRepair({ directory, target: location.path, sessionId, format: { ...format, validateBytes: async (bytes) => {
      if (location.path.endsWith(".zstd")) {
        if (typeof persistence.readZstdPrefix !== "function") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u7F3A\u5C11\u538B\u7F29\u65E5\u5FD7\u6821\u9A8C\u80FD\u529B");
        const parsed = await persistence.readZstdPrefix(bytes);
        if (parsed.meta.id !== sessionId || parsed.tornTruncateTo !== void 0) throw new Error("\u751F\u6210\u7684\u538B\u7F29\u65E5\u5FD7\u672A\u901A\u8FC7\u5BBF\u4E3B\u6821\u9A8C");
      }
    }, validate: (artifact) => {
      if (typeof SessionRuntime.Session?.fromRestore !== "function") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u7F3A\u5C11\u5B8C\u6574\u4F1A\u8BDD\u6821\u9A8C\u80FD\u529B");
      SessionRuntime.Session.fromRestore(artifact.header.id, artifact.events, artifact.header, artifact.inheritedEventCount, "detached");
    } } });
  }
  async ensureSessionRepairIdle(sessionId) {
    if (!this.requireState().archivedSessionIds.includes(sessionId)) throw new Error("\u8BF7\u5148\u5F52\u6863\u4F1A\u8BDD\uFF0C\u518D\u8FDB\u884C\u4FEE\u590D");
    if (this.ctx.get("sessions")?.get(sessionId)) throw new Error("\u4F1A\u8BDD\u4ECD\u5728\u5BBF\u4E3B\u5185\u6253\u5F00\uFF0C\u8BF7\u5173\u95ED\u4F1A\u8BDD\u5E76\u91CD\u542F DSH \u540E\u4FEE\u590D");
  }
  async diagnoseSession(input) {
    const { sessionId } = repairInputSchema.parse(input);
    const result = { code: "unknown", sessionId, repairable: false, repaired: false, token: "", count: 0, reason: "", advice: "" };
    try {
      if (!await this.sessionKnown(sessionId)) throw new Error("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
      await this.readConversationEvents(sessionId);
      return { ...result, code: "healthy", reason: "\u4F1A\u8BDD\u5DF2\u53EF\u6B63\u5E38\u8BFB\u53D6", advice: "\u5237\u65B0\u4F1A\u8BDD\u8BE6\u60C5\u5373\u53EF\uFF0C\u65E0\u9700\u4FEE\u590D\u3002" };
    } catch (error) {
      const diagnostic = classifySessionError(error);
      result.code = diagnostic.code;
      result.reason = diagnostic.reason;
      result.advice = diagnostic.advice;
    }
    try {
      const plan = await this.sessionRepairPlan(sessionId);
      return {
        ...result,
        code: plan.correctingFrame ? "ready-frame" : "ready",
        repairable: true,
        token: plan.token,
        count: plan.count,
        reason: plan.correctingFrame ? "\u53D1\u73B0\u65E7\u7248\u4FEE\u590D\u7684\u538B\u7F29\u5E27\u95EE\u9898\uFF0C\u5DF2\u901A\u8FC7\u5BBF\u4E3B\u8BFB\u53D6\u6821\u9A8C" : `\u53D1\u73B0 ${plan.count} \u5904\u65E7\u7248\u6765\u6E90\uFF0C\u5DF2\u901A\u8FC7\u5BBF\u4E3B\u683C\u5F0F\u8F6C\u6362\u6821\u9A8C`,
        advice: "\u5C06\u6765\u6E90\u6539\u5199\u4E3A\u5BBF\u4E3B\u652F\u6301\u7684\u63D2\u4EF6\u5F52\u5C5E\uFF0C\u4FDD\u7559\u6B63\u6587\uFF0C\u751F\u6210\u65B0\u7248\u65E5\u5FD7\uFF1B\u65E7\u65E5\u5FD7\u539F\u6837\u4FDD\u7559\u3002\u8BF7\u786E\u4FDD\u5176\u4ED6 DSH \u8FDB\u7A0B\u672A\u6253\u5F00\u8BE5\u4F1A\u8BDD\u3002"
      };
    } catch (error) {
      return {
        ...result,
        code: result.code === "unknown" ? "blocked" : result.code,
        advice: (result.advice + " \u6682\u4E0D\u80FD\u81EA\u52A8\u4FEE\u590D\uFF1A" + errorMessage(error)).slice(0, 1e3)
      };
    }
  }
  async repairSession(input) {
    const { sessionId, token } = repairInputSchema.parse(input);
    if (!token) throw new Error("\u8BF7\u5148\u8BCA\u65AD\uFF0C\u518D\u786E\u8BA4\u4FEE\u590D");
    return this.enqueueOperation(async () => {
      const plan = await this.sessionRepairPlan(sessionId);
      const persistence = this.ctx.get("sessionPersistence");
      if (typeof persistence.acquireLease !== "function") throw new Error("\u5F53\u524D\u5BBF\u4E3B\u7F3A\u5C11\u4F1A\u8BDD\u5199\u9501\uFF0C\u65E0\u6CD5\u5B89\u5168\u4FEE\u590D");
      const lease = await persistence.acquireLease(sessionId, void 0, dirname(plan.source));
      try {
        await plan.publish(token, () => this.ensureSessionRepairIdle(sessionId));
      } finally {
        await lease.release();
      }
      try {
        await this.readConversationEvents(sessionId);
      } catch {
        return { sessionId, repairable: false, repaired: false, token: "", count: plan.count, code: "published-unreadable", reason: "\u65B0\u7248\u65E5\u5FD7\u5DF2\u751F\u6210\uFF0C\u4F46\u5BBF\u4E3B\u590D\u8BFB\u672A\u901A\u8FC7", advice: "\u65E7\u65E5\u5FD7\u4ECD\u4FDD\u7559\uFF0C\u8BF7\u91CD\u542F DSH \u540E\u91CD\u65B0\u8BCA\u65AD\uFF1B\u4E0D\u8981\u53CD\u590D\u4FEE\u590D\u6216\u5220\u9664\u65E5\u5FD7\u3002" };
      }
      return { sessionId, repairable: false, repaired: true, token: "", count: plan.count, code: "repaired", reason: "\u4FEE\u590D\u5B8C\u6210\uFF0C\u5BBF\u4E3B\u5DF2\u80FD\u6B63\u5E38\u8BFB\u53D6", advice: "\u65E7\u65E5\u5FD7\u4FDD\u7559\uFF0C\u5F52\u6863\u72B6\u6001\u4E0D\u53D8\uFF1B\u53EF\u4EE5\u91CD\u65B0\u9884\u89C8\u6216\u6253\u5F00\u4F1A\u8BDD\u3002" };
    });
  }
  /** 已归档与未归档共用正文检索；只读已知会话，不激活或改变归档状态。 */
  async searchSessionContent(input) {
    const { sessionIds, query } = searchInputSchema.parse(input);
    const items = [], failures = [];
    for (const sessionId of sessionIds) {
      try {
        if (!await this.sessionKnown(sessionId)) throw new Error("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
        const messages = extractConversation(await this.readConversationEvents(sessionId));
        if (!await this.sessionKnown(sessionId)) throw new Error("\u4F1A\u8BDD\u5DF2\u79FB\u9664\uFF0C\u8BF7\u5237\u65B0\u5217\u8868");
        const match = findContentMatch(messages, query);
        if (match) items.push({ sessionId, ...match });
      } catch (error) {
        failures.push({ sessionId, message: errorMessage(error).slice(0, 500) });
      }
    }
    return { items, failures };
  }
  /** 输入为限定批次的归档 ID 和关键词，逐条返回命中或失败。 */
  async searchArchivedContent(input) {
    const { sessionIds, query } = searchInputSchema.parse(input);
    const items = [], failures = [];
    for (const sessionId of sessionIds) {
      try {
        const match = findContentMatch(await this.readArchivedConversation(sessionId), query);
        if (match) items.push({ sessionId, ...match });
      } catch (error) {
        failures.push({ sessionId, message: errorMessage(error).slice(0, 500) });
      }
    }
    return { items, failures };
  }
  /** 返回最近八条对话或关键词附近的八条，单条最多 2000 字，不写入宿主数据。 */
  async previewArchivedSession(input) {
    const { sessionId, query } = previewInputSchema.parse(input);
    return { sessionId, ...previewConversation(await this.readArchivedConversation(sessionId), query) };
  }
  /** 独立收藏域不改变官方工作区数据结构；旧版本回退时可保留收藏。 */
  async favoriteDomain() {
    if (!this.favoriteDomainPromise) {
      this.favoriteDomainPromise = this.ctx.storageDomain.open(favoriteDomainSpec).then((domain) => {
        this.ctx.effect(() => () => domain.close(), "archive-manager: \u6536\u85CF\u5B58\u50A8\u5173\u95ED");
        return domain;
      }).catch((error) => {
        this.favoriteDomainPromise = void 0;
        throw error;
      });
    }
    return this.favoriteDomainPromise;
  }
  /** 返回宿主保存的收藏；读取时清理已确认不存在的会话。 */
  async favoriteSessions() {
    return this.enqueueOperation(async () => {
      const domain = await this.favoriteDomain();
      const state = favoriteStateSchema.parse(domain.global.get());
      const kept = [];
      for (const id of state.favoriteSessionIds) {
        if (this.ctx.get("sessions")?.get(id) !== void 0 || !await this.sessionArtifactMissing(id)) kept.push(id);
      }
      if (kept.length !== state.favoriteSessionIds.length) await domain.global.set({ favoriteSessionIds: kept });
      return { favoriteSessionIds: kept };
    });
  }
  /** 设置单条收藏，串行写入避免不同浏览器相互覆盖。 */
  async setSessionFavorite(input) {
    const { sessionId, favorite } = favoriteInputSchema.parse(input);
    return this.enqueueOperation(async () => {
      if (favorite && !await this.sessionKnown(sessionId)) throw new Error("\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u6536\u85CF");
      const domain = await this.favoriteDomain();
      const state = favoriteStateSchema.parse(domain.global.get());
      const ids = new Set(state.favoriteSessionIds);
      if (favorite) ids.add(sessionId);
      else ids.delete(sessionId);
      const next = favoriteStateSchema.parse({ favoriteSessionIds: [...ids] });
      await domain.global.set(next);
      return next;
    });
  }
  /**
   * 只有 persistence.stat 明确说文件不在时才从持久集合摘掉。
   * list/header 读不出不等于文件没了；没有 stat 时宁可不落盘删除。
   */
  async sessionArtifactMissing(sessionId) {
    const persistence = this.ctx.get("sessionPersistence");
    if (typeof persistence?.stat !== "function") return false;
    try {
      return await persistence.stat(sessionId) === void 0;
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: could not stat archived session "${sessionId}": ${String(error)}`
      );
      return false;
    }
  }
  /**
   * 从归档集合摘掉已经确认不存在的会话。打开归档列表时调用。
   * 读不出头部的标记留在持久集合里，只从本次元数据结果里隐藏。
   */
  async pruneUnknownArchivedSessionIds() {
    return this.enqueueOperation(async () => {
      const state = this.requireState();
      const listed = /* @__PURE__ */ new Set();
      for (const item of await this.listStoredHeaders()) {
        const header = item.header ?? item;
        if (typeof header?.id === "string") listed.add(header.id);
      }
      const sessions = this.ctx.get("sessions");
      const kept = [];
      const seen = /* @__PURE__ */ new Set();
      for (const sessionId of state.archivedSessionIds) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        if (sessions?.get(sessionId) !== void 0) {
          kept.push(sessionId);
          continue;
        }
        if (listed.has(sessionId)) {
          kept.push(sessionId);
          continue;
        }
        if (await this.sessionArtifactMissing(sessionId)) {
          this.forgetIndexedSession(sessionId);
          const projCache = this.ctx.get("sessionProjectionCache");
          if (projCache !== void 0) {
            try {
              await projCache.requireTable().delete(sessionId);
            } catch (e) {
              this.ctx.logger.warn(`archive-manager: cleanup projection cache for missing session "${sessionId}" failed: ${String(e)}`);
            }
          }
          continue;
        }
        kept.push(sessionId);
      }
      if (kept.length === state.archivedSessionIds.length && kept.every((id, index) => id === state.archivedSessionIds[index]))
        return kept;
      await this.setState({ ...state, archivedSessionIds: kept });
      return kept;
    });
  }
  /** 仅返回归档头部元数据；不读取正文、不重建或补写投影缓存。 */
  async archivedSessionMetadata() {
    await this.pruneUnknownArchivedSessionIds();
    const items = [];
    for (const sessionId of this.requireState().archivedSessionIds) {
      try {
        const header = await this.readSessionHeader(sessionId);
        if (typeof header.createdAt === "number" && Number.isFinite(header.createdAt))
          items.push({ sessionId, createdAt: header.createdAt });
      } catch (error) {
        this.ctx.logger.warn(
          `archive-manager: could not read creation time for archived session "${sessionId}": ${String(error)}`
        );
      }
    }
    return { items };
  }
  /** 只读句柄必须关闭，避免激活 Agent 或写入会话日志。 */
  async readStoredProjectionSource(persistence, sessionId) {
    const handle = await persistence.open(sessionId, "read");
    try {
      const { events } = await handle.read(0);
      return {
        meta: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        events
      };
    } finally {
      await handle.close();
    }
  }
  /** 官方负责移出归档集合。这里只补远程接口需要的当前集合，不补工作区记账。 */
  async unarchiveSession(sessionId) {
    await super.unarchiveSession(sessionId);
    return { archivedSessionIds: [...this.requireState().archivedSessionIds] };
  }
  /**
   * 按作用域永久删除归档会话。跨会话文件删除无法组成事务，因此继续处理
   * 后续目标并把成功、并发消失和失败分别返回给客户端。
   */
  async deleteArchivedSessions(target) {
    return this.enqueueOperation(async () => {
      const requestedSessionIds = this.archivedSessionIdsForTarget(target);
      const deletedSessionIds = [];
      const skippedSessionIds = [];
      const failures = [];
      let descendantHeaders;
      try {
        descendantHeaders = await this.listStoredHeaders();
      } catch (error) {
        this.ctx.logger.warn(
          `archive-manager: batch descendant listing failed; each cascade will retry: ${String(error)}`
        );
      }
      for (const sessionId of requestedSessionIds) {
        try {
          const result = await this.deleteSessionCore(sessionId, descendantHeaders);
          if (result?.skipped) skippedSessionIds.push(sessionId);
          else deletedSessionIds.push(sessionId);
        } catch (error) {
          failures.push({ sessionId, message: deletionFailureMessage(error) });
        }
      }
      return {
        requestedSessionIds,
        deletedSessionIds,
        skippedSessionIds,
        failures
      };
    });
  }
  /** 删除未知会话遗留的投影行、spill、工作区记账和归档标记。 */
  async cleanupUnknownArchivedSession(sessionId) {
    const projCache = this.ctx.get("sessionProjectionCache");
    if (projCache !== void 0) await projCache.requireTable().delete(sessionId);
    await this.cleanSpill(sessionId);
    await this.removeFromWorkspaceAccounts(sessionId);
    const state = this.requireState();
    if (state.archivedSessionIds.includes(sessionId)) {
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(
          (id) => id !== sessionId
        )
      });
    }
  }
  /** 以归档集合顺序解析批量目标，避免依赖浏览器尚未加载完整的摘要投影。 */
  archivedSessionIdsForTarget(input) {
    const target = archivedBatchTargetSchema.parse(input);
    const state = this.requireState();
    const archivedSessionIds = [...new Set(state.archivedSessionIds)];
    if (target.scope === "all") return archivedSessionIds;
    if (target.scope === "sessions") {
      const selected = new Set(target.sessionIds);
      return archivedSessionIds.filter((id) => selected.has(id));
    }
    if (target.scope === "workspace") {
      const workspace = this.requireTable().get(target.workspaceId);
      if (workspace === void 0)
        throw new Error(`unknown workspace "${target.workspaceId}"`);
      const accounted2 = new Set(workspace.sessionIds);
      return archivedSessionIds.filter((id) => accounted2.has(id));
    }
    const accounted = /* @__PURE__ */ new Set();
    const table = this.requireTable();
    for (const workspaceId of state.workspaceIds) {
      for (const sessionId of table.get(workspaceId)?.sessionIds ?? [])
        accounted.add(sessionId);
    }
    return archivedSessionIds.filter((id) => !accounted.has(id));
  }
  /**
   * 永久删除一个会话及其全部痕迹（转录目录、工作区记账、归档标记、
   * 投影缓存行）。
   * @param sessionId - 要删除的会话。
   * @returns 持久化完成后的 `{ deleted: true }`。未知会话清掉残留痕迹后同样返回成功，不抛错。
   */
  async deleteSession(sessionId) {
    return this.enqueueOperation(async () => {
      await this.deleteSessionCore(sessionId);
      return { deleted: true };
    });
  }
  /** 串行化后的删除主体（级联路径复用：它已持有操作链，绝不能再入队）。 */
  async deleteSessionCore(sessionId, descendantHeaders) {
    if (!await this.sessionKnown(sessionId)) {
      await this.cleanupUnknownArchivedSession(sessionId);
      return { deleted: true, skipped: true };
    }
    const sessions = this.ctx.get("sessions");
    const live = sessions?.get(sessionId);
    if (live !== void 0) {
      await sessions.flush(live);
      const entry = sessions.liveEntryFor(live);
      sessions.detachEntered(entry);
    } else if (sessions !== void 0)
      await this.publishColdSessionRemoval(sessionId, sessions);
    const projCache = this.ctx.get("sessionProjectionCache");
    if (projCache !== void 0) await projCache.requireTable().delete(sessionId);
    await this.deleteDescendants(sessionId, descendantHeaders);
    await this.cleanSpill(sessionId);
    await this.removeTranscriptDirectory(sessionId);
    const state = this.requireState();
    if (state.archivedSessionIds.includes(sessionId)) {
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(
          (id) => id !== sessionId
        )
      });
    }
    await this.removeFromWorkspaceAccounts(sessionId);
    this.forgetIndexedSession(sessionId);
    this.publishDeletedSession(sessionId);
    return { deleted: true };
  }
  /** 删除完成后通知全部客户端；新版不再通过伪造冷会话生命周期触发通知。 */
  publishDeletedSession(sessionId) {
    try {
      this.ctx.emit("api-session/removed", sessionId);
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: session "${sessionId}" deleted but removal notification failed: ${String(error)}`
      );
    }
  }
  /** 物理删除成功后移除父类的会话头部和路径索引。 */
  forgetIndexedSession(sessionId) {
    this.headers.delete(sessionId);
    this.sessionPaths.delete(sessionId);
    this.invalidSessionPaths.delete(sessionId);
  }
  /** 为未处于实时状态的持久化会话发布相同的移除事件。 */
  async publishColdSessionRemoval(sessionId, sessions) {
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0 || typeof persistence.prepare !== "function")
      return;
    try {
      const preparation = await persistence.prepare(sessionId);
      const detach = sessions.enter(preparation.session);
      try {
        sessions.announce(preparation.session);
      } finally {
        detach();
        preparation[Symbol.dispose]();
      }
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: could not publish removal for stored session "${sessionId}": ${String(error)}`
      );
    }
  }
  /** 官方 JSONL 已知布局清理会话专属目录；其他后端只删除定位到的工件。 */
  async removeTranscriptDirectory(sessionId) {
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0 || typeof persistence.locate !== "function") {
      throw new Error(
        `cannot delete session "${sessionId}": the session persistence backend does not expose locate() to resolve its transcript artifact`
      );
    }
    const header = this.headers?.get(sessionId) ?? await this.readSessionHeader(sessionId);
    const location = persistence.locate(header);
    if (location === void 0 || typeof location.path !== "string") {
      throw new Error(
        `cannot delete session "${sessionId}": the session persistence backend could not resolve its transcript artifact`
      );
    }
    let target = { path: location.path, kind: "transcript artifact" };
    try {
      const directory = jsonlSessionDirectory(persistence, header, location);
      if (directory !== void 0) {
        target = { path: directory, kind: "session directory" };
        for (const path of [dirname(directory), directory]) {
          let stat;
          try {
            stat = await lstat(path);
          } catch (error) {
            if (errorCode(error) === "ENOENT") continue;
            throw error;
          }
          if (stat.isSymbolicLink())
            throw new Error(`refusing to delete through symbolic link "${path}"`);
          if (!stat.isDirectory())
            throw new Error(`expected session storage directory "${path}"`);
        }
      } else if (persistence.name === "session-persistence-jsonl") {
        this.ctx.logger.warn(
          `archive-manager: session "${sessionId}": JSONL directory ownership could not be verified; falling back to artifact-only deletion at "${location.path}" (parent directory retained)`
        );
      }
      const existed = await pathExists(target.path);
      await rm(target.path, { recursive: true, force: true });
      if (typeof persistence.stat === "function") {
        try {
          const postStat = await persistence.stat(sessionId);
          if (postStat !== void 0) {
            throw new PersistenceStillPresentError(sessionId);
          }
        } catch (error) {
          if (error instanceof PersistenceStillPresentError) throw error;
          const gone = !await pathExists(target.path);
          if (!existed || !gone) {
            throw new Error(
              `cannot verify removal of session "${sessionId}": stat failed and "${target.path}" was not a present artifact removed by this deletion`
            );
          }
          this.ctx.logger.warn(
            `archive-manager: session "${sessionId}" stat check after artifact removal failed; removal confirmed because "${target.path}" existed before rm and is gone now: ${String(error)}`
          );
        }
      }
    } catch (error) {
      const message = `cannot delete session "${sessionId}": cleanup of ${target.kind} "${target.path}" failed; bookkeeping retained for retry`;
      const detail = `${message}: ${String(error)}`;
      this.ctx.logger.warn(`archive-manager: ${detail}`);
      throw new Error(detail, { cause: error });
    }
  }
  /** 把 id 从每个工作区记录中移除，并刷新实体快照。 */
  async removeFromWorkspaceAccounts(sessionId) {
    const table = this.requireTable();
    const state = this.requireState();
    for (const workspaceId of state.workspaceIds) {
      const record2 = table.get(workspaceId);
      if (record2 === void 0 || !record2.sessionIds.includes(sessionId)) continue;
      const next = await table.update(workspaceId, (current) => ({
        ...current,
        sessionIds: current.sessionIds.filter((id) => id !== sessionId),
        updatedAt: /* @__PURE__ */ (/* @__PURE__ */ new Date()).toISOString()
      }));
      const entity = this.entities.get(workspaceId);
      if (entity !== void 0) entity.record = next;
    }
  }
  /** 修复父日志前收集直属 subagent 的目录证据。读不出来的子日志跳过，不把其他子会话一起丢掉。 */
  async childCatalogFacts(sessionId) {
    const ids = /* @__PURE__ */ new Set();
    const sessions = this.ctx.get("sessions");
    if (typeof sessions?.list === "function") {
      for (const session of sessions.list()) {
        const header = session?.header;
        if (header?.parentSession === sessionId && header.origin === "subagent" && typeof session.id === "string") ids.add(session.id);
      }
    }
    try {
      for (const header of await this.listStoredHeaders()) {
        if (header.parentSession === sessionId && header.origin === "subagent") ids.add(header.id);
      }
    } catch (error) {
      this.ctx.logger.warn(`archive-manager: child header list for "${sessionId}" failed: ${String(error)}`);
    }
    const persistence = this.ctx.get("sessionPersistence");
    const facts = [];
    for (const childId of ids) {
      try {
        if (persistence === void 0) continue;
        const stored = await this.readStoredProjectionSource(persistence, childId);
        const fact = childCatalogFact(stored.meta, stored.events, stored.inheritedEventCount ?? 0);
        if (fact !== void 0) facts.push(fact);
      } catch (error) {
        this.ctx.logger.warn(`archive-manager: child catalog fact for "${childId}" skipped: ${String(error)}`);
      }
    }
    return facts;
  }
  /** 尽力而为的级联删除：删除 `sessionId` 的 SUBAGENT 子会话。
   * 仅头部标记 `origin: "subagent"` 的会话参与：单凭 `parentSession` 有歧义
   *（fork 分支也携带它），而 fork 分支是独立的用户会话，绝不能被级联删除。 */
  async deleteDescendants(sessionId, storedHeaders) {
    try {
      const descendants = [];
      const collected = /* @__PURE__ */ new Set();
      const sessions = this.ctx.get("sessions");
      if (sessions !== void 0)
        for (const session of sessions.list()) {
          if (session.header.parentSession === sessionId && session.header.origin === "subagent") {
            descendants.push(session.id);
            collected.add(session.id);
          }
        }
      for (const header of storedHeaders ?? await this.listStoredHeaders()) {
        if (header.parentSession === sessionId && header.origin === "subagent" && !collected.has(header.id)) {
          descendants.push(header.id);
          collected.add(header.id);
        }
      }
      for (const childId of descendants) {
        try {
          if (!await this.sessionKnown(childId)) continue;
          await this.deleteSessionCore(childId, storedHeaders);
        } catch (error) {
          this.ctx.logger.warn(
            `archive-manager: cascade delete of subagent session "${childId}" (child of "${sessionId}") failed: ${String(error)}`
          );
        }
      }
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: descendant enumeration for deleted session "${sessionId}" failed: ${String(error)}`
      );
    }
  }
  /** 尽力而为的 spill 清理：移除该会话作用域的 spill 目录。 */
  async cleanSpill(sessionId) {
    try {
      const spill = this.ctx.get("spillStore");
      if (spill === void 0 || typeof spill.root !== "string") return;
      await rm(sessionDir(spill.root, sessionId), {
        recursive: true,
        force: true
      });
    } catch (error) {
      this.ctx.logger.warn(
        `archive-manager: spill cleanup for deleted session "${sessionId}" failed: ${String(error)}`
      );
    }
  }
  /**
   * 扫描存储中所有母会话已被外部删除的孤儿子代理会话。
   * 必须同时满足 origin === "subagent"、未被播种（排除 fork）、拥有 parentSession，
   * 且该 parentSession 在存储和实时会话中均已不存在。
   */
  async diagnoseOrphanSubagents() {
    const persistence = this.ctx.get("sessionPersistence");
    if (persistence === void 0 || typeof persistence.list !== "function") {
      return { count: 0, items: [], totalSizeBytes: 0 };
    }
    const storedHeaders = await this.listStoredHeaders();
    const liveSessions = this.ctx.get("sessions")?.list?.() ?? [];
    const knownIds = /* @__PURE__ */ new Set();
    for (const s of liveSessions) knownIds.add(s.id);
    for (const h of storedHeaders) knownIds.add(h.id);
    const orphans = [];
    let totalSizeBytes = 0;
    for (const header of storedHeaders) {
      if (header.origin === "subagent" && header.isSeeded !== true && typeof header.parentSession === "string" && header.parentSession.length > 0 && !knownIds.has(header.parentSession) && this.ctx.get("sessions")?.get?.(header.id) === void 0) {
        if (await this.sessionArtifactMissing(header.id)) continue;
        let sizeBytes = 0;
        try {
          if (typeof persistence.locate === "function") {
            const location = persistence.locate(header);
            if (location !== void 0 && typeof location.path === "string") {
              const directory = jsonlSessionDirectory(persistence, header, location);
              const targetPath = directory ?? location.path;
              sizeBytes = await estimatePathSize(targetPath);
            }
          }
        } catch {
          sizeBytes = 0;
        }
        totalSizeBytes += sizeBytes;
        orphans.push({
          sessionId: header.id,
          parentSessionId: header.parentSession,
          createdAt: typeof header.createdAt === "number" ? header.createdAt : 0,
          sizeBytes
        });
      }
    }
    return {
      count: orphans.length,
      items: orphans,
      totalSizeBytes
    };
  }
  /**
   * 物理清理孤儿子代理会话。
   * 支持传入指定的 sessionIds，若未传则清理当前诊断出的全部孤儿子代理。
   */
  async cleanOrphanSubagents(target) {
    return this.enqueueOperation(async () => {
      const candidateIds = target?.sessionIds ?? (await this.diagnoseOrphanSubagents()).items.map((item) => item.sessionId);
      const cleanedSessionIds = [];
      const skippedSessionIds = [];
      const failures = [];
      const storedHeaders = await this.listStoredHeaders();
      for (const sessionId of candidateIds) {
        try {
          const header = this.headers?.get(sessionId) ?? storedHeaders.find((h) => h.id === sessionId);
          if (!header || header.origin !== "subagent" || header.isSeeded === true) {
            skippedSessionIds.push(sessionId);
            continue;
          }
          if (this.ctx.get("sessions")?.get?.(sessionId) !== void 0) {
            skippedSessionIds.push(sessionId);
            continue;
          }
          await this.deleteSessionCore(sessionId, storedHeaders);
          cleanedSessionIds.push(sessionId);
        } catch (error) {
          failures.push({ sessionId, message: errorMessage(error) });
        }
      }
      return { cleanedSessionIds, skippedSessionIds, failures };
    });
  }
};
const workspaceOverlay = Symbol.for("dsh-archive-manager.workspace-overlay");
const remoteMethodDescriptor = "@deepseek-ai/dsh-typert-protocol/remote-methods";
function markOverlayMethods(registry, methods) {
  const raw = Reflect.get(registry, symbols.original) ?? registry;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype === null) return () => {
  };
  const before = Object.getOwnPropertyDescriptor(prototype, remoteMethodDescriptor);
  const marked = /* @__PURE__ */ new Set();
  for (const marker of Reflect.get(before?.value ?? {}, "methods") ?? []) {
    if (typeof marker.method === "string") marked.add(marker.method);
  }
  for (const method of methods) {
    if (marked.has(method)) continue;
    markRemoteMethod(raw, method);
  }
  return () => {
    if (before === void 0) delete prototype[remoteMethodDescriptor];
    else Object.defineProperty(prototype, remoteMethodDescriptor, before);
  };
}
function bindOverlayRemote(registry) {
  const raw = Reflect.get(registry, symbols.original) ?? registry;
  if (Reflect.get(raw, "typertRemote") !== void 0) return () => {
  };
  const name = Reflect.get(raw, "name");
  const serviceKey = typeof name === "string" ? name : "workspaceRegistry";
  Reflect.set(raw, "typertRemote", bindTypertRemote(raw, serviceKey));
  return () => {
    Reflect.deleteProperty(raw, "typertRemote");
  };
}
function installArchiveWorkspace(registry) {
  const overlay = registry;
  if (overlay[workspaceOverlay] === true) return () => {
  };
  if (registry instanceof ArchiveWorkspaceRegistry) return () => {
  };
  const target = overlay;
  const restoreRemote = bindOverlayRemote(registry);
  const originalUnarchive = target.unarchiveSession;
  const unarchiveDescriptor = Object.getOwnPropertyDescriptor(target, "unarchiveSession");
  const restoredMethods = [];
  const copiedMethods = [];
  for (const name of Object.getOwnPropertyNames(ArchiveWorkspaceRegistry.prototype)) {
    if (name === "constructor") continue;
    const method = Reflect.get(ArchiveWorkspaceRegistry.prototype, name);
    if (typeof method !== "function") continue;
    restoredMethods.push({ name, hadOwn: Object.hasOwn(target, name), previous: target[name] });
    if (name === "unarchiveSession") {
      Object.defineProperty(target, name, {
        configurable: unarchiveDescriptor?.configurable ?? true,
        enumerable: unarchiveDescriptor?.enumerable ?? true,
        writable: true,
        value: async function(sessionId) {
          await originalUnarchive.call(this, sessionId);
          return { archivedSessionIds: [...this.requireState().archivedSessionIds] };
        }
      });
    } else target[name] = method;
    copiedMethods.push(name);
  }
  const restoreMarkers = markOverlayMethods(registry, ARCHIVE_REMOTE_METHODS.filter((method) => copiedMethods.includes(method)));
  target[workspaceOverlay] = true;
  return () => {
    if (target[workspaceOverlay] !== true) return;
    restoreMarkers();
    restoreRemote();
    for (const item of restoredMethods.reverse()) {
      if (item.name === "unarchiveSession" && unarchiveDescriptor !== void 0) Object.defineProperty(target, item.name, unarchiveDescriptor);
      else if (item.hadOwn) target[item.name] = item.previous;
      else delete target[item.name];
    }
    delete target[workspaceOverlay];
  };
}
export {
  ArchiveWorkspaceRegistry,
  bindArchiveManagerRemote,
  ArchiveWorkspaceRegistry as default,
  installArchiveWorkspace
};
