// 请求处理核心模块，供脚本入口与其他运行时复用。
// Request processing core module reused by script entry files and other runtimes.
// 导入依赖项
// Import dependencies
import gRPC from "@nsnanocat/grpc"; // 仅在处理 gRPC 时需要导入 / Only needed when handling gRPC
import { URL } from "@nsnanocat/url"; // 仅在 JavaScriptCore 环境中使用 URL 时需要导入，WebView 环境不需要 / Only needed when using URL in JavaScriptCore; not needed in WebView
import { $app, $argument, Console, done, fetch, Lodash as _, notification, Storage, time, wait } from "@nsnanocat/util";
// 加密库（按需启用）
// Crypto library (enable as needed)
// 使用场景 / Use cases:
// - 数据加密解密（AES, DES, TripleDES 等）/ Data encryption/decryption (AES, DES, TripleDES, etc.)
// - 哈希计算（MD5, SHA1, SHA256, SHA512 等）/ Hash calculation (MD5, SHA1, SHA256, SHA512, etc.)
// - HMAC 签名生成和验证 / HMAC signature generation and verification
// - Base64 编码解码 / Base64 encoding/decoding
// - 请求体加密或签名 / Request body encryption or signing
import CryptoJS from "crypto-js"; // 默认导入，按需启用 / Default import, enable as needed

// 请求脚本模板
// Request Script Template
// 此脚本在发送请求之前执行
// This script is executed before sending a request
// 您可以修改请求、添加请求头、参数等
// You can modify the request, add headers, parameters, etc.

/**
 * 请求处理结果。
 * Request processing result.
 * @typedef {Object} RequestProcessResult
 * @property {Object} $request - 处理后的请求对象 / Processed request object.
 * @property {Object|undefined} $response - 可选的构造响应对象 / Optional constructed response object.
 */

/**
 * 处理请求数据并返回请求或可选响应。
 * Process the incoming request and return the request plus an optional response.
 * @param {Object} $request - 原始请求对象 / Original request object.
 * @returns {Promise<RequestProcessResult>} 处理结果，包含请求和可选响应 / Processing result containing the request and an optional response.
 */
