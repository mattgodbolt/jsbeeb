var processor;
var video;
var soundChip;
var dbgr;
var jsAudioNode;  // has to remain to keep thing alive
var frames = 0;
var frameSkip = 0;
var syncLights;
var sth;
var dropbox;
var running;

function noteEvent(category, type, label) {
    if (window.location.origin == "http://bbc.godbolt.org") {
        // Only note events on the public site
        ga('send', 'event', category, type, label);
    }
    console.log('event noted:', category, type, label);
}

$(function() {
    "use strict";
    var canvas = $('#screen')[0];
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 1280, 768);
    if (!ctx.getImageData) {
        alert('Unsupported browser');
        return;
    }
    var backBuffer = document.createElement("canvas");
    backBuffer.width = 1280;
    backBuffer.height = 768;
    var backCtx = backBuffer.getContext("2d");
    var imageData = backCtx.createImageData(backBuffer.width, backBuffer.height);
    var fb8 = imageData.data;
    var canvasWidth = canvas.width;
    var canvasHeight = canvas.height;
    function paint(minx, miny, maxx, maxy) {
        frames++;
        if (frames < frameSkip) return;
        frames = 0;
        var width = maxx - minx;
        var height = maxy - miny;
        backCtx.putImageData(imageData, 0, 0, minx, miny, width, height);
        ctx.drawImage(backBuffer, minx, miny, width, height, 0, 0, canvasWidth, canvasHeight);
    }
    var fb32 = new Uint32Array(fb8.buffer);
    video = new Video(fb32, paint);

    soundChip = (function() {
        var context = null;
        if (typeof AudioContext !== 'undefined') {
            context = new AudioContext();
        } else if (typeof(webkitAudioContext) !== 'undefined') {
            context = new webkitAudioContext(); // jshint ignore:line
        } else {
            return new SoundChip(10000);
        }
        soundChip = new SoundChip(context.sampleRate);
        jsAudioNode = context.createScriptProcessor(1024, 0, 1);
        function pumpAudio(event) {
            var outBuffer = event.outputBuffer;
            var chan = outBuffer.getChannelData(0);
            soundChip.render(chan, 0, chan.length);
        }
        jsAudioNode.onaudioprocess = pumpAudio;
        jsAudioNode.connect(context.destination);
        return soundChip;
    })();

    dbgr = new Debugger();
    function keyCode(evt) {
        return evt.which || evt.charCode || evt.keyCode;
    }
    function keyPress(evt) {
        if (running || !dbgr.enabled()) return;
        if (keyCode(evt) === 103) {
            dbgr.hide();
            go();
            return;
        }
        return dbgr.keyPress(keyCode(evt)); 
    }
    function keyDown(evt) {
        if (!running) return;
        var code = keyCode(evt);
        if (code === 36) {  // home
            noteEvent('keyboard', 'press', 'home');
            stop(true);
        } else if (code == 123) { // F12
            noteEvent('keyboard', 'press', 'break');
            processor.reset(false);
            evt.preventDefault();
        } else {
            processor.sysvia.keyDown(keyCode(evt));
            evt.preventDefault();
        }
    }
    function keyUp(evt) {
        if (!running) return;
        processor.sysvia.keyUp(keyCode(evt));
        evt.preventDefault();
    }
    document.onkeydown = keyDown;
    document.onkeypress = keyPress;
    document.onkeyup = keyUp;

    processor = new Cpu6502(dbgr, video, soundChip);

    sth = new StairwayToHell(function(cat) {
        var sthList = $("#sth-list");
        $("#sth .loading").hide();
        var template = sthList.find(".template");
        $.each(cat, function(_, cat) {
           var row = template.clone().removeClass("template").appendTo(sthList); 
           row.find(".name").text(cat);
           $(row).on("click", function(){
               var file = sth.fetch(cat);
               noteEvent('sth', 'click', cat);
               if (file) {
                   processor.fdc.loadDiscData(0, file);
                   parsedQuery.disc = "|" + cat;
                   updateUrl();
               }
               $('#sth').modal("hide");
           });
        });
    }, function() {
        $('#sth .loading').text("There was an error accessing the STH archive");
    });

    function setSthFilter(filter) {
        filter = filter.toLowerCase();
        $("#sth-list li").each(function() {
            var el = $(this);
            if (el.hasClass("template")) return;
            el.toggle(el.text().toLowerCase().indexOf(filter) >= 0);
        });
    }
    $('#sth-filter').on("change keyup", function() { setSthFilter($('#sth-filter').val()); });

    function autoboot(image) {
        console.log("Autobooting");
        noteEvent('init', 'autoboot', image);
        processor.sysvia.keyDown(16);
        setTimeout(function() {
            // defer...so we only start counting once we've run a bit...
            setTimeout(function() { processor.sysvia.keyUp(16); }, 5000);
        }, 0);
    }

    var availableImages = starCat();
    var queryString = document.location.search;
    var discImage = availableImages[0].file;
    var secondDiscImage = null;
    var parsedQuery = {};
    var needsAutoboot = false;
    if (queryString) {
        queryString = queryString.substring(1);
        if (queryString[queryString.length - 1] == '/')  // workaround for shonky python web server
            queryString = queryString.substring(0, queryString.length - 1);
        queryString.split("&").forEach(function(keyval) {
            var keyAndVal = keyval.split("=");
            var key = decodeURIComponent(keyAndVal[0]);
            var val = undefined;
            if (keyAndVal.length > 1) val = decodeURIComponent(keyAndVal[1]);
            parsedQuery[key] = val;
            switch (key) {
            case "autoboot":
                needsAutoboot = true;
                break;
            case "disc": case "disc1":
                discImage = val;
                break;
            case "disc2":
                secondDiscImage = val;
                break;
            }
        });
    }

    if (parsedQuery.dbEnabled) {
        $('.hidden-unless-db-enabled').show();
    }

    if (needsAutoboot) autoboot(discImage);
    function updateUrl() {
        var url = window.location.origin + window.location.pathname;
        var sep = '?';
        $.each(parsedQuery, function(key, value) {
            url += sep + encodeURIComponent(key);
            if (value) url += "=" + encodeURIComponent(value);
            sep = '&';
        });
        window.history.pushState(null, null, url);
    }
    function loadDiscImage(drive, discImage) {
        if (discImage && discImage[0] == "!") {
            processor.fdc.loadDisc(drive, localDisc(processor.fdc, discImage.substr(1)));
        } else if (discImage && discImage[0] == "|") {
            processor.fdc.loadDiscData(drive, sth.fetch(discImage.substr(1)));
        } else if (discImage && discImage[0] == "^") {
            _.defer(function() {
                popupLoading("Connecting to Dropbox");
                var db = new DropboxLoader(function(){
                    dropboxLoad(db, discImage.substr(1));
                }, function(error){
                    loadingFinished(error);
                });
            });
        } else {
            processor.fdc.loadDiscData(drive, ssdLoad("discs/" + discImage));
        }
    }
    if (discImage) loadDiscImage(0, discImage);
    if (secondDiscImage) loadDiscImage(1, secondDiscImage);

    $('#disc_load').change(function(evt) { 
        var file = evt.target.files[0]; 
        var reader = new FileReader();
        noteEvent('local', 'click'); // NB no filename here
        reader.onload = function(e) {
            processor.fdc.loadDiscData(0, e.target.result);
            delete parsedQuery.disc;
            updateUrl();
        };
        reader.readAsBinaryString(file);
    });

    function anyModalsVisible() {
        return $(".modal:visible").length !== 0;
    }
    var modalDepth = 0;
    var modalSavedRunning = false;
    $('.modal').on('show.bs.modal', function() { 
        if (!anyModalsVisible()) modalSavedRunning = running;
        if (running) stop(false);
    });
    $('.modal').on('hidden.bs.modal', function() { 
        if (!anyModalsVisible() && modalSavedRunning) {
            go();
        }
    });
    function popupLoading(msg) {
        var modal = $('#loading-dialog');
        modal.find(".loading").text(msg);
        modal.modal("show");
    }
    function loadingFinished(error) {
        // TODO: either look for Dropbox errors here or wrap all the DB callers
        // with wrappers to do the right thing on DB errors.
        var modal = $('#loading-dialog');
        if (error) {
            modal.find(".loading").text("Error: " + error);
            setTimeout(function() { 
                modal.modal("hide");
            }, 2000);
        } else {
            modal.modal("hide");
        }
    }

    function dropboxLoad(dropbox, cat, create) {
        noteEvent('dropbox', 'click', cat);
        parsedQuery.disc = "^" + cat;
        updateUrl();
        if (create)
            popupLoading("Creating '" + cat + "' on Dropbox");
        else 
            popupLoading("Loading '" + cat + "' from Dropbox");
        dropbox.load(processor.fdc, cat, 0, function(error) {
            loadingFinished(error);
        });
    }

    var dropboxModal = $('#dropbox');
    dropboxModal.on('show.bs.modal', function() {
        dropboxModal.find(".loading").text("Loading...").show();
        dropboxModal.find("li").not(".template").remove();
        dropbox = new DropboxLoader(function(cat) {
            var dbList = $("#dropbox-list");
            $("#dropbox .loading").hide();
            var template = dbList.find(".template");
            $.each(cat, function(_, cat) {
                var row = template.clone().removeClass("template").appendTo(dbList); 
                row.find(".name").text(cat);
                $(row).on("click", function(){
                    dropboxLoad(dropbox, cat);
                    dropboxModal.modal("hide");
                });
            });
        }, function(error) {
            $('#dropbox .loading').text("There was an error accessing your Dropbox account: " + error);
        });
    });
    var discList = $('#disc-list');
    var template = discList.find(".template");
    $.each(availableImages, function(i, image) {
        var elem = template.clone().removeClass("template").appendTo(discList);
        elem.find(".name").text(image.name);
        elem.find(".description").text(image.desc);
        $(elem).on("click", function(){
            noteEvent('images', 'click', image.file);
            processor.fdc.loadDiscData(0, ssdLoad("/discs/" + image.file));
            parsedQuery.disc = image.file;
            updateUrl();
            $('#discs').modal("hide");
        });
    });
    function dbCreate() {
        var text = $("#db-disc-name").val();
        if (!text) return false;
        popupLoading("Connecting to Dropbox");
        $("#dropbox").modal("hide");
        var db = new DropboxLoader(function(){
            dropboxLoad(db, text, true);
        }, function(error){
            loadingFinished(error);
        });
        return false;
    }
    $("#dropbox form").on("submit", dbCreate);

    function Light(name) {
        var dom = $("#" + name);
        var on = false;
        this.update = function(val) {
            if (val == on) return;
            on = val;
            dom.toggleClass("on", on);
        };
    }
    var caps = new Light("capslight");
    var shift = new Light("shiftlight");
    var drive0 = new Light("drive0");
    var drive1 = new Light("drive1");
    syncLights = function() {
        caps.update(processor.sysvia.capsLockLight);
        shift.update(processor.sysvia.shiftLockLight);
        drive0.update(processor.fdc.motoron[0]);
        drive1.update(processor.fdc.motoron[1]);
    };

    go();
});

