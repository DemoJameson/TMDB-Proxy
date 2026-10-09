// 请求脚本入口，负责调用共享请求处理器并完成宿主环境收尾。
import { Request } from "./process/Request.mjs";
import { $app, Console, done } from "./runtime/script.mjs";

let $response;
!(async () => {
	// 将请求处理委托给共享核心模块，便于脚本入口与其他运行时复用。
	({ $request, $response } = await Request($request));
})()
	.catch(e => Console.error(e))
	.finally(() => {
		// 根据是否构造了响应对象，决定返回响应还是继续发送请求。
		switch (typeof $response) {
			// 已构造响应对象，直接返回给宿主。
			case "object":
				$response.headers = Object.fromEntries(Object.entries($response.headers ?? {}).filter(([key]) => !["content-length", "transfer-encoding"].includes(key.toLowerCase())));
				if ($response.headers["Content-Encoding"]) $response.headers["Content-Encoding"] = "identity";
				if ($response.headers["content-encoding"]) $response.headers["content-encoding"] = "identity";
				switch ($app) {
					default:
						done({ response: $response });
						break;
					case "Quantumult X":
						if (!$response.status) $response.status = 200;
						done($response);
						break;
				}
				break;
			// 未构造响应对象，继续发送修改后的请求。
			case "undefined":
				done($request);
				break;
			default:
				Console.error(`不合法的 $response 类型: ${typeof $response}`);
				break;
		}
	});
