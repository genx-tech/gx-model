"use strict";

exports.Commands = {    
    'build': 'Generate database scripts and entity models.',
    'migrate': 'Create database structure.',        
    'dataset': 'List available data set.',
    'import': 'Import data set.',
    'export': 'Export data from database.',
    'reverse': 'Reverse engineering from a databse.',
    'listValidators': 'List all builtin validators.'
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

        case 'dataset': 
            cmdOptions['schema'] = {
                desc: 'The schema to list',                
                promptMessage: 'Please select a schema:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => core.getSchemasInConfig()
            };
            break;

        case 'import':
            cmdOptions['schema'] = {
                desc: 'The schema to list',                
                promptMessage: 'Please select a schema:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => core.getSchemasInConfig()
            };
            cmdOptions['dataset'] = {
                desc: 'The name of the data set to import',
                promptMessage: 'Please select the target dataset:',
                alias: [ 'ds', 'data' ],
                inquire: true,
                promptType: 'list',
                choicesProvider: () => core.getDataset_()
            };
            break;

        case 'export':
            cmdOptions['conn'] = {
                desc: 'The data source connector',
                alias: [ 'connector' ],
                promptMessage: 'Please select the data source connector:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => Object.keys(core.connectionStrings),
                afterInquire: () => { console.log('The conenction string of selected connector:', connectionStrings[core.option('conn')]); }                
            };           
            break;

        case 'reverse':        
            cmdOptions['conn'] = {
                desc: 'The data source connector',
                alias: [ 'connector' ],
                promptMessage: 'Please select the data source connector:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => Object.keys(core.connectionStrings),
                afterInquire: () => { console.log('The conenction string of selected connector:', connectionStrings[core.option('conn')]); }                
            };
            break;

        case 'listValidators':
            break;    
        
        default:
            //module general options
            break;
    }

    return cmdOptions;
};

