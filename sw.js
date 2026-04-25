// ═══════════════════════════════════════════════════════════════
//  SERVICE WORKER — Will & Anna PWA
//  Versão: 1.0
//  Funcionalidades:
//    - Cache offline (app funciona sem internet)
//    - Push notifications (chega mesmo com app fechado)
//    - Background sync (verifica prazos a cada hora via periodicsync)
//    - Notification click → abre o app
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME = 'will-anna-v1';
const URLS_TO_CACHE = [
  '/casa/',
  '/casa/index.html',
  '/casa/manifest.json',
  '/casa/icon-192.png',
  '/casa/icon-512.png',
];

// ─── INSTALL: cache dos ficheiros principais ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(URLS_TO_CACHE).catch(() => {
        // Se algum ficheiro falhar, continua na mesma
        console.warn('[SW] Alguns ficheiros não foram cacheados.');
      });
    })
  );
  self.skipWaiting();
});

// ─── ACTIVATE: limpa caches antigos ──────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── FETCH: serve do cache se disponível ─────────────────────
self.addEventListener('fetch', event => {
  // Só intercepta GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cacheia respostas válidas
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        if (event.request.destination === 'document') {
          return caches.match('/casa/index.html');
        }
      });
    })
  );
});

// ─── PUSH: recebe notificações do servidor ────────────────────
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch(e) {
    data = { title: 'Will & Anna', body: event.data?.text() || '' };
  }

  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/casa/icon-192.png',
    badge:   '/casa/icon-192.png',
    tag:     data.tag     || 'will-anna-' + Date.now(),
    data:    { url: data.url || '/casa/index.html', tab: data.tab || '' },
    actions: data.actions || [],
    vibrate: data.urgent ? [100, 50, 100, 50, 200] : [60, 80, 60],
    requireInteraction: data.urgent || false,
    silent:  false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '🏠 Will & Anna', options)
  );
});

// ─── NOTIFICATION CLICK: abre o app ──────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/casa/index.html';
  const targetTab = event.notification.data?.tab || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Se já há uma janela aberta, foca nela
      for (const client of clientList) {
        if (client.url.includes('/casa') && 'focus' in client) {
          client.focus();
          // Envia mensagem para abrir a tab certa
          if (targetTab) {
            client.postMessage({ type: 'OPEN_TAB', tab: targetTab });
          }
          return;
        }
      }
      // Senão, abre uma nova janela
      if (clients.openWindow) {
        return clients.openWindow(targetUrl + (targetTab ? `#tab=${targetTab}` : ''));
      }
    })
  );
});

// ─── PERIODIC SYNC: verifica prazos em background ────────────
// (funciona no Chrome Android com permissão Periodic Background Sync)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-deadlines') {
    event.waitUntil(checkDeadlinesInBackground());
  }
  if (event.tag === 'check-budgets') {
    event.waitUntil(checkBudgetsInBackground());
  }
});

async function checkDeadlinesInBackground() {
  // Lê o localStorage via mensagem ao cliente ativo
  const clientList = await clients.matchAll({ type: 'window' });

  // Se o app estiver aberto, delega ao cliente
  if (clientList.length > 0) return;

  // App fechado — lê dados cacheados do IndexedDB ou Cache Storage
  // Aqui usamos um mecanismo simples via cache de dados
  try {
    const cache = await caches.open(CACHE_NAME);
    const dataResponse = await cache.match('/casa/__deadlines_cache');
    if (!dataResponse) return;

    const data = await dataResponse.json();
    const now  = new Date();

    (data.todos || []).forEach(item => {
      if (item.done || !item.deadline) return;
      const dead = new Date(item.deadline + 'T' + (item.deadlineTime ? item.deadlineTime + ':00' : '23:59:59'));
      const diff = dead - now;
      const hours = diff / 3600000;

      if (diff < 0) {
        self.registration.showNotification('⏰ Prazo ultrapassado!', {
          body: `"${item.name}" deveria estar concluída`,
          icon: '/casa/icon-192.png',
          badge: '/casa/icon-192.png',
          tag: 'deadline-overdue-' + item.id,
          data: { url: '/casa/index.html', tab: 'todo' },
          vibrate: [100, 50, 100, 50, 200],
          requireInteraction: true,
        });
      } else if (hours <= (data.settings?.deadlineHours || 24)) {
        const label = hours < 1 ? 'menos de 1 hora'
          : hours < 24 ? `${Math.floor(hours)} horas`
          : `${Math.floor(hours/24)} dia(s)`;
        self.registration.showNotification('⏱ Prazo a aproximar!', {
          body: `"${item.name}" — faltam ${label}`,
          icon: '/casa/icon-192.png',
          badge: '/casa/icon-192.png',
          tag: 'deadline-warn-' + item.id,
          data: { url: '/casa/index.html', tab: 'todo' },
          vibrate: [60, 80, 60],
        });
      }
    });
  } catch(e) {
    console.warn('[SW] Erro ao verificar prazos:', e);
  }
}

async function checkBudgetsInBackground() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const dataResponse = await cache.match('/casa/__budgets_cache');
    if (!dataResponse) return;

    const data = await dataResponse.json();
    const { budgets, spending } = data;

    Object.entries(budgets || {}).forEach(([cat, limit]) => {
      if (!limit || limit <= 0) return;
      const spent = spending?.[cat] || 0;
      const ratio = spent / limit;

      if (ratio >= 1) {
        self.registration.showNotification('🔴 Orçamento ultrapassado!', {
          body: `Categoria "${cat}": €${spent.toFixed(0)} de €${limit}`,
          icon: '/casa/icon-192.png',
          tag: 'budget-over-' + cat,
          data: { url: '/casa/index.html', tab: 'financas' },
          vibrate: [100, 50, 100, 50, 200],
          requireInteraction: true,
        });
      } else if (ratio >= 0.8) {
        self.registration.showNotification('💸 Orçamento a esgotar', {
          body: `"${cat}": ${Math.round(ratio*100)}% usado (€${spent.toFixed(0)} de €${limit})`,
          icon: '/casa/icon-192.png',
          tag: 'budget-warn-' + cat,
          data: { url: '/casa/index.html', tab: 'financas' },
          vibrate: [60, 80, 60],
        });
      }
    });
  } catch(e) {
    console.warn('[SW] Erro ao verificar orçamentos:', e);
  }
}

// ─── MESSAGE: recebe dados do app para cache ──────────────────
// O app envia os dados do localStorage pro SW guardar em cache
// para que o SW possa verificar prazos mesmo com o app fechado
self.addEventListener('message', async event => {
  if (event.data?.type === 'CACHE_DEADLINES') {
    const cache = await caches.open(CACHE_NAME);
    const response = new Response(JSON.stringify(event.data.payload), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put('/casa/__deadlines_cache', response);
  }

  if (event.data?.type === 'CACHE_BUDGETS') {
    const cache = await caches.open(CACHE_NAME);
    const response = new Response(JSON.stringify(event.data.payload), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put('/casa/__budgets_cache', response);
  }

  if (event.data?.type === 'NOTIFY') {
    const { title, body, tag, tab, urgent } = event.data;
    self.registration.showNotification(title, {
      body,
      icon: '/casa/icon-192.png',
      badge: '/casa/icon-192.png',
      tag:   tag || 'wa-' + Date.now(),
      data:  { url: '/casa/index.html', tab: tab || '' },
      vibrate: urgent ? [100,50,100,50,200] : [60,80,60],
      requireInteraction: urgent || false,
    });
  }
});
