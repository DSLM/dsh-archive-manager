const CacheBase = SessionProjectionCache;
import { createHash } from "node:crypto";
import { Service, symbols } from "@deepseek-ai/cordis";
import {
  SessionProjectionCache,
  checkpointIdentity,
  checkpointRecord,
  projectionCacheDomainSpec
} from "@deepseek-ai/dsh-session-projection-cache";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { trackTombstone } from "./tombstone.js";
const storedCheckpointRecord = checkpointRecord.extend({
  sessionId: checkpointIdentity.shape.cwd.unwrap()
});
const safeDomainInput = {
  // 旧版 DSH 不支持同名域的版本迁移。v2 改用新域名，确保升级时不会在
  // 打开目标域之前因旧 v1 元数据而终止启动。
  name: "session_projcache_archive_manager_v2",
  version: 2,
  tables: { sessions: domainTable(storedCheckpointRecord) },
  ...projectionCacheDomainSpec.layout === "per-record" ? { layout: "per-record" } : {}
};
const safeProjectionCacheDomainSpec = defineDomain(safeDomainInput);
const legacyOptionalIdentityFields = {};
for (const field of ["isSeeded", "inheritedEventCount"]) {
  if (Object.hasOwn(checkpointIdentity.shape, field)) legacyOptionalIdentityFields[field] = true;
}
const legacyCheckpointRecord = checkpointRecord.extend({
  identity: checkpointIdentity.partial(legacyOptionalIdentityFields)
});
const legacyStoredCheckpointRecord = legacyCheckpointRecord.extend({
  sessionId: checkpointIdentity.shape.cwd.unwrap()
});
const legacySafeV2ProjectionCacheDomainSpec = defineDomain({
  name: "session_projcache_archive_manager",
  version: 2,
  tables: { sessions: domainTable(storedCheckpointRecord) },
  ...projectionCacheDomainSpec.layout === "per-record" ? { layout: "per-record" } : {}
});
const legacySafeProjectionCacheDomainSpec = defineDomain({
  name: "session_projcache_archive_manager",
  version: 1,
  tables: { sessions: domainTable(legacyStoredCheckpointRecord) },
  ...projectionCacheDomainSpec.layout === "per-record" ? { layout: "per-record" } : {}
});
const legacyProjectionCacheDomainSpec = defineDomain({
  name: "session_projcache",
  version: 3,
  tables: { sessions: domainTable(legacyCheckpointRecord) }
});
function projectionCacheStorageKey(sessionId) {
  return `session_${createHash("sha256").update(sessionId, "utf8").digest("base64url")}`;
}
function unwrapStoredCheckpoint(stored) {
  return { identity: stored.identity, rows: stored.rows };
}
class SafeSessionTable {
  constructor(table) {
    this.table = table;
  }
  get size() {
    return [...this.keys()].length;
  }
  get(sessionId) {
    const stored = this.table.get(projectionCacheStorageKey(sessionId));
    if (stored === void 0 || stored.sessionId !== sessionId) return void 0;
    return unwrapStoredCheckpoint(stored);
  }
  has(sessionId) {
    return this.get(sessionId) !== void 0;
  }
  *entries() {
    for (const [key, stored] of this.table.entries()) {
      if (projectionCacheStorageKey(stored.sessionId) !== key) continue;
      yield [stored.sessionId, unwrapStoredCheckpoint(stored)];
    }
  }
  *keys() {
    for (const [sessionId] of this.entries()) yield sessionId;
  }
  *values() {
    for (const [, value] of this.entries()) yield value;
  }
  async put(sessionId, record) {
    const key = projectionCacheStorageKey(sessionId);
    const existing = this.table.get(key);
    if (existing !== void 0 && existing.sessionId !== sessionId) {
      throw new Error(`projection-cache storage-key collision for "${sessionId}"`);
    }
    await this.table.put(key, { sessionId, identity: record.identity, rows: record.rows });
  }
  async delete(sessionId) {
    const key = projectionCacheStorageKey(sessionId);
    const existing = this.table.get(key);
    if (existing === void 0 || existing.sessionId !== sessionId) return false;
    return this.table.delete(key);
  }
}
async function readSourceRecords(ctx, spec, label) {
  let domain;
  try {
    domain = await ctx.storageDomain.open(spec);
    return { opened: true, records: [...domain.table("sessions").entries()] };
  } catch (error) {
    ctx.logger.warn(`archive-manager projcache: ${label} cache import skipped: ${String(error)}`);
    return { opened: false, records: [] };
  } finally {
    try {
      await domain?.close();
    } catch (error) {
      ctx.logger.warn(`archive-manager projcache: ${label} cache close failed: ${String(error)}`);
    }
  }
}
async function readLegacySafeRecords(ctx, spec, label) {
  const source = await readSourceRecords(ctx, spec, label);
  const records = [];
  for (const [physicalKey, stored] of source.records) {
    if (stored === null || typeof stored !== "object" || !("sessionId" in stored) || typeof stored.sessionId !== "string") {
      ctx.logger.warn(`archive-manager projcache: ${label} row "${physicalKey}" import skipped because its session id is invalid`);
      continue;
    }
    if (projectionCacheStorageKey(stored.sessionId) !== physicalKey) {
      ctx.logger.warn(`archive-manager projcache: ${label} row "${physicalKey}" import skipped because its storage key does not match the session id`);
      continue;
    }
    records.push([stored.sessionId, { identity: "identity" in stored ? stored.identity : void 0, rows: "rows" in stored ? stored.rows : void 0 }]);
  }
  return { ...source, records };
}
function normalizeLegacyRecord(record) {
  if (record === null || typeof record !== "object" || !("identity" in record) || record.identity === null || typeof record.identity !== "object") return void 0;
  const identity = record.identity;
  const inheritedEventCount = identity.inheritedEventCount;
  const validOffset = typeof inheritedEventCount === "number" && Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0;
  if (identity.isSeeded === true) {
    if (!validOffset) return void 0;
    checkpointRecord.parse(record);
    return record;
  }
  if (identity.isSeeded !== void 0 && identity.isSeeded !== false) return void 0;
  if (inheritedEventCount !== void 0 && inheritedEventCount !== 0) return void 0;
  const normalized = {
    ...record,
    identity: {
      ...identity,
      isSeeded: false,
      inheritedEventCount: 0
    }
  };
  checkpointRecord.parse(normalized);
  return normalized;
}
function sameIdentity(left, right) {
  return left.createdAt === right.createdAt && left.cwd === right.cwd && left.formatVersion === right.formatVersion && (left.isSeeded ?? false) === (right.isSeeded ?? false) && (left.inheritedEventCount ?? 0) === (right.inheritedEventCount ?? 0);
}
function mergeCheckpoint(current, incoming) {
  if (current !== void 0 && incoming.identity.formatVersion === void 0 && current.identity.formatVersion !== void 0 && current.identity.createdAt === incoming.identity.createdAt && current.identity.cwd === incoming.identity.cwd && (current.identity.isSeeded ?? false) === (incoming.identity.isSeeded ?? false)) return current;
  if (current === void 0 || !sameIdentity(current.identity, incoming.identity)) return incoming;
  const rows = { ...current.rows };
  let changed = false;
  for (const [key, row] of Object.entries(incoming.rows)) {
    const previous = rows[key];
    if (previous === void 0 || previous.ver === row.ver && previous.seq < row.seq) {
      rows[key] = row;
      changed = true;
    }
  }
  return changed ? { identity: current.identity, rows } : current;
}
async function importPreviousProjectionCache(ctx, target, persistence, guards) {
  if (persistence === void 0) return 0;
  const sources = [
    await readLegacySafeRecords(ctx, safeProjectionCacheDomainSpec, "archive-manager current"),
    await readLegacySafeRecords(ctx, legacySafeV2ProjectionCacheDomainSpec, "archive-manager v2"),
    // 逐记录后端会把不同版本当缺行，打开成功也须单独读取 v1。
    await readLegacySafeRecords(ctx, legacySafeProjectionCacheDomainSpec, "archive-manager v1")
  ];
  let imported = 0;
  for (const source of sources) for (const [id, raw] of source.records) {
    if (projectionCacheDomainSpec.layout === "per-record" && !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    guards?.revisions.set(id, 0);
    const revision = 0;
    const unchanged = () => !guards?.deleted.has(id) && (guards?.revisions.get(id) ?? 0) === revision;
    try {
      const record = normalizeLegacyRecord(raw);
      if (record === void 0 || !unchanged()) continue;
      const snapshot = await persistence.stat(id);
      const header = snapshot?.header;
      if (!header || header.id !== id || header.createdAt !== record.identity.createdAt || header.cwd !== record.identity.cwd || (header.isSeeded ?? false) !== (record.identity.isSeeded ?? false) || record.identity.formatVersion !== void 0 && record.identity.formatVersion !== header.version) continue;
      if (header.isSeeded) {
        if (!persistence.open) continue;
        const handle = await persistence.open(id, "read");
        try {
          if (handle.inheritedEventCount !== record.identity.inheritedEventCount) continue;
        } finally {
          await handle.close();
        }
      }
      if (!unchanged()) continue;
      const existing = target.get(id);
      if (existing !== void 0 && mergeCheckpoint(existing, record) === existing) continue;
      try {
        await target.update(id, (current) => unchanged() ? mergeCheckpoint(current, record) : current);
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "missing-key") throw error;
        if (!unchanged()) continue;
        await target.put(id, record);
      }
      imported += 1;
    } catch (error) {
      ctx.logger.warn(`archive-manager projcache: historical row "${id}" handoff failed: ${String(error)}`);
    } finally {
      guards?.revisions.delete(id);
    }
  }
  return imported;
}
class ArchiveProjectionCache extends CacheBase {
  static inject = [...SessionProjectionCache.inject, "sessionPersistence"];
  async [Service.init]() {
    await super[Service.init]();
    const uninstall = await installArchiveProjectionCache(this, Reflect.get(this.ctx, "sessionPersistence"));
    this.ctx.effect(() => uninstall, "archive-manager.projcacheGuards");
  }
}
const projectionGuards = /* @__PURE__ */ new WeakMap();
function installArchiveProjectionCacheGuards(cache) {
  const target = Reflect.get(cache, symbols.original) ?? cache;
  const existing = projectionGuards.get(target);
  if (existing) return existing.uninstall;
  const table = target.requireTable();
  const originalWrite = target.write;
  const originalPut = target.put;
  const deleted = /* @__PURE__ */ new Set();
  const order = [];
  const revisions = /* @__PURE__ */ new Map();
  let tail = Promise.resolve();
  let active = true;
  const track = (task) => {
    tail = Promise.allSettled([tail, task]).then(() => void 0);
    return task;
  };
  const changed = (id) => {
    if (revisions.has(id)) revisions.set(id, revisions.get(id) + 1);
  };
  const put = (id, identity, rows) => {
    changed(id);
    if (deleted.has(id)) return Promise.resolve();
    return track(Reflect.apply(originalPut, receiver, [id, identity, rows]));
  };
  const writeTable = Object.create(table, { put: { value: (id, record) => deleted.has(id) ? Promise.resolve() : table.put(id, record) } });
  const receiver = Object.create(target, {
    put: { value: put, configurable: true },
    requireTable: { value: () => writeTable }
  });
  const methods = {
    write(session) {
      if (deleted.has(session.id)) return Promise.resolve();
      return track(Reflect.apply(originalWrite, receiver, [session]));
    },
    put,
    delete(id) {
      changed(id);
      trackTombstone(deleted, order, id, 4096);
      return track(table.delete(id).then(() => void 0));
    },
    whenIdle: () => tail,
    clearTombstone(id) {
      changed(id);
      deleted.delete(id);
      const index = order.indexOf(id);
      if (index !== -1) order.splice(index, 1);
    }
  };
  const restored = [];
  const restore = () => {
    active = false;
    for (const { name, descriptor, wrapper } of [...restored].reverse()) {
      if (target[name] !== wrapper) continue;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    }
  };
  try {
    for (const [name, method] of Object.entries(methods)) {
      const previous = target[name];
      const wrapper = (...args) => {
        if (!active && typeof previous === "function") return Reflect.apply(previous, target, args);
        return Reflect.apply(method, target, args);
      };
      restored.push({ name, descriptor: Object.getOwnPropertyDescriptor(target, name), wrapper });
      target[name] = wrapper;
    }
  } catch (error) {
    restore();
    throw error;
  }
  let disposal;
  const uninstall = () => {
    if (disposal) return disposal;
    const drain = tail;
    restore();
    projectionGuards.delete(target);
    return disposal = drain;
  };
  projectionGuards.set(target, { uninstall, deleted, revisions });
  return uninstall;
}
async function installArchiveProjectionCache(cache, persistence) {
  const target = Reflect.get(cache, symbols.original) ?? cache;
  const uninstall = installArchiveProjectionCacheGuards(cache);
  try {
    await importPreviousProjectionCache(target.ctx, target.requireTable(), persistence, projectionGuards.get(target));
    return uninstall;
  } catch (error) {
    await uninstall();
    throw error;
  }
}
export {
  ArchiveProjectionCache,
  SafeSessionTable,
  ArchiveProjectionCache as default,
  importPreviousProjectionCache,
  installArchiveProjectionCache,
  installArchiveProjectionCacheGuards,
  legacyProjectionCacheDomainSpec,
  legacySafeProjectionCacheDomainSpec,
  legacySafeV2ProjectionCacheDomainSpec,
  projectionCacheStorageKey,
  safeProjectionCacheDomainSpec
};
