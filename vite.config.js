import { configDefaults, defineConfig } from "vitest/config";
import { firShaderPlugin } from "./tools/vite-plugin-fir-shader.js";
import { workersFor } from "./tools/test-workers.js";

const ProjectFlag = "--project";
const SuiteTitles = { unit: "Unit tests", integration: "Integration tests", shader: "Shader tests" };
const InGithubActions = process.env.GITHUB_ACTIONS === "true";

function projectsAsked() {
    const args = process.argv;
    return args.flatMap((arg, i) => {
        if (arg === ProjectFlag) return args[i + 1] ? [args[i + 1]] : [];
        if (arg.startsWith(`${ProjectFlag}=`)) return [arg.slice(ProjectFlag.length + 1)];
        return [];
    });
}

/**
 * Heading for the GitHub Actions job summary. Every run in a job appends to the same summary
 * page, so the three suites need headings of their own; the reporter's title is a root option
 * and cannot live on the projects, so it comes from the project the command line asked for.
 * Undefined leaves Vitest's own default.
 */
function jobSummaryTitle() {
    const titles = projectsAsked()
        .map((name) => SuiteTitles[name])
        .filter(Boolean);
    return titles.length === 1 ? titles[0] : undefined;
}

/** @type {import("vite").UserConfig} */
export default defineConfig({
    base: "./", // Use relative paths for Electron compatibility
    plugins: [firShaderPlugin()],
    build: {
        sourcemap: true,
        // Prevent inlining; we don't want any worklets/audio workers to be inlined as that doesn't work.
        assetsInlineLimit: 0,
    },
    test: {
        testTimeout: 15000,
        // Named only under Actions, so that everywhere else Vitest picks its own reporters.
        ...(InGithubActions
            ? { reporters: ["default", ["github-actions", { jobSummary: { title: jobSummaryTitle() } }]] }
            : {}),
        // Every worker runs CPU-bound JavaScript (an emulated machine, or jsdom),
        // so a hyperthread sibling would only share its core: one worker per two
        // threads.
        maxWorkers: workersFor(2),
        projects: [
            { extends: true, test: { name: "unit", include: ["tests/unit/**/test-*.js"] } },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["tests/integration/**/*.js"],
                    exclude: [...configDefaults.exclude, "tests/integration/helpers.js", "tests/integration/png.js"],
                    // A hang detector; the dearest test costs under ten seconds uncontended.
                    testTimeout: 120000,
                },
            },
            { extends: true, test: { name: "shader", include: ["tests/shader/test-*.js"] } },
        ],
        slowTestThreshold: 1000,
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov", "json", "json-summary"],
            include: [
                "src/**/*.js", // Only include project source files
            ],
            exclude: [
                "tests/**",
                "node_modules/**",
                "src/lib/**", // Third-party libraries
                "**/*.config.js",
                "src/app/**", // App-specific code
            ],
        },
    },
});
