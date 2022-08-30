"use strict";

const testSuite = require("@genx/test");
const { cmd } = require('@genx/sys');

const path = require("path");

const WORK_DIR = path.resolve(__dirname);

testSuite(
    function (suite) {
        suite.testCase("allow 1 feature", async function () {
            const { stdout, stderr } = await cmd.run_('node ./src/cli/index.js nosense --fp=./test/features -c ./test/conf/allow-features.json --allow=localFeature');
            stderr.should.be.eql('');
            stdout.indexOf('value of key: test').should.be.above(0);
            stdout.indexOf('value of key: hello').should.be.exactly(-1);
        });

        suite.testCase("allow 2 features", async function () {
            const { stdout, stderr } = await cmd.run_('node ./src/cli/index.js nosense --fp=./test/features -c ./test/conf/allow-features.json --allow=localFeature --allow=ttlMemCache --allow=localFeature2');
            stderr.should.be.eql('');
            stdout.indexOf('value of key: test').should.be.above(0);
            stdout.indexOf('value of key: hello').should.be.above(0);
        });
    },
    { verbose: true }
);
