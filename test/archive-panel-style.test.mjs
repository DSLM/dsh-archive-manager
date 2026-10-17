import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const clientPath = fileURLToPath(new URL("../src/client.ts", import.meta.url));

test("归档会话使用卡片布局，并始终显示恢复与删除操作", async () => {
  const client = await readFile(clientPath, "utf8");

  assert.match(client, /dsham_archiveCardActions/);
  assert.match(client, /dsham_archiveCardMeta/);
  assert.match(client, /onUnarchive\(node\.id\)/);
  assert.match(client, /onDeleteSession\(node\.id, row\.title\)/);
  assert.match(client, /background:var\(--dsw-alias-button-elevated-fill\)/);
});

test("设置页不再桥接 Ant，控件直接使用宿主原语和令牌", async () => {
  const client = await readFile(clientPath, "utf8");
  const discovery = await readFile(new URL("../src/archive-discovery-ui.ts", import.meta.url), "utf8");
  const organizer = await readFile(new URL("../src/archive-organizer-ui.ts", import.meta.url), "utf8");
  for (const source of [client, discovery, organizer]) {
    assert.doesNotMatch(source, /from ["']antd|antd-ui\.js|from ["']dayjs/);
  }
  assert.match(client, /SegmentedTabs/);
  assert.match(client, /dsham_modalDialog/);
  assert.match(client, /--dsw-radius-panel/);
  assert.match(client, /--dsw-alias-bg-layer-2/);
  assert.match(discovery, /SegmentedControl/);
  assert.match(organizer, /NumberField/);
});

test("归档设置页删除确认使用红色危险样式", async () => {
  const client = await readFile(clientPath, "utf8");

  assert.match(client, /danger: true, disabled: busy, onClick: confirmDelete/);
  assert.doesNotMatch(client, /dsham_settingsDeleteConfirm/);
});

test("弹窗按钮对齐宿主：不改尺寸和边框，危险操作只改文字颜色", async () => {
  const client = await readFile(clientPath, "utf8");
  const helper = client.slice(client.indexOf("function modalFooterButton"), client.indexOf("function tabsShell"));

  assert.match(helper, /function modalFooterButton/);
  assert.doesNotMatch(helper, /size:/);
  assert.match(client, /modalFooterButton\(\{ variant: "primary"/);
  assert.match(client, /\.dsham_modalDanger:not\(:disabled\)\{color:var\(--dsw-alias-state-error-primary\)\}/);
  assert.match(client, /className: WorkspaceBrowser_module_css_default\.deleteAction/);
  assert.doesNotMatch(client, /dsham_archiveWorkspaceConfirm/);
  assert.doesNotMatch(client, /border-color:var\(--dsw-alias-state-error-primary\)!important/);
  assert.doesNotMatch(client, /color-mix\(in srgb,var\(--dsw-alias-state-error-primary\)/);
});
