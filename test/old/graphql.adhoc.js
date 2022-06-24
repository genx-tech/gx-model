'use strict';

const { runCmdLive_, fs } = require('rk-utils');
const path = require('path');

const WORKING_FOLDER = path.resolve(__dirname, 'adhoc');
const GEML_CLI = '../../src/cli/index.js';

fs.ensureDirSync(WORKING_FOLDER);
fs.emptyDirSync(WORKING_FOLDER);
process.chdir(WORKING_FOLDER);

let onOutput = (info) => {
    console.log(info.toString());
};

let onError = (info) => {
    console.error(info.toString());
};

runCmdLive_('node', [ GEML_CLI, 'graphql', '-c', '../geml.adhoc.json' ], onOutput, onError).then(code => {
    console.log('exit code:', code);
}); 