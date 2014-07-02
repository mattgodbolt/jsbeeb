function waitFor(testFx, onReady, timeOutMillis) {
    var maxtimeOutMillis = timeOutMillis ? timeOutMillis : 3000, //< Default Max Timout is 3s
        start = new Date().getTime(),
        condition = false,
        interval = setInterval(function () {
            if ((new Date().getTime() - start < maxtimeOutMillis) && !condition) {
                // If not time-out yet and condition not yet fulfilled
                condition = (typeof(testFx) === "string" ? eval(testFx) : testFx()); //< defensive code
            } else {
                if (!condition) {
                    // If condition still not fulfilled (timeout but condition is 'false')
                    console.log("'waitFor()' timeout");
                    phantom.exit(1);
                } else {
                    // Condition fulfilled (timeout and/or condition is 'true')
                    console.log("'waitFor()' finished in " + (new Date().getTime() - start) + "ms.");
                    typeof(onReady) === "string" ? eval(onReady) : onReady(); //< Do what it's supposed to do once the condition is fulfilled
                    clearInterval(interval); //< Stop this interval
                }
            }
        }, 250); //< repeat check every 250ms
}

var finished = false;
var page = require('webpage').create();
page.onConsoleMessage = function (msg) {
    console.log(">> " + msg);
    if (msg === "All tests complete") finished = true;
};

function firstTest() {
    return page.evaluate(function () {
        return $('#test-info:visible').length !== 0;
    });
}

function whenAllFinished() {
    var numFailed = page.evaluate(function () {
        return $('#test-info > .fail').length;
    });
    var numSucceeded = page.evaluate(function () {
        return $('#test-info > .success').length;
    });
    console.log("NumSucceeded = " + numSucceeded + ", NumFailed = " + numFailed);
    if (numSucceeded === 0 || numFailed !== 0) {
        console.log("Exiting with failure");
        phantom.exit(1);
    }
    console.log("Exiting with success");
    phantom.exit();
}

function waitForAllToFinish() {
    console.log("Waiting for all tests complete");
    waitFor("finished", whenAllFinished, 900000);
}

console.log("Loading test page");
page.open("http://localhost:8000/tests/index.html", function (status) {
    console.log("Page loaded");
    if (status != 'success') {
        console.log("Failed to load test page");
        phantom.exit(1);
    }
    console.log("Waiting for tests to start");
    waitFor(firstTest, waitForAllToFinish, 10000);
});
