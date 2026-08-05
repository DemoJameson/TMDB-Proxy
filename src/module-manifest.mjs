const REPOSITORY_URL = "https://github.com/DemoJameson/TMDB-Proxy";
const RAW_BASE_URL = "https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main";
const MODULE_PATH = "dist";
const REQUEST_SCRIPT_FILE = "tmdb_proxy_request.js";
const RESPONSE_SCRIPT_FILE = "tmdb_proxy_response.js";

const metadata = {
	name: "TMDB 增强",
	description: "TMDB API 尽量补全中文标题、TV 演职员接口与角色名汉化，支持本地代理工具脚本和 Vercel/Workers 反向代理。",
	icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/tmdb.png",
	homepage: REPOSITORY_URL,
	author: "DemoJameson",
	repositoryUrl: REPOSITORY_URL,
	rawBaseUrl: RAW_BASE_URL,
	modulePath: MODULE_PATH,
};

const BOXJS_CONFIG_KEY = "dj_tmdb_proxy_boxjs_configs";

const argumentFields = [
	{
		key: "aliasFallback",
		defaultValue: true,
		type: "boolean",
		tag: "中文标题",
		desc: "缺少中文标题时，使用别名补全",
	},
	{
		key: "characterTranslation",
		defaultValue: true,
		type: "boolean",
		tag: "中文角色名",
		desc: "使用豆瓣数据将演职员中的中文角色名",
	},
	{
		key: "aggregateCredits",
		defaultValue: true,
		type: "boolean",
		tag: "聚合演职人员",
		desc: "演职人员数据从主演改为整剧/整季演员",
	},
	{
		key: "imageWebp",
		defaultValue: true,
		type: "boolean",
		tag: "WebP 图片",
		desc: "请求 TMDB 图片时优先获取 WebP 格式，更省流量",
	},
	{
		key: "cacheBackend",
		defaultValue: "https://tmdb-proxy.demojameson.de5.net",
		type: "text",
		tag: "缓存后端",
		desc: "远端缓存地址，留空使用默认地址",
	},
];

const ALL_ARGUMENT_KEYS = argumentFields.map(field => field.key);

const scriptRules = [
	{
		title: "TMDB Request",
		comment: "追加 alternative_titles，并改写 TV credits 请求",
		phase: "http-request",
		pattern: String.raw`^https:\/\/(?:api\.(?:themoviedb|tmdb)\.org|vidora-tmdb\.wwmm\.date)\/3\/(?:movie|tv|collection)\/\d+(?:(?:\/season\/\d+)?\/credits|\/alternative_titles)?(?:\?.*)?$`,
		scriptFile: REQUEST_SCRIPT_FILE,
		timeout: 10,
		argumentKeys: ALL_ARGUMENT_KEYS,
	},
	{
		title: "TMDB Image Request",
		comment: "请求图片时优先 WebP 格式",
		phase: "http-request",
		pattern: String.raw`^https:\/\/image\.tmdb\.org\/.*$`,
		scriptFile: REQUEST_SCRIPT_FILE,
		timeout: 10,
		argumentKeys: ALL_ARGUMENT_KEYS,
	},
	{
		title: "Forward 播放器反代重定向",
		comment: "需要修改的 forwardinfo.vvebo.vip 反代请求重定向到 TMDB",
		phase: "http-request",
		pattern: String.raw`^https:\/\/forwardinfo\.vvebo\.vip\/(?:movie|tv|collection)\/\d+(?:(?:\/season\/\d+)?\/credits|\/alternative_titles)?(?:\?.*)?$`,
		scriptFile: REQUEST_SCRIPT_FILE,
		timeout: 10,
		argumentKeys: ALL_ARGUMENT_KEYS,
	},
	{
		title: "TMDB Response",
		comment: "中文详情或列表缺标题时从 alternative_titles 回填中文别名，演职员角色名使用豆瓣数据汉化",
		phase: "http-response",
		pattern: String.raw`^https:\/\/(?:api\.(?:themoviedb|tmdb)\.org|vidora-tmdb\.wwmm\.date)\/3\/.*(?:\?.*)?$`,
		scriptFile: RESPONSE_SCRIPT_FILE,
		timeout: 60,
		requiresBody: true,
		maxSize: 0,
		argumentKeys: ALL_ARGUMENT_KEYS,
	},
	{
		title: "Forward 播放器反代响应",
		comment: "中文列表缺标题时从 alternative_titles 回填中文别名，演职员角色名使用豆瓣数据汉化",
		phase: "http-response",
		pattern: String.raw`^https:\/\/forwardinfo\.vvebo\.vip\/.*$`,
		scriptFile: RESPONSE_SCRIPT_FILE,
		timeout: 60,
		requiresBody: true,
		maxSize: 0,
		argumentKeys: ALL_ARGUMENT_KEYS,
	},
];

const mitmHosts = ["api.themoviedb.org", "api.tmdb.org", "vidora-tmdb.wwmm.date", "image.tmdb.org", "forwardinfo.vvebo.vip"];

const boxjs = {
	id: "demojameson.app.sub",
	name: "DemoJameson 应用订阅",
	description: "DemoJameson 的 BoxJs 订阅",
	author: "@DemoJameson",
	repo: REPOSITORY_URL,
	icon: "https://avatars.githubusercontent.com/u/181192?v=4",
	app: {
		id: "demojameson_tmdb_proxy",
		author: "@DemoJameson",
		repo: `${REPOSITORY_URL}/tree/main/${MODULE_PATH}`,
		icons: [metadata.icon, metadata.icon],
		descsHtml: [
			metadata.description,
			`点此直达 <a href="${REPOSITORY_URL}/tree/main/${MODULE_PATH}">项目目录</a>`,
			`Egern 安装：<a href="egern:/modules/new?name=TMDB%20Proxy&amp;url=${encodeURIComponent(`${RAW_BASE_URL}/${MODULE_PATH}/tmdb_proxy.plugin`)}">安装模块</a>`,
			`Loon 安装：<a href="https://www.nsloon.com/openloon/import?plugin=${encodeURIComponent(`${RAW_BASE_URL}/${MODULE_PATH}/tmdb_proxy.plugin`)}">安装插件</a>`,
			`Surge 安装：<a href="surge:///install-module?url=${encodeURIComponent(`${RAW_BASE_URL}/${MODULE_PATH}/tmdb_proxy.sgmodule`)}">安装模块</a>`,
			`QX 安装：<a href="https://quantumult.app/x/open-app/add-resource?remote-resource=${encodeURIComponent(JSON.stringify({ rewrite_remote: [`${RAW_BASE_URL}/${MODULE_PATH}/tmdb_proxy.snippet, tag=TMDB Proxy, enabled=true`] }))}">安装片段</a>`,
			"脚本读取优先级：默认值 < BoxJs < 插件参数。已经在插件参数里填写的值会覆盖 BoxJs。",
		],
	},
};

export { argumentFields, BOXJS_CONFIG_KEY, boxjs, metadata, mitmHosts, REQUEST_SCRIPT_FILE, RESPONSE_SCRIPT_FILE, scriptRules };
