define(['./fdc'], function (fdc) {
    "use strict";

    function Model(name, synonyms, os, nmos, isMaster, swram, fdc, tube) {
        this.name = name;
        this.synonyms = synonyms;
        this.os = os;
        this.nmos = nmos;
        this.isMaster = isMaster;
        this.Fdc = fdc;
        this.swram = swram;
        this.isTest = false;
        this.tube = tube;
    }

    // TODO: semi-bplus-style to get swram for exile hardcoded here
    var beebSwram = [
        true, true, true, true,      // Dunjunz variants. Exile (not picky).
        true, true, true, true,      // Crazee Rider.
        false, false, false, false,
        false, false, false, false];
    var masterSwram = [
        false, false, false, false,
        true, true, true, true,
        false, false, false, false,
        false, false, false, false];
    var tube65c02 = new Model("Tube65C02", [], ["tube/6502Tube.rom"], false, false);
    var allModels = [
        new Model("BBC B", ["B"], ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"], true, false, beebSwram, fdc.I8271),
        new Model("BBC B (DFS 0.9)", ["B-DFS0.9"], ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"], true, false, beebSwram, fdc.I8271),
        new Model("BBC B (DFS 1.2)", ["B-DFS1.2"], ["os.rom", "BASIC.ROM", "b/DFS-1.2.rom"], true, false, beebSwram, fdc.I8271),
        new Model("BBC B (with 65c02 Tube)", ["B-Tube"], ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"], true, false, beebSwram, fdc.I8271, tube65c02),
        new Model("BBC B (1770)", ["B1770"], ["os.rom", "BASIC.ROM", "b1770/dfs1770.rom", "b1770/zADFS.ROM"],
            true, false, beebSwram, fdc.WD1770),
        new Model("BBC Master 128", ["Master"], ["master/mos3.20"], false, true, masterSwram, fdc.WD1770),
        new Model("BBC Master Turbo", ["MasterTurbo"], ["master/mos3.20"], false, true, masterSwram, fdc.WD1770, tube65c02),
    ];

    function findModel(name) {
        name = name.toLowerCase();
        for (var i = 0; i < allModels.length; ++i) {
            var model = allModels[i];
            if (model.name.toLowerCase() === name)
                return model;
            for (var j = 0; j < model.synonyms.length; ++j) {
                if (model.synonyms[j].toLowerCase() === name)
                    return model;
            }
        }
        return null;
    }

    var cpu6502TestModel = new Model("TEST", ["TEST"], [], true, false, beebSwram, fdc.I8271);
    cpu6502TestModel.isTest = true;
    var cpu65c12TestModel = new Model("TEST", ["TEST"], [], false, false, masterSwram, fdc.I8271);
    cpu65c12TestModel.isTest = true;

    var basicOnly = new Model("Basic only", ["Basic only"], ["master/mos3.20"], false, true, masterSwram, fdc.WD1770);

    return {
        allModels: allModels,
        findModel: findModel,
        TEST_6502: cpu6502TestModel,
        TEST_65C12: cpu65c12TestModel,
        basicOnly: basicOnly
    };
});
