import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import type { CheckpointRecord, CheckpointIdentity, Config } from "@deepseek-ai/dsh-session-projection-cache";
import type { DomainSpec, KvTable } from "@deepseek-ai/dsh-storage-domain";

// 上游以 TypeScript private 声明的扩展点在 JS 运行时仍可访问。
// 仅此处描述已由多版本回归覆盖的内部契约，避免把整个宿主退化为无类型对象。
type CacheTable = Pick<KvTable<string, CheckpointRecord>, "get" | "entries" | "keys" | "put" | "update" | "delete" | "size">;
interface CacheCompat extends Omit<SessionProjectionCache, "write"> {
 ctx: Context;
 write(session: Session): Promise<void>;
 table?: CacheTable;
 installWritePath(): void;
 requireTable(): CacheTable;
 put(id: string, identity: CheckpointIdentity, rows: CheckpointRecord["rows"]): Promise<void>;
 [Service.init](): Promise<void>;
}
const CacheBase = SessionProjectionCache as unknown as { new(ctx: Context, config: Config): CacheCompat; prototype: CacheCompat } & Pick<typeof SessionProjectionCache, "Config" | "inject">;
type StoredCheckpoint = CheckpointRecord & { sessionId: string };
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

/**
 * 历史版本曾写入独立安全域。现在仅保留这些声明及键映射用于只读交接，
 * 日常写入完全交还官方域；交接不删除来源记录，可在后续启动重试。
 */
const storedCheckpointRecord = checkpointRecord.extend({
	sessionId: checkpointIdentity.shape.cwd.unwrap()
});
const safeDomainInput = {
	// 旧版 DSH 不支持同名域的版本迁移。v2 改用新域名，确保升级时不会在
	// 打开目标域之前因旧 v1 元数据而终止启动。
	name: "session_projcache_archive_manager_v2",
	version: 2,
	tables: { sessions: domainTable(storedCheckpointRecord) },
	...(projectionCacheDomainSpec.layout === "per-record" ? { layout: "per-record" as const } : {})
};
const safeProjectionCacheDomainSpec = defineDomain(safeDomainInput);

/** 历史官方整文件格式，仅保留导出契约，不再尝试重复打开官方域。 */
const legacyOptionalIdentityFields: Partial<Record<"isSeeded" | "inheritedEventCount", true>> = {};
for (const field of ["isSeeded", "inheritedEventCount"] as const) {
	// rc.2 的身份 schema 尚未定义这些字段；向 Zod 传入不存在的字段会在
	// 首次解析历史记录时抛错，因此只能按当前运行时实际的 schema 构造掩码。
	if (Object.hasOwn(checkpointIdentity.shape, field)) legacyOptionalIdentityFields[field] = true;
}
const legacyCheckpointRecord = checkpointRecord.extend({
	identity: checkpointIdentity.partial(legacyOptionalIdentityFields)
});
const legacyStoredCheckpointRecord = legacyCheckpointRecord.extend({
	sessionId: checkpointIdentity.shape.cwd.unwrap()
});
/** v0.1.24 短暂使用过的旧名 v2 安全缓存域。 */
const legacySafeV2ProjectionCacheDomainSpec = defineDomain({
	name: "session_projcache_archive_manager",
	version: 2,
	tables: { sessions: domainTable(storedCheckpointRecord) },
	...(projectionCacheDomainSpec.layout === "per-record" ? { layout: "per-record" as const } : {})
});
/** v0.1.23 及以前归档管理器自身使用的安全缓存域。 */
const legacySafeProjectionCacheDomainSpec = defineDomain({
	name: "session_projcache_archive_manager",
	version: 1,
	tables: { sessions: domainTable(legacyStoredCheckpointRecord) },
	...(projectionCacheDomainSpec.layout === "per-record" ? { layout: "per-record" as const } : {})
});
const legacyProjectionCacheDomainSpec = defineDomain({
	name: "session_projcache",
	version: 3,
	tables: { sessions: domainTable(legacyCheckpointRecord) }
});

function projectionCacheStorageKey(sessionId: string) {
	return `session_${createHash("sha256").update(sessionId, "utf8").digest("base64url")}`;
}

