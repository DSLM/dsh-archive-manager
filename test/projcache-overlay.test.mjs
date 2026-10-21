import assert from "node:assert/strict";
import test from "node:test";
import { Context, Service, symbols } from "@deepseek-ai/cordis";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { SessionProjectionCache } from "@deepseek-ai/dsh-session-projection-cache";
import { apply, inject } from "../lib/index.js";
import { installArchiveProjectionCache, installArchiveProjectionCacheGuards, ArchiveProjectionCache, SafeSessionTable, safeProjectionCacheDomainSpec, legacySafeProjectionCacheDomainSpec, legacySafeV2ProjectionCacheDomainSpec } from "../lib/projcache.js";

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

// 保留真实域的重复打开限制、写入队列和关闭行为，仅替换最底层存储介质。
async function mountCache({ layered = false, headers = new Map(), CacheClass = SessionProjectionCache } = {}) {
	const ctx = new Context();
	const units = new Map();
	const opened = [];
	const closed = [];
	let beforePut = async () => {};
	let domains;
	const provideStorage = (serviceCtx) => {
		serviceCtx.provide("storage", { backend: { get: () => ({ kv: {
			async open(spec) {
				opened.push(spec.name);
				let state = units.get(spec.name);
				if (state === undefined) {
					state = { version: spec.version, tables: Object.fromEntries(spec.tables.map((name) => [name, {}])), global: null };
					units.set(spec.name, state);
				}
				return {
					loadAll: async () => structuredClone(state.version === spec.version ? state : { version: spec.version, tables: Object.fromEntries(spec.tables.map(name => [name, {}])), global: null }),
					putRecord: async (table, key, value) => {
						await beforePut(spec.name, key);
						state.tables[table][key] = structuredClone(value);
					},
					deleteRecord: async (table, key) => { delete state.tables[table][key]; },
					setGlobal: async (value) => { state.global = structuredClone(value); },
					close: async () => { closed.push(spec.name); },
				};
			},
		} }) } });
		domains = new DomainFacility(serviceCtx, { backend: "memory" });
		serviceCtx.provide("storageDomain", domains);
		serviceCtx.provide("sessionProjections", {});
		serviceCtx.provide("sessions", { get: () => undefined });
	};
	let cache;
	const provideCache = async (serviceCtx) => {
		cache = new CacheClass(serviceCtx, { writeEveryEvents: 200, writeIntervalMs: 5000 });
		await cache[Service.init]();
	};
	let storageFiber;
	let cacheFiber;
	if (layered) {
		// 根 Context 上的服务可绕过注入门禁，必须模拟宿主的独立插件提供者。
		storageFiber = ctx.plugin({ name: "overlay-storage", apply: provideStorage });
		await storageFiber;
		cacheFiber = ctx.plugin({ name: "overlay-official-cache", inject: ["storageDomain", "sessionProjections", "sessions"], apply: provideCache });
		await cacheFiber;
	} else {
		provideStorage(ctx);
		await provideCache(ctx);
	}
	return { ctx, cache, domains, opened, closed, persistence: { stat: async (id) => {
		const header = headers.get(id);
		return header ? { header } : undefined;
	} }, delayPut: (callback) => { beforePut = callback; }, async dispose() {
		await domains.get("session_projcache")?.close();
		await cacheFiber?.dispose();
		await storageFiber?.dispose();
	} };
}

const identity = { formatVersion: 4, createdAt: 1, isSeeded: false, inheritedEventCount: 0 };
const rows = (title) => ({ title: { ver: 1, seq: 1, val: title } });

test("归档插件始终保留官方表，停用后标题与空白状态仍在官方域", async () => {
	const host = await mountCache();
	const official = host.cache.table;
	const read = host.cache.cachedSnapshot;
	let uninstall;
	try {
		uninstall = await installArchiveProjectionCache(host.cache);
		assert.equal(host.cache.table, official);
		assert.equal(host.cache.cachedSnapshot, read);
		await host.cache.put("kept", identity, {
			...rows("停用后保留"),
			blank: { ver: 1, seq: 1, val: true },
		});
		await uninstall();
		assert.equal(official.get("kept").rows.title.val, "停用后保留");
		assert.equal(official.get("kept").rows.blank.val, true);
		assert.equal(host.closed.includes("session_projcache"), false);
	} finally {
		await uninstall?.();
		await host.dispose();
	}
});

