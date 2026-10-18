const GoogleScriptHosts = "*.google-analytics.com *.google.com";
const CspScriptSrc = /(http-equiv="Content-Security-Policy"\s+content="script-src [^;"]*)/;

// The meta CSP covers only what follows it, so the tag that loads gtag.js goes first.
const gtagTags = (measurementId) => [
    {
        tag: "script",
        attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}` },
        injectTo: "head-prepend",
    },
    {
        tag: "script",
        children: `window.dataLayer = window.dataLayer || [];
function gtag() {
    dataLayer.push(arguments);
}
gtag("js", new Date());`,
        injectTo: "head-prepend",
    },
];

/** Google Analytics on the page and its measurement id in `import.meta.env.GA_MEASUREMENT_ID`, both only with an id. */
export function analyticsPlugin(measurementId = process.env.GA_MEASUREMENT_ID) {
    return {
        name: "analytics",
        config: () => ({ define: { "import.meta.env.GA_MEASUREMENT_ID": JSON.stringify(measurementId || "") } }),
        transformIndexHtml(html) {
            if (!measurementId) return html;
            if (!CspScriptSrc.test(html)) throw new Error("No script-src in index.html's CSP to add Google's hosts to");
            return { html: html.replace(CspScriptSrc, `$1 ${GoogleScriptHosts}`), tags: gtagTags(measurementId) };
        },
    };
}
