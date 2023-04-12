export function joinQuery(...queries) {
    let result = "";
    for (const query of queries) {
        if (query) {
            if (result) result += "&";
            result += query;
        }
    }
    return result;
}

export function parseQuery(queryString, argTypes) {
    if (!queryString) return {};
    argTypes = argTypes || new Map();
    const keys = queryString.split("&");
    const parsedQuery = {};
    for (const keyval of keys) {
        const keyAndVal = keyval.split("=");
        const key = decodeURIComponent(keyAndVal[0]);
        const val = keyAndVal.length > 1 ? decodeURIComponent(keyAndVal[1]) : null;
        switch (argTypes.get(key)) {
            case undefined:
            case "string":
                parsedQuery[key] = val;
                break;
            case "array":
                if (!(key in parsedQuery)) parsedQuery[key] = [];
                parsedQuery[key].push(val);
                break;
            case "int":
                parsedQuery[key] = parseInt(val);
                break;
            case "float":
                parsedQuery[key] = parseFloat(val);
                break;
            case "bool":
                parsedQuery[key] = val === "true";
                break;
            default:
                throw new Error(`Unknown arg type ${argTypes.get(key)}`);
        }
    }
    return parsedQuery;
}

export function combineQuery(parsedQuery, argTypes) {
    argTypes = argTypes || new Map();
    const urlParts = [];
    for (const key of Object.keys(parsedQuery)) {
        const val = parsedQuery[key];
        switch (argTypes.get(key)) {
            case undefined:
            case "string":
                urlParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
                break;
            case "array": {
                for (const subVal of val) {
                    urlParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(subVal)}`);
                }
                break;
            }
            case "int":
                urlParts.push(`${encodeURIComponent(key)}=${val | 0}`);
                break;
            case "float":
                urlParts.push(`${encodeURIComponent(key)}=${Number(val)}`);
                break;
            case "bool":
                urlParts.push(`${encodeURIComponent(key)}=${val ? "true" : "false"}`);
                break;
        }
    }
    return urlParts.join("&");
}
