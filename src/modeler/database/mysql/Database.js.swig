const { _, pascalCase } = require('rk-utils');

const { getEntityModelOfDriver } = require('@genx/data');
const BaseEntityModel = getEntityModelOfDriver('{{ driver }}');

class {{ className }} {
    constructor(app, connector, i18n) {     
        this.app = app;
        this.connector = connector;
        this.i18n = options;

        this._modelCache = {};
    }

    model(entityName) {        
        if (this._modelCache[entityName]) return this._modelCache[entityName];

        let modelClassName = pascalCase(entityName);
        if (this._modelCache[modelClassName]) return this._modelCache[modelClassName];

        let entitySpecMixin = require(`./{{ schemaName }}/${modelClassName}`);
        let modelClass = entitySpecMixin(this, BaseEntityModel);

        this._modelCache[entityName] = modelClass;
        if (modelClassName !== entityName) {
            this._modelCache[modelClassName] = modelClass;
        }
        
        return modelClass;
    }

    entitiesOfType(baseEntityName) {
        return _.filter(this.constructor.entities, entityName => {
            let Model = this.model(entityName);
            return Model.baseClasses && Model.baseClasses.indexOf(baseEntityName) > -1;
        });
    }

    async close_() {
        delete this._modelCache;
        delete this.connector;
        delete this.app;
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

{{ className }}.driver = '{{ driver }}';
{{ className }}.schemaName = '{{ schemaName }}';
{{ className }}.entities = {{ entities|safe }};

module.exports = {{ className }};