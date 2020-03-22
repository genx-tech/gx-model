"use strict";

const path = require('path');
const { _, fs, glob } = require('rk-utils');
const { Types } = require('@genx/data');

const Oolong = require('./grammar/oolong');
const OolongParser = Oolong.parser;
const OolTypes = require('./OolTypes');
const Entity = require('./Entity');
const Schema = require('./Schema');
const View = require('./View');
const Dataset = require('./Dataset');

const ELEMENT_CLASS_MAP = {
    [OolTypes.Element.ENTITY]: Entity,
    [OolTypes.Element.VIEW]: View,
    [OolTypes.Element.DATASET]: Dataset,
};

const GEML_SOURCE_EXT = '.geml';
const BUILTINS_PATH = path.resolve(__dirname, 'builtins');

/**
 * Linker of geml
 * @class GemlLinker
 */
class Linker {
    static getGemlFiles(sourceDir, useJsonSource, recursive) {
        let pattern = '*' + GEML_SOURCE_EXT;

        if (useJsonSource) {
            pattern += '.json';
        }

        if (recursive) {
            pattern = '**/' + pattern;
        }

        return glob.sync(path.join(sourceDir, pattern), {nodir: true});
    }

    /**
     * @param {ServiceContainer} app 
     * @param {object} context
     * @property {string} context.gemlPath - Geml source files path     
     * @property {bool} [context.useJsonSource=false] - Use .json intermediate source file instead of .ool
     * @property {bool} [context.saveIntermediate=false] - Save intermediate source file while linking
     */
    constructor(app, context) {
        /**
         * App
         * @member {ServiceContainer}
         */
        this.app = app;

        /**
         * Geml source files path
         * @member {string}
         */
        this.sourcePath = context.gemlPath;

        /**
         * Use json or ols
         * @member {bool}
         */
        this.useJsonSource = context.useJsonSource;

        /**
         * Save intermediate files
         * @member {bool}
         */
        this.saveIntermediate = context.saveIntermediate;

        /**
         * Schema deployment settings
         * @member {object}
         */
        this.schemaDeployment = context.schemas;

        /**
         * Linked schemas
         * @member {object.<string, Schema>}
         */
        this.schemas = {};

        /**
         * Parsed oolong files, path => module
         * @member {object}
         * @private
         */
        this._oolModules = {};

        /**
         * Element cache, map of <referenceId, element> and <selfId, element>
         * @member {object} 
         * @private
         */
        this._elementsCache = {};

        /**
         * Map of <referenceId, moduleId>
         * @member {object}
         * @private
         */
        this._mapOfReferenceToModuleId = new Map();
    }

    /**
     * Write log
     * @param {string} level
     * @param {string} message
     * @param {object} [data]
     */
    log(...args) {
        this.app.log(...args);
    }

    /**
     * Check whether a module is loaded
     * @param {string} moduleId
     * @returns {boolean}
     */
    isModuleLoaded(moduleId) {
        return (moduleId in this._oolModules);
    }

    /**
     * Get a loaded oolone module
     * @param {string} moduleId
     * @returns {object}
     */
    getModuleById(moduleId) {
        return this._oolModules[moduleId];
    }

    /**
     * Start linking oolong files
     * @param {string} entryFileName
     */
    link(entryFileName) {
        //compile entry file        
        let entryModule = this.loadModule(entryFileName);

        if (!entryModule) {
            throw new Error(`Cannot resolve file "${entryFileName}".`);
        }

        if (_.isEmpty(entryModule.schema)) {
            throw new Error('No schema defined in entry file.');
        }

        _.forOwn(entryModule.schema, (schemaInfo, schemaName) => {
            let deploymentSettings = this.schemaDeployment[schemaName];
            //assert: deploymentSettings, `"deploymentSettings" of schema [${schemaName}] not found.`;
            
            let schema = new Schema(this, schemaName, entryModule, schemaInfo, deploymentSettings);
            schema.link();

            if (this.schemas.hasOwnProperty(schemaName)) {
                throw new Error(`Duplicate schema: "${schemaName}".`);
            }
            this.schemas[schemaName] = schema;

            if (this.saveIntermediate) {
                let jsFile = path.resolve(this.sourcePath, entryFileName + '-linked.json');
                fs.writeFileSync(jsFile, JSON.stringify(schema.toJSON(), null, 4));
            }
        });        
    }

    /**
     * Load a oolong module, return undefined if not exist
     * @param {string} modulePath
     * @returns {*}
     */
    loadModule(modulePath) {        
        modulePath = path.resolve(this.sourcePath, modulePath);

        let id = this.getModuleIdByPath(modulePath);

        if (this.isModuleLoaded(id)) {
            return this.getModuleById(id);
        }

        if (!fs.existsSync(modulePath)) {
            return undefined;
        }       

        let ool = this._compile(modulePath);

        return (this._oolModules[id] = ool);
    }

