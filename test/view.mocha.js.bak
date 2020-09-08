'use strict';

const { fs, runCmdSync, _ } = require('rk-utils');
const path = require('path');
const winston = require('winston');
const WORKING_FOLDER = path.resolve(__dirname, 'view');
const OOLONG_CLI = 'node ../../lib/cli/oolong.js';

describe.skip('e2e:view', function () {
    let logger = winston.createLogger({
        "level": "debug",
        "transports": [
            new winston.transports.Console({                            
                "format": winston.format.combine(winston.format.colorize(), winston.format.simple())
            })
        ]
    });

    let cfg;

    before(function () {        
        process.chdir(WORKING_FOLDER);
        fs.removeSync(path.join(WORKING_FOLDER, 'models'));
        fs.removeSync(path.join(WORKING_FOLDER, 'scripts'));
        //fs.removeSync(path.join(WORKING_FOLDER, 'resources'));

        cfg = fs.readJsonSync('./oolong.json', 'utf8');
    });

    after(function () {
        fs.removeSync(path.join(WORKING_FOLDER, 'oolong-cli.log'));
        fs.removeSync(path.join(WORKING_FOLDER, 'models'));
        fs.removeSync(path.join(WORKING_FOLDER, 'scripts'));
        //fs.removeSync(path.join(WORKING_FOLDER, 'resources'));
    });

    it('build', function () {
        let output = runCmdSync(OOLONG_CLI + ' build -c oolong.json');
        
        output.should.match(/Generated entity model/);
    });

    it('migrate', function () {
        let output = runCmdSync(OOLONG_CLI + ' migrate -c oolong.json -r');
        
        output.should.match(/Database scripts ".+?" run successfully/);
    });   
    
});