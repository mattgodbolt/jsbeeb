define(['jquery', 'underscore', 'models'],
    function ($, _, models) {
        "use strict";

        return function Config(onClose) {
            var changed = {};
            this.model = null;
            var $configuration = $('#configuration');
            $configuration.on('show.bs.modal', function () {
                changed = {};
            });
            $configuration.on('hide.bs.modal', function () {
                onClose(changed);
            });

            this.setModel = function (modelName) {
                this.model = models.findModel(modelName);
                $(".bbc-model").text(this.model.name);
            };

            this.setKeyLayout = function (keyLayout) {
                $(".keyboard-layout").text(keyLayout[0].toUpperCase() + keyLayout.substr(1));
            };

            $('.model-menu a').on("click", function (e) {
                var modelName = $(e.target).attr("data-target");
                changed.model = modelName;
                this.setModel(modelName);
            }.bind(this));

            $('.keyboard-menu a').on("click", function (e) {
                var keyLayout = $(e.target).attr("data-target");
                changed.keyLayout = keyLayout;
                this.setKeyLayout(keyLayout);
            }.bind(this));
        };
    }
);