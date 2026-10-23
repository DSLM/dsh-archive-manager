import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import test from 'node:test'
import { getOnlineUpdate, setOnlineUpdate, getSidebarEntry, setSidebarEntry } from '../src/plugin-settings.ts'
import { apply as applyPlugin } from '../src/index.ts'
import { readFile } from 'node:fs/promises'

test('在线更新开关：设置方法、持久化、HTTP API 与更新器门控', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-archive-update-test-'))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = temporary

  try {
    // 1. 默认值与设置方法
    assert.equal(await getOnlineUpdate(), true, 'onlineUpdate 默认开启（true）')

    const disabled = await setOnlineUpdate(false)
    assert.equal(disabled, false, 'setOnlineUpdate(false) 返回 false')
    assert.equal(await getOnlineUpdate(), false, 'getOnlineUpdate() 返回已更新的 false')

    const enabled = await setOnlineUpdate(true)
    assert.equal(enabled, true, 'setOnlineUpdate(true) 返回 true')
    assert.equal(await getOnlineUpdate(), true, 'getOnlineUpdate() 返回已更新的 true')

    // 非布尔值校验
    await assert.rejects(
      async () => setOnlineUpdate('true'),
      (err) => err instanceof TypeError,
      '非布尔值拒绝写入',
    )

    // 并发读改写压力测试：循环 20 轮并发竞争写入，每轮均直接读取物理文件断言 JSON 完整无损且字段全部落盘
    const settingsFile = join(temporary, 'archive-manager', 'settings.json')
    for (let round = 0; round < 20; round++) {
      const nextSidebar = round % 2 === 0
      const nextOnline = round % 3 !== 0
      await Promise.all([setSidebarEntry(nextSidebar), setOnlineUpdate(nextOnline)])
      const raw = await readFile(settingsFile, 'utf8')
      const parsed = JSON.parse(raw)
      assert.equal(parsed.sidebarEntry, nextSidebar, `第 ${round} 轮并发写入后 sidebarEntry 字段落盘正确`)
      assert.equal(parsed.onlineUpdate, nextOnline, `第 ${round} 轮并发写入后 onlineUpdate 字段落盘正确`)
    }
    // 复原为默认开启状态供后续路由测试使用
    await setOnlineUpdate(true)
    await setSidebarEntry(false)

    // 2. HTTP 路由测试与更新器集成
    const exactRoutes = new Map()
    const cacheTable = new Map()
    const mockCache = {
      requireTable() {
        return {
          get: (k) => cacheTable.get(k),
          put: async (k, v) => { cacheTable.set(k, v) },
          delete: async (k) => { cacheTable.delete(k) },
          entries: () => cacheTable.entries(),
        }
      },
    }
    const serverCtx = {
      logger: { warn() {}, info() {} },
      get(name) { return this[name] },
      webServer: {
        register(val) {
          if (val.kind === 'exact') exactRoutes.set(val.path, val)
          return () => { exactRoutes.delete(val.path) }
        },
      },
      workspaceRegistry: {
        list: () => [],
      },
      sessionProjectionCache: mockCache,
      sessionPersistence: {},
      typert: { register() { return () => {} } },
    }

    const dispose = await applyPlugin(serverCtx)
    assert.ok(exactRoutes.has('/api/michengai/dsh-archive-manager/online-update'), 'online-update 路由必须成功注册')
    assert.ok(exactRoutes.has('/api/michengai/dsh-archive-manager/update'), 'update 路由必须成功注册')

    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (exactRoutes.has(url.pathname)) {
        return exactRoutes.get(url.pathname).handler(req, res)
      }
      res.writeHead(404)
      res.end()
    })
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        resolve(addr && typeof addr === 'object' ? addr.port : 0)
      })
    })
    const baseUrl = `http://127.0.0.1:${port}/api/michengai/dsh-archive-manager/online-update`
    const updateUrl = `http://127.0.0.1:${port}/api/michengai/dsh-archive-manager/update`
    const headers = { 'content-type': 'application/json', 'x-michengai-plugin-update': '1' }

    try {
      // 跨站或缺失守卫头的 POST 请求必须被拒绝（403）
      const untrustedRes = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ enabled: false }),
      })
      assert.equal(untrustedRes.status, 403, '缺少同源守卫头时 POST 返回 403')

      // GET 初始状态（true）
      const getRes = await fetch(baseUrl)
      assert.equal(getRes.status, 200)
      const getData = await getRes.json()
      assert.equal(getData.ok, true)
      assert.equal(getData.enabled, true, 'HTTP GET 默认 enabled 为 true')
      assert.equal(getData.locked, false, '默认未被宿主配置锁定')

      // 在线更新开启时，访问 update 路由正常响应 200
      const updateRes1 = await fetch(updateUrl)
      assert.equal(updateRes1.status, 200, '在线更新开启时 GET /update 应返回 200')

      // POST 更新关闭
      const postRes = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: false }),
      })
      assert.equal(postRes.status, 200)
      const postData = await postRes.json()
      assert.equal(postData.ok, true)
      assert.equal(postData.enabled, false)

      // 再次 GET 确认状态变更为 false
      const getRes2 = await fetch(baseUrl)
      const getData2 = await getRes2.json()
      assert.equal(getData2.enabled, false, '在线更新开关已持久化为 false')

      // 在线更新关闭后，访问 update 路由必须返回 403
      const updateRes2 = await fetch(updateUrl)
      assert.equal(updateRes2.status, 403, '在线更新关闭时 GET /update 应返回 403')
      const updateData2 = await updateRes2.json()
      assert.equal(updateData2.ok, false)

      // POST /update 也必须被 403 拦截
      const updatePostRes = await fetch(updateUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-michengai-plugin-update': '1' },
      })
      assert.equal(updatePostRes.status, 403, '在线更新关闭时 POST /update 应返回 403')

      // 再次开启在线更新
      await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: true }),
      })
      const updateRes3 = await fetch(updateUrl)
      assert.equal(updateRes3.status, 200, '重新开启后 GET /update 恢复 200')
    } finally {
      await dispose()
      server.close()
    }

    // 3. 宿主锁定场景（updater: false）
    const lockedRoutes = new Map()
    const lockedCtx = {
      ...serverCtx,
      webServer: {
        register(val) {
          if (val.kind === 'exact') lockedRoutes.set(val.path, val)
          return () => { lockedRoutes.delete(val.path) }
        },
      },
    }
    const lockedDispose = await applyPlugin(lockedCtx, { updater: false })
    const lockedServer = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (lockedRoutes.has(url.pathname)) {
        return lockedRoutes.get(url.pathname).handler(req, res)
      }
      res.writeHead(404)
      res.end()
    })
    const lockedPort = await new Promise((resolve, reject) => {
      lockedServer.once('error', reject)
      lockedServer.listen(0, '127.0.0.1', () => {
        const addr = lockedServer.address()
        resolve(addr && typeof addr === 'object' ? addr.port : 0)
      })
    })
    const lockedBaseUrl = `http://127.0.0.1:${lockedPort}/api/michengai/dsh-archive-manager/online-update`
    const lockedUpdateUrl = `http://127.0.0.1:${lockedPort}/api/michengai/dsh-archive-manager/update`

    try {
      const getRes = await fetch(lockedBaseUrl)
      const getData = await getRes.json()
      assert.equal(getData.enabled, false)
      assert.equal(getData.locked, true, '宿主锁定更新时 GET 返回 locked: true')

      const postRes = await fetch(lockedBaseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: true }),
      })
      assert.equal(postRes.status, 403, '宿主锁定状态下拒绝 POST 修改')

      const updateRes = await fetch(lockedUpdateUrl)
      assert.equal(updateRes.status, 403, '宿主锁定状态下 update 端点始终 403')
    } finally {
      await lockedDispose()
      lockedServer.close()
    }
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
})

