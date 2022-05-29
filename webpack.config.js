"use strict";

import * as path from "path";
import CopyWebpackPlugin from "copy-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import CssMinimizerPlugin from "css-minimizer-webpack-plugin";
import TerserPlugin from "terser-webpack-plugin";
import { CleanWebpackPlugin } from "clean-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";
import { fileURLToPath } from "url";

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const isDev = process.env.NODE_ENV !== "production";

const entry = path.resolve(__dirname, "./main.js");
const outputPath = path.resolve(__dirname, "out/dist");

function getOptimizationSettings() {
    return {
        minimize: !isDev,
        minimizer: [new CssMinimizerPlugin(), new TerserPlugin()],
    };
}

function getPlugins() {
    return [
        new CleanWebpackPlugin(),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: "roms/**/*",
                    globOptions: { ignore: ["**/*.txt", "**/*README*"] },
                },
                {
                    from: "discs/*.[ds]sd",
                },
                {
                    from: "tapes/*.uef",
                },
                {
                    from: "tapes/*.tape",
                },
                {
                    from: "sounds/**/*.wav",
                },
                {
                    from: "teletext/*.dat",
                },
                {
                    from: "music5000-worklet.js",
                },
            ],
        }),
        new MiniCssExtractPlugin({
            filename: isDev ? "[name].css" : "[name].[contenthash].css",
        }),
        new HtmlWebpackPlugin({
            title: "jsbeeb - Javascript BBC Micro emulator",
            template: "index.html",
        }),
    ];
}

export default {
    mode: isDev ? "development" : "production",
    entry: entry,
    target: "web",
    // "fs" used in a couple of places to support node
    externals: ["fs"],
    output: {
        filename: isDev ? "[name].js" : `[name].[contenthash].js`,
        path: outputPath,
    },
    devtool: "source-map",
    plugins: getPlugins(),
    devServer: {
        hot: isDev,
        static: {
            publicPath: "/",
            directory: "./",
        },
    },
    optimization: getOptimizationSettings(),
    module: {
        rules: [
            {
                test: /\.less$/,
                use: [isDev ? "style-loader" : { loader: MiniCssExtractPlugin.loader }, "css-loader", "less-loader"],
            },
            {
                test: /\.css$/,
                use: [isDev ? "style-loader" : { loader: MiniCssExtractPlugin.loader }, "css-loader"],
            },
            {
                test: /\.(html)$/,
                loader: "html-loader",
            },
            {
                test: /\.(png|svg|jpg|jpeg|gif)$/i,
                type: "asset",
            },
        ],
    },
};