    /**
     * Track back the type derived chain.
     * @param {object} oolModule
     * @param {object} info
     * @returns {object}
     */
    trackBackType(oolModule, info) {
        if (Types.Builtin.has(info.type)) {
            return info;
        }

        let baseInfo = this.loadElement(oolModule, OolTypes.Element.TYPE, info.type, true);

        if (!Types.Builtin.has(baseInfo.type)) {
            //the base type is not a builtin type
            let uniqueId = this.getElementUniqueId(oolModule, OolTypes.Element.TYPE, value.name);
            let ownerModule = this.getModuleById(this._mapOfReferenceToModuleId.get(uniqueId));
            let rootTypeInfo = this.trackBackType(ownerModule, baseInfo);
            ownerModule.type[baseInfo.type] = rootTypeInfo;
            baseInfo = rootTypeInfo;
        }

        let derivedInfo = { ..._.cloneDeep(_.omit(baseInfo, ['modifiers'])), ..._.omit(info, ['type', 'modifiers'])};
        if (baseInfo.modifiers || info.modifiers) {
            derivedInfo.modifiers = [ ...(baseInfo.modifiers || []), ...(info.modifiers || []) ];
        }

        if (!derivedInfo.subClass) {
            derivedInfo.subClass = [];
        }
        derivedInfo.subClass.push(info.type);
        return derivedInfo;
    }    
    
    /**
     * Translate an value by inferring all the references.
     * @param {object} oolModule 
     * @param {*} value 
     * @returns {*} - Translated value.
     */
    translateOolValue(oolModule, value) {
        if (_.isPlainObject(value)) {
            if (value.oolType === OolTypes.Lang.CONST_REF) {                
                let refedValue = this.loadElement(oolModule, OolTypes.Element.CONST, value.name, true);
                let uniqueId = this.getElementUniqueId(oolModule, OolTypes.Element.CONST, value.name);
                let ownerModule = this.getModuleById(this._mapOfReferenceToModuleId.get(uniqueId));
                return this.translateOolValue(ownerModule, refedValue);
            } else if (value.oolType) {
                throw new Error(`todo: translateOolValue with type: ${value.oolType}`)
            }

            return _.mapValues(value, v => this.translateOolValue(oolModule, v));
        }

        if (Array.isArray(value)) {
            return value.map(v => this.translateOolValue(oolModule, v));
        }

        return value;
    }

    /**
     * Get the unique module id by source file path.
     * @param {string} modulePath - The path of an oolong source file.
     * @returns {string} - The module id.
     */
    getModuleIdByPath(modulePath) {        
        let isBuiltinEntity = _.startsWith(modulePath, BUILTINS_PATH);      
        return isBuiltinEntity ? 
            path.relative(BUILTINS_PATH, modulePath) : 
            './' + path.relative(this.sourcePath, modulePath);  
    }

    /**
     * Get the unique name of an element.
     * @param {object} refererModule 
     * @param {string} elementType 
     * @param {string} elementName 
     * @returns {string} - The unique name of an element.
     */
    getElementUniqueId(refererModule, elementType, elementName) {
        return elementType + ':' + elementName + '<-' + refererModule.id;
    }

    loadEntity(refererModule, elementName, throwOnMissing = true) {
        let entity = this.loadElement(refererModule, OolTypes.Element.ENTITY, elementName, throwOnMissing);

        if (entity && _.isEmpty(entity.fields)) {
            throw new Error(`Entity "${elementName}" has no any fields defined.`);
        }

        return entity;
    }

    loadType(refererModule, elementName, throwOnMissing = true) {
        return this.loadElement(refererModule, OolTypes.Element.TYPE, elementName, throwOnMissing);
    }

    loadDataset(refererModule, elementName, throwOnMissing = true) {
        return this.loadElement(refererModule, OolTypes.Element.DATASET, elementName, throwOnMissing);
    }

    loadView(refererModule, elementName, throwOnMissing = true) {
        return this.loadElement(refererModule, OolTypes.Element.VIEW, elementName, throwOnMissing);
    }

