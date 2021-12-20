"use strict";

require("source-map-support/register");

const path = require('path');

const {
  _
} = require('@genx/july');

const {
  fs,
  glob
} = require('@genx/sys');

const {
  Types
} = require('@genx/data');

const Geml = require('./grammar/geml');

const GemlParser = Geml.parser;

const GemlTypes = require('./GemlTypes');

const Entity = require('./Entity');

const Schema = require('./Schema');

const View = require('./View');

const Dataset = require('./Dataset');

const ELEMENT_CLASS_MAP = {
  [GemlTypes.Element.ENTITY]: Entity,
  [GemlTypes.Element.VIEW]: View,
  [GemlTypes.Element.DATASET]: Dataset
};
const GEML_SOURCE_EXT = '.geml';
const BUILTINS_PATH = path.resolve(__dirname, 'builtins');

class Linker {
  static getGemlFiles(sourceDir, useJsonSource, recursive) {
    let pattern = '*' + GEML_SOURCE_EXT;

    if (useJsonSource) {
      pattern += '.json';
    }

    if (recursive) {
      pattern = '**/' + pattern;
    }

    return glob.sync(path.join(sourceDir, pattern), {
      nodir: true
    });
  }

  constructor(app, context) {
    this.app = app;
    this.sourcePath = context.gemlPath;
    this.useJsonSource = context.useJsonSource;
    this.saveIntermediate = context.saveIntermediate;
    this.schemas = {};
    this.dependencies = context.dependencies ?? {};
    this._gemlModules = {};
    this._elementsCache = {};
    this._mapOfReferenceToModuleId = new Map();
  }

  log(...args) {
    this.app.log(...args);
  }

  isModuleLoaded(moduleId) {
    return moduleId in this._gemlModules;
  }

  getModuleById(moduleId) {
    return this._gemlModules[moduleId];
  }

