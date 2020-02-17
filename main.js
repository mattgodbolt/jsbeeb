require(['jquery', 'underscore', 'utils', 'video', 'soundchip', 'ddnoise', 'debug', '6502', 'cmos', 'sth', 'gamepads',
        'fdc', 'discs/cat', 'tapes', 'google-drive', 'models', 'basic-tokenise',
        'canvas', 'config', 'promise', 'bootstrap', 'jquery-visibility'],
    function ($, _, utils, Video, SoundChip, DdNoise, Debugger, Cpu6502, Cmos, StairwayToHell, Gamepad, disc,
              starCat, tapes, GoogleDriveLoader, models, tokeniser, canvasLib, Config) {
        "use strict";

        var processor;
        var video;
        var soundChip = null;
        var ddNoise = null;
        var dbgr;
        var frames = 0;
        var frameSkip = 0;
        var syncLights;
        var discSth;
        var tapeSth;
        var running;
        var model;
        var gamepad = new Gamepad();

        var availableImages;
        var discImage;
        var extraRoms = [];
        if (typeof starCat === 'function') {
            availableImages = starCat();

            if (availableImages && availableImages[0]) {
                discImage = availableImages[0].file;
            }
        }
        var queryString = document.location.search.substring(1) + "&" + window.location.hash.substring(1);
        var secondDiscImage = null;
        var parsedQuery = {};
        var needsAutoboot = false;
        var keyLayout = window.localStorage.keyLayout || "physical";

        var BBC = utils.BBC;
        var keyCodes = utils.keyCodes;
        var emuKeyHandlers = {};
        var cpuMultiplier = 1;
        var fastAsPossible = false;
        var fastTape = false;
        var noSeek = false;
        var pauseEmu = false;
        var stepEmuWhenPaused = false;
        var audioFilterFreq = 7000;
        var audioFilterQ = 5;

        if (queryString) {
            if (queryString[queryString.length - 1] === '/')  // workaround for shonky python web server
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
                        case "fasttape":
                            fastTape = true;
                            break;
                        case "noseek":
                            noSeek = true;
                            break;
                        case "audiofilterfreq":
                            audioFilterFreq = Number(val);
                            break;
                        case "audiofilterq":
                            audioFilterQ = Number(val);
                            break;
                    }
                }
            });
        }

        if (parsedQuery.frameSkip)
            frameSkip = parseInt(parsedQuery.frameSkip);

        var config = new Config(
            function (changed) {
                parsedQuery = _.extend(parsedQuery, changed);
                updateUrl();
                if (changed.model) {
                    areYouSure("Changing model requires a restart of the emulator. Restart now?",
                        "Yes, restart now",
                        "No, thanks",
                        function () {
                            window.location.reload();
                        });
                }
                if (changed.keyLayout) {
                    window.localStorage.keyLayout = changed.keyLayout;
                    emulationConfig.keyLayout = changed.keyLayout;
                    processor.updateKeyLayout();
                }
            });
        config.setModel(parsedQuery.model || guessModelFromUrl());
        config.setKeyLayout(keyLayout);
        model = config.model;

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
        var $screen = $('#screen');
        var canvas = tryGl ? canvasLib.bestCanvas($screen[0]) : new canvasLib.Canvas($screen[0]);
        video = new Video.Video(model.isMaster, canvas.fb32, function paint(minx, miny, maxx, maxy) {
            frames++;
            if (frames < frameSkip) return;
            frames = 0;
            canvas.paint(minx, miny, maxx, maxy);
        });
        if (parsedQuery.fakeVideo !== undefined)
            video = new Video.FakeVideo();

        // Recent browsers, particularly Safari and Chrome, require a user
        // interaction in order to enable sound playback.
        function userInteraction() {
            if (audioContext) audioContext.resume();
        }

        var audioContext = typeof AudioContext !== 'undefined' ? new AudioContext() // jshint ignore:line
            : typeof webkitAudioContext !== 'undefined' ? new webkitAudioContext() // jshint ignore:line
                : null;
        var $audioWarningNode = $('#audio-warning');
        $audioWarningNode.on('mousedown', function () {
            userInteraction();
        });

        function checkAudioSuspended() {
            if (audioContext.state === "suspended") $audioWarningNode.fadeIn();
        }

        if (audioContext) {
            audioContext.onstatechange = function () {
                if (audioContext.state === "running") $audioWarningNode.fadeOut();
            };
            soundChip = new SoundChip.SoundChip(audioContext.sampleRate);
            // NB must be assigned to some kind of object else it seems to get GC'd by
            // Safari...
            soundChip.jsAudioNode = audioContext.createScriptProcessor(2048, 0, 1);
            soundChip.jsAudioNode.onaudioprocess = function pumpAudio(event) {
                var outBuffer = event.outputBuffer;
                var chan = outBuffer.getChannelData(0);
                soundChip.render(chan, 0, chan.length);
            };

            if (audioFilterFreq !== 0) {
                soundChip.filterNode = audioContext.createBiquadFilter();
                soundChip.filterNode.type = "lowpass";
                soundChip.filterNode.frequency.value = audioFilterFreq;
                soundChip.filterNode.Q.value = audioFilterQ;
                soundChip.jsAudioNode.connect(soundChip.filterNode);
                soundChip.filterNode.connect(audioContext.destination);
            } else {
                soundChip.jsAudioNode.connect(audioContext.destination);
            }

            if (!noSeek) ddNoise = new DdNoise.DdNoise(audioContext);

            $audioWarningNode.toggle(false);
            // Firefox will report that audio is suspended even when it will
            // start playing without user interaction, so we need to delay a
            // little to get a reliable indication.
            window.setTimeout(checkAudioSuspended, 1000);
        }
        if (!soundChip) soundChip = new SoundChip.FakeSoundChip();
        if (!ddNoise) ddNoise = new DdNoise.FakeDdNoise();

        var lastShiftLocation = 1;
        var lastCtrlLocation = 1;
        var lastAltLocation = 1;

        dbgr = new Debugger(video);

        $('.initially-hidden').removeClass('initially-hidden');

        function keyCode(evt) {
            var ret = evt.which || evt.charCode || evt.keyCode;

            var keyCodes = utils.keyCodes;

            switch (evt.location) {
                default:
                    // keyUp events seem to pass location = 0 (Chrome)
                    switch (ret) {
                        case keyCodes.SHIFT:
                            if (lastShiftLocation === 1) {
                                return keyCodes.SHIFT_LEFT;
                            } else {
                                return keyCodes.SHIFT_RIGHT;
                            }
                            break;

                        case keyCodes.ALT:
                            if (lastAltLocation === 1) {
                                return keyCodes.ALT_LEFT;
                            } else {
                                return keyCodes.ALT_RIGHT;
                            }
                            break;

                        case keyCodes.CTRL:
                            if (lastCtrlLocation === 1) {
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
                            return keyCodes.SHIFT_LEFT;

                        case keyCodes.ALT:
                            lastAltLocation = 1;
                            return keyCodes.ALT_LEFT;

                        case keyCodes.CTRL:
                            lastCtrlLocation = 1;
                            return keyCodes.CTRL_LEFT;
                    }
                    break;
                case 2:
                    switch (ret) {
                        case keyCodes.SHIFT:
                            lastShiftLocation = 2;
                            return keyCodes.SHIFT_RIGHT;

                        case keyCodes.ALT:
                            lastAltLocation = 2;
                            return keyCodes.ALT_RIGHT;

                        case keyCodes.CTRL:
                            lastCtrlLocation = 2;
                            return keyCodes.CTRL_RIGHT;
                    }
                    break;
                case 3: // numpad
                    switch (ret) {
                        case keyCodes.ENTER:
                            return utils.keyCodes.NUMPADENTER;

                        case keyCodes.DELETE:
                            return utils.keyCodes.NUMPAD_DECIMAL_POINT;
                    }
                    break;
            }

            return ret;
        }

        function keyPress(evt) {
            if (document.activeElement.id === 'paste-text') return;
            if (running || (!dbgr.enabled() && !pauseEmu)) return;
            var code = keyCode(evt);
            if (dbgr.enabled() && code === 103 /* lower case g */) {
                dbgr.hide();
                go();
                return;
            }
            if (pauseEmu) {
                if (code === 103 /* lower case g */) {
                    pauseEmu = false;
                    go();
                    return;
                } else if (code === 110 /* lower case n */) {
                    stepEmuWhenPaused = true;
                    go();
                    return;
                }
            }
            var handled = dbgr.keyPress(keyCode(evt));
            if (handled) evt.preventDefault();
        }

        emuKeyHandlers[utils.keyCodes.S] = function (down, code) {
            if (down) {
                utils.noteEvent('keyboard', 'press', 'S');
                stop(true);
            }
        };
        emuKeyHandlers[utils.keyCodes.R] = function (down, code) {
            if (down)
                window.location.reload();
        };

        function keyDown(evt) {
            userInteraction();
            if (document.activeElement.id === 'paste-text') return;
            if (!running) return;
            var code = keyCode(evt);
            if (evt.altKey) {
                var handler = emuKeyHandlers[code];
                if (handler) {
                    handler(true, code);
                    evt.preventDefault();
                }
            } else if (code === utils.keyCodes.HOME && evt.ctrlKey) {
                utils.noteEvent('keyboard', 'press', 'home');
                stop(true);
            } else if (code === utils.keyCodes.INSERT && evt.ctrlKey) {
                utils.noteEvent('keyboard', 'press', 'insert');
                fastAsPossible = !fastAsPossible;
            } else if (code === utils.keyCodes.END && evt.ctrlKey) {
                utils.noteEvent('keyboard', 'press', 'end');
                pauseEmu = true;
                stop(false);
            } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
                utils.noteEvent('keyboard', 'press', 'break');
                processor.setReset(true);
                evt.preventDefault();
            } else if (code === utils.keyCodes.B && evt.ctrlKey) {
                // Ctrl-B turns on the printer, so we open a printer output
                // window in addition to passing the keypress along to the beeb.
                processor.sysvia.keyDown(keyCode(evt), evt.shiftKey);
                evt.preventDefault();
                checkPrinterWindow();
            } else {
                processor.sysvia.keyDown(keyCode(evt), evt.shiftKey);
                evt.preventDefault();
            }
        }

        function keyUp(evt) {
            if (document.activeElement.id === 'paste-text') return;
            // Always let the key ups come through. That way we don't cause sticky keys in the debugger.
            var code = keyCode(evt);
            if (processor && processor.sysvia)
                processor.sysvia.keyUp(code);
            if (!running) return;
            if (evt.altKey) {
                var handler = emuKeyHandlers[code];
                if (handler) {
                    handler(false, code);
                    evt.preventDefault();
                }
            } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
                processor.setReset(false);
            }
            evt.preventDefault();
        }

        function loadHTMLFile(file) {
            var reader = new FileReader();
            reader.onload = function (e) {
                processor.fdc.loadDisc(0, disc.discFor(processor.fdc, file.name, e.target.result));
                delete parsedQuery.disc;
                delete parsedQuery.disc1;
                updateUrl();
                $('#discs').modal("hide");
            };
            reader.readAsBinaryString(file);
        }

        var $pastetext = $('#paste-text');
        $pastetext.on('paste', function (event) {
            var text = event.originalEvent.clipboardData.getData('text/plain');
            sendRawKeyboardToBBC(utils.stringToBBCKeys(text), true);
        });
        $pastetext.on('dragover', function (event) {
            event.preventDefault();
            event.stopPropagation();
            event.originalEvent.dataTransfer.dropEffect = "copy";
        });
        $pastetext.on('drop', function (event) {
            utils.noteEvent('local', 'drop');
            var file = event.originalEvent.dataTransfer.files[0];
            loadHTMLFile(file);
        });

        var $cub = $('#cub-monitor');
        $cub.on('mousemove mousedown mouseup', function (evt) {
            userInteraction();
            if (document.activeElement !== document.body)
                document.activeElement.blur();
            var cubOffset = $cub.offset();
            var screenOffset = $screen.offset();
            var x = (evt.offsetX - cubOffset.left + screenOffset.left) / $screen.width();
            var y = (evt.offsetY - cubOffset.top + screenOffset.top) / $screen.height();
            if (processor.touchScreen)
                processor.touchScreen.onMouse(x, y, evt.buttons);
            evt.preventDefault();
        });

        $(window).blur(function () {
            if (processor.sysvia) processor.sysvia.clearKeys();
        });

        $('#fs').click(function (event) {
            $screen[0].requestFullscreen();
            event.preventDefault();
        });

        document.onkeydown = keyDown;
        document.onkeypress = keyPress;
        document.onkeyup = keyUp;

        // To lower chance of data loss, only accept drop events in the drop
        // zone in the menu bar.
        document.ondragover = function (event) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "none";
        };
        document.ondrop = function (event) {
            event.preventDefault();
        };

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

        var userPort = null;
        if (true /* keyswitch */) {
            var switchState = 0xff;

            var switchKey = function (down, code) {
                var bit = 1 << (code - utils.keyCodes.K1);
                if (down)
                    switchState &= (0xff ^ bit);
                else
                    switchState |= bit;
            };

            for (var idx = utils.keyCodes.K1; idx <= utils.keyCodes.K8; ++idx) {
                emuKeyHandlers[idx] = switchKey;
            }
            userPort = {
                write: function (val) {
                },
                read: function () {
                    return switchState;
                }
            };
        }

        var printerWindow = null;
        var printerTextArea = null;

        function checkPrinterWindow() {
            if (printerWindow && !printerWindow.closed) return;

            printerWindow = window.open('', '_blank', 'height=300,width=400');
            printerWindow.document.write('<textarea id="text" rows="15" cols="40" placeholder="Printer outputs here..."></textarea>');
            printerTextArea = printerWindow.document.getElementById('text');

            processor.uservia.setca1(true);
        }

        var printerPort = {
            outputStrobe: function (level, output) {
                if (!printerTextArea) return;
                if (!output || level) return;

                var uservia = processor.uservia;
                // Ack the character by pulsing CA1 low.
                uservia.setca1(false);
                uservia.setca1(true);
                var newChar = String.fromCharCode(uservia.ora);
                printerTextArea.value += newChar;
            }
        };

        var emulationConfig = {
            keyLayout: keyLayout,
            cpuMultiplier: cpuMultiplier,
            videoCyclesBatch: parsedQuery.videoCyclesBatch,
            extraRoms: extraRoms,
            userPort: userPort,
            printerPort: printerPort,
        };
        processor = new Cpu6502(model, dbgr, video, soundChip, ddNoise, cmos, emulationConfig);

        function setDisc1Image(name) {
            delete parsedQuery.disc;
            parsedQuery.disc1 = name;
            updateUrl();
        }

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
            setDisc1Image("sth:" + item);
            var needsAutoboot = parsedQuery.autoboot !== undefined;
            if (needsAutoboot) {
                processor.reset(true);
            }
            popupLoading("Loading " + item);
            loadDiscImage(parsedQuery.disc1).then(function (disc) {
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

        function sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks) {
            var lastChar;
            var nextKeyMillis = 0;
            processor.sysvia.disableKeyboard();

            if (checkCapsAndShiftLocks) {
                var toggleKey = null;
                if (!processor.sysvia.capsLockLight) toggleKey = BBC.CAPSLOCK;
                else if (processor.sysvia.shiftLockLight) toggleKey = BBC.SHIFTLOCK;
                if (toggleKey) {
                    keysToSend.unshift(toggleKey);
                    keysToSend.push(toggleKey);
                }
            }

            var sendCharHook = processor.debugInstruction.add(function nextCharHook() {
                var millis = processor.cycleSeconds * 1000 + processor.currentCycles / (clocksPerSecond / 1000);
                if (millis < nextKeyMillis) {
                    return;
                }

                if (lastChar && lastChar !== utils.BBC.SHIFT) {
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

            // Shift-break simulation, hold SHIFT for 1000ms.
            sendRawKeyboardToBBC([BBC.SHIFT, 1000], false);
        }

        function autoChainTape() {
            var BBC = utils.BBC;

            console.log("Auto Chaining Tape");
            utils.noteEvent('init', 'autochain');

            var bbcKeys = utils.stringToBBCKeys('*TAPE\nCH.""\n');
            sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
        }

        function autoRunTape() {
            var BBC = utils.BBC;

            console.log("Auto Running Tape");
            utils.noteEvent('init', 'autorun');

            var bbcKeys = utils.stringToBBCKeys('*TAPE\n*/\n');
            sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
        }

        function autoRunBasic() {
            var BBC = utils.BBC;

            console.log("Auto Running basic");
            utils.noteEvent('init', 'autorunbasic');

            var bbcKeys = utils.stringToBBCKeys('RUN\n');
            sendRawKeyboardToBBC([1000].concat(bbcKeys), false);
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
            // TODO: come up with a decent UX for passing an 'onChange' parameter to each of these.
            // Consider:
            // * hashing contents and making a local disc image named by original disc hash, save by that, and offer
            //   to load the modified disc on load.
            // * popping up a message that notes the disc has changed, and offers a way to make a local image
            // * Dialog box (ugh) saying "is this ok?"
            if (schema === "|" || schema === "sth") {
                return discSth.fetch(discImage).then(function (discData) {
                    return disc.discFor(processor.fdc, discImage, discData);
                });
            }
            if (schema === "gd") {
                var splat = discImage.match(/([^\/]+)\/?(.*)/);
                var title = "(unknown)";
                if (splat) {
                    discImage = splat[1];
                    title = splat[2];
                }
                return gdLoad({title: title, id: discImage});
            }
            if (schema === "data") {
                var arr = Array.prototype.map.call(atob(discImage), (x) => x.charCodeAt(0));
                var unzipped = utils.unzipDiscImage(arr);
                var discData = unzipped.data;
                discImage = unzipped.name;
                return Promise.resolve(disc.discFor(processor.fdc, discImage, discData));
            }
            if (schema === "http" || schema === "https") {
                return utils.loadData(schema + "://" + discImage).then(function (discData) {
                    if (/\.zip/i.test(discImage)) {
                        var unzipped = utils.unzipDiscImage(discData);
                        discData = unzipped.data;
                        discImage = unzipped.name;
                    }
                    return disc.discFor(processor.fdc, discImage, discData);
                });
            }

            return disc.load("discs/" + discImage).then(function (discData) {
                return disc.discFor(processor.fdc, discImage, discData);
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
            if (schema === "data") {
                var arr = Array.prototype.map.call(atob(tapeImage), (x) => x.charCodeAt(0));
                var unzipped = utils.unzipDiscImage(arr);
                return Promise.resolve(processor.acia.setTape(tapes.loadTapeFromData(unzipped.name, unzipped.data)));
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
            utils.noteEvent('local', 'click'); // NB no filename here
            var file = evt.target.files[0];
            loadHTMLFile(file);
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
            // TODO: have a onclose flush event, handle errors
            /*
             $(window).bind("beforeunload", function() {
             return confirm("Do you really want to close?");
             });
             */
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
                        utils.noteEvent('google-drive', 'click', cat.title);
                        setDisc1Image("gd:" + cat.id + "/" + cat.title);
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
                setDisc1Image(image.file);
                loadDiscImage(parsedQuery.disc1).then(function (disc) {
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
                    setDisc1Image("gd:" + result.fileId + "/" + text);
                    processor.fdc.loadDisc(0, result.disc);
                    loadingFinished();
                }, function (error) {
                    loadingFinished(error);
                });
        });

        $('#hard-reset').click(function (event) {
            processor.reset(true);
            event.preventDefault();
        });

        $('#soft-reset').click(function (event) {
            processor.reset(false);
            event.preventDefault();
        });

        function guessModelFromUrl() {
            if (window.location.hostname.indexOf("bbc") === 0) return "B";
            if (window.location.hostname.indexOf("master") === 0) return "Master";
            return "B";
        }

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

                function insertBasic(getBasicPromise,needsRun){
                    imageLoads.push(getBasicPromise.then(function (prog) {
                        return tokeniser.create().then(function (t) { return t.tokenise(prog); });
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

                if (parsedQuery.loadBasic) {
                    var needsRun = needsAutoboot === "run";
                    needsAutoboot = "";
                    insertBasic(new Promise(function(resolve,reject){
                        utils.loadData(parsedQuery.loadBasic).then(function (data) {
                            resolve(String.fromCharCode.apply(null, data));
                        });
                    }),needsRun);
                }

                if (parsedQuery.embedBasic) {
                    insertBasic(new Promise(function(resolve,reject){
                        resolve(parsedQuery.embedBasic);
                    }),true);
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
            var startTime = performance.now();
            processor.execute(numCycles);
            var endTime = performance.now();
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
            var startTime = performance.now();
            video.polltime(numCycles);
            var endTime = performance.now();
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

        function VirtualSpeedUpdater() {
            this.cycles = 0;
            this.time = 0;
            this.v = $('.virtualMHz');
            this.header = $('#virtual-mhz-header');
            this.speedy = false;

            this.update = function (cycles, time, speedy) {
                this.cycles += cycles;
                this.time += time;
                this.speedy = speedy;
            };

            this.display = function () {
                // MRG would be nice to graph instantaneous speed to get some idea where the time goes.
                if (this.cycles) {
                    var thisMHz = this.cycles / this.time / 1000;
                    this.v.text(thisMHz.toFixed(1));
                    if (this.cycles >= 10 * 2 * 1000 * 1000) {
                        this.cycles = this.time = 0;
                    }
                    var colour = "white";
                    if (this.speedy) {
                        colour = "red";
                    }
                    this.header.css("color", colour);
                }
                setTimeout(this.display.bind(this), 3333);
            };

            this.display();
        }

        var virtualSpeedUpdater = new VirtualSpeedUpdater();

        function draw(now) {
            if (!running) {
                last = 0;
                return;
            }
            // If we got here via setTimeout, we don't get passed the time.
            if (now === undefined) {
                now = window.performance.now();
            }

            var motorOn = processor.acia.motorOn;
            var speedy = fastAsPossible || (fastTape && motorOn);
            var useTimeout = speedy || motorOn;
            var timeout = speedy ? 0 : (1000.0 / 50);

            // In speedy mode, we still run all the state machines accurately
            // but we paint less often because painting is the most expensive
            // part of jsbeeb at this time.
            // We need need to paint per odd number of frames so that interlace
            // modes, i.e. MODE 7, still look ok.
            var frameSkipCount = speedy ? 9 : 0;
            video.frameSkipCount = frameSkipCount;

            // We use setTimeout instead of requestAnimationFrame in two cases:
            // a) We're trying to run as fast as possible.
            // b) Tape is playing, normal speed but backgrounded tab should run.
            if (useTimeout) {
                window.setTimeout(draw, timeout);
            } else {
                window.requestAnimationFrame(draw);
            }

            gamepad.update(processor.sysvia);
            syncLights();
            if (last !== 0) {
                var cycles;
                if (!speedy) {
                    // Now and last are DOMHighResTimeStamp, just a double.
                    var sinceLast = now - last;
                    cycles = sinceLast * clocksPerSecond / 1000;
                    cycles = Math.min(cycles, MaxCyclesPerFrame);
                } else {
                    cycles = clocksPerSecond / 50;
                }
                cycles |= 0;
                try {
                    if (!processor.execute(cycles)) {
                        stop(true);
                    }
                    var end = performance.now();
                    virtualSpeedUpdater.update(cycles, end - now, speedy);
                } catch (e) {
                    running = false;
                    utils.noteEvent('exception', 'thrown', e.stack);
                    dbgr.debug(processor.pc);
                    throw e;
                }
                if (stepEmuWhenPaused) {
                    stop(false);
                    stepEmuWhenPaused = false;
                }
            }
            last = now;
        }

        function run() {
            window.requestAnimationFrame(draw);
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

        (function () {
            const $cubMonitor = $("#cub-monitor");
            var cubOrigHeight = $cubMonitor.height();
            var cubToScreenHeightRatio = $screen.height() / cubOrigHeight;
            var cubOrigWidth = $cubMonitor.width();
            var cubToScreenWidthRatio = $screen.width() / cubOrigWidth;
            var navbarHeight = $("#header-bar").height();
            const desiredAspectRatio = cubOrigWidth / cubOrigHeight;
            const minWidth = cubOrigWidth / 4;
            const minHeight = cubOrigHeight / 4;
            const borderReservedSize = 100;
            const bottomReservedSize = 100;

            function resizeTv() {
                var width = Math.max(minWidth, window.innerWidth - borderReservedSize * 2);
                var height = Math.max(minHeight, window.innerHeight - navbarHeight - bottomReservedSize);
                if (width / height <= desiredAspectRatio) {
                    height = width / desiredAspectRatio;
                } else {
                    width = height * desiredAspectRatio;
                }
                $('#cub-monitor').height(height).width(width);
                $('#cub-monitor-pic').height(height).width(width);
                $screen.height(height * cubToScreenHeightRatio).width(width * cubToScreenWidthRatio);
            }

            window.onresize = resizeTv;
            resizeTv();
        })();

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
);
