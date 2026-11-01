import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8000;
const tossBaseUrl = "https://openapi.tossinvest.com";
const staticAssets = new Map([
	["/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
	["/app-icon.svg", "image/svg+xml"],
	["/service-worker.js", "text/javascript; charset=utf-8"]
]);
const appHtml = path.join(root, "index.html");
const quoteCache = new Map();
const stockCatalogCache = new Map();
const stockCatalogRequests = new Map();
let tokenValue = "";
let tokenExpiresAt = 0;
let tokenRequest = null;
let exchangeCache = null;
let accountCache = null;
let accountRequest = null;
let lastStockCatalogRequestAt = 0;
let diagnosticCache = null;
let diagnosticRequest = null;

class TossApiError extends Error {
	constructor(status, code, detail) {
		super(detail || `Toss API request failed (${status}).`);
		this.status = status;
		this.code = code;
	}
}

function sendJson(response, status, value) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	response.end(JSON.stringify(value));
}

function apiConfigured() {
	return Boolean(process.env.TOSS_CLIENT_ID && process.env.TOSS_CLIENT_SECRET);
}

function getSupabasePublicConfig() {
	const url = process.env.SUPABASE_URL || "";
	const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
	const validUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url);
	return { configured: validUrl && Boolean(anonKey), url: validUrl ? url : "", anonKey: validUrl ? anonKey : "" };
}

