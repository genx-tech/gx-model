"use strict";

const path = require('path');
const { _, fs, eachAsync_, pascalCase, quote } = require('rk-utils');

/**
 * MySQL migration.
 * @class
 */
class MySQLMigration {
    /**     
     * @param {object} context
     * @param {Connector} connector
     */
    constructor(app, context, schemaName, connector) {
        this.app = app;        
        this.modelPath = context.modelPath;
        this.scriptPath = context.scriptPath;
        this.schemaName = schemaName;
        this.connector = connector;

        this.dbScriptPath = path.join(this.scriptPath, this.connector.driver, this.connector.database);
    }

    async reset_() {
        return this.connector.execute_(`DROP DATABASE IF EXISTS ??`, [ this.connector.database ], { createDatabase: true });
    }

    async create_(extraOptions) {        
        let sqlFiles = [ 'entities.sql', 'relations.sql', 'procedures.sql' ];

        let sqlCreate = 'CREATE DATABASE IF NOT EXISTS ??';

        if (extraOptions && !_.isEmpty(extraOptions.db)) {
            sqlCreate += ' ' + _.reduce(extraOptions.db, (r, v, k) => {
                return r + ' ' + _.upperCase(k) + ' ' + quote(v.toString(), '"');
            }, '');
        }
        
        let result = await this.connector.execute_(sqlCreate, 
            [ this.connector.database ], 
            { createDatabase: true }
        );
        
        if (result.warningStatus == 0) {
            this.app.log('info', `Created database "${this.connector.database}".`);
        } else {
            this.app.log('warn', `Database "${this.connector.database}" exists.`);
        }                        

        return eachAsync_(sqlFiles, async (file) => {
            let sqlFile = path.join(this.dbScriptPath, file);
            if (!fs.existsSync(sqlFile)) {
                throw new Error(`Database script "${sqlFile}" not found. Try run "oolong build" first.`);
            }

            let sql = _.trim(fs.readFileSync(sqlFile, { encoding: 'utf8' }));
            if (sql) {
                result = _.castArray(await this.connector.execute_(sql, null, { multipleStatements: 1 }));

                let warningRows = _.reduce(result, (sum, row) => {
                    sum += row.warningStatus;
                    return sum;
                }, 0);

                if (warningRows > 0) {
                    this.app.log('warn', `${warningRows} warning(s) reported while running "${file}".`);
                } else {
                    this.app.log('info', `Database scripts "${sqlFile}" run successfully.`);
                }
            }
        });
    }

    async load_(dataFile) {
        let ext = path.extname(dataFile);
        this.app.log('verbose', `Loading data file "${dataFile}" ...`);

        if (ext === '.json') {
            let data = fs.readJsonSync(dataFile, {encoding: 'utf8'});

            if (Array.isArray(data)) {
                let entityName = path.basename(dataFile, ext);
                await this._loadSingleEntityRecords_(entityName, data);
            } else {
                await this._loadMultiEntityRecords_(data);
            }
        } else if (ext === '.sql') {
            let sql = fs.readFileSync(dataFile, {encoding: 'utf8'});
            let result = await this.connector.execute_(sql, null, { multipleStatements: 1 });
            this.app.log('verbose', `Executed SQL file: ${dataFile}`, result);
        } else if (ext === '.xlsx') {

            const Excel = require('exceljs');
            let workbook = new Excel.Workbook();
            await workbook.xlsx.readFile(dataFile);     
            
            let data = {};

            workbook.eachSheet((worksheet, sheetId) => {
                let colKeys;

                let entityName = worksheet.name;
                let entityData = [];
                data[entityName] = entityData;
                
                worksheet.eachRow(function(row, rowNumber) {                   
                    
                    if (!colKeys) {
                        colKeys = _.drop(row.values);    
                    } else {
                        let record = _.fromPairs(_.zip(colKeys, _.drop(row.values)));
                        entityData.push(record);
                    }
                });
            });

            await this._loadMultiEntityRecords_(data);
        } else if (ext === '.js') {           
            let executor = require(dataFile);
            await executor(this.app, this.connector);
        } else {
            throw new Error('Unsupported data file format.');
        }
    }

    async _loadMultiEntityRecords_(data) {
        let className = pascalCase(this.schemaName);
        let Db = require(path.join(this.modelPath, className));
        let db = new Db(this.connector.connectionString, this.connector.options);    

        try {
            await db.connector.execute_('SET FOREIGN_KEY_CHECKS=0;');

            await eachAsync_(data, async (records, entityName) => {                
                let items = Array.isArray(records) ? records : [ records ];
                return eachAsync_(items, item => db.model(entityName).create_(item, { $migration: true }));  
            });
        } catch (error) {
            throw error;
        } finally {
            await db.connector.execute_('SET FOREIGN_KEY_CHECKS=1;');
            await db.close_();
        }
    }

    async _loadSingleEntityRecords_(entityName, data) {
        let className = pascalCase(this.schemaName);
        let Db = require(path.join(this.modelPath, className));
        let db = new Db(this.connector.connectionString, this.connector.options);    

        try {
            await db.connector.execute_('SET FOREIGN_KEY_CHECKS=0;');

            await eachAsync_(data, item => db.model(entityName).create_(item, { $migration: true }));  
        } catch (error) {
            throw error;
        } finally {
            await db.connector.execute_('SET FOREIGN_KEY_CHECKS=1;');
            await db.close_();
        }
    }
}

module.exports = MySQLMigration;