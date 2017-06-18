require(['jquery', 'utils', 'video', 'soundchip', 'ddnoise', 'debug', '6502', 'cmos', 'sth', 'gamepads', 'fdc', 'discs/cat', 'tapes', 'google-drive', 'models', 'basic-tokenise',
        'canvas', 'promise', 'bootstrap', 'jquery-visibility'],
    function ($, utils, Video, SoundChip, DdNoise, Debugger, Cpu6502, Cmos, StairwayToHell, Gamepads, disc,
              starCat, tapes, GoogleDriveLoader, models, tokeniser, canvasLib) {
        "use strict";

        var processor;
        var video;
        var soundChip;
        var ddNoise;
        var dbgr;
        var frames = 0;
        var frameSkip = 0;
        var syncLights;
        var discSth;
        var tapeSth;
        var running;
        var gamepad = new Gamepads();

        var availableImages;
        var discImage;
        var extraRoms = [];
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
        var keyCodes = utils.keyCodes;
        var cpuMultiplier = 1;

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

                // eg KEY.CAPSLOCK=CTRL
                var bbcKey;
                if (key.toUpperCase().indexOf("KEY.") === 0) {
                    bbcKey = val.toUpperCase();

                    if (BBC[bbcKey]) {
                        var nativeKey = key.substring(4).toUpperCase(); // remove KEY.
                        if (keyCodes[nativeKey]) {
                            console.log("mapping " + nativeKey + " to " + bbcKey);
                            utils.userKeymap.push({native: nativeKey, bbc: bbcKey});
                        } else {
                            console.log("unknown key: " + nativeKey);
                        }
                    } else {
                        console.log("unknown BBC key: " + val);
                    }
                } else if (key.indexOf("GP.") === 0) {
                    // gamepad mapping
                    // eg ?GP.FIRE2=RETURN
                    var gamepadKey = key.substring(3).toUpperCase(); // remove GP. prefix
                    gamepad.remap(gamepadKey, val.toUpperCase());
                } else {
                    switch (key) {
                        case "LEFT":
                        case "RIGHT":
                        case "UP":
                        case "DOWN":
                        case "FIRE":
                            gamepad.remap(key, val.toUpperCase());
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
                        case "rom":
                            extraRoms.push(val);
                            break;
                        case "disc2":
                            secondDiscImage = val;
                            break;
                        case "embed":
                            $(".embed-hide").hide();
                            $("#about").append(" jsbeeb");
                            break;
                    }
                }
            });
        }
        function guessModelFromUrl() {
            if (window.location.hostname.indexOf("bbc") === 0) return "B";
            if (window.location.hostname.indexOf("master") === 0) return "Master";
            return "B";
        }

        var model = models.findModel(parsedQuery.model || guessModelFromUrl());

        function sbBind(div, url, onload) {
            if (!url) return;
            var img = div.find("img");
            img.attr("src", url).bind("load", function () {
                onload(div, img);
                img.show();
            }).hide();
        }

        sbBind($(".sidebar.left"), parsedQuery.sbLeft, function (div, img) {
            div.css({left: -img.width() - 5});
        });
        sbBind($(".sidebar.right"), parsedQuery.sbRight, function (div, img) {
            div.css({right: -img.width() - 5});
        });
        sbBind($(".sidebar.bottom"), parsedQuery.sbBottom, function (div, img) {
            div.css({bottom: -img.height()});
        });

        if (parsedQuery.cpuMultiplier) {
            cpuMultiplier = parseFloat(parsedQuery.cpuMultiplier);
            console.log("CPU multiplier set to " + cpuMultiplier);
        }
        var clocksPerSecond = (cpuMultiplier * 2 * 1000 * 1000) | 0;
        var MaxCyclesPerFrame = clocksPerSecond / 10;

        var tryGl = true;
        if (parsedQuery.glEnabled !== undefined) {
            tryGl = parsedQuery.glEnabled === "true";
        }
        var canvas = tryGl ? canvasLib.bestCanvas($('#screen')[0]) : new canvasLib.Canvas($('#screen')[0]);
        video = new Video.Video(canvas.fb32, function paint(minx, miny, maxx, maxy) {
            frames++;
            if (frames < frameSkip) return;
            frames = 0;
            canvas.paint(minx, miny, maxx, maxy);
        });

        var audioContext = typeof AudioContext !== 'undefined' ? new AudioContext()
            : typeof webkitAudioContext !== 'undefined'? new webkitAudioContext()
            : null;

        if (audioContext) {
            soundChip = new SoundChip.SoundChip(audioContext.sampleRate);
            // NB must be assigned to some kind of object else it seems to get GC'd by
            // Safari...
            soundChip.jsAudioNode = audioContext.createScriptProcessor(2048, 0, 1);
            soundChip.jsAudioNode.onaudioprocess = function pumpAudio(event) {
                var outBuffer = event.outputBuffer;
                var chan = outBuffer.getChannelData(0);
                soundChip.render(chan, 0, chan.length);
            };
            soundChip.jsAudioNode.connect(audioContext.destination);
            ddNoise = new DdNoise.DdNoise(audioContext);
        } else {
            soundChip = new SoundChip.FakeSoundChip();
            ddNoise = new DdNoise.FakeDdNoise();
        }

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
                            break;

                        case keyCodes.ALT:
                            if (lastAltLocation == 1) {
                                return keyCodes.ALT_LEFT;
                            } else {
                                return keyCodes.ALT_RIGHT;
                            }
                            break;

                        case keyCodes.CTRL:
                            if (lastCtrlLocation == 1) {
                                return keyCodes.CTRL_LEFT;
                            } else {
                                return keyCodes.CTRL_RIGHT;
                            }
                            break;
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
                processor.setReset(true);
                evt.preventDefault();
            } else {
                processor.sysvia.keyDown(keyCode(evt), evt.shiftKey);
                evt.preventDefault();
            }
        }

        function keyUp(evt) {
            // Always let the key ups come through. That way we don't cause sticky keys in the debugger.
            var code = keyCode(evt);
            processor.sysvia.keyUp(code);
            if (!running) return;
            if (code == utils.keyCodes.F12 || code == utils.keyCodes.BREAK) {
                processor.setReset(false);
            }
            evt.preventDefault();
        }

        $(window).blur(function () {
            processor.sysvia.clearKeys();
        });
        document.onkeydown = keyDown;
        document.onkeypress = keyPress;
        document.onkeyup = keyUp;

        window.onbeforeunload = function () {
            if (running && processor.sysvia.hasAnyKeyDown()) {
                return "It seems like you're still using the emulator. If you're in Chrome, it's impossible for jsbeeb to prevent some shortcuts (like ctrl-W) from performing their default behaviour (e.g. closing the window).\n" +
                    "As a workarond, create an 'Application Shortcut' from the Tools menu.  When jsbeeb runs as an application, it *can* prevent ctrl-W from closing the window.";
            }
        };

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
        var emulationConfig = {
            keyLayout: keyLayout,
            cpuMultiplier: cpuMultiplier,
            videoCyclesBatch: parsedQuery.videoCyclesBatch,
            extraRoms: extraRoms
        };
        processor = new Cpu6502(model, dbgr, video, soundChip, ddNoise, cmos, emulationConfig);

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
            parsedQuery.disc = "sth:" + item;
            updateUrl();
            var needsAutoboot = parsedQuery.autoboot !== undefined;
            if (needsAutoboot) {
                processor.reset(true);
            }
            popupLoading("Loading " + item);
            loadDiscImage(parsedQuery.disc).then(function (disc) {
                processor.fdc.loadDisc(0, disc);
            }).then(
                function () {
                    loadingFinished();
                    if (needsAutoboot) {
                        autoboot(item);
                    }
                },
                function (err) {
                    loadingFinished(err);
                });
        }

        function tapeSthClick(item) {
            utils.noteEvent('sth', 'clickTape', item);
            parsedQuery.tape = "sth:" + item;
            updateUrl();
            popupLoading("Loading " + item);
            loadTapeImage(parsedQuery.tape).then(
                function () {
                    loadingFinished();
                },
                function (err) {
                    loadingFinished(err);
                });
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

        $('#sth .autoboot').click(function () {
            if ($('#sth .autoboot').prop('checked')) {
                parsedQuery.autoboot = "";
            } else {
                delete parsedQuery.autoboot;
            }
            updateUrl();
        });

        $(document).on("click", "a.sth", function () {
            var type = $(this).data('id');
            if (type === 'discs') {
                discSth.populate();
            } else if (type === 'tapes') {
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

        function sendRawKeyboardToBBC() {
            var keysToSend = Array.prototype.slice.call(arguments, 0);
            var lastChar;
            var nextKeyMillis = 0;
            processor.sysvia.disableKeyboard();

            var sendCharHook = processor.debugInstruction.add(function nextCharHook() {
                var millis = processor.cycleSeconds * 1000 + processor.currentCycles / (clocksPerSecond / 1000);
                if (millis < nextKeyMillis) {
                    return;
                }

                if (lastChar && lastChar != utils.BBC.SHIFT) {
                    processor.sysvia.keyToggleRaw(lastChar);
                }

                if (keysToSend.length === 0) {
                    // Finished
                    processor.sysvia.enableKeyboard();
                    sendCharHook.remove();
                    return;
                }

                var ch = keysToSend[0];
                var debounce = lastChar === ch;
                lastChar = ch;
                var clocksPerMilli = clocksPerSecond / 1000;
                if (debounce) {
                    lastChar = undefined;
                    nextKeyMillis = millis + 30;
                    return;
                }

                var time = 50;
                if (typeof lastChar === "number") {
                    time = lastChar;
                    lastChar = undefined;
                } else {
                    processor.sysvia.keyToggleRaw(lastChar);
                }

                // remove first character
                keysToSend.shift();

                nextKeyMillis = millis + time;
            });
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

        function autoRunBasic() {
            var BBC = utils.BBC;

            console.log("Auto Running basic");
            utils.noteEvent('init', 'autorunbasic');

            sendRawKeyboardToBBC(1000,
                // RUN
                BBC.R,
                BBC.U,
                BBC.N,
                BBC.RETURN
            );
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

        function splitImage(image) {
            var match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
            var schema = match[2] || match[1] || "";
            image = match[3];
            return {image: image, schema: schema};
        }

        function loadDiscImage(discImage) {
            if (!discImage) return Promise.resolve(null);
            var split = splitImage(discImage);
            discImage = split.image;
            var schema = split.schema;
            if (schema[0] === "!" || schema === "local") {
                return Promise.resolve(disc.localDisc(processor.fdc, discImage));
            }
            if (schema === "|" || schema === "sth") {
                return discSth.fetch(discImage).then(function (discData) {
                    return disc.discFor(processor.fdc, false, discData);
                });
            }
            if (schema === "gd") {
                var splat = discImage.match(/([^/]+)\/?(.*)/);
                var title = "(unknown)";
                if (splat) {
                    discImage = splat[1];
                    title = splat[2];
                }
                return gdLoad({title: title, id: discImage});
            }
            if (schema === "http" || schema === "https") {
                return utils.loadData(schema + "://" + discImage).then(function (discData) {
                    if (/\.zip/i.test(discImage)) {
                        var unzipped = utils.unzipDiscImage(discData);
                        discData = unzipped.data;
                        discImage = unzipped.name;
                    }
                    return disc.discFor(processor.fdc, /\.dsd$/i.test(discImage), discData);
                });
            }

            return disc.load("discs/" + discImage).then(function (discData) {
                return disc.discFor(processor.fdc, /\.dsd$/i.test(discImage), discData);
            });
        }

        function loadTapeImage(tapeImage) {
            var split = splitImage(tapeImage);
            tapeImage = split.image;
            var schema = split.schema;

            if (schema === '|' || schema === "sth") {
                return tapeSth.fetch(tapeImage).then(function (image) {
                    processor.acia.setTape(tapes.loadTapeFromData(tapeImage, image));
                });
            }

            if (schema === "http" || schema === "https") {
                return utils.loadData(schema + "://" + tapeImage).then(function (tapeData) {
                    if (/\.zip/i.test(tapeImage)) {
                        var unzipped = utils.unzipDiscImage(tapeData);
                        tapeData = unzipped.data;
                        tapeImage = unzipped.name;
                    }
                    processor.acia.setTape(tapes.loadTapeFromData(tapeImage, tapeData));
                });
            }

            return tapes.loadTape("tapes/" + tapeImage).then(function (tape) {
                processor.acia.setTape(tape);
            });
        }

        $('#disc_load').change(function (evt) {
            var file = evt.target.files[0];
            var reader = new FileReader();
            utils.noteEvent('local', 'click'); // NB no filename here
            reader.onload = function (e) {
                processor.fdc.loadDisc(0, disc.discFor(processor.fdc, /\.dsd$/i.test(file.name), e.target.result));
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
                processor.acia.setTape(tapes.loadTapeFromData("local file", e.target.result));
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
            $('#google-drive-auth').hide();
            modal.modal("show");
        }

        function loadingFinished(error) {
            var modal = $('#loading-dialog');
            $('#google-drive-auth').hide();
            if (error) {
                modal.modal("show");
                modal.find(".loading").text("Error: " + error);
                setTimeout(function () {
                    modal.modal("hide");
                }, 5000);
            } else {
                modal.modal("hide");
            }
        }

        var gdAuthed = false;
        var googleDrive = new GoogleDriveLoader();

        function gdAuth(imm) {
            return googleDrive.authorize(imm)
                .then(function (authed) {
                    gdAuthed = authed;
                    console.log("authed =", authed);
                    return authed;
                }, function (err) {
                    console.log("Error handling google auth: " + err);
                    gdModal.find('.loading').text("There was an error accessing your Google Drive account: " + err);
                });
        }

        var googleDriveLoadingResolve, googleDriveLoadingReject;
        $('#google-drive-auth form').on("submit", function (e) {
            $('#google-drive-auth').hide();
            e.preventDefault();
            gdAuth(false).then(function (authed) {
                if (authed) googleDriveLoadingResolve();
                else googleDriveLoadingReject(new Error("Unable to authorize Google Drive"));
            });
        });

        function gdLoad(cat) {
            utils.noteEvent('google-drive', 'click', cat.title);
            // TODO: have a onclose flush event, handle errors
            /*
             $(window).bind("beforeunload", function() {
             return confirm("Do you really want to close?");
             });
             */
            parsedQuery.disc = "gd:" + cat.id + "/" + cat.title;
            updateUrl();
            popupLoading("Loading '" + cat.title + "' from Google Drive");
            return googleDrive.initialise()
                .then(function (available) {
                    console.log("Google Drive available =", available);
                    if (!available) throw new Error("Google Drive is not available");
                    return gdAuth(true);
                })
                .then(function (authed) {
                    console.log("Google Drive authed=", authed);
                    if (authed) {
                        return true;
                    } else {
                        return new Promise(function (resolve, reject) {
                            googleDriveLoadingResolve = resolve;
                            googleDriveLoadingReject = reject;
                            $('#google-drive-auth').show();
                        });
                    }
                })
                .then(function () {
                    return googleDrive.load(processor.fdc, cat.id);
                })
                .then(function (ssd) {
                    console.log("Google Drive loading finished");
                    loadingFinished();
                    return ssd;
                })
                .catch(function (error) {
                    console.log("Google Drive loading error:", error);
                    loadingFinished(error);
                });
        }

        $('.if-drive-available').hide();
        googleDrive.initialise().then(function (available) {
            if (available) {
                $('.if-drive-available').show();
                gdAuth(true);
            }
        });
        var gdModal = $('#google-drive');
        $('#open-drive-link').on('click', function () {
            if (gdAuthed) {
                gdModal.modal("show");
            } else {
                gdAuth(false).then(function (authed) {
                    if (authed) {
                        gdModal.modal("show");
                    }
                });
            }
            return false;
        });
        gdModal.on('show.bs.modal', function () {
            gdModal.find(".loading").text("Loading...").show();
            gdModal.find("li").not(".template").remove();
            googleDrive.cat().then(function (cat) {
                var dbList = gdModal.find(".list");
                gdModal.find(".loading").hide();
                var template = dbList.find(".template");
                $.each(cat, function (_, cat) {
                    var row = template.clone().removeClass("template").appendTo(dbList);
                    row.find(".name").text(cat.title);
                    $(row).on("click", function () {
                        gdLoad(cat).then(function (ssd) {
                            processor.fdc.loadDisc(0, ssd);
                        });
                        gdModal.modal("hide");
                    });
                });
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
                parsedQuery.disc = image.file;
                updateUrl();
                loadDiscImage(parsedQuery.disc).then(function (disc) {
                    processor.fdc.loadDisc(0, disc);
                });
                $('#discs').modal("hide");
            });
        });

        $("#google-drive form").on("submit", function (e) {
            e.preventDefault();
            var text = $("#google-drive .disc-name").val();
            if (!text) return;
            popupLoading("Connecting to Google Drive");
            $("#google-drive").modal("hide");
            popupLoading("Creating '" + text + "' on Google Drive");
            googleDrive.create(processor.fdc, text)
                .then(function (result) {
                    parsedQuery.disc = "gd:" + result.fileId + "/" + text;
                    processor.fdc.loadDisc(0, result.disc);
                    updateUrl();
                    loadingFinished();
                }, function (error) {
                    loadingFinished(error);
                });
        });

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
            if (type === undefined) return;

            if (type === "rewind") {
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

        var startPromise = Promise.all([ddNoise.initialise(), processor.initialise()])
            .then(function () {
                // Ideally would start the loads first. But their completion needs the FDC from the processor
                var imageLoads = [];
                if (discImage) imageLoads.push(loadDiscImage(discImage).then(function (disc) {
                    processor.fdc.loadDisc(0, disc);
                }));
                if (secondDiscImage) imageLoads.push(loadDiscImage(secondDiscImage).then(function (disc) {
                    processor.fdc.loadDisc(1, disc);
                }));
                if (parsedQuery.tape) imageLoads.push(loadTapeImage(parsedQuery.tape));

                if (parsedQuery.loadBasic) {
                    var needsRun = needsAutoboot === "run";
                    needsAutoboot = "";
                    imageLoads.push(utils.loadData(parsedQuery.loadBasic).then(function (data) {
                        var prog = String.fromCharCode.apply(null, data);
                        return tokeniser.create().then(function (t) {
                            return t.tokenise(prog);
                        });
                    }).then(function (tokenised) {
                        var idleAddr = processor.model.isMaster ? 0xe7e6 : 0xe581;
                        var hook = processor.debugInstruction.add(function (addr) {
                            if (addr !== idleAddr) return;
                            var page = processor.readmem(0x18) << 8;
                            for (var i = 0; i < tokenised.length; ++i) {
                                processor.writemem(page + i, tokenised.charCodeAt(i));
                            }
                            // Set VARTOP (0x12/3) and TOP(0x02/3)
                            var end = page + tokenised.length;
                            var endLow = end & 0xff;
                            var endHigh = (end >>> 8) & 0xff;
                            processor.writemem(0x02, endLow);
                            processor.writemem(0x03, endHigh);
                            processor.writemem(0x12, endLow);
                            processor.writemem(0x13, endHigh);
                            hook.remove();
                            if (needsRun) {
                                autoRunBasic();
                            }
                        });
                    }));
                }

                return Promise.all(imageLoads);
            });

        startPromise.then(function () {
            switch (needsAutoboot) {
                case "boot":
                    $("#sth .autoboot").prop('checked', true);
                    autoboot(discImage);
                    break;
                case "chain":
                    autoChainTape();
                    break;
                case "run":
                    autoRunTape();
                    break;
                default:
                    $("#sth .autoboot").prop('checked', false);
                    break;
            }

            if (parsedQuery.patch) {
                dbgr.setPatch(parsedQuery.patch);
            }

            go();
        }, function (error) {
            showError("initialising", error);
            console.log(error);
        }).done();

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

        var last = 0;

        function draw(now) {
            if (!running) {
                last = 0;
                return;
            }
            requestAnimationFrame(draw);
            gamepad.update();
            syncLights();
            if (last !== 0) {
                var sinceLast = now - last;
                var cycles = (sinceLast * clocksPerSecond / 1000) | 0;
                cycles = Math.min(cycles, MaxCyclesPerFrame);
                try {
                    if (!processor.execute(cycles)) {
                        stop(true);
                    }
                } catch (e) {
                    running = false;
                    utils.noteEvent('exception', 'thrown', e.stack);
                    dbgr.debug(processor.pc);
                    throw e;
                }
            }
            last = now;
        }

        function run() {
            requestAnimationFrame(draw);
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
            ddNoise.unmute();
            running = true;
            run();
        }

        function stop(debug) {
            running = false;
            processor.stop();
            if (debug) dbgr.debug(processor.pc);
            soundChip.mute();
            ddNoise.mute();
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
        window.m7dump = function () {
            console.log(utils.hd(function (x) {
                return processor.readmem(x) & 0x7f;
            }, 0x7c00, 0x7fe8, {width: 40, gap: false}));
        };
    }
)
;