async function getAccessToken(forceRefresh = false) {
	if (!apiConfigured()) throw new Error("Toss API credentials are not configured.");
	if (!forceRefresh && tokenValue && Date.now() < tokenExpiresAt - 60_000) return tokenValue;
	if (tokenRequest) return tokenRequest;

	tokenRequest = (async () => {
		const body = new URLSearchParams({
			grant_type: "client_credentials",
			client_id: process.env.TOSS_CLIENT_ID,
			client_secret: process.env.TOSS_CLIENT_SECRET
		});
		const response = await fetch(`${tossBaseUrl}/oauth2/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(10_000)
		});
		const result = await response.json().catch(() => null);
		if (!response.ok) throw new TossApiError(response.status, result?.error, result?.error_description);
		if (!result || typeof result !== "object") throw new Error("Toss returned an invalid token response.");
		if (!result.access_token || !Number(result.expires_in)) throw new Error("Toss returned an invalid token response.");
		tokenValue = result.access_token;
		tokenExpiresAt = Date.now() + Number(result.expires_in) * 1000;
		return tokenValue;
	})();

	try { return await tokenRequest; }
	finally { tokenRequest = null; }
}

async function tossGet(apiPath, params, canRetry = true, accountSeq = null) {
	const token = await getAccessToken();
	const query = new URLSearchParams(params);
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	if (accountSeq !== null) headers["X-Tossinvest-Account"] = String(accountSeq);
	const response = await fetch(`${tossBaseUrl}${apiPath}?${query}`, {
		headers,
		signal: AbortSignal.timeout(10_000)
	});
	if (response.status === 401 && canRetry) {
		tokenValue = "";
		tokenExpiresAt = 0;
		await getAccessToken(true);
		return tossGet(apiPath, params, false, accountSeq);
	}
	const result = await response.json().catch(() => null);
	if (!response.ok) throw new TossApiError(response.status, result?.code || result?.error, result?.message || result?.error_description);
	if (!result || typeof result !== "object") throw new Error("Toss returned an invalid response.");
	return result;
}

function tossFailure(response, operation, error) {
	const upstreamStatus = error instanceof TossApiError ? error.status : null;
	const status = upstreamStatus || 502;
	const code = error instanceof TossApiError ? error.code : "";
	let message = `${operation} 요청이 실패했습니다.`;
	if (code === "ip-not-allowed" || code === "access_denied") message = "토스증권 허용 IP에 등록되지 않은 서버 IP일 수 있습니다. Render 서버의 실제 outbound IP를 허용 목록과 대조해 주세요.";
	else if (code === "invalid_client") message = "토스증권 client ID 또는 client secret을 확인해 주세요.";
	else if (code === "token-revoked") message = "다른 프로세스에서 토큰을 새로 발급해 현재 토큰이 폐기됐습니다.";
	else if (code === "forbidden") message = "토스증권 API 사용 권한이 없습니다.";
	else if (status === 429) message = "토스증권 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
	else if (status === 502 && !(error instanceof TossApiError)) message = "토스증권 서버에 연결하지 못했습니다.";
	else if (status) message = `토스증권이 HTTP ${status} 응답을 반환했습니다.`;
	console.error(`[toss] ${operation} failed: HTTP ${status}${code ? ` (${code})` : ""}`);
	const proxyStatus = status === 401 || status === 403 ? status : 502;
	return sendJson(response, proxyStatus, {
		error: message,
		upstreamStatus,
		proxyStatus,
		...(code ? { upstreamCode: code } : {})
	});
}

async function requireTossOwner(request, response) {
	const expectedUserId = process.env.TOSS_ALLOWED_USER_ID;
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(expectedUserId || "")) {
		sendJson(response, 503, { error: "TOSS_ALLOWED_USER_ID must be configured before brokerage account access is enabled." });
		return null;
	}
	const authorization = request.headers.authorization || "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match) {
		sendJson(response, 401, { error: "Sign in to the household account before accessing brokerage data." });
		return null;
	}
	const config = getSupabasePublicConfig();
	if (!config.configured) {
		sendJson(response, 503, { error: "Supabase authentication is not configured on the server." });
		return null;
	}
	try {
		const authResponse = await fetch(`${config.url}/auth/v1/user`, {
			headers: { apikey: config.anonKey, Authorization: `Bearer ${match[1]}` },
			signal: AbortSignal.timeout(10_000)
		});
		if (!authResponse.ok) {
			sendJson(response, 401, { error: "The household sign-in session is invalid or expired." });
			return null;
		}
		const user = await authResponse.json();
		if (user.id !== expectedUserId) {
			sendJson(response, 403, { error: "This household account is not authorized to access brokerage data." });
			return null;
		}
		return user;
	} catch (error) {
		console.error("Could not validate the Supabase session for brokerage access:", error);
		sendJson(response, 502, { error: "Could not validate the household sign-in session." });
		return null;
	}
}

async function runDiagnostics() {
	if (diagnosticCache && Date.now() - diagnosticCache.at < 30_000) return diagnosticCache.value;
	if (diagnosticRequest) return diagnosticRequest;
	diagnosticRequest = (async () => {
		let oauth = { success: false };
		let quotes = [];
		let exchangeRate = { success: false };
		try {
			await getAccessToken();
			oauth = { success: true };
			const payload = await getQuotes(["005930", "AAPL"]);
			quotes = ["005930", "AAPL"].map(symbol => {
				const quote = payload.result.find(item => String(item.symbol).toUpperCase() === symbol);
				const lastPrice = Number(quote?.lastPrice);
				return {
					symbol,
					success: Number.isFinite(lastPrice) && lastPrice > 0,
					...(Number.isFinite(lastPrice) && lastPrice > 0 ? {
						lastPrice,
						currency: quote.currency || null,
						timestamp: quote.timestamp || null
					} : {})
				};
			});
			const fx = await getExchangeRate();
			exchangeRate = { success: true, rate: fx.result.rate, timestamp: fx.result.validFrom || null };
		} catch (error) {
			const upstreamStatus = error instanceof TossApiError ? error.status : null;
			const status = upstreamStatus || 502;
			const code = error instanceof TossApiError ? error.code : "";
			console.error(`[toss] diagnostics failed: HTTP ${status}${code ? ` (${code})` : ""}`);
			return {
				configured: apiConfigured(),
				oauth,
				quotes,
				exchangeRate,
				error: code === "ip-not-allowed" || code === "access_denied"
					? "토스증권 허용 IP에 등록되지 않은 서버 IP일 수 있습니다."
					: code === "invalid_client"
						? "토스증권 client ID 또는 client secret을 확인해 주세요."
						: `토스증권 요청 실패 (HTTP ${status}${code ? `, ${code}` : ""}).`,
				upstreamStatus,
				proxyStatus: 502,
				...(code ? { upstreamCode: code } : {})
			};
		}
		return { configured: apiConfigured(), oauth, quotes, exchangeRate };
	})();
	try {
		const value = await diagnosticRequest;
		diagnosticCache = { at: Date.now(), value };
		return value;
	} finally { diagnosticRequest = null; }
}

async function getQuotes(symbols) {
	const key = symbols.join(",");
	const cached = quoteCache.get(key);
	if (cached && Date.now() - cached.at < 20_000) return cached.value;
	const payload = await tossGet("/api/v1/prices", { symbols: key });
	if (!Array.isArray(payload.result)) throw new Error("Toss returned an invalid quote response.");
	const result = { result: payload.result };
	quoteCache.set(key, { at: Date.now(), value: result });
	return result;
}

async function getExchangeRate() {
	if (exchangeCache && Date.now() - exchangeCache.at < 25_000) return exchangeCache.value;
	const payload = await tossGet("/api/v1/exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" });
	if (!payload.result?.rate) throw new Error("Toss returned an invalid exchange-rate response.");
	exchangeCache = { at: Date.now(), value: { result: payload.result } };
	return exchangeCache.value;
}

async function getAccounts() {
	if (accountCache && Date.now() - accountCache.at < 60_000) return accountCache.value;
	if (accountRequest) return accountRequest;
	accountRequest = (async () => {
		const payload = await tossGet("/api/v1/accounts", {});
		if (!Array.isArray(payload.result)) throw new Error("Toss returned an invalid account response.");
		const result = payload.result.map(account => ({
			accountSeq: String(account.accountSeq),
			accountType: account.accountType,
			accountNo: String(account.accountNo || "").replace(/\d(?=\d{4})/g, "•")
		}));
		return { result };
	})();
	try {
		const value = await accountRequest;
		accountCache = { at: Date.now(), value };
		return value;
	} finally { accountRequest = null; }
}

async function getStockCatalog(market) {
	const cached = stockCatalogCache.get(market);
	if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.value;
	if (stockCatalogRequests.has(market)) return stockCatalogRequests.get(market);

	const venues = market === "KR" ? ["KOSPI", "KOSDAQ", "KR_ETC"] : ["NYSE", "NASDAQ", "AMEX", "US_ETC"];
	const request = (async () => {
		const stocks = [];
		for (const venue of venues) {
			const wait = Math.max(0, 1000 - (Date.now() - lastStockCatalogRequestAt));
			if (wait) await new Promise(resolve => setTimeout(resolve, wait));
			lastStockCatalogRequestAt = Date.now();
			const payload = await tossGet("/api/v1/stocks/all", { market: venue, status: "ACTIVE" });
			if (!Array.isArray(payload.result)) throw new Error("Toss returned an invalid stock catalog.");
			stocks.push(...payload.result.map(stock => ({
				symbol: stock.symbol,
				name: stock.name,
				market: venue,
				currency: market === "US" ? "USD" : "KRW"
			})));
		}
		stockCatalogCache.set(market, { at: Date.now(), value: stocks });
		return stocks;
	})();

	stockCatalogRequests.set(market, request);
	try { return await request; }
	finally { stockCatalogRequests.delete(market); }
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
	if (request.method !== "GET") return sendJson(response, 405, { error: "Only GET requests are supported." });

	if (url.pathname === "/api/status") {
		return sendJson(response, 200, { configured: apiConfigured(), provider: "Toss Securities Open API", scopes: ["quotes", "exchange-rate"] });
	}

	if (url.pathname === "/api/config") {
		const config = getSupabasePublicConfig();
		return sendJson(response, 200, {
			configured: config.configured,
			url: config.url,
			anonKey: config.anonKey
		});
	}

	if (request.method === "GET" && url.pathname === "/healthz") {
		return sendJson(response, 200, { status: "ok" });
	}

	if (url.pathname === "/api/diagnostics") {
		if (!await requireTossOwner(request, response)) return;
		return sendJson(response, 200, await runDiagnostics());
	}

	if (url.pathname === "/api/accounts") {
		if (!await requireTossOwner(request, response)) return;
		try {
			return sendJson(response, 200, await getAccounts());
		} catch (error) { return tossFailure(response, "Toss account lookup", error); }
	}

	if (url.pathname === "/api/holdings") {
		if (!await requireTossOwner(request, response)) return;
		const accountSeq = url.searchParams.get("accountSeq") || "";
		if (!/^\d{1,20}$/.test(accountSeq)) return sendJson(response, 400, { error: "Provide a valid Toss account sequence." });
		try {
			const payload = await tossGet("/api/v1/holdings", {}, true, accountSeq);
			if (!Array.isArray(payload.result?.items)) throw new Error("Toss returned an invalid holdings response.");
			return sendJson(response, 200, payload);
		} catch (error) { return tossFailure(response, "Toss holdings lookup", error); }
	}

	if (url.pathname === "/api/quotes") {
		const rawSymbols = url.searchParams.get("symbols") || "";
		if (!rawSymbols || !/^[A-Za-z0-9.,-]{1,2000}$/.test(rawSymbols)) return sendJson(response, 400, { error: "Provide valid stock symbols." });
		const symbols = [...new Set(rawSymbols.split(",").map(symbol => symbol.trim()).filter(Boolean))];
		if (!symbols.length || symbols.length > 200) return sendJson(response, 400, { error: "Request between 1 and 200 symbols." });
		try { return sendJson(response, 200, await getQuotes(symbols)); }
		catch (error) {
			if (!apiConfigured()) return sendJson(response, 503, { error: "Toss API credentials are not configured on the server." });
			return tossFailure(response, "Toss quote", error);
		}
	}

	if (url.pathname === "/api/stock-search") {
		const market = url.searchParams.get("market");
		const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase("ko-KR");
		if (!["KR", "US"].includes(market) || query.length < 1 || query.length > 60) return sendJson(response, 400, { error: "Provide a market and a 1-60 character search query." });
		try {
			const catalog = await getStockCatalog(market);
			const matches = catalog.filter(stock => stock.name.toLocaleLowerCase("ko-KR").includes(query) || stock.symbol.toLocaleLowerCase("ko-KR").includes(query));
			matches.sort((left, right) => {
				const leftExact = left.name.toLocaleLowerCase("ko-KR") === query || left.symbol.toLocaleLowerCase("ko-KR") === query;
				const rightExact = right.name.toLocaleLowerCase("ko-KR") === query || right.symbol.toLocaleLowerCase("ko-KR") === query;
				return Number(rightExact) - Number(leftExact) || left.name.localeCompare(right.name, "ko-KR");
			});
			return sendJson(response, 200, { result: matches.slice(0, 30) });
		} catch (error) {
			if (!apiConfigured()) return sendJson(response, 503, { error: "Toss API credentials are not configured on the server." });
			return tossFailure(response, "Toss stock search", error);
		}
	}

	if (url.pathname === "/api/exchange-rate") {
		try { return sendJson(response, 200, await getExchangeRate()); }
		catch (error) {
			if (!apiConfigured()) return sendJson(response, 503, { error: "Toss API credentials are not configured on the server." });
			return tossFailure(response, "Toss exchange rate", error);
		}
	}

	if (url.pathname === "/" || url.pathname === "/index.html") {
		try {
			const html = await readFile(appHtml);
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
			return response.end(html);
		} catch (error) {
			console.error("Could not read the existing app entry point:", error);
			return sendJson(response, 500, { error: "The app page could not be loaded." });
		}
	}

	const assetType = staticAssets.get(url.pathname);
	if (request.method === "GET" && assetType) {
		try {
			const body = await readFile(path.join(root, url.pathname.slice(1)));
			response.writeHead(200, {
				"Content-Type": assetType,
				"Cache-Control": url.pathname === "/service-worker.js" ? "no-cache" : "public, max-age=3600",
				"X-Content-Type-Options": "nosniff"
			});
			return response.end(body);
		} catch (error) { return sendJson(response, 500, { error: "A static app asset could not be loaded." }); }
	}

	return sendJson(response, 404, { error: "Not found." });
});

server.listen(port, "0.0.0.0", () => console.log(`Budget app listening on port ${port}`));