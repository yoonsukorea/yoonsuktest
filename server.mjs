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
let lastStockCatalogRequestAt = 0;

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
		if (!response.ok) throw new Error(`Toss token request failed (${response.status}).`);
		const result = await response.json();
		if (!result.access_token || !Number(result.expires_in)) throw new Error("Toss returned an invalid token response.");
		tokenValue = result.access_token;
		tokenExpiresAt = Date.now() + Number(result.expires_in) * 1000;
		return tokenValue;
	})();

	try { return await tokenRequest; }
	finally { tokenRequest = null; }
}

async function tossGet(apiPath, params, canRetry = true) {
	const token = await getAccessToken();
	const query = new URLSearchParams(params);
	const response = await fetch(`${tossBaseUrl}${apiPath}?${query}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal: AbortSignal.timeout(10_000)
	});
	if (response.status === 401 && canRetry) {
		tokenValue = "";
		tokenExpiresAt = 0;
		await getAccessToken(true);
		return tossGet(apiPath, params, false);
	}
	if (!response.ok) throw new Error(`Toss data request failed (${response.status}).`);
	return response.json();
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
	if (exchangeCache && Date.now() - exchangeCache.at < 60_000) return exchangeCache.value;
	const payload = await tossGet("/api/v1/exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" });
	if (!payload.result?.rate) throw new Error("Toss returned an invalid exchange-rate response.");
	exchangeCache = { at: Date.now(), value: { result: payload.result } };
	return exchangeCache.value;
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

	if (url.pathname === "/api/quotes") {
		const rawSymbols = url.searchParams.get("symbols") || "";
		if (!rawSymbols || !/^[A-Za-z0-9.,-]{1,2000}$/.test(rawSymbols)) return sendJson(response, 400, { error: "Provide valid stock symbols." });
		const symbols = [...new Set(rawSymbols.split(",").map(symbol => symbol.trim()).filter(Boolean))];
		if (!symbols.length || symbols.length > 200) return sendJson(response, 400, { error: "Request between 1 and 200 symbols." });
		try { return sendJson(response, 200, await getQuotes(symbols)); }
		catch (error) { return sendJson(response, apiConfigured() ? 502 : 503, { error: apiConfigured() ? "Toss quote service is unavailable." : "Toss API credentials are not configured on the server." }); }
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
			return sendJson(response, apiConfigured() ? 502 : 503, { error: apiConfigured() ? "Toss stock search is unavailable." : "Toss API credentials are not configured on the server." });
		}
	}

	if (url.pathname === "/api/exchange-rate") {
		try { return sendJson(response, 200, await getExchangeRate()); }
		catch (error) { return sendJson(response, apiConfigured() ? 502 : 503, { error: apiConfigured() ? "Toss exchange-rate service is unavailable." : "Toss API credentials are not configured on the server." }); }
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