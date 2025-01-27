import { describe, it } from "vitest";
import assert from "assert";

import { combineQuery, joinQuery, parseQuery } from "../../../src/web/query-string.js";

describe("Query parser tests", () => {
    it("should join queries", () => {
        assert.deepStrictEqual(joinQuery(), "");
        assert.deepStrictEqual(joinQuery("moo"), "moo");
        assert.deepStrictEqual(joinQuery("moo&ian"), "moo&ian");
        assert.deepStrictEqual(joinQuery("moo&ian", "blab"), "moo&ian&blab");
        assert.deepStrictEqual(joinQuery("", "blab"), "blab");
    });
    it("should handle empty cases", () => {
        assert.deepStrictEqual(parseQuery(""), {});
    });
    it("should handle single toggles", () => {
        assert.deepStrictEqual(parseQuery("bob"), { bob: null });
    });
    it("should handle single various params", () => {
        assert.deepStrictEqual(parseQuery("splat=1&dither=sniff"), { splat: "1", dither: "sniff" });
    });
    it("should pick last of repeated things if not array type", () => {
        assert.deepStrictEqual(parseQuery("rom=1&rom=2&rom=3"), { rom: "3" });
    });
    it("should handle array types", () => {
        const types = new Map();
        types.set("rom", "array");
        assert.deepStrictEqual(parseQuery("rom=1", types), { rom: ["1"] });
        assert.deepStrictEqual(parseQuery("rom=1&rom=2&rom=3", types), { rom: ["1", "2", "3"] });
    });
    it("should handle int types", () => {
        const types = new Map();
        types.set("someInt", "int");
        assert.deepStrictEqual(parseQuery("someInt=123", types), { someInt: 123 });
        assert.deepStrictEqual(parseQuery("someInt=123.45", types), { someInt: 123 });
        assert.deepStrictEqual(parseQuery("someInt=moo", types), { someInt: NaN });
    });
    it("should handle float types", () => {
        const types = new Map();
        types.set("someFloat", "float");
        assert.deepStrictEqual(parseQuery("someFloat=123", types), { someFloat: 123 });
        assert.deepStrictEqual(parseQuery("someFloat=123.45", types), { someFloat: 123.45 });
        assert.deepStrictEqual(parseQuery("someFloat=moo", types), { someFloat: NaN });
    });
    it("should handle bool types", () => {
        const types = new Map();
        types.set("someBool", "bool");
        assert.deepStrictEqual(parseQuery("someBool=123", types), { someBool: false });
        assert.deepStrictEqual(parseQuery("someBool", types), { someBool: false });
        assert.deepStrictEqual(parseQuery("someBool=false", types), { someBool: false });
        assert.deepStrictEqual(parseQuery("someBool=true", types), { someBool: true });
        assert.deepStrictEqual(parseQuery("", types), {});
    });
    it("should handle boolIfPresent types", () => {
        const types = new Map();
        types.set("someBool", "boolIfPresent");
        assert.deepStrictEqual(parseQuery("someBool=123", types), { someBool: true });
        assert.deepStrictEqual(parseQuery("someBool", types), { someBool: true });
        assert.deepStrictEqual(parseQuery("someBool=false", types), { someBool: false });
        assert.deepStrictEqual(parseQuery("someBool=true", types), { someBool: true });
        assert.deepStrictEqual(parseQuery("", types), {});
    });
});

describe("Query combiner tests", () => {
    it("should combine empty things", () => {
        assert.equal(combineQuery({}), "");
    });
    it("should combine simple strings", () => {
        assert.equal(
            combineQuery({ a: "a", b: "b", somethingLong: "somethingLong" }),
            "a=a&b=b&somethingLong=somethingLong",
        );
    });
    it("should escape strings", () => {
        assert.equal(
            combineQuery({ horrid: "this & that", "bad key": "value" }),
            "horrid=this%20%26%20that&bad%20key=value",
        );
    });
    it("should honour types", () => {
        const types = new Map();
        types.set("int", "int");
        types.set("float", "float");
        types.set("boolean1", "bool");
        types.set("boolean2", "bool");
        types.set("boolean3", "bool");
        types.set("amIHere", "boolIfPresent");
        types.set("amNotHere", "boolIfPresent");
        types.set("array", "array");
        assert.equal(
            combineQuery(
                {
                    string: "stringy",
                    int: 123,
                    float: 123.456,
                    boolean1: true,
                    boolean2: false,
                    boolean3: "something truthy",
                    amIHere: true,
                    amNotHere: false,
                    array: ["one", "two", "three", "a space"],
                },
                types,
            ),
            "string=stringy&int=123&float=123.456&boolean1=true&boolean2=false&boolean3=true&amIHere&array=one&array=two&array=three&array=a%20space",
        );
    });
});
