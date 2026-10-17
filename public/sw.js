const CACHE = 'nsbus-shell-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add('/').catch(() => {}))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) return cached
    if (request.mode === 'navigate') {
      const home = await cache.match('/')
      if (home) return home
    }
    throw error
  }
}

// Chrome offers Install once a fetch handler is registered. Same-origin pages are
// kept so the home-screen icon can open the map without a fresh download.
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  if (request.headers.has('authorization')) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/buses') || url.pathname.startsWith('/cdn-cgi/')) return
  if (url.pathname === '/live' || url.pathname === '/live.html') return
  event.respondWith(networkFirst(request))
})
