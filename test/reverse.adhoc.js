'use strict';

const { fs, runCmdLive_ } = require('rk-utils');
const path = require('path');

const WORKING_FOLDER = path.resolve(__dirname, 'adhoc');

process.chdir(WORKING_FOLDER);

let onOutput = (info) => {
    console.log(info.toString());
};

runCmdLive_('node', [ '../../lib/cli/oolong.js', 'reverse', '-c', 'oolong-ool.json', '--conn', 'mysql.test2' ], onOutput, onOutput).then(code => {
    console.log('exit code:', code);
    fs.removeSync(path.join(WORKING_FOLDER, 'oolong-cli.log'));
}); 