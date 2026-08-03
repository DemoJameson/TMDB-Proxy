const DOUBAN_API_BASE_URL = "https://frodo.douban.com/api/v2";
const DOUBAN_API_KEY = "0ac44ae016490db2204ce0a042db2916";
const DOUBAN_HEADERS = {
	"User-Agent": "MicroMessenger/8.0.75(0x18004b52)",
	Referer: "https://servicewechat.com/wx2f9b06c1de1ccfca",
};

const INVALID_DOUBAN_CHARACTER_VALUES = new Set([
	"导演",
	"演员",
	"配音",
	"配音导演",
	"制片人",
	"制片",
	"监制",
	"编剧",
	"原著作者",
	"摄影",
	"摄影指导",
	"美术",
	"艺术指导",
	"布景师",
	"剪辑",
	"音乐",
	"化妆",
	"服装设计",
	"选角",
	"副导演",
	"第3副导演",
	"动作指导",
	"武师",
	"特技统筹",
	"视觉特效",
	"摄像机动画",
]);

// 网络错误：fetcher 抛出异常、无响应、或 5xx 服务器错误。4xx 视为"确实无结果"。
// Network error: fetcher throws, no response, or 5xx server error. 4xx is treated as "no result".
class NetworkError extends Error {
	constructor(message) {
		super(message);
		this.name = "NetworkError";
	}
}

function createDoubanRequest(url) {
	return { method: "GET", url, headers: { ...DOUBAN_HEADERS } };
}

async function fetchDoubanJson(url, fetcher) {
	let response;
	try {
		response = await fetcher(createDoubanRequest(url));
	} catch {
		throw new NetworkError(`Douban request failed: ${url}`);
	}
	if (!response) throw new NetworkError(`Douban request returned no response: ${url}`);
	if (response.status >= 500) throw new NetworkError(`Douban server error ${response.status}: ${url}`);
	if (!response.ok && !(response.status >= 200 && response.status < 300)) return null;
	try {
		return JSON.parse(response.body ?? "{}");
	} catch {
		return null;
	}
}

async function searchDoubanSubject(query, targetType, fetcher, year, matchTitle = true) {
	const normalizedQuery = String(query ?? "").trim();
	const normalizedTargetType = String(targetType ?? "")
		.trim()
		.toLowerCase();
	if (!normalizedQuery || !normalizedTargetType) return null;
	const url = `${DOUBAN_API_BASE_URL}/search/suggestion?q=${encodeURIComponent(normalizedQuery)}&apikey=${DOUBAN_API_KEY}`;
	const payload = await fetchDoubanJson(url, fetcher);
	if (!payload) return null;
	const matches = (payload?.cards ?? [])
		.map(card => ({
			id: String(card?.target_id ?? "").trim(),
			targetType: String(card?.target_type ?? "")
				.trim()
				.toLowerCase(),
			title: String(card?.target?.title ?? "").trim(),
			year: String(card?.target?.year ?? "").trim(),
		}))
		.filter(item => item.id && item.targetType === normalizedTargetType && (!matchTitle || item.title === normalizedQuery));
	if (matches.length === 0) return null;
	if (year) {
		const normalizedYear = String(year).trim();
		const yearMatch = matches.find(item => item.year === normalizedYear);
		if (yearMatch) return yearMatch;
	}
	return matches[0];
}

async function fetchDoubanCreditsStats(doubanId, fetcher) {
	const normalizedId = String(doubanId ?? "").trim();
	if (!normalizedId) return null;
	const url = `${DOUBAN_API_BASE_URL}/movie/${encodeURIComponent(normalizedId)}/credits_stats?start=0&count=1000&apikey=${DOUBAN_API_KEY}`;
	return fetchDoubanJson(url, fetcher);
}

async function fetchDoubanSeasons(doubanId, fetcher) {
	const normalizedId = String(doubanId ?? "").trim();
	if (!normalizedId) return null;
	const url = `${DOUBAN_API_BASE_URL}/tv/${encodeURIComponent(normalizedId)}/seasons?apikey=${DOUBAN_API_KEY}`;
	return fetchDoubanJson(url, fetcher);
}

function splitDoubanCharacters(value) {
	const raw = String(value ?? "").trim();
	if (!raw || INVALID_DOUBAN_CHARACTER_VALUES.has(raw)) return [];
	// 要求 "饰 " 或 "配 " 前缀（前缀后至少一个空白字符），避免 "配音"、"配音导演" 等职位被误匹配
	// Require "饰 " or "配 " prefix (at least one whitespace after prefix) to avoid matching "配音", "配音导演" etc.
	const prefixMatch = raw.match(/^([饰配])\s+(.+)$/);
	if (!prefixMatch) return [];
	const prefix = prefixMatch[1];
	const characterText = prefixMatch[2].trim();
	if (!characterText || INVALID_DOUBAN_CHARACTER_VALUES.has(characterText)) return [];
	return characterText
		.split(/\s*(?:\/|／|、|,|，)\s*/g)
		.map(item => item.trim())
		.filter(item => item && !INVALID_DOUBAN_CHARACTER_VALUES.has(item))
		.map(item => (prefix === "配" ? `${item}（配音）` : item))
		.filter((item, index, array) => array.indexOf(item) === index);
}

function isDoubanVoiceActorItem(item) {
	const simpleCharacter = String(item?.simple_character ?? "").trim();
	// "配 角色名" 格式才是配音角色，"配音" 或 "配音导演"（职位）不算
	// Only "配 character" format counts as voice actor, not "配音" or "配音导演" (job titles)
	if (/^配\s+\S+/.test(simpleCharacter)) return true;
	if (String(item?.category ?? "").trim() === "配音") return true;
	if (Array.isArray(item?.roles) && item.roles.some(role => String(role ?? "").trim() === "配音")) return true;
	return false;
}

function isDoubanActorItem(item) {
	if (String(item?.category ?? "").trim() === "演员") return true;
	if (Array.isArray(item?.roles) && item.roles.some(role => String(role ?? "").trim() === "演员")) return true;
	return isDoubanVoiceActorItem(item);
}

function normalizeDoubanCreditsPayload(payload) {
	const credits = {};
	(payload?.items ?? []).forEach(item => {
		if (!isDoubanActorItem(item)) return;
		const name = String(item?.name ?? "").trim();
		if (!name) return;
		const characters = splitDoubanCharacters(item?.simple_character);
		if (characters.length > 0) {
			const current = credits[name] ?? [];
			credits[name] = current.concat(characters).filter((character, index, array) => array.indexOf(character) === index);
		} else if (!credits[name]) {
			// 无角色名，用占位符代替（配音演员用"配音"，普通演员用"演员"）
			// No character name, use placeholder (voice actors use "配音", regular actors use "演员")
			credits[name] = [isDoubanVoiceActorItem(item) ? "配音" : "演员"];
		}
	});
	return credits;
}

function mergeDoubanCredits(base, additions) {
	const result = { ...base };
	for (const [name, characters] of Object.entries(additions ?? {})) {
		const current = result[name] ?? [];
		result[name] = current.concat(characters).filter((character, index, array) => array.indexOf(character) === index);
	}
	return result;
}

export { fetchDoubanCreditsStats, fetchDoubanSeasons, mergeDoubanCredits, NetworkError, normalizeDoubanCreditsPayload, searchDoubanSubject, splitDoubanCharacters };