function hd(obj, start, end) {
    var str = "";
    var j = 0;
    for (var i = start; i < end; ++i) {
        if (str) str += " ";
        str += hexbyte(obj[i]);
        if (++j == 8) str += " ";
        if (j == 16) {
            console.log(str);
            str = "";
            j = 0;
        }
    }
    if (str) console.log(str);
}

const framesPerSecond = 50;
const targetTimeout = 1000 / framesPerSecond;
var adjustedTimeout = targetTimeout;
var lastFrame = null;
const clocksPerSecond = 2 * 1000 * 1000;
const cyclesPerFrame = clocksPerSecond / framesPerSecond;
const yieldsPerFrame = 1;
const cyclesPerYield = cyclesPerFrame / yieldsPerFrame;

function benchmarkCpu(numCycles) {
    numCycles = numCycles || 10 * 1000 * 1000;
    var oldFS = frameSkip;
    frameSkip = 10000;
    var startTime = Date.now();
    processor.execute(numCycles);
    var endTime = Date.now();
    frameSkip = oldFS;
    var msTaken = endTime - startTime;
    var virtualMhz = (numCycles / msTaken) / 1000;
    console.log("Took " + msTaken + "ms to execute " + numCycles + " cycles");
    console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
}

function profileCpu() {
    console.profile("CPU");
    benchmarkCpu(10 * 1000 * 1000);
    console.profileEnd();
}

function run() {
    if (!running) return;
    var now = Date.now();
    if (lastFrame) {
        // Try and tweak the timeout to achieve target frame rate.
        var timeSinceLast = now - lastFrame;
        if (timeSinceLast < 2 * targetTimeout) {
            // Ignore huge delays (e.g. trips in and out of the debugger)
            var diff = timeSinceLast - targetTimeout;
            adjustedTimeout -= 0.01 * diff;
        }
    }
    lastFrame = now;
    setTimeout(run, adjustedTimeout);

    var count = 0;
    var runner = function() {
        if (!running) return;
        if (count++ == yieldsPerFrame) {
            syncLights();
            return;
        }
        try {
            processor.execute(cyclesPerYield);
        } catch (e) {
            running = false;
            noteEvent('exception', 'thrown', e.stack);
            throw e;
        }
        if (running) setTimeout(runner, 0);
    };
    runner();
}

function go() {
    running = true;
    run();
}

function stop(debug) {
    running = false; 
    processor.stop();
    if (debug) dbgr.debug(processor.pc);
}
