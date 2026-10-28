const CACHE_NAME = "moa-shell-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/app-icon.svg"];

self.addEventListener("install", event => {
	event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
	self.skipWaiting();
});

self.addEventListener("activate", event => {
	event.waitUntil(
		caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
	);
	self.clients.claim();
});

self.addEventListener("fetch", event => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

	if (request.mode === "navigate") {
		event.respondWith(fetch(request).then(response => {
			if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put("/", response.clone()));
			return response;
		}).catch(() => caches.match("/")));
		return;
	}

	if (APP_SHELL.includes(url.pathname)) {
		event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
	}
});
