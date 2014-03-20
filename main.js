var processor;
var video;
var soundChip;
var dbgr;
var jsAudioNode;  // has to remain to keep thing alive
var frames = 0;
var syncLights;

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
    function paint(minx, miny, maxx, maxy) {
        frames++;
        //if ((frames & 0x1) != 0) return; TODO: frameskip
        var width = maxx-minx;
        var height = maxy-miny;
        backCtx.putImageData(imageData, 0, 0, minx, miny, width, height);
        ctx.drawImage(backBuffer, minx, miny, width, height, 0, 0, canvas.width, canvas.height);
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
        if (running) return;
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
            stop(true);
        } else if (code == 123) { // F12
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
    //processor.debugread = function(mem) {
    //    if (mem === 0x983f) stop();
    //        //console.log(hexword(processor.pc), "Read of", hexword(mem));
    //};
    //processor.debugwrite = function(mem, v) {
    //    if (mem == 0xfd) {
    //        console.log(hexword(processor.oldpc), "Write to", hexword(mem), hexbyte(v));
    //        //processor.stop();
    //    }
    //}
    //processor.debugInstruction = function(pc, opcode) {
    //    if (pc === 0xffdd) {
    //        var paramBlock = processor.x + (processor.y<<8);
    //        var fnAddr = processor.readmem(paramBlock) + (processor.readmem(paramBlock + 1) << 8);
    //            
    //        console.log("OSFILE", processor.a, fnAddr, processor.readstring(fnAddr));
    //        if (fnAddr === 22137) return true;
    //        //return true;
    //    }
    //    return false;
    //};
    //var count = 0;
    //var debugging = false;
    //processor.debugInstruction = function(pc) {
    //    function s(via) { return "t1c: " + via.t1c + " t2l: " + via.t1l + " t2c:" + via.t2c + " t2l: " + via.t2l; };
    //    if (pc === 0xceb) debugging = true;
    //    if (debugging && count < 1000) {
    //        count++;
    //        console.log(hexword(pc) + " " 
    //                + processor.disassembler.disassemble(pc)[0]
    //                + " "+ processor.cycles + " u{" + s(processor.uservia) +"} s{" + s(processor.sysvia) + "}"); 
    //    }
    //};
    //processor.debugInstruction = function(pc) {
      //return (pc == 0xdef);
    //};
    //    if (pc == 0xfff7) {
    //        var addr = processor.x + (processor.y<<8);
    //        var oscli = "";
    //        for (;;) {
    //            var b = processor.readmem(addr);
    //            addr++;
    //            if (b == 13) break;
    //            oscli += String.fromCharCode(b);
    //        }
    //        console.log("OSCLI:", oscli);
    //    }
    //    return false;
    //};

    function autoboot() {
        console.log("Autobooting");
        processor.sysvia.keyDown(16);
        setTimeout(function() { processor.sysvia.keyUp(16); }, 5000);
    }

    var availableImages = starCat();
    var queryString = document.location.search;
    var discImage = availableImages[0].file;
    var secondDiscImage = null;
    var parsedQuery = {};
    if (queryString) {
        queryString = queryString.substring(1);
        if (queryString[queryString.length - 1] == '/')  // workaround for shonky python web server
            queryString = queryString.substring(0, queryString.length - 1);
        queryString.split("&").forEach(function(keyval) {
            var keyAndVal = keyval.split("=");
            var key = keyAndVal[0], val = keyAndVal[1];
            parsedQuery[key] = val;
            switch (key) {
            case "autoboot":
                autoboot();
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

    function updateUrl() {
        var url = window.location.origin + window.location.pathname;
        var sep = '?';
        $.each(parsedQuery, function(key, value) {
            url += sep + encodeURIComponent(key) + "=" + encodeURIComponent(value);
            sep = '&';
        });
        window.history.pushState(null, null, url);
    }
    function loadDiscImage(drive, discImage) {
        if (discImage && discImage[0] == "!") {
            processor.fdc.loadDisc(drive, localDisc(processor.fdc, discImage.substr(1)));
        } else {
            processor.fdc.loadDiscData(drive, ssdLoad("discs/" + discImage));
        }
    }
    if (discImage) loadDiscImage(0, discImage);
    if (secondDiscImage) loadDiscImage(1, secondDiscImage);

    $('#disc_load').change(function(evt) { 
        var file = evt.target.files[0]; 
        var reader = new FileReader();
        reader.onload = function(e) {
            processor.fdc.loadDiscData(0, e.target.result);
            delete parsedQuery.disc;
            updateUrl();
        };
        reader.readAsBinaryString(file);
    });

    var modalSavedRunning = false;
    $('.modal').on('show.bs.modal', function() { 
        modalSavedRunning = running;
        if (running) stop(false);
    });
    $('.modal').on('hidden.bs.modal', function() { 
        if (modalSavedRunning) go();
    });
    var discList = $('#disc-list');
    var template = discList.find(".template");
    $.each(availableImages, function(i, image) {
        var elem = template.clone().removeClass("template").appendTo(discList);
        elem.find(".name").text(image.name);
        elem.find(".description").text(image.desc);
        $(elem).on("click", function(){
            processor.fdc.loadDiscData(0, ssdLoad("discs/" + image.file));
            parsedQuery.disc = image.file;
            updateUrl();
            $('#discs').modal("hide");
        });
    });

    function Light(name) {
        var dom = $("#" + name);
        var on = false;
        this.update = function(val) {
            if (val == on) return;
            on = val;
            dom.toggleClass("on", on);
        }
    };
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


const framesPerSecond = 50;
const targetTimeout = 1000 / framesPerSecond;
var adjustedTimeout = targetTimeout;
var lastFrame = null;
const clocksPerSecond = 2 * 1000 * 1000;
const cyclesPerFrame = clocksPerSecond / framesPerSecond;
const yieldsPerFrame = 1;
const cyclesPerYield = cyclesPerFrame / yieldsPerFrame;

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