function unwrapStoredCheckpoint<T extends { identity: unknown; rows: unknown }>(stored: T): Pick<T, "identity" | "rows"> {
	return { identity: stored.identity, rows: stored.rows };
}

/** 历史安全表适配器；保留旧导出，正式安装路径不再使用它接管缓存。 */
class SafeSessionTable {
	declare table: KvTable<string, StoredCheckpoint>;
	constructor(table: KvTable<string, StoredCheckpoint>) {
		this.table = table;
	}
	get size() {
		return [...this.keys()].length;
	}
	get(sessionId: string) {
		const stored = this.table.get(projectionCacheStorageKey(sessionId));
		if (stored === void 0 || stored.sessionId !== sessionId) return void 0;
		return unwrapStoredCheckpoint(stored);
	}
	has(sessionId: string) {
		return this.get(sessionId) !== void 0;
	}
	*entries() {
		for (const [key, stored] of this.table.entries()) {
			if (projectionCacheStorageKey(stored.sessionId) !== key) continue;
			yield [stored.sessionId, unwrapStoredCheckpoint(stored)] as [string, CheckpointRecord];
		}
	}
	*keys() {
		for (const [sessionId] of this.entries()) yield sessionId;
	}
	*values() {
		for (const [, value] of this.entries()) yield value;
	}
	async put(sessionId: string, record: CheckpointRecord) {
		const key = projectionCacheStorageKey(sessionId);
		const existing = this.table.get(key);
		if (existing !== void 0 && existing.sessionId !== sessionId) {
			throw new Error(`projection-cache storage-key collision for "${sessionId}"`);
		}
		await this.table.put(key, { sessionId, identity: record.identity, rows: record.rows });
	}
	async delete(sessionId: string) {
		const key = projectionCacheStorageKey(sessionId);
		const existing = this.table.get(key);
		if (existing === void 0 || existing.sessionId !== sessionId) return false;
		return this.table.delete(key);
	}
}

