"use strict";

exports.Commands = {    
    'build': 'Generate database scripts and entity models.',
    'graphql': 'Generate graphql schemas.',
    'migrate': 'Create database structure.',            
    'import': 'Import data set.',
    'export': 'Export data from database.',
    'reverse': 'Reverse engineering from a databse.'
};

/**
 * @param {CommandLine} cli - CommandLine object.
 * @param {string} command - Command
 */
exports.getCommandOptions = (cli, command) => {
    let cmdOptions = {};

    switch (command) {
        case 'build':
            break;

        case 'graphql':
            break;

        case 'migrate':
            cmdOptions['r'] = {
                desc: 'Reset all data if the database exists',
                promptMessage: 'Reset existing database?',
                promptDefault: false,
                inquire: true,
                required: true,
                alias: [ 'reset' ],
                bool: true
            };
            break;        

        case 'import':
            cmdOptions['schema'] = {
                desc: 'The schema to list',                               
                required: true                
            };
            cmdOptions['dataset'] = {
                desc: 'The name of the data set to import',                
                alias: [ 'ds', 'data' ],
                required: true                
            };
            cmdOptions['ignore'] = {
                desc: 'Ignore exception on duplicate',                
                alias: [ 'ignore-duplicate' ],
                bool: true                
            };
            break;

        case 'export':
            cmdOptions['schema'] = {
                desc: 'The schema to export',
                required: true        
            };      
            cmdOptions['override'] = {
                desc: 'Override same day output',
                alias: [ 'f' ],
                bool: true
            };            
            break;

        case 'reverse':        
            cmdOptions['schema'] = {
                desc: 'The schema to reverse',
                required: true        
            };
            cmdOptions['override'] = {
                desc: 'Override same day output',
                alias: [ 'f' ],
                bool: true
            };
            break;
        
        default:
            //module general options
            break;
    }

    return cmdOptions;
};

