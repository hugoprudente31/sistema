/* Service worker do app TGT Agenda.
 *
 * Objetivo: permitir instalar o sistema como aplicativo (Android/iPhone) e
 * mostrar uma tela amigável quando o celular estiver sem internet.
 *
 * Importante: NÃO guardamos em cache as telas nem a API. Agenda, horários e
 * login precisam estar sempre atualizados, então tudo continua vindo do
 * servidor. Só a página offline e os ícones ficam salvos no aparelho.
 */
const CACHE = "tgt-app-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Só tratamos a navegação entre páginas. API, scripts e imagens seguem
  // direto para a rede, sem nenhuma interferência do service worker.
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(
    fetch(req).catch(() => caches.match(OFFLINE_URL))
  );
});