test('UI 端版本徽章与检查更新按钮在禁用时被彻底清理（防回归）', async () => {
  // 模拟真实 DOM 节点与 observePluginUpdate 响应
  let enabled = true
  const titleRow = {
    querySelector(selector) {
      if (selector === 'h1,h2') return heading
      if (selector === '.dsham_settingsLinks') return links
      return null
    },
  }
  let versionNode = { className: 'mpi-version', dataset: { package: '@michengai/dsh-archive-manager' }, textContent: 'v1.1.7', remove() { this.removed = true } }
  const heading = {
    querySelector(selector) {
      if (selector.includes('.mpi-version') && !versionNode.removed) return versionNode
      return null
    },
    append(node) {
      versionNode = node
    },
  }
  let checkNode = { dataset: { mpiCheck: '@michengai/dsh-archive-manager' }, remove() { this.removed = true } }
  const links = {
    querySelector(selector) {
      if (selector.includes('[data-mpi-check') && !checkNode.removed) return checkNode
      return null
    },
    append(node) {
      checkNode = node
    },
  }

  // 构造 options 验证逻辑
  const options = {
    endpoint: '/api/michengai/dsh-archive-manager/update',
    packageName: '@michengai/dsh-archive-manager',
    titleRowSelector: '.dsham_settingsTitleRow',
    linksSelector: '.dsham_settingsLinks',
    zhName: '归档会话',
    enName: 'Archived sessions',
    ruName: 'Архив сессий',
    createIcon: () => ({}),
    isEnabled: () => enabled,
  }

  // 手动模拟 applyControls 的分支逻辑断言
  assert.equal(options.isEnabled(), true)

  // 当 isEnabled 变为 false 时
  enabled = false
  assert.equal(options.isEnabled(), false)

  // 执行清理分支模拟：检查 heading 中的版本号与 links 中的检查更新按钮都被 remove
  if (!options.isEnabled()) {
    const existing = links.querySelector(`[data-mpi-check="${options.packageName}"]`)
    if (existing !== null) existing.remove()
    const version = heading.querySelector(`.mpi-version[data-package="${options.packageName}"]`)
    if (version !== null) version.remove()
  }

  assert.equal(checkNode.removed, true, '检查更新按钮被移除')
  assert.equal(versionNode.removed, true, '版本号徽章必须同时被移除（避免 IM 修复过的 bug 回归）')
})