test("兼容子类入口也初始化官方域而不是安全域", async () => {
	const host = await mountCache({ CacheClass: ArchiveProjectionCache });
	try {
		assert.equal(host.opened[0], "session_projcache");
		await host.cache.put("official-class", identity, rows("官方类入口"));
		assert.equal(host.cache.table.get("official-class").rows.title.val, "官方类入口");
		await host.cache.delete("official-class");
		assert.equal(host.cache.table.get("official-class"), undefined);
	} finally { await host.dispose(); }
});

test("历史安全域交接更新旧标题，保留官方更新的行且不回写旧域", async () => {
	const host = await mountCache({ headers: new Map([["shared", { id: "shared", version: 4, createdAt: 1, isSeeded: false }]]) });
	const official = host.cache.table;
	await host.cache.put("shared", identity, {
		title: { ver: 1, seq: 1, val: "旧官方标题" },
		blank: { ver: 1, seq: 10, val: false },
	});
	const domain = await host.domains.open(safeProjectionCacheDomainSpec);
	const legacy = { identity, rows: {
		title: { ver: 1, seq: 9, val: "最新标题" },
		blank: { ver: 1, seq: 8, val: true },
	} };
	await new SafeSessionTable(domain.table("sessions")).put("shared", legacy);
	await domain.close();
	let uninstall;
	try {
		uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
		assert.equal(host.cache.table, official);
		assert.equal(official.get("shared").rows.title.val, "最新标题");
		assert.equal(official.get("shared").rows.blank.val, false);
		await host.cache.put("new-session", identity, rows("新会话"));
		await uninstall();
		const source = await host.domains.open(safeProjectionCacheDomainSpec);
		assert.deepEqual(new SafeSessionTable(source.table("sessions")).get("shared"), legacy);
		assert.equal(new SafeSessionTable(source.table("sessions")).get("new-session"), undefined);
		await source.close();
	} finally {
		await uninstall?.();
		await host.dispose();
	}
});

test("删除守护只包装必要方法并委托宿主原始写入", async () => {
	const host = await mountCache();
	const originalInit = host.cache[Service.init];
	const originalPut = host.cache.put;
	let called = 0;
	host.cache.put = async function (...args) {
		called += 1;
		return Reflect.apply(originalPut, this, args);
	};
	const customizedPut = host.cache.put;
	const uninstall = installArchiveProjectionCacheGuards(host.cache);
	try {
		assert.equal(host.cache[Service.init], originalInit);
		assert.equal(Object.hasOwn(host.cache, "putCore"), false);
		assert.equal(Object.hasOwn(host.cache, "writeCore"), false);
		await host.cache.put("native", identity, rows("原方法"));
		assert.equal(called, 1);
		await host.cache.delete("native");
		await host.cache.put("native", identity, rows("不复活"));
		assert.equal(called, 1);
		assert.equal(host.cache.table.get("native"), undefined);
		await uninstall();
		assert.equal(host.cache.put, customizedPut);
	} finally {
		await uninstall();
		await host.dispose();
	}
});

async function seedLegacy(host, id, record, spec = safeProjectionCacheDomainSpec) {
	const domain = await host.domains.open(spec);
	await new SafeSessionTable(domain.table("sessions")).put(id, record);
	await domain.close();
}

function mountRoot(host) {
	host.ctx.provide("workspaceRegistry", { host: { sessionPath: () => undefined }, invalidSessionPaths: new Set() });
	host.ctx.provide("typert", { register: () => () => {} });
	host.ctx.provide("webServer", { register: () => () => {} });
	host.ctx.provide("sessionPersistence", host.persistence);
	return host.ctx.plugin({ name: "archive-official-cache-test", apply, inject });
}