  link(entryFileName) {
    let entryModule = this.loadModule(entryFileName);

    if (!entryModule) {
      throw new Error(`Cannot resolve file "${entryFileName}".`);
    }

    if (_.isEmpty(entryModule.schema)) {
      throw new Error('No schema defined in entry file.');
    }

    _.forOwn(entryModule.schema, (schemaInfo, schemaName) => {
      let schema = new Schema(this, schemaName, entryModule, schemaInfo);
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

  loadModule(modulePath, packageName) {
    modulePath = path.resolve(this.sourcePath, modulePath);
    let id = this.getModuleIdByPath(modulePath);

    if (this.isModuleLoaded(id)) {
      return this.getModuleById(id);
    }

    if (!fs.existsSync(modulePath)) {
      return undefined;
    }

    let gemlModule = this._compile(modulePath, packageName);

    return this._gemlModules[id] = gemlModule;
  }

  getTypeInfo(name, location) {
    const gemlModule = this.getModuleById(location);
    return gemlModule.type[name];
  }

  trackBackType(gemlModule, info) {
    if (Types.Builtin.has(info.type)) {
      return [info];
    }

    let baseInfo = this.loadElement(gemlModule, GemlTypes.Element.TYPE, info.type, true);

    if (!Types.Builtin.has(baseInfo.type)) {
      let ownerModule = baseInfo.gemlModule;
      let [rootTypeInfo] = this.trackBackType(ownerModule, baseInfo);
      ownerModule.type[baseInfo.type] = rootTypeInfo;
      baseInfo = rootTypeInfo;
    }

    let derivedInfo = { ..._.cloneDeep(_.omit(baseInfo, ['gemlModule', 'modifiers'])),
      ..._.omit(info, ['gemlModule', 'type', 'modifiers'])
    };

    if (baseInfo.modifiers || info.modifiers) {
      derivedInfo.modifiers = [...(baseInfo.modifiers || []), ...(info.modifiers || [])];
    }

    if (!derivedInfo.subClass) {
      derivedInfo.subClass = [];
    }

    derivedInfo.subClass.push(info.type);
    return [derivedInfo, baseInfo];
  }

  translateOolValue(gemlModule, value) {
    if (_.isPlainObject(value)) {
      if (value.oolType === GemlTypes.Lang.CONST_REF) {
        let refedValue = this.loadElement(gemlModule, GemlTypes.Element.CONST, value.name, true);
        let uniqueId = this.getElementUniqueId(gemlModule, GemlTypes.Element.CONST, value.name);
        let ownerModule = this.getModuleById(this._mapOfReferenceToModuleId.get(uniqueId));
        return this.translateOolValue(ownerModule, refedValue);
      } else if (value.oolType) {
        throw new Error(`todo: translateOolValue with type: ${value.oolType}`);
      }

      return _.mapValues(value, v => this.translateOolValue(gemlModule, v));
    }

    if (Array.isArray(value)) {
      return value.map(v => this.translateOolValue(gemlModule, v));
    }

    return value;
  }

  getModuleIdByPath(modulePath) {
    let isBuiltinEntity = _.startsWith(modulePath, BUILTINS_PATH);

    return isBuiltinEntity ? path.relative(BUILTINS_PATH, modulePath) : './' + path.relative(this.sourcePath, modulePath);
  }

  getElementUniqueId(refererModule, elementType, elementName) {
    return elementType + ':' + elementName + '<-' + refererModule.id;
  }

  loadEntity(refererModule, elementName, throwOnMissing = true) {
    let entity = this.loadElement(refererModule, GemlTypes.Element.ENTITY, elementName, throwOnMissing);

    if (entity && _.isEmpty(entity.fields) && _.isEmpty(entity.info.associations)) {
      throw new Error(`Entity "${elementName}" has no any fields defined.`);
    }

    return entity;
  }

  loadType(refererModule, elementName, throwOnMissing = true) {
    return this.loadElement(refererModule, GemlTypes.Element.TYPE, elementName, throwOnMissing);
  }

  loadDataset(refererModule, elementName, throwOnMissing = true) {
    return this.loadElement(refererModule, GemlTypes.Element.DATASET, elementName, throwOnMissing);
  }

  loadView(refererModule, elementName, throwOnMissing = true) {
    return this.loadElement(refererModule, GemlTypes.Element.VIEW, elementName, throwOnMissing);
  }

  loadElement(refererModule, elementType, elementName, throwOnMissing) {
    let uniqueId = this.getElementUniqueId(refererModule, elementType, elementName);

    if (uniqueId in this._elementsCache) {
      return this._elementsCache[uniqueId];
    }

    let targetModule;

    if (elementType in refererModule && elementName in refererModule[elementType]) {
      targetModule = refererModule;
    } else {
      let index = _.findLastIndex(refererModule.namespace, modulePath => {
        let packageName;

        if (Array.isArray(modulePath)) {
          packageName = modulePath[1];
          modulePath = modulePath[0];
        }

        targetModule = this.loadModule(modulePath, packageName);

        if (!targetModule) {
          return undefined;
        }

        return targetModule[elementType] && elementName in targetModule[elementType];
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
      return this._elementsCache[uniqueId] = this._elementsCache[elementSelfId];
    }

    this._mapOfReferenceToModuleId.set(uniqueId, targetModule.id);

    let elementInfo = targetModule[elementType][elementName];
    let element;

    if (elementType in ELEMENT_CLASS_MAP) {
      let ElementClass = ELEMENT_CLASS_MAP[elementType];
      element = new ElementClass(this, elementName, targetModule, elementInfo);
      element.link();
    } else {
      if (elementType === GemlTypes.Element.TYPE) {
        element = { ...elementInfo,
          gemlModule: targetModule
        };
      } else {
        element = elementInfo;
      }
    }

    this._elementsCache[elementSelfId] = element;
    this._elementsCache[uniqueId] = element;
    return element;
  }

  _compile(oolFile, packageName) {
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
      try {
        ool = GemlParser.parse(fs.readFileSync(oolFile, 'utf8'));
      } catch (error) {
        throw new Error(`Failed to compile "${oolFile}".\n${error.message || error}`);
      }

      if (!ool) {
        throw new Error('Unknown error occurred while compiling.');
      }

      searchExt = GEML_SOURCE_EXT;
    }

    let baseName = path.basename(oolFile, GEML_SOURCE_EXT);
    let namespace = [];
    let currentPath = path.dirname(oolFile);

    function expandNs(namespaces, ns, recursive, packageName) {
      let stats = fs.statSync(ns);

      if (stats.isFile() && ns.endsWith(searchExt)) {
        if (packageName) {
          namespaces.push([ns, packageName]);
        } else {
          namespaces.push(ns);
        }

        return;
      }

      if (stats.isDirectory() && recursive) {
        let files = fs.readdirSync(ns);
        files.forEach(f => expandNs(namespaces, path.join(ns, f), true, packageName));
      }
    }

    if (ool.namespace) {
      ool.namespace.forEach(ns => {
        let p;
        let packageName;
        const packageSep = ns.indexOf(':');

        if (packageSep > 0) {
          packageName = ns.substring(0, packageSep);
          const pkgPath = this.dependencies[packageName];

          if (pkgPath == null) {
            throw new Error(`Package "${packageName}" not found in geml dependencies settings.`);
          }

          ns = path.join(pkgPath, ns.substring(packageSep + 1));
        }

        if (ns.endsWith('/*')) {
          p = path.resolve(currentPath, ns.substr(0, ns.length - 2));
          let files = fs.readdirSync(p);
          files.forEach(f => expandNs(namespace, path.join(p, f), false, packageName));
        } else if (ns.endsWith('/**')) {
          p = path.resolve(currentPath, ns.substr(0, ns.length - 3));
          let files = fs.readdirSync(p);
          files.forEach(f => expandNs(namespace, path.join(p, f), true, packageName));
        } else {
          ns = path.resolve(currentPath, _.endsWith(ns, GEML_SOURCE_EXT) ? ns : ns + GEML_SOURCE_EXT);

          if (packageName) {
            namespace.push([ns, packageName]);
          } else {
            namespace.push(ns);
          }
        }
      });
    }

    ool.namespace = namespace;
    ool.id = this.getModuleIdByPath(oolFile);

    if (packageName) {
      ool.packageName = packageName;
    }

    ool.name = baseName;

    if (!this.useJsonSource && this.saveIntermediate) {
      fs.writeFileSync(jsFile, JSON.stringify(ool, null, 4));
    }

    return ool;
  }

}

module.exports = Linker;
//# sourceMappingURL=Linker.js.map