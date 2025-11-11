/* Enhanced Service Worker with Background Sync for Kokoro TTS */

const CACHE_NAME = 'kokoro-tts-cache-v1';
const TRANSFORMERS_CACHE = 'transformers-cache';

// Install event - cache essential resources
self.addEventListener("install", (event) => {
  console.log('Service Worker installing...');
  
  event.waitUntil(
    caches.open(TRANSFORMERS_CACHE).then((cache) => {
      return cache.addAll([
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/ort-wasm-simd-threaded.jsep.mjs",
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/ort-wasm-simd-threaded.jsep.wasm"
      ]).catch(err => {
        console.warn('Failed to cache transformers resources:', err);
      });
    }).then(() => {
      // Skip waiting to activate immediately
      return self.skipWaiting();
    })
  );
});

// Activate event - claim clients
self.addEventListener("activate", (event) => {
  console.log('Service Worker activated');
  event.waitUntil(
    self.clients.claim().then(() => {
      console.log('Service Worker now controlling all clients');
    })
  );
});

// Fetch event - serve from cache when possible
self.addEventListener("fetch", (event) => {
  // Only cache transformer-related resources
  if (
    event.request.url.includes("ort-wasm-simd-threaded.jsep.mjs") ||
    event.request.url.includes("ort-wasm-simd-threaded.jsep.wasm")
  ) {
    event.respondWith(
      caches.match(event.request).then((response) => {
        if (response) {
          console.log('Serving from cache:', event.request.url);
          return response;
        }
        console.log('Fetching from network:', event.request.url);
        return fetch(event.request).then(networkResponse => {
          // Cache the fetched resource
          return caches.open(TRANSFORMERS_CACHE).then(cache => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        });
      })
    );
  }
});

// Background Sync - process TTS queue in background
// NOTE: Background Sync API is only supported in Chrome/Edge (not Safari/Firefox)
self.addEventListener('sync', (event) => {
  console.log('Background sync event:', event.tag);
  
  if (event.tag === 'process-tts-queue') {
    event.waitUntil(processTTSQueue());
  }
});

async function processTTSQueue() {
  console.log('Background sync: Processing TTS queue');
  
  try {
    // Open IndexedDB
    const db = await openDatabase();
    
    // Get queued jobs
    const jobs = await getQueuedJobs(db);
    
    if (jobs.length === 0) {
      console.log('No queued jobs found');
      return;
    }
    
    console.log(`Found ${jobs.length} queued job(s)`);
    
    // Notify clients to process jobs
    const clients = await self.clients.matchAll({ type: 'window' });
    
    if (clients.length > 0) {
      // If app is open, notify it to process
      clients.forEach(client => {
        client.postMessage({
          type: 'process-queue',
          jobCount: jobs.length
        });
      });
    } else {
      // No clients open - show notification
      await self.registration.showNotification('TTS Jobs Pending', {
        body: `${jobs.length} audio conversion(s) ready to process. Open the app to continue.`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'tts-queue-pending',
        requireInteraction: false,
        data: {
          url: self.location.origin
        }
      });
    }
    
  } catch (error) {
    console.error('Background sync error:', error);
  }
}

// Open IndexedDB
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('KokoroTTSDatabase', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get queued jobs from IndexedDB
function getQueuedJobs(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    const index = store.index('status');
    const request = index.getAll('queued');
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('Notification clicked:', event.notification.tag);
  event.notification.close();
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if app is already open
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      
      // Otherwise open new window
      if (self.clients.openWindow) {
        const url = event.notification.data?.url || '/';
        return self.clients.openWindow(url);
      }
    })
  );
});

// Message handler - receive messages from main app
self.addEventListener('message', (event) => {
  console.log('Service Worker received message:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'REGISTER_SYNC') {
    // Register background sync
    if ('sync' in self.registration) {
      self.registration.sync.register('process-tts-queue').then(() => {
        console.log('Background sync registered');
      }).catch(err => {
        console.warn('Background sync registration failed:', err);
      });
    }
  }
});

// Periodic Background Sync (experimental - Chrome only)
// This allows truly background processing even when tab is closed
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'check-tts-queue') {
      event.waitUntil(processTTSQueue());
    }
  });
}

console.log('Service Worker loaded and ready');
