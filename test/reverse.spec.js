'use strict';

const { fs, runCmdSync, _ } = require('rk-utils');
const path = require('path');

const WORKING_FOLDER = path.resolve(__dirname, 'build');
const GEML_CLI = 'node ../../src/cli/index.js';

describe.only('reverse', function () {
    before(function () {        
        process.chdir(WORKING_FOLDER);
        fs.removeSync(path.join(WORKING_FOLDER, 'models'));
        fs.removeSync(path.join(WORKING_FOLDER, 'scripts'));
        fs.removeSync(path.join(WORKING_FOLDER, 'manifests'));
    });

    after(function () {        
        fs.removeSync(path.join(WORKING_FOLDER, 'models'));
        fs.removeSync(path.join(WORKING_FOLDER, 'scripts'));
        //fs.removeSync(path.join(WORKING_FOLDER, 'manifests'));
    });

    it('reverse', function () {        
        let output = runCmdSync(GEML_CLI + ' reverse -c geml.json --schema=fooBar');
        console.log('output');
        
        
    });

});