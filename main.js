require(['jquery', 'utils', 'video', 'soundchip', 'debug', '6502', 'cmos', 'sth', 'fdc', 'discs/cat', 'tapes', 'dropbox', 'models', 'basic-tokenise', 'bootstrap', 'jquery-visibility'],
    function ($, utils, Video, SoundChip, Debugger, Cpu6502, Cmos, StairwayToHell, disc, starCat, tapes, DropboxLoader, models, tokeniser) {
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

        var availableImages;
        var discImage;
        if (typeof starCat === 'function') {
            availableImages = starCat();

            if (availableImages && availableImages[0]) {
                discImage = availableImages[0].file;
            }
        }
        var queryString = document.location.search;
        var secondDiscImage = null;
        var parsedQuery = {};
        var needsAutoboot = false;
        var keyLayout = window.localStorage.keyLayout || "physical";

        var BBC = utils.BBC;

        self.gamepadMapping = [BBC.COLON_STAR, BBC.X, BBC.SLASH, BBC.Z,
            BBC.SPACE, BBC.SPACE, BBC.SPACE, BBC.SPACE,
            BBC.SPACE, BBC.SPACE, BBC.SPACE, BBC.SPACE,
            BBC.SPACE, BBC.SPACE, BBC.SPACE, BBC.SPACE];

        // default: "snapper" keys
        self.gamepadAxisMapping = [
            [],
            [],
            [],
            []
        ];

        self.gamepadAxisMapping[0][-1] = BBC.Z;          // left
        self.gamepadAxisMapping[0][1] = BBC.X;          // right
        self.gamepadAxisMapping[1][-1] = BBC.COLON_STAR; // up
        self.gamepadAxisMapping[1][1] = BBC.SLASH;      // down
        self.gamepadAxisMapping[2][-1] = BBC.Z;          // left
        self.gamepadAxisMapping[2][1] = BBC.X;          // right
        self.gamepadAxisMapping[3][-1] = BBC.COLON_STAR; // up
        self.gamepadAxisMapping[3][1] = BBC.SLASH;      // down

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
                    case "LEFT":
                        self.gamepadMapping[3] = BBC[val];
                        self.gamepadAxisMapping[0][-1] = BBC[val];
                        self.gamepadAxisMapping[2][-1] = BBC[val];
                        break;
                    case "RIGHT":
                        self.gamepadMapping[1] = BBC[val];
                        self.gamepadAxisMapping[0][1] = BBC[val];
                        self.gamepadAxisMapping[2][1] = BBC[val];
                        break;
                    case "UP":
                        self.gamepadMapping[0] = BBC[val];
                        self.gamepadAxisMapping[1][-1] = BBC[val];
                        self.gamepadAxisMapping[3][-1] = BBC[val];
                        break;
                    case "DOWN":
                        self.gamepadMapping[2] = BBC[val];
                        self.gamepadAxisMapping[1][1] = BBC[val];
                        self.gamepadAxisMapping[3][1] = BBC[val];
                        break;
                    case "FIRE":
                        for (var i = 0; i < 16; i++) {
                            self.gamepadMapping[i] = BBC[val];
                        }
                        break;
                    case "autoboot":
                        needsAutoboot = "boot";
                        break;
                    case "autochain":
                        needsAutoboot = "chain";
                        break;
                    case "autorun":
                        needsAutoboot = "run";
                        break;
                    case "keyLayout":
                        keyLayout = (val + "").toLowerCase();
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
        function guessModelFromUrl() {
            if (window.location.hostname.indexOf("bbc") === 0) return "B";
            if (window.location.hostname.indexOf("master") === 0) return "Master";
            return "B";
        }

        var model = models.findModel(parsedQuery.model || guessModelFromUrl());

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
            jsAudioNode = context.createScriptProcessor(2048, 0, 1);
            function pumpAudio(event) {
                var outBuffer = event.outputBuffer;
                var chan = outBuffer.getChannelData(0);
                soundChip.render(chan, 0, chan.length);
            }

            jsAudioNode.onaudioprocess = pumpAudio;
            jsAudioNode.connect(context.destination);

            return soundChip;
        })();
        
        var lastShiftLocation = 1;
        var lastCtrlLocation = 1;
        var lastAltLocation = 1;


        dbgr = new Debugger(video);
        function keyCode(evt) {
            var ret = evt.which || evt.charCode || evt.keyCode;

            var keyCodes = utils.keyCodes;

            switch (evt.location) {
            default:
                // keyUp events seem to pass location = 0 (Chrome)
                switch (ret) {
                    case keyCodes.SHIFT:
                        if (lastShiftLocation == 1) {
                            return keyCodes.SHIFT_LEFT;
                        } else {
                            return keyCodes.SHIFT_RIGHT;
                        }

                    case keyCodes.ALT:
                        if (lastAltLocation == 1) {
                            return keyCodes.ALT_LEFT;
                        } else {
                            return keyCodes.ALT_RIGHT;
                        }

                    case keyCodes.CTRL:
                        if (lastCtrlLocation == 1) {
                            return keyCodes.CTRL_LEFT;
                        } else {
                            return keyCodes.CTRL_RIGHT;
                        }
                }
                break;
            case 1:
                switch (ret) {
                    case keyCodes.SHIFT:
                        lastShiftLocation = 1;
                        //console.log("left shift");
                        return keyCodes.SHIFT_LEFT;

                    case keyCodes.ALT:
                        lastAltLocation = 1;
                        //console.log("left alt");
                        return keyCodes.ALT_LEFT;

                    case keyCodes.CTRL:
                        lastCtrlLocation = 1;
                        //console.log("left ctrl");
                        return keyCodes.CTRL_LEFT;
                }
                break;
            case 2:
                switch (ret) {
                    case keyCodes.SHIFT:
                        lastShiftLocation = 2;
                        //console.log("right shift");
                        return keyCodes.SHIFT_RIGHT;

                    case keyCodes.ALT:
                        lastAltLocation = 2;
                        //console.log("right alt");
                        return keyCodes.ALT_RIGHT;

                    case keyCodes.CTRL:
                        lastCtrlLocation = 2;
                        //console.log("right ctrl");
                        return keyCodes.CTRL_RIGHT;
                }
                break;
            case 3: // numpad
                switch (ret) {
                    case keyCodes.ENTER:
                        console.log("numpad enter");
                        return utils.keyCodes.NUMPADENTER;

                    case keyCodes.DELETE:
                        console.log("numpad dot");
                        return utils.keyCodes.NUMPAD_DECIMAL_POINT;
                }
                break;
            }

            return ret;
        }

        function keyPress(evt) {
            if (running || !dbgr.enabled()) return;
            if (keyCode(evt) === 103 /* lower case g */) {
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
            if (code === utils.keyCodes.HOME && evt.ctrlKey) {
                utils.noteEvent('keyboard', 'press', 'home');
                stop(true);
            } else if (code == utils.keyCodes.F12 || code == utils.keyCodes.BREAK) {
                utils.noteEvent('keyboard', 'press', 'break');
                processor.reset(false);
                evt.preventDefault();
            } else {
                processor.sysvia.keyDown(keyCode(evt), evt.shiftKey);
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

        var cmos = new Cmos({
            load: function () {
                if (window.localStorage.cmosRam) {
                    return JSON.parse(window.localStorage.cmosRam);
                }
                return null;
            },
            save: function (data) {
                window.localStorage.cmosRam = JSON.stringify(data);
            }
        });
        var emulationConfig = {keyLayout: keyLayout};
        processor = new Cpu6502(model, dbgr, video, soundChip, cmos, emulationConfig);

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
            if (type == 'discs') {
                discSth.populate();
            } else if (type == 'tapes') {
                tapeSth.populate();
            } else {
                console.log("unknown id", type);
            }
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

        var keysToSend;
        var lastChar;

        function sendNextChar() {
            if (lastChar && lastChar != utils.BBC.SHIFT) {
                processor.sysvia.keyToggleRaw(lastChar);
            }

            if (keysToSend.length === 0) {
                // Finished
                processor.sysvia.enableKeyboard();
                return;
            }

            var ch = keysToSend[0];
            var debounce = lastChar === ch;
            lastChar = ch;
            if (debounce) {
                lastChar = undefined;
                setTimeout(sendNextChar, 20);
                return;
            }

            var time = 70;
            if (typeof lastChar === "number") {
                time = lastChar;
                lastChar = undefined;
            } else {
                processor.sysvia.keyToggleRaw(lastChar);
            }

            // remove first character
            keysToSend.shift();

            setTimeout(sendNextChar, time);
        }

        function sendRawKeyboardToBBC() {
            keysToSend = Array.prototype.slice.call(arguments, 0);
            lastChar = undefined;
            processor.sysvia.disableKeyboard();
            sendNextChar();
        }

        function autoboot(image) {
            var BBC = utils.BBC;

            console.log("Autobooting disc");
            utils.noteEvent('init', 'autoboot', image);

            sendRawKeyboardToBBC(0,
                // Shift on power-on -> run !Boot from the disc
                BBC.SHIFT,
                1000 // pause in ms
            );
        }

        function autoChainTape() {
            var BBC = utils.BBC;

            console.log("Auto Chaining Tape");
            utils.noteEvent('init', 'autochain');

            sendRawKeyboardToBBC(1000,
                // *TAPE
                // CH.""
                BBC.SHIFT,
                BBC.COLON_STAR,
                BBC.SHIFT,
                BBC.T,
                BBC.A,
                BBC.P,
                BBC.E,
                BBC.RETURN,
                BBC.C,
                BBC.H,
                BBC.PERIOD,
                BBC.SHIFT,
                BBC.K2,
                BBC.K2,
                BBC.SHIFT,
                BBC.RETURN
            );
        }

        function autoRunTape() {

            var BBC = utils.BBC;

            console.log("Auto Running Tape");
            utils.noteEvent('init', 'autorun');

            sendRawKeyboardToBBC(1000,
                // *TAPE
                // */
                BBC.SHIFT,
                BBC.COLON_STAR,
                BBC.SHIFT,
                BBC.T,
                BBC.A,
                BBC.P,
                BBC.E,
                BBC.RETURN,
                BBC.SHIFT,
                BBC.COLON_STAR,
                BBC.SHIFT,
                BBC.SLASH,
                BBC.RETURN
            );
        }

        if (parsedQuery.dbEnabled) {
            $('.hidden-unless-db-enabled').show();
        }

        if (parsedQuery.patch) {
            dbgr.setPatch(parsedQuery.patch);
        }

        if (parsedQuery.loadBasic) {
            var prog = String.fromCharCode.apply(null, utils.loadData(parsedQuery.loadBasic));
            var tokenised = tokeniser.tokenise(prog);
            var page = parsedQuery.page ? utils.parseAddr(parsedQuery.page) : 0x1900;
            // Load the program immediately after the \xff of the "no program" has been
            // written to PAGE+1
            processor.debugwrite = function (addr, b) {
                if (addr === (page + 1) && b == 0xff) {
                    // Needed as the debug happens before the write takes place.
                    processor.debugInstruction = function () {
                        for (var i = 0; i < tokenised.length; ++i) {
                            processor.writemem(page + i, tokenised.charCodeAt(i));
                        }
                        processor.debugInstruction = null;
                    };
                    processor.debugwrite = null;
                }
            };
        }

        switch (needsAutoboot) {
            case "boot":
                autoboot(discImage);
                break;
            case "chain":
                autoChainTape();
                break;
            case "run":
                autoRunTape();
                break;
        }

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
                    processor.fdc.loadDisc(drive, disc.localDisc(processor.fdc, discImage));
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
                processor.fdc.loadDiscData(0, disc.ssdLoad("discs/" + image.file));
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

        $('#model-menu a').on("click", function (e) {
            parsedQuery.model = $(e.target).attr("data-target");

            console.log(parsedQuery.model);

            if (parsedQuery.model === "soft-reset") {
                processor.reset(false);
            } else if (parsedQuery.model === "hard-reset") {
                processor.reset(true);
            } else {
                updateUrl();
                areYouSure("Changing model requires a restart of the emulator. Restart now?", "Yes, restart now", "No, thanks", function () {
                    window.location.reload();
                });
            }
        });
        $("#bbc-model").text(model.name);

        $('#keyboard-menu a').on("click", function (e) {
            var type = $(e.target).attr("data-target");
            window.localStorage.keyLayout = type;
            parsedQuery.keyLayout = type;
            updateUrl();
            emulationConfig.keyLayout = type;
            processor.updateKeyLayout();
        });

        $('#tape-menu a').on("click", function (e) {
            var type = $(e.target).attr("data-id");

            if (type == "rewind") {
                console.log("Rewinding tape to the start");

                processor.acia.rewindTape();

            } else {
                console.log("unknown type", type);
            }
        });

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

        function areYouSure(message, yesText, noText, yesFunc) {
            var ays = $('#are-you-sure');
            ays.find(".context").text(message);
            ays.find(".ays-yes").text(yesText);
            ays.find(".ays-no").text(noText);
            ays.find(".ays-yes").one("click", function () {
                ays.modal("hide");
                yesFunc();
            });
            ays.modal("show");
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
                if (running) {
                    setTimeout(runner, 0);

                    // init gamepad
                    // gamepad not necessarily available until a button press
                    // so need to check gamepads[0] continuously
                    if (navigator.getGamepads && !self.gamepad0) {
                        var gamepads = navigator.getGamepads();
                        self.gamepad0 = gamepads[0];

                        if (self.gamepad0) {

                            console.log("initing gamepad");

                            var BBC = utils.BBC;

                            // 16 buttons
                            self.gamepadButtons = [false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false];

                            // two joysticks (so 4 axes)
                            self.gamepadAxes = [0, 0, 0, 0];


                        }


                    }

                    // process gamepad buttons
                    if (self.gamepad0) {

                        // these two lines needed in Chrome to update state, not Firefox
                        // TODO: what about IE? (can't get Gamepads to work in IE11/IE12. Mike)
                        if (!utils.isFirefox()) {
                            self.gamepad0 = navigator.getGamepads()[0];
                        }

                        //console.log(self.gamepad0.axes);

                        for (var i = 0; i < 4; i++) {

                            var axisRaw = self.gamepad0.axes[i];
                            var axis;

                            // Mike's XBox 360 controller, zero positions
                            // console.log(i, axisRaw, axis);
                            //0 -0.03456169366836548 -1
                            //1 -0.037033677101135254 -1
                            //2 0.055374979972839355 1
                            //3 0.06575113534927368 1
                            var threshold = 0.1;
                            
                            // normalize to -1, 0, 1
                            if (axisRaw < -threshold) {
                                axis = -1;
                            } else if (axisRaw > threshold) {
                                axis = 1;
                            } else {
                                axis = 0;
                            }

                            if (axis !== self.gamepadAxes[i]) {

                                // tricky because transition can be
                                // -1 to 0
                                // -1 to 1
                                // 0 to 1
                                // 0 to -1
                                // 1 to 0
                                // 1 to -1
                                var oldKey = self.gamepadAxisMapping[i][self.gamepadAxes[i]];
                                if (oldKey) {
                                    processor.sysvia.keyUpRaw(oldKey);
                                }

                                var newKey = self.gamepadAxisMapping[i][axis];
                                if (newKey) {
                                    processor.sysvia.keyDownRaw(newKey);
                                }

                            }

                            // store new state
                            self.gamepadAxes[i] = axis;

                        }

                        for (i = 0; i < 16; i++) {
                            if (self.gamepad0.buttons[i]) {
                                var button = self.gamepad0.buttons[i];

                                if (button.pressed) {
                                    console.log("gamepad button pressed ", i, self.gamepad0.id);
                                }

                                if (button.pressed !== self.gamepadButtons[i]) {
                                    // different to last time

                                    if (button.pressed) {
                                        processor.sysvia.keyDownRaw(self.gamepadMapping[i]);
                                    } else {
                                        processor.sysvia.keyUpRaw(self.gamepadMapping[i]);
                                    }
                                }

                                // store new state
                                self.gamepadButtons[i] = button.pressed;

                            }

                        }

                    }
                }
            };
            runner();
        }

        var wasPreviouslyRunning = false;
        $(document).on(
            {
                "hide.visibility": function () {
                    wasPreviouslyRunning = running;
                    if (running && !processor.acia.motorOn) {
                        stop(false);
                    }
                },
                "show.visibility": function () {
                    if (wasPreviouslyRunning) {
                        go();
                    }
                }
            }
        );

        function go() {
            soundChip.unmute();
            running = true;
            run();
        }

        function stop(debug) {
            running = false;
            processor.stop();
            if (debug) dbgr.debug(processor.pc);
            soundChip.mute();
        }

        // Handy shortcuts. bench/profile stuff is delayed so that they can be
        // safely run from the JS console in firefox.
        window.benchmarkCpu = _.debounce(benchmarkCpu, 1);
        window.profileCpu = _.debounce(profileCpu, 1);
        window.benchmarkVideo = _.debounce(benchmarkVideo, 1);
        window.profileVideo = _.debounce(profileVideo, 1);
        window.go = go;
        window.stop = stop;
        window.soundChip = soundChip;
        window.processor = processor;
        window.video = video;
        window.hd = function (start, end) {
            console.log(utils.hd(function (x) {
                return processor.readmem(x);
            }, start, end));
        };
        window.m7dump = function() {
            console.log(utils.hd(function (x) {
                return processor.readmem(x) & 0x7f;
            }, 0x7c00, 0x7fe8, { width: 40, gap: false }));
        };
    }
);
