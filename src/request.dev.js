// 请求脚本入口，负责调用共享请求处理器并完成宿主环境收尾。
// Request script entry that invokes the shared request processor and finalizes host output.
import { $app, Console, done, Lodash as _ } from "@nsnanocat/util";
import { Request } from "./process/Request.dev.mjs";
/***************** Processing *****************/
let $response;
!(async () => {
	// 将请求处理委托给共享核心模块，便于脚本入口与其他运行时复用。
	// Delegate request processing to the shared core module so script and server runtimes can reuse the same logic.
	({ $request, $response } = await Request($request));
})()
	.catch(e => Console.error(e))
	.finally(() => {
		// 根据是否构造了响应对象，决定返回响应还是继续发送请求。
		// Return a constructed response when present; otherwise continue with the modified request.
		switch (typeof $response) {
			// 已构造响应对象，直接返回给宿主。
			// A response object was constructed; return it to the host.
			case "object":
				//Console.debug("finally", `echo $response: ${JSON.stringify($response, null, 2)}`);
				if ($response.headers?.["Content-Encoding"]) $response.headers["Content-Encoding"] = "identity";
				if ($response.headers?.["content-encoding"]) $response.headers["content-encoding"] = "identity";
				switch ($app) {
					default:
						done({ response: $response });
						break;
					case "Quantumult X":
						if (!$response.status) $response.status = 200;
						delete $response.headers?.["Content-Length"];
						delete $response.headers?.["content-length"];
						delete $response.headers?.["Transfer-Encoding"];
						done($response);
						break;
				}
				break;
			// 未构造响应对象，继续发送修改后的请求。
			// No response object was constructed; send the modified request.
			case "undefined":
				//Console.debug("finally", `$request: ${JSON.stringify($request, null, 2)}`);
				done($request);
				break;
			default:
				Console.error(`不合法的 $response 类型: ${typeof $response}`);
				break;
		}
	});
