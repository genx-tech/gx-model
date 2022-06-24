"use strict";

const testSuite = require("@genx/test");
const { fs } = require('@genx/sys');

const path = require("path");
const getAppInitiator = require("./lib/getAppInitiator");

const WORK_DIR = path.resolve(__dirname);
const SOURCE_DIR = path.resolve(WORK_DIR, './src');
const SCRIPT_DIR = path.resolve(WORK_DIR, './scripts');
const MANIFEST_DIR = path.resolve(WORK_DIR, './manifests');

testSuite(
    __filename,
    function (suite) {
        suite.testCase("build", async function () {
            await suite.startWorker_(
                async (app) => {
                    const appInitiator = getAppInitiator(app);

                    await fs.remove(SOURCE_DIR);
                    await fs.remove(SCRIPT_DIR);
                    await fs.remove(MANIFEST_DIR);

                    await appInitiator.run("build");                    
                },  
                {
                    workingPath: WORK_DIR,
                    configName: "app",
                    configPath: "./conf",
                    appModulesPath: "./app_modules",
                    logger: {
                        level: "verbose",
                    },
                    verbose: true,
                }
            );
        });
    },
    { verbose: true }
);
