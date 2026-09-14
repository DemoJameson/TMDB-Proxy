import { getRequestLanguage, hasHan, isChineseLanguage } from "./routes.mjs";

// TMDB 唯一两个在中文请求下不返回译名的类型：10765 Sci-Fi & Fantasy、10768 War & Politics。
// 其余类型 TMDB 都会返回中文，交由 TMDB 自己给译名，代理不介入，避免覆盖其后续的译名调整。
// 表内按语言独立维护译名（简中/台/港），不做简繁转换；未收录的 ID 一律保留 TMDB 原值。
// The only two TMDB genres that come back untranslated for Chinese requests: 10765 Sci-Fi & Fantasy and
// 10768 War & Politics. Every other genre is localized by TMDB itself, so the proxy leaves it untouched
// rather than overriding future wording changes. Names are maintained per locale (no script conversion);
// IDs outside the table keep the original TMDB value.
const GENRE_NAMES = new Map([
	[10765, { "zh-CN": "科幻奇幻", "zh-TW": "科幻奇幻", "zh-HK": "科幻奇幻" }],
	[10768, { "zh-CN": "战争政治", "zh-TW": "戰爭政治", "zh-HK": "戰爭政治" }],
]);

const DEFAULT_LOCALE = "zh-CN";

// 请求语言 → 表内的语言键。简体/繁体各按区域归位，读不到区域时按文字系统判断。
// Request language → locale key used by the table; falls back to the script when no region is present.
const LANGUAGE_LOCALES = {
	zh: DEFAULT_LOCALE,
	"zh-cn": "zh-CN",
	"zh-sg": "zh-CN",
	"zh-hans": "zh-CN",
	"zh-hans-cn": "zh-CN",
	"zh-hans-sg": "zh-CN",
	"zh-tw": "zh-TW",
	"zh-hant": "zh-TW",
	"zh-hant-tw": "zh-TW",
	"zh-hk": "zh-HK",
	"zh-mo": "zh-HK",
	"zh-hant-hk": "zh-HK",
	"zh-hant-mo": "zh-HK",
};

// 解析类型 ID 在该语言下的本地化名称；未收录该语言或该 ID 时返回空串。
// Resolves the localized name of a genre ID for the given locale; returns "" when unavailable.
function resolveGenreName(id, locale) {
	const names = GENRE_NAMES.get(Number(id));
	if (!names) return "";
	return names[locale] ?? names[DEFAULT_LOCALE] ?? "";
}

// 把响应体中表内类型（10765/10768）的名称替换为对应语言的中文译名，仅处理 TMDB 返回非中文
//（即英文原名）的条目；TMDB 已给出中文（含 zh-TW/zh-HK 请求返回的同一串中文）时保持原值，不做简繁转换。
// 表外类型一律不动。
// Replaces the names of the table's genres (10765/10768) in the response body with the localized Chinese
// names, only for entries TMDB returned in a non-Chinese name (the English original). Entries TMDB already
// localized are kept as-is, with no simplified/traditional conversion. Genres outside the table are untouched.
function applyGenreTranslation(request, body) {
	if (!body || typeof body !== "object" || !Array.isArray(body.genres)) return body;
	const language = getRequestLanguage(new URL(request.url));
	if (!isChineseLanguage(language)) return body;
	const locale = LANGUAGE_LOCALES[String(language).toLowerCase()] ?? DEFAULT_LOCALE;
	for (const genre of body.genres) {
		if (!genre || typeof genre !== "object") continue;
		if (hasHan(genre.name)) continue;
		const name = resolveGenreName(genre.id, locale);
		if (name) genre.name = name;
	}
	return body;
}

export { applyGenreTranslation, GENRE_NAMES };
