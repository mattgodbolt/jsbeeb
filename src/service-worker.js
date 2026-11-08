import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";

const NavigationTimeoutMs = 4000;
const ShellEntry = "index.html";

// The page is fetched from the network so a deploy is seen at once; the precached copy is only for
// when there is no network. Registered before the precache route, which would otherwise answer first.
registerRoute(
    new NavigationRoute(async ({ request }) => {
        try {
            return await fetch(request, { signal: AbortSignal.timeout(NavigationTimeoutMs) });
        } catch {
            return (await matchPrecache(ShellEntry)) ?? Response.error();
        }
    }),
);

// Everything the build names with a content hash, the ROMs and the page's own art.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// The bundled discs and tapes are kept once used, so a game played offline once can be again. Any other
// origin (disc archives, GitHub, Google Drive) has no route and goes straight to the network.
registerRoute(
    ({ url, sameOrigin }) => sameOrigin && /\/(discs|tapes)\//.test(url.pathname),
    new StaleWhileRevalidate({ cacheName: "media" }),
);

// The theme's web font is the one cross-origin thing the page cannot render without; its files never change.
registerRoute(
    ({ url }) => url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com",
    new CacheFirst({
        cacheName: "fonts",
        // A stylesheet pulled in with @import comes back opaque, with status 0.
        plugins: [
            {
                cacheWillUpdate: async ({ response }) =>
                    response.status === 0 || response.status === 200 ? response : null,
            },
        ],
    }),
);

self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