async function readSourceRecords(ctx: Context, spec: DomainSpec, label: string): Promise<{ opened: boolean; records: [string, unknown][] }> {
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

async function readLegacySafeRecords(ctx: Context, spec: DomainSpec, label: string) {
	const source = await readSourceRecords(ctx, spec, label);
	const records: [string, unknown][] = [];
	for (const [physicalKey, stored] of source.records) {
		if (stored === null || typeof stored !== "object" || !("sessionId" in stored) || typeof stored.sessionId !== "string") {
			ctx.logger.warn(`archive-manager projcache: ${label} row "${physicalKey}" import skipped because its session id is invalid`);
			continue;
		}
		if (projectionCacheStorageKey(stored.sessionId) !== physicalKey) {
			ctx.logger.warn(`archive-manager projcache: ${label} row "${physicalKey}" import skipped because its storage key does not match the session id`);
			continue;
		}
		records.push([stored.sessionId, { identity: "identity" in stored ? stored.identity : undefined, rows: "rows" in stored ? stored.rows : undefined }]);
	}
	return { ...source, records };
}

/**
 * 旧版记录没有完整身份时，只能安全补齐未播种会话的零继承切点。
 * 播种会话无法从头部反推出精确切点，宁可跳过并按需重建。
 */
function normalizeLegacyRecord(record: unknown): CheckpointRecord | undefined {
	if (record === null || typeof record !== "object" || !("identity" in record) || record.identity === null || typeof record.identity !== "object") return void 0;
	const identity = record.identity as Record<string, unknown>;
	const inheritedEventCount = identity.inheritedEventCount;
	const validOffset = typeof inheritedEventCount === "number" && Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0;
	if (identity.isSeeded === true) {
		if (!validOffset) return void 0;
		checkpointRecord.parse(record);
		// 旧宿主 schema 会剔除未知身份字段，校验后保留原记录。
		return record as CheckpointRecord;
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
	return normalized as CheckpointRecord;
}

/** 迁移只读会话头；播种会话另读取句柄的继承切点，不读取正文。 */
export interface MigrationPersistence {
	stat(id: string): Promise<{ header: { id: string; version?: number; createdAt: number; cwd?: string; isSeeded?: boolean } } | undefined>;
	open?(id: string, mode: "read"): Promise<{ inheritedEventCount: number; close(): Promise<void> }>;
}

function sameIdentity(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
	return left.createdAt === right.createdAt && left.cwd === right.cwd
		&& left.formatVersion === right.formatVersion
		&& (left.isSeeded ?? false) === (right.isSeeded ?? false)
		&& (left.inheritedEventCount ?? 0) === (right.inheritedEventCount ?? 0);
}

/** 同版本投影仅接受更高序号；不同版本不猜测谁更新。 */
function mergeCheckpoint(current: CheckpointRecord | undefined, incoming: CheckpointRecord): CheckpointRecord {
	// 历史记录无法证明格式语义时，不降级同生命周期的当前格式缓存。
	if (current !== undefined && incoming.identity.formatVersion === undefined
		&& current.identity.formatVersion !== undefined
		&& current.identity.createdAt === incoming.identity.createdAt
		&& current.identity.cwd === incoming.identity.cwd
		&& (current.identity.isSeeded ?? false) === (incoming.identity.isSeeded ?? false)) return current;
	if (current === undefined || !sameIdentity(current.identity, incoming.identity)) return incoming;
	const rows = { ...current.rows };
	let changed = false;
	for (const [key, row] of Object.entries(incoming.rows)) {
		const previous = rows[key];
		if (previous === undefined || (previous.ver === row.ver && previous.seq < row.seq)) {
			rows[key] = row;
			changed = true;
		}
	}
	return changed ? { identity: current.identity, rows } : current;
}

/** 只向官方表交接旧插件缓存；不再打开或重定向官方域，也不删除来源数据。 */
async function importPreviousProjectionCache(ctx: Context, target: CacheTable, persistence?: MigrationPersistence, guards?: GuardState) {
	if (persistence === undefined) return 0;
	const sources = [
		await readLegacySafeRecords(ctx, safeProjectionCacheDomainSpec, "archive-manager current"),
		await readLegacySafeRecords(ctx, legacySafeV2ProjectionCacheDomainSpec, "archive-manager v2"),
		// 逐记录后端会把不同版本当缺行，打开成功也须单独读取 v1。
		await readLegacySafeRecords(ctx, legacySafeProjectionCacheDomainSpec, "archive-manager v1"),
	];
	let imported = 0;
	for (const source of sources) for (const [id, raw] of source.records) {
		// 当前 per-record 后端拒绝冒号等物理键；旧行保留在来源域，不另建替代缓存。
		if (projectionCacheDomainSpec.layout === "per-record" && !/^[A-Za-z0-9_-]+$/.test(id)) continue;
		guards?.revisions.set(id, 0);
		const revision = 0;
		const unchanged = () => !guards?.deleted.has(id) && (guards?.revisions.get(id) ?? 0) === revision;
		try {
			const record = normalizeLegacyRecord(raw);
			if (record === undefined || !unchanged()) continue;
			const snapshot = await persistence.stat(id);
			const header = snapshot?.header;
			if (!header || header.id !== id || header.createdAt !== record.identity.createdAt
				|| header.cwd !== record.identity.cwd
				|| (header.isSeeded ?? false) !== (record.identity.isSeeded ?? false)
				|| (record.identity.formatVersion !== undefined && record.identity.formatVersion !== header.version)) continue;
			if (header.isSeeded) {
				if (!persistence.open) continue;
				const handle = await persistence.open(id, "read");
				try { if (handle.inheritedEventCount !== record.identity.inheritedEventCount) continue; }
				finally { await handle.close(); }
			}
			if (!unchanged()) continue;
			const existing = target.get(id);
			if (existing !== undefined && mergeCheckpoint(existing, record) === existing) continue;
			// update 的回调在官方写队列内部读取最新值，包含安装前已排队的写入。
			try {
				await target.update(id, current => unchanged() ? mergeCheckpoint(current, record) : current);
			} catch (error) {
				if (!(error instanceof Error) || Reflect.get(error, "code") !== "missing-key") throw error;
				// 新写入会同步增加 revision；缺行回退期间发生过写入则留给官方结果。
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
/** 保留旧导出入口，但初始化和持久化均使用官方服务实现。 */
class ArchiveProjectionCache extends CacheBase {
	static inject = [...SessionProjectionCache.inject, "sessionPersistence"];
	declare delete: (id: string) => Promise<void>;
	declare whenIdle: () => Promise<void>;
	declare clearTombstone: (id: string) => void;
	async [Service.init]() {
		await super[Service.init]();
		const uninstall = await installArchiveProjectionCache(this, Reflect.get(this.ctx, "sessionPersistence") as MigrationPersistence | undefined);
		this.ctx.effect(() => uninstall, "archive-manager.projcacheGuards");
	}
}
/** 删除版本也用于迁移：并发写入后，旧缓存不得再覆盖该会话。 */
interface GuardState {
	uninstall(): Promise<void>;
	deleted: Set<string>;
	revisions: Map<string, number>;
}
const projectionGuards = new WeakMap<object, GuardState>();

/** 只包装删除所需入口，保留宿主的初始化、读取、表和原始写入实现。 */
export function installArchiveProjectionCacheGuards(cache: object): () => Promise<void> {
	const target = ((Reflect.get(cache, symbols.original) as object | undefined) ?? cache) as CacheCompat & Record<string, unknown>;
	const existing = projectionGuards.get(target);
	if (existing) return existing.uninstall;
	const table = target.requireTable();
	const originalWrite = target.write;
	const originalPut = target.put;
	const deleted = new Set<string>();
	const order: string[] = [];
	const revisions = new Map<string, number>();
	let tail = Promise.resolve();
	let active = true;
	const track = <T>(task: Promise<T>): Promise<T> => {
		tail = Promise.allSettled([tail, task]).then(() => void 0);
		return task;
	};
	const changed = (id: string) => {
		if (revisions.has(id)) revisions.set(id, revisions.get(id)! + 1);
	};
	const put = (id: string, identity: CheckpointIdentity, rows: CheckpointRecord["rows"]): Promise<void> => {
		changed(id);
		if (deleted.has(id)) return Promise.resolve();
		// 原始 put 在首次 await 前进入官方表的串行队列，delete 紧随其后排队。
		return track(Reflect.apply(originalPut, receiver, [id, identity, rows]) as Promise<void>);
	};
	// 在途 write 恢复后仍使用安装时的 put 守护，避免 flush 后的嵌套写入复活墓碑。
	const writeTable = Object.create(table, { put: { value: (id: string, record: CheckpointRecord) =>
		deleted.has(id) ? Promise.resolve() : table.put(id, record) } }) as CacheTable;
	const receiver = Object.create(target, {
		put: { value: put, configurable: true },
		requireTable: { value: () => writeTable },
	}) as CacheCompat;
	const methods = {
		write(session: Session): Promise<void> {
			if (deleted.has(session.id)) return Promise.resolve();
			return track(Reflect.apply(originalWrite, receiver, [session]) as Promise<void>);
		},
		put,
		delete(id: string): Promise<void> {
			changed(id);
			trackTombstone(deleted, order, id, 4096);
			return track(table.delete(id).then(() => void 0));
		},
		whenIdle: () => tail,
		clearTombstone(id: string) {
			changed(id);
			deleted.delete(id);
			const index = order.indexOf(id);
			if (index !== -1) order.splice(index, 1);
		},
	};
	const restored: { name: string; descriptor?: PropertyDescriptor; wrapper: unknown }[] = [];
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
			const wrapper = (...args: unknown[]) => {
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
	let disposal: Promise<void> | undefined;
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
/** 安装删除守护；官方投影表及其读写路径保持原样。 */
export async function installArchiveProjectionCache(cache: object, persistence?: MigrationPersistence): Promise<() => Promise<void>> {
	const target = ((Reflect.get(cache, symbols.original) as object | undefined) ?? cache) as CacheCompat;
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
	ArchiveProjectionCache as default,
	SafeSessionTable,
	importPreviousProjectionCache,
	legacyProjectionCacheDomainSpec,
	legacySafeProjectionCacheDomainSpec,
	legacySafeV2ProjectionCacheDomainSpec,
	projectionCacheStorageKey,
	safeProjectionCacheDomainSpec
};
