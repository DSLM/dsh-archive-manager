import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createOrganizerPanel, organizerZh } from "../src/archive-organizer-ui.ts";
const Panel = createOrganizerPanel(React);
const props = { t: key => organizerZh[key] ?? key, ready: true, busy: false, days: 30, count: 0, undoCount: 0 };
test("已归档页没有空闲置整理框或重复的收藏筛选", () => {
  const html = renderToStaticMarkup(React.createElement(Panel, { ...props, archived: true }));
  assert.doesNotMatch(html, /class="dsham_organizer"|只看收藏/);
});
test("失败计数与重试按钮一致，不再显示恒为零的未处理", () => {
  const t = (key, values) => {
    let text = organizerZh[key] ?? key;
    if (values) for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
  const tree = Panel({ ...props, t, archived: false, result: { kind: "archive", succeeded: ["a"], skipped: [], failures: [{ sessionId: "b", message: "失败" }, { sessionId: "c", message: "失败" }], remaining: ["b", "c"] } });
  const children = React.Children.toArray(tree.props.children);
  const feedback = children.find(child => child.props?.className === "dsham_batchFeedback");
  const text = (node) => node == null || typeof node === "boolean" ? "" : typeof node === "string" || typeof node === "number" ? String(node) : [node.props?.children].flat().map(text).join("");
  const html = text(feedback);
  assert.match(html, /失败 2/);
  assert.match(html, /重试剩余 2/);
  assert.doesNotMatch(html, /未处理/);
});
test("删除结果独立于闲置整理区域并保留失败重试", () => {
  const tree = Panel({ ...props, archived: false, result: { kind: "delete", succeeded: [], skipped: [], failures: [{ sessionId: "a", message: "失败" }], remaining: ["a"] } });
  const children = React.Children.toArray(tree.props.children);
  const feedback = children.find(child => child.props?.className === "dsham_batchFeedback");
  assert.ok(feedback, "操作结果应为独立区域");
  const text = (node) => node == null || typeof node === "boolean" ? "" : typeof node === "string" || typeof node === "number" ? String(node) : [node.props?.children].flat().map(text).join("");
  const html = text(feedback);
  assert.match(html, /删除结果/);
  assert.match(html, /重试剩余/);
  assert.doesNotMatch(html, /闲置天数|预览闲置归档/);
});
