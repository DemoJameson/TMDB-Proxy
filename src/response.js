// 响应脚本入口，负责调用共享响应处理器并回传处理结果。
// Response script entry that invokes the shared response processor and returns the processed result.
import { Console, done } from "@nsnanocat/util";
import { Response } from "./process/Response.mjs";
/***************** Processing *****************/
!(async () => {
	// 复用共享响应处理逻辑，避免生产版与开发版入口复制实现。
	// Reuse the shared response pipeline so production and development entries do not duplicate the implementation.
	$response = await Response($request, $response);
})()
	.catch(e => Console.error(e))
	.finally(() => {
		// 将处理后的响应交回宿主环境。
		// Hand the processed response back to the host runtime.
		done($response);
	});
