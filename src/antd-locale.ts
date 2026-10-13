import type { Locale } from "antd/es/locale/index.js";
import enUSModule from "antd/es/locale/en_US.js";
import zhCNModule from "antd/es/locale/zh_CN.js";
import ruRUModule from "antd/es/locale/ru_RU.js";

const enUS: Locale = enUSModule.default;
const zhCN: Locale = zhCNModule.default;
const ruRU: Locale = ruRUModule.default;

export function antdLocale(active: "zh" | "en" | "ru"): Locale {
	return active === "en" ? enUS : active === "ru" ? ruRU : zhCN;
}

export function antdLocaleFromDocument(): Locale {
	if (typeof document === "undefined") return zhCN;
	const lang = document.documentElement.lang.toLowerCase();
	return antdLocale(lang.startsWith("en") ? "en" : lang.startsWith("ru") ? "ru" : "zh");
}
