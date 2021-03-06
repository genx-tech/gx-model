"use strict";

const { _ } = require('rk-utils');
const { generateDisplayName, deepCloneField, Clonable, schemaNaming } = require('./GemlUtils');

/**
 * Oolong schema class.
 * @class OolongSchema
 */
class Schema extends Clonable {
    /**
     * Entities in this schema, map of <entityName, entityObject>
     * @member {object.<string, OolongEntity>}
     */
    entities = {};

    /**
     * Datasets, dataset = entity + relations + projection
     * @member {object}
     */
    datasets = {};

    /**
     * Views, view = dataset + filters 
     * @member {object}
     */
    views = {};    

    /**     
     * @param {OolongLinker} linker
     * @param {string} name
     * @param {object} gemlModule
     * @param {object} info
     */
    constructor(linker, name, gemlModule, info, deploymentSettings) {
        super();

        /**
         * Linker to process this schema
         * @member {OolongLinker}
         */
        this.linker = linker;

        /**
         * Name of this entity
         * @member {string}
         */
        this.name = schemaNaming(name);

        /**
         * Owner geml module
         * @member {object}
         */
        this.gemlModule = gemlModule;

        /**
         * Raw metadata
         * @member {object}
         */
        this.info = info;        

        /**
         * Deployment settings
         * @member {object}
         */
        this.deploymentSettings = deploymentSettings;
    }

    /**
     * Start linking this schema
     * @returns {Schema}
     */
    link() {
        pre: !this.linked;

        this.linker.log('debug', 'Linking schema [' + this.name + '] ...');

        if (this.info.comment) {
            /**
             * @member {string}
             */
            this.comment = this.info.comment;
        }

        /**
         * @member {string}
         */
        this.displayName = generateDisplayName(this.name);

        //1st round, get direct output entities
        this.info.entities || (this.info.entities = []);

        this.info.entities.forEach(entityEntry => {            
            let entity = this.linker.loadEntity(this.gemlModule, entityEntry.entity);
            assert: entity.linked;

            this.addEntity(entity);
        });

        if (!_.isEmpty(this.info.views)) {
            this.info.views.forEach(viewName => {
                this.linker.loadView(this.gemlModule, viewName);
                assert: view.linked;

                this.addView(view);
            });
        }

        this.linked = true;

        return this;
    }

    /**
     * Check whether a entity with given name is in the schema
     * @param {string} entityName
     * @returns {boolean}
     */
    hasEntity(entityName) {
        return (entityName in this.entities);
    }

    /**
     * Add an entity into the schema
     * @param {OolongEntity} entity
     * @returns {OolongSchema}
     */
    addEntity(entity) {
        pre: !this.hasEntity(entity.name), `Entity name [${entity.name}] conflicts in schema [${this.name}].`;

        this.entities[entity.name] = entity;

        return this;
    }

    /**
     * Check whether a view with given name is in the schema
     * @param {string} viewName
     * @returns {boolean}
     */
    hasView(viewName) {
        return (viewName in this.views);
    }

    /**
     * Add a view into the schema
     * @param {OolongView} view 
     * @returns {OolongSchema}
     */
    addView(view) {
        pre: !this.hasView(view.name), `View name [${view.name}] conflicts in schema [${this.name}].`;

        this.views[view.name] = view;

        return this;
    }

    /**
     * Get a document hierarchy
     * @param {object} fromModule
     * @param {string} datasetName
     * @returns {object}
     */
    getDocumentHierachy(fromModule, datasetName) {
        if (datasetName in this.datasets) {
            return this.datasets[datasetName];
        }

        let dataset = this.linker.loadDataset(fromModule, datasetName);
        return (this.datasets[datasetName] = dataset.buildHierarchy(this));
    }

    /**
     * Get the referenced entity, add it into schema if not in schema
     * @param {object} refererModule
     * @param {string} entityName
     * @returns {OolongEntity}
     */
    getReferencedEntity(refererModule, entityName) {
        let entity = this.linker.loadEntity(refererModule, entityName);

        if (!this.hasEntity(entity.name)) {
            throw new Error(`Entity "${entity.name}" not exists in schema "${this.name}".`);
        }

        return entity;
    }

    /**
     * 
     * @param {*} refererModule 
     * @param {*} entityName 
     */
    ensureGetEntity(refererModule, entityName, newlyAdded) {
        if (this.hasEntity(entityName)) return this.entities[entityName];

        let entity = this.linker.loadEntity(refererModule, entityName, false);

        if (entity) {
            this.addEntity(entity);   

            if (newlyAdded) {
                newlyAdded.push(entity.name);
                this.linker.log('debug', `New entity "${entity.name}" added by association.`);
            }
        }

        return entity;
    }

    /**
     * Clone the schema
     * @returns {Schema}
     */
    clone() {
        super.clone();
        
        let schema = new Schema(this.linker, this.name, this.gemlModule, this.info, this.deploymentSettings);
        
        deepCloneField(this, schema, 'displayName');
        deepCloneField(this, schema, 'comment');        
        deepCloneField(this, schema, 'entities');        
        deepCloneField(this, schema, 'datasets');
        deepCloneField(this, schema, 'views');        

        schema.linked = true;

        return schema;
    }

    /**
     * Translate the schema into a plain JSON object
     * @returns {object}
     */
    toJSON() {
        return {
            name: this.name,
            displayName: this.displayName,
            comment: this.comment,        
            entities: _.mapValues(this.entities, entity => entity.toJSON()),            
            datasets: _.mapValues(this.datasets, dataset => dataset.toJSON()), 
            views: _.mapValues(this.views, view => view.toJSON()) 
        };
    }
}

module.exports = Schema;