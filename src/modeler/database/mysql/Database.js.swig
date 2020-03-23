const { _, pascalCase } = require('rk-utils');

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

    async doTransaction_(transaction_, errorHandler) {
        let connection;

        try {
            connection = await this.connector.beginTransaction_();
            let ret = await transaction_(connection);
            await this.connector.commit_(connection);
            return ret;
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