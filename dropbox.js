function DropboxLoader(onCat, onError) {
    "use strict";
    console.log("Dropbox loader");
    var self = this;
    var client = new Dropbox.Client({ key: "k99h7ia8txlduda" });
    self.client = client;
    client.authDriver(new Dropbox.AuthDriver.Popup({
        receiverUrl: document.location.origin + "/oauth_receiver.html"})); 
    function dropboxDisc(client, fdc, drive, name, whenDone) {
        "use strict";
        client.readFile(name, function(error, dataString) {
            var i;
            var data;
            var lastString = dataString;
            function save() {
                var str = "";
                for (var i = 0; i < data.length; ++i) str += String.fromCharCode(data[i]);
                if (lastString == str) { return; }
                lastString = str;
                client.writeFile(name, data, function(error, stat) {
                    console.log("error", error);
                    console.log("stat", stat);
                });
            }
            if (error) {
                if (error.status != Dropbox.ApiError.NOT_FOUND) {
                    if (onError) onError(error);
                    whenDone(error);
                    return;
                } else {
                    console.log("Creating disc image");
                    data = new Uint8Array(100 * 1024);
                    for (i = 0; i < Math.max(12, name.length); ++i) 
                        data[i] = name.charCodeAt(i) & 0xff;
                    save();
                }
            } else {
                console.log("Loaded successfully");
                var len = dataString.length;
                data = new Uint8Array(len);
                for (i = 0; i < len; ++i) data[i] = dataString.charCodeAt(i) & 0xff;
            }

            var ssd = baseSsd(fdc, data, _.debounce(save, 2000));
            fdc.loadDisc(drive, ssd);
            whenDone(null);
        });
    } 
    self.load = function(fdc, name, drive, whenDone) {
        dropboxDisc(client, fdc, drive, name, whenDone);
    };

    client.authenticate(function(error, client) {
        if (error) {
            onError(error);
            return;
        }
        client.readdir("/", function(error, entries) {
            if (error) {
                onError(error);
                return;
            }
            onCat(entries);
        });
    });
}
