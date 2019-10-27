define(['jquery', 'underscore', './utils'], function ($, _, utils) {
    "use strict";
    var hexbyte = utils.hexbyte;
    var hexword = utils.hexword;
    return function Debugger(video) {
        var self = this;
        var disass = $('#disassembly');
        var memview = $('#memory');
        var memloc = 0;
        var debugNode = $('#debug, #hardware_debug, #crtc_debug');

        function setupGoto(form, func) {
            var addr = form.find(".goto-addr");
            form.on('submit', function (e) {
                func(utils.parseAddr(addr.val()));
                addr.val("");
                addr.blur();
                e.preventDefault();
            });
        }

        setupGoto($("#goto-mem-addr-form"), updateMemory);
        setupGoto($("#goto-dis-addr-form"), updateDisassembly);

        var cpu = null;
        var disassemble = null;
        var enabled = false;

        function enable(e) {
            if (enabled && !e) {
                updatePrevMem();
            }
            enabled = e;
            debugNode.toggle(enabled);
        }

        this.enabled = function () {
            return enabled;
        };

        enable(false);

        var numToShow = 16;
        var i;
        for (i = 0; i < numToShow; i++) {
            disass.find('.template').clone().removeClass('template').appendTo(disass);
            memview.find('.template').clone().removeClass('template').appendTo(memview);
        }

        var uservia;
        var sysvia;
        var crtc;

        function updateElem(elem, val) {
            var prevVal = elem.text();
            if (prevVal !== val) {
                elem.text(val);
            }
            elem.toggleClass("changed", prevVal !== val && prevVal !== "");
        }

        function setupVia(node, via) {
            var updates = [];
            if (!via) return utils.noop;
            var regs = ["ora", "orb", "ira", "irb", "ddra", "ddrb",
                "acr", "pcr", "ifr", "ier",
                "t1c", "t1l", "t2c", "t2l", "portapins", "portbpins", "IC32"];
            $.each(regs, function (_, elem) {
                if (via[elem] === undefined) return;
                var row = node.find(".template").clone().removeClass("template").appendTo(node);
                row.find(".register").text(elem.toUpperCase());
                var value = row.find(".value");
                if (elem.match(/t[12][cl]/)) {
                    updates.push(function () {
                        var reg = via[elem];
                        updateElem(value, hexbyte((reg >>> 16) & 0xff) +
                            hexbyte((reg >>> 8) & 0xff) + hexbyte(reg & 0xff));
                    });
                } else {
                    updates.push(function () {
                        updateElem(value, hexbyte(via[elem]));
                    });
                }
            });
            var update = function () {
                $.each(updates, function (_, up) {
                    up();
                });
            };
            update();
            return update;
        }

        function setupCrtc(node, video) {
            if (!video) return utils.noop;
            var updates = [];

            var regNode = node.find('.crtc_regs');

            function makeRow(node, text) {
                var row = node.find(".template").clone().removeClass("template").appendTo(node);
                row.find(".register").text(text);
                return row.find(".value");
            }

            for (var i = 0; i < 16; ++i) {
                (function (i) { // jshint ignore:line
                    var value = makeRow(regNode, "R" + i);
                    updates.push(function () {
                        updateElem(value, hexbyte(video.regs[i]));
                    });
                })(i);
            }

            var stateNode = node.find('.crtc_state');
            var others = [
                'bitmapX', 'bitmapY', 'dispEnabled',
                'horizCounter', 'inHSync', 'scanlineCounter', 'vertAdjustCounter', 'vertCounter',
                'inVSync', 'endOfMainLatched', 'endOfVertAdjustLatched', 'inVertAdjust', 'inDummyRaster',
                'addr', 'lineStartAddr', 'nextLineStartAddr'];
            $.each(others, function (_, elem) {
                var value = makeRow(stateNode, elem);
                if (typeof video[elem] === "boolean") {
                    updates.push(function () {
                        updateElem(value, video[elem] ? "true" : "false");
                    });
                } else {
                    updates.push(function () {
                        updateElem(value, hexword(video[elem]));
                    });
                }
            });

            var update = function () {
                $.each(updates, function (_, up) {
                    up();
                });
            };
            update();
            return update;
        }

        this.setCpu = function (c) {
            cpu = c;
            disassemble = c.disassembler.disassemble;
            sysvia = setupVia($('#sysvia'), c.sysvia);
            uservia = setupVia($('#uservia'), c.uservia);
            crtc = setupCrtc($('#crtc_debug'), c.video);
        };

        var disassPc = null;
        var disassStack = [];
        this.debug = function (where) {
            enable(true);
            updateDisassembly(where);
            updateRegisters();
            updateMemory();
            sysvia();
            uservia();
            crtc();
            video.debugPaint();
        };

        this.hide = function () {
            enable(false);
        };

        function updateRegisters() {
            updateElem($("#cpu6502_a"), hexbyte(cpu.a));
            updateElem($("#cpu6502_x"), hexbyte(cpu.x));
            updateElem($("#cpu6502_y"), hexbyte(cpu.y));
            updateElem($("#cpu6502_s"), hexbyte(cpu.s));
            updateElem($("#cpu6502_pc"), hexword(cpu.pc));
            ["c", "z", "i", "d", "v", "n"].forEach(function (flag) {
                updateElem($("#cpu6502_flag_" + flag), cpu.p[flag] ? flag.toUpperCase() : flag);
            });
        }

        function stepUntil(f) {
            cpu.targetCycles = cpu.currentCycles; // TODO: this prevents the cpu from running any residual cycles. look into a better solution
            for (var i = 0; i < 65536; i++) {
                cpu.execute(1);
                if (f()) break;
            }
            self.debug(cpu.pc);
        }

        function step() {
            updatePrevMem();
            var curpc = cpu.pc;
            stepUntil(function () {
                return cpu.pc !== curpc;
            });
        }

        this.step = step;

        function isUnconditionalJump(addr) {
            var result = disassemble(addr);
            return !!result[0].match(/^(JMP|RTS|BRA)/);
        }

        function stepOver() {
            updatePrevMem();
            if (isUnconditionalJump(cpu.pc)) {
                return step();
            }
            var nextPc = nextInstruction(cpu.pc);
            stepUntil(function () {
                return cpu.pc === nextPc;
            });
        }

        function isReturn(addr) {
            var result = disassemble(addr);
            return result[0] === "RTS";
        }

        function stepOut() {
            updatePrevMem();
            var s = cpu.s;
            stepUntil(function () {
                if (cpu.s >= s && isReturn(cpu.pc)) {
                    var nextInstr = nextInstruction(cpu.pc);
                    step();
                    return cpu.pc !== nextInstr;
                }
                return false;
            });
        }

        // Some attempt at making prevInstruction more accurate; score the sequence of instructions leading
        // up to the target by counting all "common" instructions as a point. The highest-scoring run of
        // instructions is picked as the most likely, and the previous from that is used. Common instructions
        // here mean loads, stores, branches, compares, arithmetic and carry-set/clear that don't use "unusual"
        // indexing modes like abs,X, abs,Y and (zp,X).
        // Good test cases:
        //   Repton 2 @ 2cbb
        //   MOS @ cfc8
        // also, just starting from the back of ROM and going up...
        var commonInstructions = /(RTS|B..|JMP|JSR|LD[AXY]|ST[AXY]|TA[XY]|T[XY]A|AD[DC]|SUB|SBC|CLC|SEC|CMP|EOR|ORR|AND|INC|DEC).*/;
        var uncommonInstrucions = /.*,\s*([XY]|X\))$/;

        function prevInstruction(address) {
            address &= 0xffff;
            var bestAddr = address - 1;
            var bestScore = 0;
            for (var startingPoint = address - 20; startingPoint !== address; startingPoint++) {
                var score = 0;
                var addr = startingPoint & 0xffff;
                while (addr < address) {
                    var result = disassemble(addr);
                    if (result[0] === cpu.pc) score += 10; // huge boost if this instruction was executed
                    if (result[0].match(commonInstructions) && !result[0].match(uncommonInstrucions)) {
                        score++;
                    }
                    if (result[1] === address) {
                        if (score > bestScore) {
                            bestScore = score;
                            bestAddr = addr;
                            break;
                        }
                    }
                    addr = result[1];
                }
            }
            return bestAddr;
        }

        function nextInstruction(address) {
            return disassemble(address)[1] & 0xffff;
        }

        function addressName() {
            return null;
            /* later, more clevers */
        }

        var breakpoints = {};

        function labelHtml(addr) {
            var name = addressName(addr);
            if (name) {
                return name + ':';
            } else {
                return '<span class="addr">' + hexword(addr) + '</span>';
            }
        }

        var prevDump = [];

        function updatePrevMem() {
            for (var i = 0; i < 65536; ++i) {
                prevDump[i] = cpu.peekmem(i);
            }
        }

        function memdump(from, to) {
            var hex = [];
            var asc = [];
            var changed = [];
            for (var i = from; i < to; ++i) {
                var b = cpu.peekmem(i);
                hex.push(hexbyte(b));
                changed.push(i < prevDump.length && prevDump[i] !== b);
                if (b >= 32 && b < 128) {
                    asc.push(String.fromCharCode(b));
                } else {
                    asc.push(".");
                }
            }
            return {hex: hex, asc: asc, changed: changed};
        }

        function updateMemory(newAddr) {
            if (newAddr !== undefined) memloc = newAddr;
            var kids = memview.children().filter(":visible");
            var addr = memloc - (8 * Math.floor(kids.length / 2));
            if (addr < 0) addr = 0;
            kids.each(function () {
                $(this).find('.dis_addr').html(labelHtml(addr));
                $(this).toggleClass('highlight', addr === memloc);
                var dump = memdump(addr, addr + 8);
                var bytes = $(this).find('.mem_bytes span');
                var ascii = $(this).find('.mem_asc span');
                for (var i = 0; i < 8; ++i) {
                    $(bytes[i]).text(dump.hex[i]).toggleClass("changed", dump.changed[i]);
                    $(ascii[i]).text(dump.asc[i]).toggleClass("changed", dump.changed[i]);
                }
                addr += 8;
            });
        }

        function instrClick(e) {
            var info = $(e.target).closest('.dis_elem').data();
            disassStack.push(disassPc);
            updateDisassembly(info.ref);
        }

        function memClick(e) {
            var info = $(e.target).closest('.dis_elem').data();
            updateMemory(info.ref);
        }

        function toggleBreakpoint(address) {
            if (breakpoints[address]) {
                console.log("Removing breakpoint from address " + utils.hexword(address));
                breakpoints[address].remove();
                breakpoints[address] = undefined;
            } else {
                console.log("Adding breakpoint to address " + utils.hexword(address));
                breakpoints[address] = cpu.debugInstruction.add(function (x) {
                    return x === address;
                });
            }
        }

        function bpClick(e) {
            var address = $(e.target).closest('.dis_elem').data().addr;
            toggleBreakpoint(address);
            $(e.target).toggleClass('active', !!breakpoints[address]);
        }

        disass.find('.bp_gutter').click(bpClick);

        function updateDisassembly(address) {
            disassPc = address;
            var elems = disass.children().filter(":visible");

            function updateDisElem(elem, address) {
                var result = disassemble(address);
                var dump = memdump(address, result[1]);
                elem.find('.dis_addr').html(labelHtml(address));
                elem.toggleClass('current', address === cpu.pc);
                elem.toggleClass('highlight', address === disassPc);
                elem.find('.instr_bytes').text(dump.hex.join(" "));
                elem.find('.instr_asc').text(dump.asc.join(""));
                var disNode = elem.find('.disassembly').html(result[0]);
                disNode.find('.instr_mem_ref').click(memClick);
                disNode.find('.instr_instr_ref').click(instrClick);
                elem.find('.bp_gutter').toggleClass('active', !!breakpoints[address]);
                elem.data({addr: address, ref: result[2]});
                return result[1];
            }

            var i;
            var elem;
            for (i = 0; i < numToShow / 2; ++i) {
                elem = $(elems[i + numToShow / 2]);
                address = updateDisElem(elem, address);
            }
            address = disassPc;
            for (i = numToShow / 2 - 1; i >= 0; --i) {
                address = prevInstruction(address);
                elem = $(elems[i]);
                updateDisElem(elem, address);
            }
        }

        disass.bind('wheel', function (evt) {
            var deltaY = evt.originalEvent.deltaY;
            if (deltaY === 0) return;
            var addr = disassPc;
            var func = deltaY < 0 ? prevInstruction : nextInstruction;
            deltaY = Math.abs(deltaY);
            while (deltaY > 0) {
                addr = func(addr);
                deltaY -= 30;
            }
            updateDisassembly(addr);
            evt.preventDefault();
        });

        memview.bind('wheel', function (evt) {
            var deltaY = evt.originalEvent.deltaY;
            if (deltaY === 0) return;
            var steps = (deltaY / 20) | 0;
            updateMemory(memloc + 8 * steps);
            evt.preventDefault();
        });

        this.keyPress = function (key) {
            if ($(":focus").length > 0) {
                return false;
            }
            switch (String.fromCharCode(key)) {
                case 'b':
                    if (disassStack.length)
                        updateDisassembly(disassStack.pop());
                    break;
                case 'k':
                    updateDisassembly(prevInstruction(disassPc));
                    break;
                case 'j':
                    updateDisassembly(nextInstruction(disassPc));
                    break;
                case 't':
                    toggleBreakpoint(disassPc);
                    updateDisassembly(disassPc);
                    break;
                case 'u':
                    updateMemory(memloc + 8);
                    break;
                case 'i':
                    updateMemory(memloc - 8);
                    break;
                case 'U':
                    updateMemory(memloc + 64);
                    break;
                case 'I':
                    updateMemory(memloc - 64);
                    break;
                case 'n':
                    step();
                    break;
                case 'N':
                    updatePrevMem();
                    cpu.execute(1);
                    self.debug(cpu.pc);
                    break;
                case 'm':
                    stepOver();
                    break;
                case 'o':
                    stepOut();
                    break;
            }
            return true;
        };

        var patchInstructions = {};

        function execPatch(inst) {
            var insts = inst.split(",");
            if (insts.length !== 1) {
                _.each(insts, execPatch);
                return;
            }
            if (!inst) return;
            var ops = inst.split(":");
            var addr = parseInt(ops[0], 16);
            var setTo = ops[1];
            for (var i = 0; i < setTo.length; i += 2) {
                var b = parseInt(setTo.substr(i, 2), 16);
                cpu.writemem(addr, b);
                addr++;
            }
        }

        this.setPatch = function (patch) {
            _.each(patch.split(";"), function (inst) {
                if (inst[0] === '@') {
                    var at = parseInt(inst.substr(1, 4), 16);
                    inst = inst.substr(5);
                    if (!patchInstructions[at])
                        patchInstructions[at] = [];
                    patchInstructions[at].push(inst);
                } else {
                    execPatch(inst);
                }
            });
            if (Object.keys(patchInstructions).length !== 0) {
                var hook = cpu.debugInstruction.add(function (pc) {
                    var insts = patchInstructions[pc];
                    if (!insts) return false;
                    _.each(insts, execPatch);
                    delete patchInstructions[pc];
                    if (Object.keys(patchInstructions).length === 0) {
                        console.log("All patches done");
                        hook.remove();
                    }
                    return false;
                });
            }
        };
    };
});
