const $app = (() => {
	const has = key => key in globalThis;
	if (has("$task")) return "Quantumult X";
	if (has("$loon")) return "Loon";
	if (has("$rocket")) return "Shadowrocket";
	if (has("Egern")) return "Egern";
	if (globalThis.$environment?.["surge-version"]) return "Surge";
	if (globalThis.$environment?.["stash-version"]) return "Stash";
	if (has("Cloudflare")) return "Worker";
	if (globalThis.process?.versions?.node) return "Node.js";
	return undefined;
})();

const STATUS_TEXTS = {
	200: "OK",
	201: "Created",
	202: "Accepted",
	204: "No Content",
	301: "Moved Permanently",
	302: "Found",
	304: "Not Modified",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	500: "Internal Server Error",
};

const Console = {
	error: (...messages) => console.log(messages.map(message => `ERROR: ${message?.stack ?? message}`).join("\n")),
};

function setPath(object, path, value) {
	const parts = String(path).split(".").filter(Boolean);
	let current = object;
	for (const part of parts.slice(0, -1)) current = current[part] ??= {};
	if (parts.length) current[parts.at(-1)] = value;
}

function getPath(object, path) {
	return String(path)
		.split(".")
		.filter(Boolean)
		.reduce((current, part) => current?.[part], object);
}

function done(payload = {}) {
	if ($app === "Quantumult X") {
		const object = { ...payload };
		if (typeof object.status === "number") object.status = `HTTP/1.1 ${object.status} ${STATUS_TEXTS[object.status] ?? ""}`.trim();
		if (object.body instanceof ArrayBuffer) {
			object.bodyBytes = object.body;
			object.body = undefined;
		}
		globalThis.$done?.(object);
		return;
	}
	if ($app !== "Worker" && $app !== "Node.js") globalThis.$done?.(payload);
}

const Storage = {
	getItem(keyName, defaultValue = null) {
		let value;
		if (keyName.startsWith("@")) {
			const [, key, path] = keyName.match(/^@([^.]+)(?:\.(.*))?$/) ?? [];
			value = getPath(Storage.getItem(key, {}), path);
		} else if ($app === "Quantumult X") {
			value = globalThis.$prefs?.valueForKey(keyName);
		} else if (["Surge", "Loon", "Stash", "Egern", "Shadowrocket"].includes($app)) {
			value = globalThis.$persistentStore?.read(keyName);
		}
		try {
			value = JSON.parse(value);
		} catch {}
		return value ?? defaultValue;
	},
	setItem(keyName, value) {
		const serialized = typeof value === "string" ? value : JSON.stringify(value);
		if ($app === "Quantumult X") return Boolean(globalThis.$prefs?.setValueForKey?.(serialized, keyName));
		if (["Surge", "Loon", "Stash", "Egern", "Shadowrocket"].includes($app)) return Boolean(globalThis.$persistentStore?.write?.(serialized, keyName));
		return false;
	},
};

async function fetch(resource) {
	const source = typeof resource === "string" ? { url: resource } : resource;
	const { headers: sourceHeaders, ...request } = source ?? {};
	request.headers = { ...(sourceHeaders ?? {}) };
	request.method ??= request.body || request.bodyBytes ? "POST" : "GET";
	request.headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !["content-length", "Content-Length"].includes(key)));
	if ($app === "Quantumult X") {
		const response = await globalThis.$task.fetch(request);
		return { ok: /^2\d\d$/.test(response.statusCode), status: response.statusCode, body: response.body, headers: response.headers ?? {} };
	}
	if (globalThis.$httpClient) {
		return await new Promise((resolve, reject) => {
			globalThis.$httpClient[String(request.method).toLowerCase()](request, (error, response, body) => {
				if (error) reject(error);
				else resolve({ ...response, ok: /^2\d\d$/.test(response.status), status: response.status, body });
			});
		});
	}
	const { url, bodyBytes, ...init } = request;
	if (bodyBytes !== undefined && init.body === undefined) init.body = bodyBytes;
	const response = await globalThis.fetch(url, init);
	return { ok: response.ok, status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers.entries()) };
}

export { $app, Console, done, fetch, Storage, setPath };
