// 响应脚本入口，负责调用共享响应处理器并回传处理结果。
import { Response } from "./process/Response.mjs";
import { Console, done } from "./runtime/script.mjs";

!(async () => {
	// 复用共享响应处理逻辑，避免生产版与开发版入口复制实现。
	$response = await Response($request, $response);
})()
	.catch(e => Console.error(e))
	.finally(() => {
		// 将处理后的响应交回宿主环境。
		done($response);
	});
