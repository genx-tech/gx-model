const path = require('path');
const { _, pascalCase, fs } = require('rk-utils');

const { DbModel } = require('@genx/data');

class {{ className }} extends DbModel {
    constructor(app, connector, i18n) {     
        super(app, connector, i18n);
        
        this.schemaName = '{{ schemaName }}';
        this.entities = {{ entities|safe }};        
    }

    loadModel(modelClassName) {        
        return require(`./${this.schemaName}/${modelClassName}`);
    }

    loadCustomModel(modelClassName) {    
        const customModelPath = path.resolve(__dirname, `./${this.schemaName}/custom/${modelClassName}.js`);    
        return fs.existsSync(customModelPath) && require(customModelPath);
    }

    async doTransaction_(transaction, errorHandler, resultHandler) {
        let connection;

        try {
            connection = await this.connector.beginTransaction_();
            let ret = await transaction({connection});
            await this.connector.commit_(connection);
            return resultHandler ? resultHandler(ret) : ret;
        } catch(error) {
            if (connection) {
                await this.connector.rollback_(connection);
            }

            if (errorHandler) {
                return errorHandler(error);
            }

            throw error;
        }
    }
}

module.exports = {{ className }};