// 响应处理核心模块，供脚本入口与其他运行时复用。
// Response processing core module reused by script entry files and other runtimes.
// 导入依赖项
// Import dependencies
import gRPC from "@nsnanocat/grpc"; // 仅在处理 gRPC 时需要导入 / Only needed when handling gRPC
import { URL } from "@nsnanocat/url"; // 仅在 JavaScriptCore 环境中使用 URL 时需要导入，WebView 环境不需要 / Only needed when using URL in JavaScriptCore; not needed in WebView
import { $app, $argument, Console, done, fetch, Lodash as _, notification, Storage, time, wait } from "@nsnanocat/util";
// 加密库（按需启用）
// Crypto library (enable as needed)
// 使用场景 / Use cases:
// - 数据解密（AES, DES, TripleDES 等）/ Data decryption (AES, DES, TripleDES, etc.)
// - 哈希验证（MD5, SHA1, SHA256, SHA512 等）/ Hash verification (MD5, SHA1, SHA256, SHA512, etc.)
// - HMAC 签名验证 / HMAC signature verification
// - Base64 解码 / Base64 decoding
// - 响应体解密或验签 / Response body decryption or signature verification
import CryptoJS from "crypto-js"; // 默认导入，按需启用 / Default import, enable as needed

// 响应脚本模板
// Response Script Template
// 此脚本在收到响应后执行
// This script is executed after receiving a response
// 您可以修改响应、解析数据、处理错误等
// You can modify the response, parse data, handle errors, etc.

/**
 * 处理响应数据并返回修改后的响应。
 * Process the response payload and return the modified response.
 * @param {Object} $request - 原始请求对象 / Original request object.
 * @param {Object} $response - 原始响应对象 / Original response object.
 * @returns {Promise<Object>} 修改后的响应对象 / Modified response object.
 */
