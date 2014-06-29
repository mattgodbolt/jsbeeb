function loadData(url) {
    "use strict";
    var request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send(null);
    if (request.status != 200) return null;
    if (typeof(request.response) != "string") {
        return request.response;
    }
    var stringData = request.response;
    var len = stringData.length;
    var data = new Uint8Array(len);
    for (var i = 0; i < len; ++i) data[i] = stringData.charCodeAt(i) & 0xff;
    return data;
}

function readInt32(data, offset) {
    return (data[offset + 3] << 24) 
        | (data[offset + 2] << 16) 
        | (data[offset + 1] << 8) 
        | (data[offset + 0]);
}

function readInt16(data, offset) {
    return (data[offset + 1] << 8) 
        | (data[offset + 0]);
}

function ungzip(data) {
    var dataOffset = 10;
    if (data[3] & 0x02) dataOffset += 2; // Header CRC
    if (data[3] & 0x04) {
        dataOffset += 2 + readInt16(data, dataOffset); // FEXTRA
    }
    if (data[3] & 0x08) {
        while (data[dataOffset] !== 0) dataOffset++; // FILENAME
        dataOffset++;
    }
    if (data[3] & 0x10) {
        while (data[dataOffset] !== 0) dataOffset++; // FCOMMENT
        dataOffset++;
    }
    var tinf = new TINF();
    tinf.init();
    var uncompressedSize = readInt32(data, data.length - 4);
    var result = tinf.uncompress(data, dataOffset, uncompressedSize);
    if (result.status === 0) return result.data;
    throw "Unable to ungzip"; 
}
