// A classic script in ES5, because it has to run exactly where the bundle's syntax does not.
// tools/vite-plugin-browser-floor.js puts it in the head and the message it shows in the body.
(function () {
    var StartupFailed = "startup_failed";
    // Between them these set package.json's browserslist floor: each is the last of the three to arrive in one of
    // Chromium, Gecko and WebKit.
    var FloorFeatures = [
        [
            "color-mix",
            function () {
                return window.CSS && CSS.supports && CSS.supports("color", "color-mix(in srgb, red, red)");
            },
        ],
        [
            "toSorted",
            function () {
                return Array.prototype.toSorted;
            },
        ],
        [
            "CompressionStream",
            function () {
                return window.CompressionStream;
            },
        ],
    ];
    // Edge's agent string also says Chrome, and Chrome's also says Safari, so the order matters.
    var Browsers = [
        ["Edge", /Edge?\/(\d+)/],
        ["Firefox", /Firefox\/(\d+)/],
        ["Chrome", /Chrome\/(\d+)/],
        ["Safari", /Version\/(\d+(?:\.\d+)?).*Safari/],
    ];
    var pageDirectory = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
    var shown = false;

    function missingFeature() {
        for (var i = 0; i < FloorFeatures.length; ++i) {
            if (!FloorFeatures[i][1]()) return FloorFeatures[i][0];
        }
        return null;
    }

    function thisBrowser() {
        for (var i = 0; i < Browsers.length; ++i) {
            var match = Browsers[i][1].exec(navigator.userAgent);
            if (match) return Browsers[i][0] + " " + match[1];
        }
        return null;
    }

    function withoutQuery(url) {
        return url.split(/[?#]/)[0];
    }

    function configured() {
        var dataLayer = window.dataLayer || [];
        for (var i = 0; i < dataLayer.length; ++i) {
            if (dataLayer[i][0] === "config") return true;
        }
        return false;
    }

    // The same condition as analytics.js: an id, and the gtag the deploy build injects. main.js sends the
    // page_view, so when it did not get that far this sends one of its own, with no query to filter.
    function report(measurementId, reason) {
        if (!measurementId || typeof window.gtag !== "function") return;
        if (!configured()) {
            window.gtag("config", measurementId, {
                page_location: withoutQuery(location.href),
                page_referrer: withoutQuery(document.referrer),
            });
        }
        window.gtag("event", "unsupported_browser", { reason: reason });
    }

    function reveal(reason) {
        var message = document.getElementById("browser-floor");
        var browser = thisBrowser();
        if (browser) document.getElementById("browser-floor-browser").textContent = " This looks like " + browser + ".";
        document.getElementById("browser-floor-close").addEventListener("click", function () {
            message.hidden = true;
        });
        message.hidden = false;
        report(message.getAttribute("data-measurement-id"), reason);
    }

    function show(reason) {
        if (shown) return;
        shown = true;
        if (document.readyState !== "loading") return reveal(reason);
        document.addEventListener("DOMContentLoaded", function () {
            reveal(reason);
        });
    }

    // Below the floor the bundle usually fails to parse too, which is reported before DOMContentLoaded; the
    // feature is checked first so that it, not the parse error, is what gets reported.
    var missing = missingFeature();
    if (missing) show(missing);

    function onError(event) {
        if (event.filename && event.filename.indexOf(pageDirectory) === 0) show(StartupFailed);
    }

    window.addEventListener("error", onError);
    window.jsbeebStartupFinished = function () {
        window.removeEventListener("error", onError);
    };
})();
