"use strict";

const testSuite = require("@genx/test");
const { fs } = require('@genx/sys');
const { _ } = require('@genx/july');

const path = require("path");
const getAppInitiator = require("./lib/getAppInitiator");

const WORK_DIR = path.resolve(__dirname);
const SOURCE_DIR = path.resolve(WORK_DIR, './src');
const SCRIPT_DIR = path.resolve(WORK_DIR, './scripts');
const MANIFEST_DIR = path.resolve(WORK_DIR, './manifests');

testSuite(
    function (suite) {
        suite.testCase("build", async function () {
            await suite.startWorker_(
                async (app) => {
                    const appInitiator = getAppInitiator(app, 'conf/customize.default.json');

                    await fs.remove(SOURCE_DIR);
                    await fs.remove(SCRIPT_DIR);
                    await fs.remove(MANIFEST_DIR);

                    await appInitiator.run("build");                                           
                },  
                {
                    workingPath: WORK_DIR,
                    configName: "test",
                    configPath: "./conf",
                    appModulesPath: "./app_modules",
                    logger: {
                        level: "verbose",
                    },
                    verbose: true,
                }
            );

            const linked = fs.readJsonSync(path.join(WORK_DIR, './gemlCustomize/test.model.json'), 'utf8');
            const { user } = linked.entities;

            should.exist(user.fields.extraField);
            should.exist(user.associations);

            [
                {
                    "type": "hasMany",
                    "destEntity": "task",
                    "remoteField": "owner",
                    "srcField": "createdTasks",
                    "fieldProps": {}
                },
                {
                    "type": "hasMany",
                    "destEntity": "task",
                    "remoteField": "assignedTo",
                    "srcField": "assignedTasks",
                    "fieldProps": {}
                }
            ].every(expected => {
                _.find(user.associations, assoc => _.isEqual(assoc, expected)) != null
            });


        });
    },
    { verbose: true }
);
