'use strict';

const { fs, runCmdLive_, _ } = require('rk-utils');
const path = require('path');

const WORKING_FOLDER = path.resolve(__dirname, 'build');
const GEML_CLI = 'node';

process.chdir(WORKING_FOLDER);
fs.removeSync(path.join(WORKING_FOLDER, 'models'));
fs.removeSync(path.join(WORKING_FOLDER, 'scripts'));
fs.removeSync(path.join(WORKING_FOLDER, 'manifests'));

runCmdLive_(GEML_CLI, ['../../src/cli/index.js', 'build', '-c', 'geml.json'], (output) => {
    console.log(output.toString());
}, (error) => {
    console.error(error.toString());
});


fs.removeSync(path.join(WORKING_FOLDER, 'models'));
fs.removeSync(path.join(WORKING_FOLDER, 'scripts'));
fs.removeSync(path.join(WORKING_FOLDER, 'manifests'));
