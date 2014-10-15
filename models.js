define(['fdc'], function (fdc) {
    function Model(name, synonyms, os, nmos, isMaster, fdc) {
        this.name = name;
        this.synonyms = synonyms;
        this.os = os;
        this.nmos = nmos;
        this.isMaster = isMaster;
        this.Fdc = fdc;
        this.isTest = false;
    }

    var allModels = [
        new Model("BBC B", ["B"], ["os.rom", "b/BASIC.ROM", "b/DFS-0.9.rom"], false, false, fdc.I8271),
        new Model("BBC Master 128", ["Master"], ["master/mos3.20"], true, true, fdc.WD1770)
    ];

    function findModel(name) {
        name = name.toLowerCase();
        for (var i = 0; i < allModels.length; ++i) {
            var model = allModels[i];
            if (model.name.toLowerCase() == name)
                return model;
            for (var j = 0; j < model.synonyms.length; ++j) {
                if (model.synonyms[j].toLowerCase() == name)
                    return model;
            }
        }
        return null;
    }

    var cpu6502TestModel = new Model("TEST", ["TEST"], [], false, false, fdc.I8271);
    cpu6502TestModel.isTest = true;
    var cpu65c12TestModel = new Model("TEST", ["TEST"], [], true, false, fdc.I8271);
    cpu65c12TestModel.isTest = true;

    return {
        allModels: allModels,
        findModel: findModel,
        TEST_6502: cpu6502TestModel,
        TEST_65C12: cpu65c12TestModel
    };
});