test("正式根入口也交接旧缓存，停用保留官方标题", async () => {
	const host = await mountCache({ headers: new Map([["root", { id: "root", version: 4, createdAt: 1 }]]) });
	await seedLegacy(host, "root", { identity, rows: rows("根入口旧缓存") });
	let fiber;
	try {
		fiber = mountRoot(host);
		await fiber;
		assert.equal(host.cache.table.get("root")?.rows.title.val, "根入口旧缓存");
		await fiber.dispose();
		assert.equal(host.cache.table.get("root").rows.title.val, "根入口旧缓存");
	} finally { await fiber?.dispose(); await host.dispose(); }
});

test("真实插件注入下保持官方表和读取入口，停用还原方法", async () => {
	const host = await mountCache({ layered: true });
	const official = host.cache.table, originalPut = host.cache.put;
	let fiber;
	try {
		fiber = host.ctx.plugin({ name: "cache-consumer", inject: ["sessionProjectionCache"], async apply(ctx) {
			const proxy = ctx.sessionProjectionCache;
			assert.equal(Reflect.get(proxy, symbols.original), host.cache);
			assert.throws(() => proxy.ctx.storageDomain, /without inject/);
			const uninstall = await installArchiveProjectionCache(proxy);
			ctx.effect(() => uninstall);
			await proxy.put("native", identity, rows("官方写入"));
		} });
		await fiber;
		assert.equal(host.cache.table, official);
		assert.equal(official.get("native").rows.title.val, "官方写入");
		await fiber.dispose();
		assert.equal(host.cache.put, originalPut);
		assert.equal(host.closed.includes("session_projcache"), false);
	} finally { await fiber?.dispose(); await host.dispose(); }
});

for (const mutation of ["put", "delete"]) {
	test(`迁移核验期间发生 ${mutation} 时旧缓存不得覆盖或复活`, async () => {
		const host = await mountCache();
		await seedLegacy(host, "race", { identity, rows: rows("过时缓存") });
		const started = deferred(), finish = deferred();
		host.persistence.stat = async () => { started.resolve(); await finish.promise; return { header: { id: "race", version: 4, createdAt: 1 } }; };
		const installing = installArchiveProjectionCache(host.cache, host.persistence);
		let uninstall;
		try {
			await started.promise;
			if (mutation === "put") await host.cache.put("race", identity, rows("运行中的新标题"));
			else await host.cache.delete("race");
			finish.resolve(); uninstall = await installing;
			assert.equal(host.cache.table.get("race")?.rows.title.val, mutation === "put" ? "运行中的新标题" : undefined);
		} finally { finish.resolve(); uninstall ??= await installing; await uninstall(); await host.dispose(); }
	});
}

test("迁移跳过孤儿、生命周期不符和官方不接受的物理键", async () => {
	const host = await mountCache();
	for (const id of ["orphan", "recreated", "im:unsafe"]) await seedLegacy(host, id, { identity, rows: rows("旧缓存") });
	host.persistence.stat = async id => id === "orphan" ? undefined : { header: { id, version: 4, createdAt: 2 } };
	const uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
	try { assert.equal(host.cache.table.size, 0); }
	finally { await uninstall(); await host.dispose(); }
});

test("迁移失败仍可使用官方表与删除守护，重启安装可重试", async () => {
	const host = await mountCache({ headers: new Map([["retry", { id: "retry", version: 4, createdAt: 1 }]]) });
	await seedLegacy(host, "retry", { identity, rows: rows("重试标题") });
	host.delayPut(async name => { if (name === "session_projcache") throw new Error("磁盘暂时不可写"); });
	let uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
	try {
		assert.equal(typeof host.cache.delete, "function");
		assert.equal(host.cache.table.get("retry"), undefined);
		await uninstall();
		host.delayPut(async () => {});
		uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
		assert.equal(host.cache.table.get("retry").rows.title.val, "重试标题");
	} finally { await uninstall(); await host.dispose(); }
});

