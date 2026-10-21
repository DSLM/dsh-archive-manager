// 在隔离宿主上使用真实 JSON 后端，验证旧缓存交接、文档格式和停用后持久结果。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIsolatedHost } from "../helpers/isolated-host.mjs";

assertIsolatedHost();
const { Context, Service } = await import("@deepseek-ai/cordis");
const { DomainFacility } = await import("@deepseek-ai/dsh-storage-domain");
const { JsonStorageBackend } = await import("@deepseek-ai/dsh-storage-json");
const { SessionProjectionCache, projectionCacheDomainSpec } = await import("@deepseek-ai/dsh-session-projection-cache");
const {
	installArchiveProjectionCache, SafeSessionTable, projectionCacheStorageKey,
	safeProjectionCacheDomainSpec, legacySafeV2ProjectionCacheDomainSpec, legacySafeProjectionCacheDomainSpec,
} = await import("../../lib/projcache.js");

for (const sourceSpec of [safeProjectionCacheDomainSpec, legacySafeV2ProjectionCacheDomainSpec, legacySafeProjectionCacheDomainSpec]) {
	test(`真实 JSON ${sourceSpec.name} v${sourceSpec.version} 交接官方格式，停用重开不丢标题`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "dsh-am-json-handoff-"));
		const ctx = new Context();
		const backend = new JsonStorageBackend(root);
		ctx.provide("storage", { backend: { get: () => backend } });
		const domains = new DomainFacility(ctx, { backend: "json" });
		ctx.provide("storageDomain", domains);
		ctx.provide("sessionProjections", {});
		ctx.provide("sessions", { get: () => undefined });
		let uninstall;
		t.after(async () => {
			await uninstall?.();
			await domains.closeAll();
			await backend.close();
			await rm(root, { recursive: true, force: true });
		});
		const id = "handoff-session";
		const header = { id, version: 4, createdAt: 42, isSeeded: false };
		const identity = { formatVersion: 4, createdAt: 42, isSeeded: false, inheritedEventCount: 0 };
		const source = await domains.open(sourceSpec);
		await new SafeSessionTable(source.table("sessions")).put(id, {
			identity,
			rows: { title: { ver: 1, seq: 8, val: "历史最新标题" }, blank: { ver: 1, seq: 5, val: true } },
		});
		await source.close();
		const sourceFile = join(root, sourceSpec.name, "sessions", `${projectionCacheStorageKey(id)}.json`);
		const originalSource = await readFile(sourceFile, "utf8");
		const cache = new SessionProjectionCache(ctx, { writeEveryEvents: 200, writeIntervalMs: 5000 });
		await cache[Service.init]();
		const official = cache.table;
		await cache.put(id, identity, {
			title: { ver: 1, seq: 1, val: "官方旧标题" }, blank: { ver: 1, seq: 10, val: false },
		});
		uninstall = await installArchiveProjectionCache(cache, { stat: async sid => sid === id ? { header } : undefined });
		assert.equal(cache.table, official);
		assert.equal(official.get(id).rows.title.val, "历史最新标题");
		assert.equal(official.get(id).rows.blank.val, false);
		await uninstall();
		await cache.put("after-disable", identity, { title: { ver: 1, seq: 9, val: "停用后的官方写入" } });
		const officialFile = join(root, projectionCacheDomainSpec.name, "sessions", `${id}.json`);
		const document = JSON.parse(await readFile(officialFile, "utf8"));
		assert.equal(document.version, projectionCacheDomainSpec.version);
		assert.deepEqual(Object.keys(document.record).sort(), ["identity", "rows"]);
		assert.equal(await readFile(sourceFile, "utf8"), originalSource);
		assert.equal((await readdir(join(root, projectionCacheDomainSpec.name, "sessions"))).some(name => name.includes(".bak") || name.endsWith(".tmp")), false);
		await domains.get(projectionCacheDomainSpec.name).close();
		const reopened = await domains.open(projectionCacheDomainSpec);
		assert.equal(reopened.table("sessions").get(id).rows.title.val, "历史最新标题");
		assert.equal(reopened.table("sessions").get("after-disable").rows.title.val, "停用后的官方写入");
	});
}