    /**
     * Load an element based on the namespace chain.
     * @param {object} refererModule 
     * @param {string} elementType 
     * @param {string} elementName 
     */
    loadElement(refererModule, elementType, elementName, throwOnMissing) {
        // the element id with type, should be unique among the whole schema
        let uniqueId = this.getElementUniqueId(refererModule, elementType, elementName);

        // the element id + referer
        if (uniqueId in this._elementsCache) {
            return this._elementsCache[uniqueId];
        }

        let targetModule;        

        if (elementType in refererModule && elementName in refererModule[elementType]) {
            // see if it exists in the same module                        
            targetModule = refererModule;
        } else {
            // search reversely by the namespaces
            //this.log('verbose', `Searching ${elementType} "${elementName}" from "${refererModule.id}" ...`);

            let index = _.findLastIndex(refererModule.namespace, modulePath => {
                //this.log('debug', `Looking for ${elementType} "${elementName}" in "${modulePath}" ...`);

                targetModule = this.loadModule(modulePath);

                return targetModule && targetModule[elementType] && (elementName in targetModule[elementType]);
            });

            if (index === -1) {   
                if (throwOnMissing) {             
                    throw new Error(`${elementType} "${elementName}" not found in imported namespaces. Referer: ${refererModule.id}`);
                }

                return undefined;
            }
        }

        let elementSelfId = elementType + ':' + elementName + '@' + targetModule.id;
        if (elementSelfId in this._elementsCache) {
            // already initialized            
            return (this._elementsCache[uniqueId] = this._elementsCache[elementSelfId]);
        }

        // assert naming validaty
        //assert: !this._mapOfReferenceToModuleId.has(uniqueId), `${elementType} "${elementName}" in "${targetModule.id}" conflicts with ${elementType} in "${this._mapOfReferenceToModuleId.get(uniqueId)}"!`;
        
        this._mapOfReferenceToModuleId.set(uniqueId, targetModule.id);

        // retrieve the compiled info
        let elementInfo = Object.freeze(targetModule[elementType][elementName]);
        let element;

        if (elementType in ELEMENT_CLASS_MAP) {
            // element need linking
            let ElementClass = ELEMENT_CLASS_MAP[elementType];
            element = new ElementClass(this, elementName, targetModule, elementInfo);   
            element.link();         
        } else {
            element = elementInfo;
        }

        this._elementsCache[elementSelfId] = element;
        this._elementsCache[uniqueId] = element;
        
        return element;
    }

    _compile(oolFile) {
        let jsFile;
        
        if (oolFile.endsWith('.json')) {
            jsFile = oolFile;
            oolFile = oolFile.substr(0, oolFile.length - 5);
        } else {
            jsFile = oolFile + '.json';
        }                
        
        let ool, searchExt;

        if (this.useJsonSource) {
            if (!fs.existsSync(jsFile)) {
                throw new Error(`"useJsonSource" enabeld but json file "${jsFile}" not found.`);
            }

            ool = fs.readJsonSync(jsFile);
            searchExt = GEML_SOURCE_EXT + '.json';
        } else {

            //this.log('debug', 'Compiling ' + oolFile + ' ...');        
            
            try {
                ool = OolongParser.parse(fs.readFileSync(oolFile, 'utf8'));
            } catch (error) {
                throw new Error(`Failed to compile "${ oolFile }".\n${ error.message || error }`)
            }

            if (!ool) {
                throw new Error('Unknown error occurred while compiling.');
            }       
            
            searchExt = GEML_SOURCE_EXT;
        }

        let baseName = path.basename(oolFile, GEML_SOURCE_EXT);

        let namespace = [];

        let currentPath = path.dirname(oolFile);

        /**
         * 
         * @param {*} namespaces - Searching path
         * @param {string} ns - Import line
         * @param {*} recursive 
         */
        function expandNs(namespaces, ns, recursive) {
            let stats = fs.statSync(ns);

            //import '/path/user.ool'
            if (stats.isFile() && ns.endsWith(searchExt)) {
                namespaces.push(ns);
                return;
            }

            if (stats.isDirectory() && recursive) {
                //resursive expand sub-directory
                let files = fs.readdirSync(ns);
                files.forEach(f => expandNs(namespaces, path.join(ns, f), true));
            }
        }

        if (ool.namespace) {
            ool.namespace.forEach(ns => {
                let p;
                
                if (ns.startsWith('<oolong>/')) {
                    ns = path.join(BUILTINS_PATH, ns.substr(9));   
                } else if (ns.startsWith('<source>/')) {
                    ns = path.join(this.sourcePath, ns.substr(9));   
                }               

                if (ns.endsWith('/*')) {
                    p = path.resolve(currentPath, ns.substr(0, ns.length - 2));
                    let files = fs.readdirSync(p);
                    files.forEach(f => expandNs(namespace, path.join(p, f), false));
                } else if (ns.endsWith('/**')) {
                    p = path.resolve(currentPath, ns.substr(0, ns.length - 3));
                    let files = fs.readdirSync(p);
                    files.forEach(f => expandNs(namespace, path.join(p, f), true));
                } else {
                    namespace.push(path.resolve(currentPath, _.endsWith(ns, GEML_SOURCE_EXT) ? ns : ns + GEML_SOURCE_EXT));
                }
            });
        }

        ool.namespace = namespace;

        ool.id = this.getModuleIdByPath(oolFile);        
        ool.name = baseName;       
        
        if (!this.useJsonSource && this.saveIntermediate) {                 
            fs.writeFileSync(jsFile, JSON.stringify(ool, null, 4));
        }

        return ool;
    }
}

module.exports = Linker;