export async function Request($request) {
	// 构造回复数据
	let $response = undefined;
	// ============================================
	// 格式检测和初始化
	// Format Detection and Initialization
	// ============================================
	// 检测当前应用环境
	// Detect current app environment
	Console.debug(`Current App: ${$app}`);

	Console.log(`\n🚀 ========== Request Start ==========`);
	Console.debug(`$request: ${JSON.stringify($request)}`);

	// 解析 URL 以便处理
	// Parse URL for processing
	const url = new URL($request.url);
	Console.debug(`Request URL: ${url.toString()}`);
	Console.debug(`URL Params: ${JSON.stringify(Object.fromEntries(url.searchParams))}`);

	// ============================================
	// 基于格式的请求处理
	// Format-based Request Processing
	// ============================================
	// 从 Content-Type 中提取 FORMAT（主 MIME 类型）
	// Extract FORMAT (main MIME type) from Content-Type
	const FORMAT = ($request.headers?.["Content-Type"] ?? $request.headers?.["content-type"])?.split(";")?.[0];

	Console.debug(`Detected FORMAT: ${FORMAT}`);

	// 格式判断
	// Format detection
	switch (FORMAT) {
		case undefined: // 视为无body / Treated as no body
			Console.log(`📦 No body (undefined)`);
			break;

		// 这些情况有意直通到 default（相同处理）
		// These cases intentionally fall through to default (same handling)
		case "application/x-www-form-urlencoded":
		case "text/plain":
		default:
			Console.log(`📦 Processing plain text or default format`);
			break;

		case "application/x-mpegURL":
		case "application/x-mpegurl":
		case "application/vnd.apple.mpegurl":
		case "audio/mpegurl":
			Console.log(`📦 Processing M3U8 format`);
			//body = M3U8.parse($request.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$request.body = M3U8.stringify(body);
			break;

		case "text/xml":
		case "text/html":
		case "text/plist":
		case "application/xml":
		case "application/plist":
		case "application/x-plist":
			Console.log(`📦 Processing XML/HTML/Plist format`);
			//body = XML.parse($request.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$request.body = XML.stringify(body);
			break;

		case "text/vtt":
		case "application/vtt":
			Console.log(`📦 Processing VTT format`);
			//body = VTT.parse($request.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$request.body = VTT.stringify(body);
			break;

		case "text/json":
		case "application/json":
			Console.log(`📦 Processing JSON format`);
			//body = JSON.parse($request.body ?? "{}");
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$request.body = JSON.stringify(body);
			break;

		case "application/protobuf":
		case "application/x-protobuf":
		case "application/vnd.google.protobuf":
		case "application/grpc":
		case "application/grpc-web":
		case "application/grpc+proto":
		case "application/octet-stream": {
			Console.log(`📦 Processing Protobuf/gRPC format`);
			//Console.debug(`$request.body: ${JSON.stringify($request.body)}`);
			// 读取二进制数据
			// Read binary data
			let rawBody = $app === "Quantumult X" ? new Uint8Array($request.bodyBytes ?? []) : ($request.body ?? new Uint8Array());
			//Console.debug(`isBuffer? ${ArrayBuffer.isView(rawBody)}: ${JSON.stringify(rawBody)}`);
			// 格式判断
			// Format detection
			switch (FORMAT) {
				case "application/protobuf":
				case "application/x-protobuf":
				case "application/vnd.google.protobuf":
					break;
				case "application/grpc":
				case "application/grpc-web":
				case "application/grpc+proto":
					// 解码 gRPC 数据
					// Decode gRPC data
					switch (FORMAT) {
						case "application/grpc":
						case "application/grpc+proto":
							rawBody = gRPC.decode(rawBody);
							break;
						case "application/grpc-web": {
							const { bodyBytes, header } = gRPC.decodeWeb(rawBody);
							rawBody = bodyBytes;
							Object.assign(($request.headers ??= {}), header ?? {});
							break;
						}
					}
					// 解析链接并处理 protobuf 数据
					// Parse link and process protobuf data
					// 示例：解析路径（需要先定义）
					// Example: Parse paths (need to be defined first)
					// const PATHs = url.pathname.split("/").filter(Boolean);
					// 主机判断
					// Host detection
					//switch (url.hostname) {
					//  case "example.com":
					//    // 路径判断
					//    // Path detection
					//    switch (PATHs?.[0]) {
					//      case "service.path":
					//        // 处理 protobuf 消息
					//        // Process protobuf message
					//        //body = ProtoMessage.fromBinary(rawBody);
					//        //Console.debug(`body: ${JSON.stringify(body)}`);
					//        // 修改消息内容
					//        // Modify message content
					//        //body.field = value;
					//        //rawBody = ProtoMessage.toBinary(body);
					//        break;
					//    }
					//    break;
					//}
					// 编码 gRPC 数据
					// Encode gRPC data
					rawBody = gRPC.encode(rawBody);
					switch (FORMAT) {
						case "application/grpc-web":
							if ($request.headers?.["Content-Type"]) $request.headers["Content-Type"] = "application/grpc";
							if ($request.headers?.["content-type"]) $request.headers["content-type"] = "application/grpc";
							break;
					}
					break;
			}
			// 写入二进制数据
			// Write binary data
			//Console.debug(`rawBody: ${JSON.stringify(rawBody)}`);
			$request.body = rawBody;
			break;
		}
	}

	// ============================================
	// 通用请求修改
	// Common Request Modifications
	// ============================================
	// 示例：添加自定义请求头
	// Example: Add custom headers
	// $request.headers['X-Custom-Header'] = 'CustomValue';
	// $request.headers['User-Agent'] = 'Custom User Agent';

	// 示例：修改 URL 参数
	// Example: Modify URL parameters
	// url.searchParams.set('key', 'value');
	$request.url = url.toString();
	Console.debug(`$request.url: ${$request.url}`);

	Console.log(`🏁 ========== Request End ==========\n`);
	Console.debug(`Modified $request: ${JSON.stringify($request)}`);
	Console.debug(`Modified $response: ${JSON.stringify($response)}`);

	// 返回修改后的响应数据（如果有）或由 finally 块处理
	// Return the modified response data (if any) or let the finally block handle it
	return { $request, $response };
}
