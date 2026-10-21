import { bindArchiveManagerRemote, installArchiveWorkspace, tolerateStaleFileUploadResolver } from "./workspace.js";
import { installArchiveProjectionCache, installArchiveProjectionCacheGuards } from "./projcache.js";
const inject = ["workspaceRegistry", "sessionProjectionCache", "sessionPersistence", "typert"];
async function apply(ctx) {
  tolerateStaleFileUploadResolver(ctx);
  const registry = ctx.workspaceRegistry;
  const cache = ctx.sessionProjectionCache;
  const uninstallWorkspace = installArchiveWorkspace(registry);
  let uninstallCache = async () => {
  };
  let unbindRemote = () => {
  };
  const dispose = async () => {
    try {
      unbindRemote();
    } finally {
      try {
        await uninstallCache();
      } finally {
        uninstallWorkspace();
      }
    }
  };
  try {
    try {
      uninstallCache = await installArchiveProjectionCache(cache, Reflect.get(ctx, "sessionPersistence"));
    } catch (error) {
      ctx.logger?.warn?.(`archive-manager: projection cache handoff skipped: ${String(error)}`);
      uninstallCache = installArchiveProjectionCacheGuards(cache);
    }
    unbindRemote = bindArchiveManagerRemote(ctx);
  } catch (error) {
    await dispose();
    throw error;
  }
  return dispose;
}
export {
  apply,
  inject
};
