'use strict';

const winston = require('winston');
const path = require('path');
const Linker = require('../lib/lang/Linker');

const SOURCE_PATH = path.resolve(__dirname, './adhoc/entity');

let logger = winston.createLogger({
    "level": "debug",
    "transports": [
        new winston.transports.Console({                            
            "format": winston.format.combine(winston.format.colorize(), winston.format.simple())
        })
    ]
});

let linker = new Linker(logger, { gemlPath: SOURCE_PATH, saveIntermediate: true });

let mod = linker.loadModule('contact.geml');

console.dir(mod, { depth: 10 });

