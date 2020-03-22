'use strict';

const winston = require('winston');
const path = require('path');
const Linker = require('../lib/lang/Linker');

const SOURCE_PATH = path.resolve(__dirname, './adhoc/special');

let logger = winston.createLogger({
    "level": "debug",
    "transports": [
        new winston.transports.Console({                            
            "format": winston.format.combine(winston.format.colorize(), winston.format.simple())
        })
    ]
});

let linker = new Linker({ logger, dslSourcePath: SOURCE_PATH, saveIntermediate: true });

let mod = linker.loadModule('user.ool');

console.log(mod);

