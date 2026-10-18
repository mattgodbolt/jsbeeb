/* exported browserFloor */
// ES5, as it runs exactly where the bundle's syntax does not. tools/vite-plugin-browser-floor.js passes the floors.
function browserFloor(config) {
    // The order matters. Safari on iOS says its version just before Mobile/; every other iOS browser is Safari's engine
    // at the iOS version (frozen at 18_6 from iOS 26). Edge's agent string also says Chrome, and Android WebView's
    // also says Version/.
    var Browsers = [
        ["Safari", /Version\/(\d+(?:\.\d+)?) Mobile\/\w+ Safari/],
        ["Safari", /OS (\d+)_(\d+)(?:_\d+)? like Mac OS X/],
        ["Edge", /Edg[eA]?\/(\d+)/],
        ["Firefox", /Firefox\/(\d+)/],
        ["Chrome", /Chrome\/(\d+)/],
        ["Safari", /Version\/(\d+(?:\.\d+)?).*Safari/],
    ];
    var pageDirectory = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
    var browser = "";
    var shown = false;

    // Once the page is parsed, so that the message is there and main.js has sent its page_view if it ever will.
    function show(reason, text) {
        if (shown) return;
        shown = true;
        if (document.readyState === "loading") return document.addEventListener("DOMContentLoaded", reveal);
        reveal();
        function reveal() {
            document.getElementById("browser-floor-text").textContent = text;
            document.getElementById("browser-floor").hidden = false;
            if (!config.measurementId || typeof window.gtag !== "function") return;
            var configured = window.dataLayer.some(function (call) {
                return call[0] === "config";
            });
            if (!configured) {
                window.gtag("config", config.measurementId, {
                    page_location: location.href.split(/[?#]/)[0],
                    page_referrer: document.referrer.split(/[?#]/)[0],
                });
            }
            window.gtag("event", "unsupported_browser", { reason: reason });
        }
    }

    for (var i = 0; i < Browsers.length && !browser; ++i) {
        var match = Browsers[i][1].exec(navigator.userAgent);
        var version = match && match.slice(1).join(".");
        var floor = config.floors[Browsers[i][0]];
        if (match) browser = Browsers[i][0] + " " + version;
        var text = "You're using " + browser + ". jsbeeb needs " + Browsers[i][0] + " " + floor + " or newer.";
        if (match && parseFloat(version) < parseFloat(floor)) show("below_floor", text);
    }

    function onError(event) {
        if (!event.filename || event.filename.indexOf(pageDirectory) !== 0) return;
        var where = browser ? " in " + browser : "";
        show("startup_failed", "jsbeeb didn't start" + where + ". It supports " + config.supported + " and newer.");
    }
    window.addEventListener("error", onError);
    window.jsbeebStartupFinished = window.removeEventListener.bind(window, "error", onError);
}