export async function Response($request, $response) {
	// ============================================
	// 格式检测和初始化
	// Format Detection and Initialization
	// ============================================
	// 检测当前应用环境
	// Detect current app environment
	Console.debug(`Current App: ${$app}`);

	Console.log(`\n🚀 ========== Response Start ==========`);
	Console.debug(`$response.statusCode: ${$response.statusCode}`);
	Console.debug(`$response.headers: ${JSON.stringify($response.headers)}`);

	// ============================================
	// 基于格式的响应处理
	// Format-based Response Processing
	// ============================================
	// 从 Content-Type 中提取 FORMAT（主 MIME 类型）
	// Extract FORMAT (main MIME type) from Content-Type
	const FORMAT = ($response.headers?.["Content-Type"] ?? $response.headers?.["content-type"])?.split(";")?.[0];

	Console.debug(`Detected FORMAT: ${FORMAT}`);
	Console.debug(`$response.body: ${JSON.stringify($response.body)}`);

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
			//body = M3U8.parse($response.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$response.body = M3U8.stringify(body);
			break;

		case "text/xml":
		case "text/html":
		case "text/plist":
		case "application/xml":
		case "application/plist":
		case "application/x-plist":
			Console.log(`📦 Processing XML/HTML/Plist format`);
			//body = XML.parse($response.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//externalSubtitle = XML.parse(externalSubtitle);
			//Console.debug(`externalSubtitle: ${JSON.stringify(externalSubtitle)}`);
			//body = Composite(body, externalSubtitle, FORMAT, URL.query?.kind, Settings.Offset, Settings.Tolerance, Settings.Position);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$response.body = XML.stringify(body);
			break;

		case "text/vtt":
		case "application/vtt":
			Console.log(`📦 Processing VTT format`);
			//body = VTT.parse($response.body);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//externalSubtitle = VTT.parse(externalSubtitle);
			//Console.debug(`externalSubtitle: ${JSON.stringify(externalSubtitle)}`);
			//body = Composite(body, externalSubtitle, FORMAT, URL.query?.kind, Settings.Offset, Settings.Tolerance, Settings.Position);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			//$response.body = VTT.stringify(body);
			break;

		case "text/json":
		case "application/json":
			Console.log(`📦 Processing JSON format`);
			//body = JSON.parse($response.body ?? "{}");
			//Console.debug(`body: ${JSON.stringify(body)}`);

			// 示例：使用 CryptoJS 解密 AES 加密的响应体
			// Example: Decrypt AES-encrypted response body using CryptoJS
			// 场景：某些 API 返回加密的 JSON 数据，需要先解密再解析
			// Scenario: Some APIs return encrypted JSON data that needs to be decrypted before parsing

			// 方法 1: AES-CBC 模式解密（带 IV）
			// Method 1: AES-CBC mode decryption (with IV)
			// 密钥（用户需要提供）
			// Secret key (user needs to provide)
			//const secretKey = "your-secret-key";
			// 初始化向量（用户需要提供）
			// Initialization vector (user needs to provide)
			//const iv = "your-iv-string";
			//body = JSON.parse(CryptoJS.AES.decrypt($response.body, CryptoJS.enc.Utf8.parse(secretKey), {
			//  iv: CryptoJS.enc.Utf8.parse(iv),
			//  // 加密模式（可选：CBC, ECB, CFB, OFB, CTR，推荐使用 CBC）
			//  // Encryption mode (options: CBC, ECB, CFB, OFB, CTR, CBC recommended)
			//  mode: CryptoJS.mode.CBC,
			//  // 填充方式（可选：Pkcs7, Iso9797_1, AnsiX923, Iso10126, ZeroPadding, NoPadding）
			//  // Padding method (options: Pkcs7, Iso9797_1, AnsiX923, Iso10126, ZeroPadding, NoPadding)
			//  padding: CryptoJS.pad.Pkcs7
			//}).toString(CryptoJS.enc.Utf8));
			//Console.debug(`Decrypted body: ${JSON.stringify(body)}`);

			// 方法 2: AES-ECB 模式解密（无 IV，不推荐用于生产环境）
			// Method 2: AES-ECB mode decryption (without IV, NOT recommended for production)
			// 警告：ECB 模式不安全，相同明文产生相同密文，容易被模式分析攻击
			// Warning: ECB mode is insecure, identical plaintext produces identical ciphertext, vulnerable to pattern analysis
			// 仅在必须兼容旧系统时使用，优先使用 CBC/GCM 模式
			// Only use when must maintain compatibility with legacy systems, prefer CBC/GCM modes
			// 密钥（用户需要提供）
			// Secret key (user needs to provide)
			//const secretKey = "your-secret-key";
			//body = JSON.parse(CryptoJS.AES.decrypt($response.body, CryptoJS.enc.Utf8.parse(secretKey), {
			//  // 加密模式（可选：CBC, ECB, CFB, OFB, CTR，推荐使用 CBC）
			//  // Encryption mode (options: CBC, ECB, CFB, OFB, CTR, CBC recommended)
			//  mode: CryptoJS.mode.ECB,
			//  // 填充方式（可选：Pkcs7, Iso9797_1, AnsiX923, Iso10126, ZeroPadding, NoPadding）
			//  // Padding method (options: Pkcs7, Iso9797_1, AnsiX923, Iso10126, ZeroPadding, NoPadding)
			//  padding: CryptoJS.pad.Pkcs7
			//}).toString(CryptoJS.enc.Utf8));
			//Console.debug(`Decrypted body: ${JSON.stringify(body)}`);

			// 处理解密后的 JSON 数据
			// Process decrypted JSON data
			//body.customField = "customValue";
			//Console.debug(`Modified body: ${JSON.stringify(body)}`);

			// 如果需要加密回去（可选）
			// If need to encrypt back (optional)
			// 密钥（用户需要提供）
			// Secret key (user needs to provide)
			//const secretKey = "your-secret-key";
			// 初始化向量（用户需要提供）
			// Initialization vector (user needs to provide)
			//const iv = "your-iv-string";
			//$response.body = CryptoJS.AES.encrypt(JSON.stringify(body), CryptoJS.enc.Utf8.parse(secretKey), {
			//  iv: CryptoJS.enc.Utf8.parse(iv),
			//  // 加密模式（可选：CBC, ECB, CFB, OFB, CTR，推荐使用 CBC）
			//  // Encryption mode (options: CBC, ECB, CFB, OFB, CTR, CBC recommended)
			//  mode: CryptoJS.mode.CBC,
			//  // 填充方式（可选：Pkcs7, Iso9797_1, AnsiX923, Iso10126, ZeroPadding, NoPadding）
			//  // Padding method (options: Pkcs7, Iso9797_1, AnsiX923, Iso10126, ZeroPadding, NoPadding)
			//  padding: CryptoJS.pad.Pkcs7
			//}).toString();

			// 或者直接返回解密后的 JSON（更常见）
			// Or directly return decrypted JSON (more common)
			//$response.body = JSON.stringify(body);
			break;

		case "application/protobuf":
		case "application/x-protobuf":
		case "application/vnd.google.protobuf": {
			Console.log(`📦 Processing Protobuf format`);
			//Console.debug(`$response.body: ${JSON.stringify($response.body)}`);
			// 读取二进制数据
			// Read binary data
			let rawBody = $app === "Quantumult X" ? new Uint8Array($response.bodyBytes ?? []) : ($response.body ?? new Uint8Array());
			//Console.debug(`isBuffer? ${ArrayBuffer.isView(rawBody)}: ${JSON.stringify(rawBody)}`);
			// 处理 protobuf 消息
			// Process protobuf message
			//body = ProtoMessage.fromBinary(rawBody);
			//Console.debug(`body: ${JSON.stringify(body)}`);
			// 修改消息内容
			// Modify message content
			//body.field = value;
			//rawBody = ProtoMessage.toBinary(body);
			// 写入二进制数据
			// Write binary data
			//Console.debug(`rawBody: ${JSON.stringify(rawBody)}`);
			$response.body = rawBody;
			break;
		}

		case "application/grpc":
		case "application/grpc-web":
		case "application/grpc+proto": {
			Console.log(`📦 Processing gRPC format`);
			//Console.debug(`$response.body: ${JSON.stringify($response.body)}`);
			// 读取二进制数据
			// Read binary data
			let rawBody = $app === "Quantumult X" ? new Uint8Array($response.bodyBytes ?? []) : ($response.body ?? new Uint8Array());
			//Console.debug(`isBuffer? ${ArrayBuffer.isView(rawBody)}: ${JSON.stringify(rawBody)}`);
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
					Object.assign(($response.headers ??= {}), header ?? {});
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
			$response.body = gRPC.encode(rawBody);
			switch (FORMAT) {
				case "application/grpc-web":
					if ($response.headers?.["Content-Type"]) $response.headers["Content-Type"] = "application/grpc";
					if ($response.headers?.["content-type"]) $response.headers["content-type"] = "application/grpc";
					break;
			}
			// 写入二进制数据
			// Write binary data
			//Console.debug(`rawBody: ${JSON.stringify(rawBody)}`);
			$response.body = rawBody;
			break;
		}

		case "application/octet-stream": {
			Console.log(`📦 Processing octet-stream format`);
			//Console.debug(`$response.body: ${JSON.stringify($response.body)}`);
			// 读取二进制数据
			// Read binary data
			let rawBody = $app === "Quantumult X" ? new Uint8Array($response.bodyBytes ?? []) : ($response.body ?? new Uint8Array());
			//Console.debug(`isBuffer? ${ArrayBuffer.isView(rawBody)}: ${JSON.stringify(rawBody)}`);
			// 写入二进制数据
			// Write binary data
			//Console.debug(`rawBody: ${JSON.stringify(rawBody)}`);
			$response.body = rawBody;
			break;
		}
	}

	// ============================================
	// 通用响应修改
	// Common Response Modifications
	// ============================================
	// 示例：添加自定义响应头
	// Example: Add custom response headers
	// $response.headers['X-Custom-Response'] = 'Modified';

	// 示例：处理特定的状态码
	// Example: Handle specific status codes
	// if ($response.statusCode >= 400) {
	//   Console.error(`Request failed with status: ${$response.statusCode}`);
	//   // 处理错误响应
	//   // Handle error response
	// }

	Console.log(`🏁 ========== Response End ==========\n`);
	Console.debug(`Modified $response.statusCode: ${$response.statusCode}`);

	// 返回修改后的响应
	// Return the modified response
	return $response;
}