test("官方已有投影版本与历史版本不同时保留官方行", async () => {
	const host = await mountCache({ headers: new Map([["versions", { id: "versions", version: 4, createdAt: 1 }]]) });
	await host.cache.put("versions", identity, { title: { ver: 2, seq: 1, val: "官方版本" } });
	await seedLegacy(host, "versions", { identity, rows: { title: { ver: 1, seq: 99, val: "旧版本" } } });
	const uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
	try { assert.equal(host.cache.table.get("versions").rows.title.val, "官方版本"); }
	finally { await uninstall(); await host.dispose(); }
});

test("删除覆盖在途官方 put，墓碑挡住冷读写回，同 ID 新生命周期可解除", async () => {
	const host = await mountCache();
	const uninstall = await installArchiveProjectionCache(host.cache);
	const started = deferred(), finish = deferred();
	host.delayPut(async () => { started.resolve(); await finish.promise; });
	const pending = host.cache.put("same", identity, rows("在途写入"));
	await started.promise;
	const deleting = host.cache.delete("same");
	try {
		finish.resolve(); await Promise.all([pending, deleting]);
		assert.equal(host.cache.table.get("same"), undefined);
		await host.cache.put("same", identity, rows("不得复活"));
		assert.equal(host.cache.table.get("same"), undefined);
		host.cache.clearTombstone("same");
		await host.cache.put("same", identity, rows("新生命周期"));
		assert.equal(host.cache.table.get("same").rows.title.val, "新生命周期");
	} finally { finish.resolve(); await Promise.allSettled([pending, deleting]); await uninstall(); await host.dispose(); }
});

test("异步宿主 put 在进入表之前遇到删除也不得复活", async () => {
	const host = await mountCache();
	const original = host.cache.put;
	const started = deferred(), finish = deferred();
	host.cache.put = async function (...args) { started.resolve(); await finish.promise; return Reflect.apply(original, this, args); };
	const uninstall = installArchiveProjectionCacheGuards(host.cache);
	const pending = host.cache.put("late", identity, rows("迟到"));
	try {
		await started.promise; await host.cache.delete("late"); finish.resolve(); await pending;
		assert.equal(host.cache.table.get("late"), undefined);
	} finally { finish.resolve(); await pending; await uninstall(); await host.dispose(); }
});

test("卸载只等待已有写入，不追逐后续官方写入", async () => {
	const host = await mountCache();
	const uninstall = await installArchiveProjectionCache(host.cache);
	const first = deferred(), second = deferred(), started = deferred(), secondStarted = deferred();
	let writes = 0;
	host.delayPut(async () => { if (writes++ === 0) { started.resolve(); await first.promise; } else { secondStarted.resolve(); await second.promise; } });
	const pending = host.cache.put("first", identity, rows("first")); await started.promise;
	const stalePut = host.cache.put;
	const stopping = uninstall(); assert.equal(uninstall(), stopping);
	const added = stalePut("second", identity, rows("second"));
	try {
		first.resolve(); await pending; await secondStarted.promise; await stopping;
		assert.equal(host.cache.delete, undefined);
		assert.equal(host.cache.table.get("first").rows.title.val, "first");
	} finally { first.resolve(); second.resolve(); await Promise.allSettled([pending, added, stopping]); await host.dispose(); }
});

test("卸载前的 write 在 flush 后继续写官方表，但不复活墓碑", async () => {
	const host = await mountCache();
	const original = host.cache.table;
	const uninstall = await installArchiveProjectionCache(host.cache);
	const started = deferred(), finish = deferred();
	const session = { id: "late-write", header: { id: "late-write", version: 4, createdAt: 1 }, inheritedEventCount: 0 };
	host.ctx.sessionProjections.checkpoint = () => rows("旧 write");
	host.ctx.sessions.get = () => session;
	host.ctx.sessions.flush = async () => { started.resolve(); await finish.promise; };
	const pending = host.cache.write(session); await started.promise;
	await host.cache.delete(session.id);
	const stopping = uninstall();
	try {
		await host.cache.put("fresh", identity, rows("不受影响"));
		finish.resolve(); await pending; await stopping;
		assert.equal(original.get(session.id), undefined);
		assert.equal(original.get("fresh").rows.title.val, "不受影响");
	} finally { finish.resolve(); await Promise.allSettled([pending, stopping]); await host.dispose(); }
});

