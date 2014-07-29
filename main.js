require(['jquery', 'utils', 'video', 'soundchip', 'debug', '6502', 'cmos', 'sth', 'fdc', 'discs/cat', 'tapes', 'dropbox', 'bootstrap'],
    function ($, utils, Video, SoundChip, Debugger, Cpu6502, Cmos, StairwayToHell, disc, starCat, tapes, DropboxLoader) {
        "use strict";
        var processor;
        var video;
        var soundChip;
        var dbgr;
        var jsAudioNode;  // has to remain to keep thing alive
        var frames = 0;
        var frameSkip = 0;
        var syncLights;
        var discSth;
        var tapeSth;
        var dropbox;
        var running;

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
            queryString.split("&").forEach(function (keyval) {
                var keyAndVal = keyval.split("=");
                var key = decodeURIComponent(keyAndVal[0]);
                var val = null;
                if (keyAndVal.length > 1) val = decodeURIComponent(keyAndVal[1]);
                parsedQuery[key] = val;
                switch (key) {
                    case "autoboot":
                        needsAutoboot = true;
                        break;
                    case "disc":
                    case "disc1":
                        discImage = val;
                        break;
                    case "disc2":
                        secondDiscImage = val;
                        break;
                }
            });
        }
        var model = parsedQuery.model || 'B';

        var framesPerSecond = 50;
        var targetTimeout = 1000 / framesPerSecond;
        var adjustedTimeout = targetTimeout;
        var lastFrame = null;
        var clocksPerSecond = 2 * 1000 * 1000;
        var cyclesPerFrame = clocksPerSecond / framesPerSecond;
        var yieldsPerFrame = 1;
        var cyclesPerYield = cyclesPerFrame / yieldsPerFrame;

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

        soundChip = (function () {
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

            var toneGenerator = context.createOscillator();
            toneGenerator.type = "sine";
            var gainNode = context.createGain();
            toneGenerator.connect(gainNode);
            toneGenerator.frequency.value = 2400;
            gainNode.connect(context.destination);
            gainNode.gain.value = 0;
            toneGenerator.start(0);
            // TODO - this is not a good way to get proper sound. I'll need to bite the
            // bullet and actually generate the wave myself; else it's really trick to get all
            // the transitions in. Should probably trick out the soundChip to do this.
            soundChip.toneGenerator = {
                mute: function () {
                    gainNode.gain.value = 0;
                },
                tone: function (freq) {
                    toneGenerator.frequency.setValueAtTime(freq, context.currentTime);
                    gainNode.gain.value = 0.5;
                }
            };

            return soundChip;
        })();

        dbgr = new Debugger(video);
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
            var handled = dbgr.keyPress(keyCode(evt));
            if (handled) evt.preventDefault();
        }

        function keyDown(evt) {
            if (!running) return;
            var code = keyCode(evt);
            if (code === 36) {  // home
                utils.noteEvent('keyboard', 'press', 'home');
                stop(true);
            } else if (code == 123) { // F12
                utils.noteEvent('keyboard', 'press', 'break');
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

        var cmos = new Cmos(); // TODO persistence model
        processor = new Cpu6502(model, dbgr, video, soundChip, cmos);

        function sthClearList() {
            $("#sth-list li:not('.template')").remove();
        }

        function sthStartLoad() {
            $("#sth .loading").text("Loading catalog from STH archive");
            $("#sth .loading").show();
            sthClearList();
        }

        function discSthClick(item) {
            utils.noteEvent('sth', 'click', item);
            parsedQuery.disc = "|" + item;
            updateUrl();
            loadDiscImage(0, parsedQuery.disc);
        }

        function tapeSthClick(item) {
            utils.noteEvent('sth', 'clickTape', item);
            parsedQuery.tape = "|" + item;
            updateUrl();
            loadTapeImage(parsedQuery.tape);
        }

        function makeOnCat(onClick) {
            return function (cat) {
                sthClearList();
                var sthList = $("#sth-list");
                $("#sth .loading").hide();
                var template = sthList.find(".template");

                function doSome(all) {
                    var MaxAtATime = 100;
                    var Delay = 30;
                    var cat = all.slice(0, MaxAtATime);
                    var remaining = all.slice(MaxAtATime);
                    var filter = $('#sth-filter').val();
                    $.each(cat, function (_, cat) {
                        var row = template.clone().removeClass("template").appendTo(sthList);
                        row.find(".name").text(cat);
                        $(row).on("click", function () {
                            onClick(cat);
                            $('#sth').modal("hide");
                        });
                        row.toggle(cat.toLowerCase().indexOf(filter) >= 0);
                    });
                    if (all.length) _.delay(doSome, Delay, remaining);
                }

                console.log("Found", cat.length, "STH entries");
                doSome(cat);
            };
        }

        function sthOnError() {
            $('#sth .loading').text("There was an error accessing the STH archive");
            $("#sth .loading").show();
            sthClearList();
        }

        discSth = new StairwayToHell(sthStartLoad, makeOnCat(discSthClick), sthOnError, false);
        tapeSth = new StairwayToHell(sthStartLoad, makeOnCat(tapeSthClick), sthOnError, true);

        $(document).on("click", "a.sth", function () {
            var type = $(this).data('id');
            if (type == 'discs')
                discSth.populate();
            else
                tapeSth.populate();
        });

        function setSthFilter(filter) {
            filter = filter.toLowerCase();
            $("#sth-list li:not('.template')").each(function () {
                var el = $(this);
                el.toggle(el.text().toLowerCase().indexOf(filter) >= 0);
            });
        }

        $('#sth-filter').on("change keyup", function () {
            setSthFilter($('#sth-filter').val());
        });

        function autoboot(image) {
            console.log("Autobooting");
            utils.noteEvent('init', 'autoboot', image);
            processor.sysvia.keyDown(16);
            setTimeout(function () {
                // defer...so we only start counting once we've run a bit...
                setTimeout(function () {
                    processor.sysvia.keyUp(16);
                }, 5000);
            }, 0);
        }

        if (parsedQuery.dbEnabled) {
            $('.hidden-unless-db-enabled').show();
        }

        if (parsedQuery.patch) {
            dbgr.setPatch(parsedQuery.patch);
        }

        if (needsAutoboot) autoboot(discImage);
        function updateUrl() {
            var url = window.location.origin + window.location.pathname;
            var sep = '?';
            $.each(parsedQuery, function (key, value) {
                url += sep + encodeURIComponent(key);
                if (value) url += "=" + encodeURIComponent(value);
                sep = '&';
            });
            window.history.pushState(null, null, url);
        }

        function showError(context, error) {
            var dialog = $('#error-dialog');
            dialog.find(".context").text(context);
            dialog.find(".error").text(error);
            dialog.modal();
        }

        function loadDiscImage(drive, discImage) {
            if (!discImage) return;
            var context = "built-in image";
            try {
                if (discImage[0] == "!") {
                    discImage = discImage.substr(1);
                    context = "Local disc";
                    processor.fdc.loadDisc(drive, localDisc(processor.fdc, discImage));
                } else if (discImage[0] == "|") {
                    discImage = discImage.substr(1);
                    context = "Stairway to Hell";
                    processor.fdc.loadDiscData(drive, discSth.fetch(discImage));
                } else if (discImage[0] == "^") {
                    discImage = discImage.substr(1);
                    context = "Dropbox";
                    _.defer(function () {
                        popupLoading("Connecting to Dropbox");
                        var db = new DropboxLoader(function () {
                            dropboxLoad(db, discImage);
                        }, function (error) {
                            loadingFinished(error);
                        });
                    });
                } else {
                    processor.fdc.loadDiscData(drive, disc.ssdLoad("discs/" + discImage));
                }
            } catch (e) {
                showError("while loading disc '" + discImage + "' from " + context + " into drive " + drive, e);
            }
        }

        if (discImage) loadDiscImage(0, discImage);
        if (secondDiscImage) loadDiscImage(1, secondDiscImage);

        function loadTapeImage(tapeImage) {
            var context = "built-in";
            try {
                if (tapeImage[0] == '|') {
                    tapeImage = tapeImage.substr(1);
                    context = "Stairway To Hell";
                    processor.acia.setTape(tapes.loadTapeFromData(tapeSth.fetch(tapeImage)));
                } else {
                    processor.acia.setTape(tapes.loadTape(tapeImage));
                }
            } catch (e) {
                showError("while loading tape '" + tapeImage + " from " + context, e);
            }
        }

        if (parsedQuery.tape) loadTapeImage(parsedQuery.tape);

        $('#disc_load').change(function (evt) {
            var file = evt.target.files[0];
            var reader = new FileReader();
            utils.noteEvent('local', 'click'); // NB no filename here
            reader.onload = function (e) {
                processor.fdc.loadDiscData(0, e.target.result);
                delete parsedQuery.disc;
                updateUrl();
                $('#discs').modal("hide");
            };
            reader.readAsBinaryString(file);
        });

        $('#tape_load').change(function (evt) {
            var file = evt.target.files[0];
            var reader = new FileReader();
            utils.noteEvent('local', 'clickTape'); // NB no filename here
            reader.onload = function (e) {
                processor.acia.setTape(tapes.loadTapeFromData(e.target.result));
                delete parsedQuery.tape;
                updateUrl();
                $('#tapes').modal("hide");
            };
            reader.readAsBinaryString(file);
        });

        function anyModalsVisible() {
            return $(".modal:visible").length !== 0;
        }

        var modalSavedRunning = false;
        $('.modal').on('show.bs.modal', function () {
            if (!anyModalsVisible()) modalSavedRunning = running;
            if (running) stop(false);
        });
        $('.modal').on('hidden.bs.modal', function () {
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
                setTimeout(function () {
                    modal.modal("hide");
                }, 2000);
            } else {
                modal.modal("hide");
            }
        }

        function dropboxLoad(dropbox, cat, create) {
            utils.noteEvent('dropbox', 'click', cat);
            parsedQuery.disc = "^" + cat;
            updateUrl();
            if (create)
                popupLoading("Creating '" + cat + "' on Dropbox");
            else
                popupLoading("Loading '" + cat + "' from Dropbox");
            dropbox.load(processor.fdc, cat, 0, function (error) {
                loadingFinished(error);
            });
        }

        var dropboxModal = $('#dropbox');
        dropboxModal.on('show.bs.modal', function () {
            dropboxModal.find(".loading").text("Loading...").show();
            dropboxModal.find("li").not(".template").remove();
            dropbox = new DropboxLoader(function (cat) {
                var dbList = $("#dropbox-list");
                $("#dropbox .loading").hide();
                var template = dbList.find(".template");
                $.each(cat, function (_, cat) {
                    var row = template.clone().removeClass("template").appendTo(dbList);
                    row.find(".name").text(cat);
                    $(row).on("click", function () {
                        dropboxLoad(dropbox, cat);
                        dropboxModal.modal("hide");
                    });
                });
            }, function (error) {
                $('#dropbox .loading').text("There was an error accessing your Dropbox account: " + error);
            });
        });
        var discList = $('#disc-list');
        var template = discList.find(".template");
        $.each(availableImages, function (i, image) {
            var elem = template.clone().removeClass("template").appendTo(discList);
            elem.find(".name").text(image.name);
            elem.find(".description").text(image.desc);
            $(elem).on("click", function () {
                utils.noteEvent('images', 'click', image.file);
                processor.fdc.loadDiscData(0, disc.ssdLoad("/discs/" + image.file));
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
            var db = new DropboxLoader(function () {
                dropboxLoad(db, text, true);
            }, function (error) {
                loadingFinished(error);
            });
            return false;
        }

        $("#dropbox form").on("submit", dbCreate);

        function Light(name) {
            var dom = $("#" + name);
            var on = false;
            this.update = function (val) {
                if (val === on) return;
                on = val;
                dom.toggleClass("on", on);
            };
        }

        var cassette = new Light("motorlight");
        var caps = new Light("capslight");
        var shift = new Light("shiftlight");
        var drive0 = new Light("drive0");
        var drive1 = new Light("drive1");
        syncLights = function () {
            caps.update(processor.sysvia.capsLockLight);
            shift.update(processor.sysvia.shiftLockLight);
            drive0.update(processor.fdc.motorOn[0]);
            drive1.update(processor.fdc.motorOn[1]);
            cassette.update(processor.acia.motorOn);
        };

//        processor.debugInstruction = function (addr) {
//            return addr == 0x8003;
//        };
        go();

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

        function benchmarkCpu(numCycles) {
            numCycles = numCycles || 10 * 1000 * 1000;
            var oldFS = frameSkip;
            frameSkip = 1000000;
            var startTime = Date.now();
            processor.execute(numCycles);
            var endTime = Date.now();
            frameSkip = oldFS;
            var msTaken = endTime - startTime;
            var virtualMhz = (numCycles / msTaken) / 1000;
            console.log("Took " + msTaken + "ms to execute " + numCycles + " cycles");
            console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
        }

        function benchmarkVideo(numCycles) {
            numCycles = numCycles || 10 * 1000 * 1000;
            var oldFS = frameSkip;
            frameSkip = 1000000;
            var startTime = Date.now();
            video.polltime(numCycles);
            var endTime = Date.now();
            frameSkip = oldFS;
            var msTaken = endTime - startTime;
            var virtualMhz = (numCycles / msTaken) / 1000;
            console.log("Took " + msTaken + "ms to execute " + numCycles + " video cycles");
            console.log("Virtual " + virtualMhz.toFixed(2) + "MHz");
        }

        function profileCpu(arg) {
            console.profile("CPU");
            benchmarkCpu(arg);
            console.profileEnd();
        }

        function profileVideo(arg) {
            console.profile("Video");
            benchmarkVideo(arg);
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
            var runner = function () {
                if (!running) return;
                if (count++ == yieldsPerFrame) {
                    syncLights();
                    return;
                }
                try {
                    if (!processor.execute(cyclesPerYield)) {
                        stop(true);
                        return;
                    }
                } catch (e) {
                    running = false;
                    utils.noteEvent('exception', 'thrown', e.stack);
                    dbgr.debug(processor.pc);
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

        // Handy shortcuts. bench/profile stuff is delayed so that they can be
        // safely run from the JS console in firefox.
        window.benchmarkCpu = _.debounce(benchmarkCpu, 1);
        window.profileCpu = _.debounce(profileCpu, 1);
        window.benchmarkVideo = _.debounce(benchmarkVideo, 1);
        window.profileVideo = _.debounce(profileVideo, 1);
        window.go = go;
        window.stop = stop;
        window.processor = processor;
        window.video = video;
    }
);