for (const spec of [legacySafeProjectionCacheDomainSpec, legacySafeV2ProjectionCacheDomainSpec]) {
	test(`旧名 v${spec.version} 缓存交接到官方域且重复安装幂等`, async () => {
		const host = await mountCache({ headers: new Map([["legacy", { id: "legacy", version: 4, createdAt: 1 }]]) });
		await seedLegacy(host, "legacy", { identity, rows: rows("旧名标题") }, spec);
		let uninstall;
		try {
			uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
			assert.equal(host.cache.table.get("legacy")?.rows.title.val, "旧名标题");
			await uninstall();
			await host.cache.put("legacy", identity, { title: { ver: 1, seq: 99, val: "官方更新" } });
			let repeatedWrites = 0;
			host.delayPut(async name => { if (name === "session_projcache") repeatedWrites += 1; });
			uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
			assert.equal(host.cache.table.get("legacy").rows.title.val, "官方更新");
			assert.equal(repeatedWrites, 0, "已经交接的旧记录不重复写入官方域");
		} finally { await uninstall?.(); await host.dispose(); }
	});
}

test("历史缺少格式身份的记录不得覆盖官方当前格式投影", async () => {
	const host = await mountCache({ headers: new Map([["format", { id: "format", version: 4, createdAt: 1 }]]) });
	await host.cache.put("format", identity, rows("当前格式"));
	const { formatVersion, ...oldIdentity } = identity;
	await seedLegacy(host, "format", { identity: oldIdentity, rows: { title: { ver: 1, seq: 99, val: "未知旧格式" } } });
	const uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
	try { assert.equal(host.cache.table.get("format").rows.title.val, "当前格式"); }
	finally { await uninstall(); await host.dispose(); }
});

for (const count of [3, 7]) {
	test(`播种缓存核验继承切点 ${count} 并关闭只读句柄`, async () => {
		const host = await mountCache({ headers: new Map([["seed", { id: "seed", version: 4, createdAt: 1, isSeeded: true }]]) });
		await seedLegacy(host, "seed", { identity: { ...identity, isSeeded: true, inheritedEventCount: 3 }, rows: rows("播种标题") });
		let closed = 0;
		host.persistence.open = async () => ({ inheritedEventCount: count, close: async () => { closed += 1; } });
		const uninstall = await installArchiveProjectionCache(host.cache, host.persistence);
		try {
			assert.equal(host.cache.table.get("seed")?.rows.title.val, count === 3 ? "播种标题" : undefined);
			assert.equal(closed, 1);
		} finally { await uninstall(); await host.dispose(); }
	});
}

test("守护幂等且停用恢复原始方法描述符", async () => {
	const host = await mountCache();
	const original = Object.getOwnPropertyDescriptor(host.cache, "put");
	const uninstall = installArchiveProjectionCacheGuards(host.cache);
	assert.equal(installArchiveProjectionCacheGuards(host.cache), uninstall);
	await uninstall();
	assert.deepEqual(Object.getOwnPropertyDescriptor(host.cache, "put"), original);
	await host.dispose();
});

test("根插件停用等待官方缓存写入，但不关闭官方域", async () => {
	const host = await mountCache(); const fiber = mountRoot(host); await fiber;
	const started = deferred(), finish = deferred();
	host.delayPut(async () => { started.resolve(); await finish.promise; });
	const pending = host.cache.put("during-stop", identity, {}); await started.promise;
	const stopping = fiber.dispose(); let stopped = false; stopping.then(() => { stopped = true; });
	try {
		await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
		finish.resolve(); await pending; await stopping;
		assert.equal(host.closed.includes("session_projcache"), false);
	} finally { finish.resolve(); await Promise.allSettled([pending, stopping]); await host.dispose(); }
});
