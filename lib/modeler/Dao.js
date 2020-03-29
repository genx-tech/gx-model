"use strict";

require("source-map-support/register");

const path = require('path');

const {
  _,
  fs,
  pascalCase,
  replaceAll,
  putIntoBucket
} = require('rk-utils');

const swig = require('swig-templates');

const OolTypes = require('../lang/OolTypes');

const JsLang = require('./util/ast.js');

const OolToAst = require('./util/oolToAst.js');

const Snippets = require('./dao/snippets');

const ChainableType = [OolToAst.AST_BLK_VALIDATOR_CALL, OolToAst.AST_BLK_PROCESSOR_CALL, OolToAst.AST_BLK_ACTIVATOR_CALL];

const getFieldName = t => t.split('.').pop();

const isChainable = (current, next) => ChainableType.indexOf(current.type) > -1 && current.target === next.target && next.type === current.type;

const chainCall = (lastBlock, lastType, currentBlock, currentType) => {
  if (lastBlock) {
    if (lastType === 'ValidatorCall') {
      if (!(currentType === 'ValidatorCall')) {
        throw new Error('Unexpected currentType');
      }

      currentBlock = JsLang.astBinExp(lastBlock, '&&', currentBlock);
    } else {
      if (!(currentType === 'ProcessorCall')) {
        throw new Error('Unexpected currentType: ' + currentType + ' last: ' + lastType);
      }

      currentBlock.arguments[0] = lastBlock;
    }
  }

  return currentBlock;
};

const asyncMethodNaming = name => name + '_';

const indentLines = (lines, indentation) => lines.split('\n').map((line, i) => i === 0 ? line : _.repeat(' ', indentation) + line).join('\n');

const OOL_MODIFIER_RETURN = {
  [OolTypes.Modifier.VALIDATOR]: () => [JsLang.astReturn(true)],
  [OolTypes.Modifier.PROCESSOR]: args => [JsLang.astReturn(JsLang.astId(args[0]))],
  [OolTypes.Modifier.ACTIVATOR]: () => [JsLang.astReturn(JsLang.astId("undefined"))]
};

class DaoModeler {
  constructor(context, connector) {
    this.linker = context.linker;
    this.outputPath = context.modelPath;
    this.manifestPath = context.manifestPath;
    this.connector = connector;
  }

  modeling_(schema) {
    this.linker.log('info', 'Generating entity models for schema "' + schema.name + '"...');

    this._generateSchemaModel(schema);

    this._generateEntityModel(schema);

    if (this.manifestPath) {
      this._generateEntityManifest(schema);
    }
  }

  _generateSchemaModel(schema) {
    let capitalized = pascalCase(schema.name);
    let locals = {
      driver: this.connector.driver,
      className: capitalized,
      schemaName: schema.name,
      entities: JSON.stringify(Object.keys(schema.entities))
    };
    let classTemplate = path.resolve(__dirname, 'database', this.connector.driver, 'Database.js.swig');
    let classCode = swig.renderFile(classTemplate, locals);
    let modelFilePath = path.resolve(this.outputPath, capitalized + '.js');
    fs.ensureFileSync(modelFilePath);
    fs.writeFileSync(modelFilePath, classCode);
    this.linker.log('info', 'Generated database model: ' + modelFilePath);
  }

  _generateEnumTypes(schema) {
    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      _.forOwn(entity.fields, (field, fieldName) => {
        if (field.type === 'enum') {}
      });
    });
  }

  _generateEntityModel(schema) {
    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      let capitalized = pascalCase(entityInstanceName);
      let sharedContext = {
        mapOfFunctorToFile: {},
        newFunctorFiles: []
      };

      let {
        ast: astClassMain,
        fieldReferences
      } = this._processFieldModifiers(entity, sharedContext);

      astClassMain = [astClassMain];
      let uniqueKeys = [_.castArray(entity.key)];

      if (entity.indexes) {
        entity.indexes.forEach(index => {
          if (index.unique) {
            uniqueKeys.push(index.fields);
          }
        });
      }

      let modelMeta = {
        schemaName: schema.name,
        name: entityInstanceName,
        keyField: entity.key,
        fields: _.mapValues(entity.fields, f => _.omit(f.toJSON(), 'modifiers')),
        features: entity.features || {},
        uniqueKeys
      };

      if (entity.baseClasses) {
        modelMeta.baseClasses = entity.baseClasses;
      }

      if (!_.isEmpty(entity.indexes)) {
        modelMeta.indexes = entity.indexes;
      }

      if (!_.isEmpty(entity.features)) {
        modelMeta.features = entity.features;
      }

      if (!_.isEmpty(entity.associations)) {
        modelMeta.associations = entity.associations;
      }

      if (!_.isEmpty(fieldReferences)) {
        modelMeta.fieldDependencies = fieldReferences;
      }

      if (entity.interfaces) {
        let astInterfaces = this._buildInterfaces(entity, modelMeta, sharedContext);

        astClassMain = astClassMain.concat(astInterfaces);
      }

      let importLines = [];

      if (!_.isEmpty(sharedContext.mapOfFunctorToFile)) {
        _.forOwn(sharedContext.mapOfFunctorToFile, (fileName, functionName) => {
          importLines.push(JsLang.astToCode(JsLang.astRequire(functionName, fileName)));
        });
      }

      if (!_.isEmpty(sharedContext.newFunctorFiles)) {
        _.each(sharedContext.newFunctorFiles, entry => {
          this._generateFunctionTemplateFile(schema, entry);
        });
      }

      let mixins = [];

      if (!_.isEmpty(entity.info.mixins)) {
        let mixinsDirPath = path.resolve(this.outputPath, schema.name, 'mixins');
        fs.ensureDirSync(mixinsDirPath);
        entity.info.mixins.forEach(m => {
          let mixinName = pascalCase(m);
          let mixinFilePath = path.join(mixinsDirPath, mixinName + '.js');

          if (!fs.pathExistsSync(mixinFilePath)) {
            fs.writeFileSync(mixinFilePath, `const {
    Errors: { ValidationError, DatabaseError },
    Processors,
    Validators
} = require("@genx/data");
const { _ } = require("rk-utils");

module.exports = ${capitalized} => class extends ${capitalized} {
    //todo: add staic methods
};`);
          }

          let mixinVarName = 'mixin' + mixinName;
          importLines.push(JsLang.astToCode(JsLang.astRequire(mixinVarName, './mixins/' + mixinName)));
          mixins.push(mixinVarName);
        });
      }

      let locals = {
        imports: importLines.join('\n'),
        className: capitalized,
        entityMeta: indentLines(JSON.stringify(modelMeta, null, 4), 4),
        classBody: indentLines(astClassMain.map(block => JsLang.astToCode(block)).join('\n\n'), 8),
        functors: indentLines(JsLang.astToCode(JsLang.astValue(_.reduce(sharedContext.newFunctorFiles, (result, functor) => {
          result['$' + functor.functionName] = JsLang.astId(functor.functionName);
          return result;
        }, {}))), 4),
        mixins
      };
      let classTemplate = path.resolve(__dirname, 'database', this.connector.driver, 'EntityModel.js.swig');
      let classCode = swig.renderFile(classTemplate, locals);
      let modelFilePath = path.resolve(this.outputPath, schema.name, capitalized + '.js');
      fs.ensureFileSync(modelFilePath);
      fs.writeFileSync(modelFilePath, classCode);
      this.linker.log('info', 'Generated entity model: ' + modelFilePath);
    });
  }

  _generateEntityManifest(schema) {
    let entities = Object.keys(schema.entities).sort().reduce((result, v) => {
      result[v] = {};
      return result;
    }, {});
    let outputFilePath = path.resolve(this.manifestPath, schema.name + '.manifest.json');
    fs.ensureFileSync(outputFilePath);
    fs.writeFileSync(outputFilePath, JSON.stringify(entities, null, 4));
    this.linker.log('info', 'Generated schema manifest: ' + outputFilePath);
  }

  _processFieldModifiers(entity, sharedContext) {
    let compileContext = OolToAst.createCompileContext(entity.oolModule.name, this.linker, sharedContext);
    compileContext.variables['raw'] = {
      source: 'context',
      finalized: true
    };
    compileContext.variables['i18n'] = {
      source: 'context',
      finalized: true
    };
    compileContext.variables['connector'] = {
      source: 'context',
      finalized: true
    };
    compileContext.variables['latest'] = {
      source: 'context'
    };
    const allFinished = OolToAst.createTopoId(compileContext, 'done.');
    let fieldReferences = {};

    _.forOwn(entity.fields, (field, fieldName) => {
      let topoId = OolToAst.compileField(fieldName, field, compileContext);
      OolToAst.dependsOn(compileContext, topoId, allFinished);

      if (field.writeOnce || field.freezeAfterNonDefault) {
        putIntoBucket(fieldReferences, fieldName, {
          reference: fieldName,
          writeProtect: true
        });
      }
    });

    let deps = compileContext.topoSort.sort();
    deps = deps.filter(dep => compileContext.mapOfTokenToMeta.has(dep));
    let methodBodyValidateAndFill = [],
        lastFieldsGroup,
        methodBodyCache = [],
        lastBlock,
        lastAstType;

    const _mergeDoValidateAndFillCode = function (fieldName, references, astCache, requireTargetField) {
      let fields = [fieldName].concat(references);
      let checker = fields.join(',');

      if (lastFieldsGroup && lastFieldsGroup.checker !== checker) {
        methodBodyValidateAndFill = methodBodyValidateAndFill.concat(Snippets._fieldRequirementCheck(lastFieldsGroup.fieldName, lastFieldsGroup.references, methodBodyCache, lastFieldsGroup.requireTargetField));
        methodBodyCache = [];
      }

      methodBodyCache = methodBodyCache.concat(astCache);
      lastFieldsGroup = {
        fieldName,
        references,
        requireTargetField,
        checker
      };
    };

    _.each(deps, (dep, i) => {
      let sourceMap = compileContext.mapOfTokenToMeta.get(dep);
      let astBlock = compileContext.astMap[dep];
      let targetFieldName = getFieldName(sourceMap.target);

      if (sourceMap.references && sourceMap.references.length > 0) {
        let fieldReference = fieldReferences[targetFieldName];

        if (!fieldReference) {
          fieldReferences[targetFieldName] = fieldReference = [];
        }

        if (sourceMap.type === OolToAst.AST_BLK_ACTIVATOR_CALL) {
          sourceMap.references.forEach(ref => {
            fieldReference.push({
              reference: ref,
              whenNull: true
            });
          });
        } else {
          sourceMap.references.forEach(ref => {
            if (fieldReference.indexOf(ref) === -1) fieldReference.push(ref);
          });
        }
      }

      if (lastBlock) {
        astBlock = chainCall(lastBlock, lastAstType, astBlock, sourceMap.type);
        lastBlock = undefined;
      }

      if (i < deps.length - 1) {
        let nextType = compileContext.mapOfTokenToMeta.get(deps[i + 1]);

        if (isChainable(sourceMap, nextType)) {
          lastBlock = astBlock;
          lastAstType = sourceMap.type;
          return;
        }
      }

      if (sourceMap.type === OolToAst.AST_BLK_VALIDATOR_CALL) {
        let astCache = Snippets._validateCheck(targetFieldName, astBlock);

        _mergeDoValidateAndFillCode(targetFieldName, sourceMap.references, astCache, true);
      } else if (sourceMap.type === OolToAst.AST_BLK_PROCESSOR_CALL) {
        let astCache = JsLang.astAssign(JsLang.astVarRef(sourceMap.target, true), astBlock, `Processing "${targetFieldName}"`);

        _mergeDoValidateAndFillCode(targetFieldName, sourceMap.references, astCache, true);
      } else if (sourceMap.type === OolToAst.AST_BLK_ACTIVATOR_CALL) {
        let astCache = Snippets._checkAndAssign(astBlock, JsLang.astVarRef(sourceMap.target, true), `Activating "${targetFieldName}"`);

        _mergeDoValidateAndFillCode(targetFieldName, sourceMap.references, astCache, false);
      } else {
        throw new Error('To be implemented.');
      }
    });

    if (!_.isEmpty(methodBodyCache)) {
      methodBodyValidateAndFill = methodBodyValidateAndFill.concat(Snippets._fieldRequirementCheck(lastFieldsGroup.fieldName, lastFieldsGroup.references, methodBodyCache, lastFieldsGroup.requireTargetField));
    }

    return {
      ast: JsLang.astMemberMethod(asyncMethodNaming('applyModifiers'), ['context', 'isUpdating'], Snippets._applyModifiersHeader.concat(methodBodyValidateAndFill).concat([JsLang.astReturn(JsLang.astId('context'))]), false, true, true, 'Applying predefined modifiers to entity fields.'),
      fieldReferences
    };
  }

  _generateFunctionTemplateFile(schema, {
    functionName,
    functorType,
    fileName,
    args
  }) {
    let filePath = path.resolve(this.outputPath, schema.name, fileName);

    if (fs.existsSync(filePath)) {
      this.linker.log('info', `${_.upperFirst(functorType)} "${fileName}" exists. File generating skipped.`);
      return;
    }

    let ast = JsLang.astProgram();
    JsLang.astPushInBody(ast, JsLang.astFunction(functionName, args, OOL_MODIFIER_RETURN[functorType](args)));
    JsLang.astPushInBody(ast, JsLang.astAssign('module.exports', JsLang.astVarRef(functionName)));
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, JsLang.astToCode(ast));
    this.linker.log('info', `Generated ${functorType} file: ${filePath}`);
  }

  _buildInterfaces(entity, modelMetaInit, sharedContext) {
    let ast = [];

    _.forOwn(entity.interfaces, (method, name) => {
      this.linker.info('Building interface: ' + name);
      let astBody = [JsLang.astVarDeclare('$meta', JsLang.astVarRef('this.meta.interfaces.' + name), true, false, 'Retrieving the meta data')];
      let compileContext = OolToAst.createCompileContext(entity.oolModule.name, this.linker, sharedContext);
      let paramMeta;

      if (method.accept) {
        paramMeta = this._processParams(method.accept, compileContext);
      }

      modelMetaInit['interfaces'] || (modelMetaInit['interfaces'] = {});
      modelMetaInit['interfaces'][name] = {
        params: Object.values(paramMeta)
      };

      _.each(method.implementation, (operation, index) => {
        OolToAst.compileDbOperation(index, operation, compileContext, compileContext.mainStartId);
      });

      if (method.return) {
        OolToAst.compileExceptionalReturn(method.return, compileContext);
      }

      let deps = compileContext.topoSort.sort();
      deps = deps.filter(dep => compileContext.mapOfTokenToMeta.has(dep));

      _.each(deps, dep => {
        let sourceMap = compileContext.mapOfTokenToMeta.get(dep);
        let astBlock = compileContext.astMap[dep];
        let targetFieldName = sourceMap.target;

        if (sourceMap.type === OolToAst.AST_BLK_VALIDATOR_CALL) {
          astBlock = Snippets._validateCheck(targetFieldName, astBlock);
        } else if (sourceMap.type === OolToAst.AST_BLK_PROCESSOR_CALL) {
          if (sourceMap.needDeclare) {
            astBlock = JsLang.astVarDeclare(JsLang.astVarRef(sourceMap.target), astBlock, false, false, `Processing "${targetFieldName}"`);
          } else {
            astBlock = JsLang.astAssign(JsLang.astVarRef(sourceMap.target, true), astBlock, `Processing "${targetFieldName}"`);
          }
        } else if (sourceMap.type === OolToAst.AST_BLK_ACTIVATOR_CALL) {
          if (sourceMap.needDeclare) {
            astBlock = JsLang.astVarDeclare(JsLang.astVarRef(sourceMap.target), astBlock, false, false, `Processing "${targetFieldName}"`);
          } else {
            astBlock = JsLang.astAssign(JsLang.astVarRef(sourceMap.target, true), astBlock, `Activating "${targetFieldName}"`);
          }
        }

        astBody = astBody.concat(_.castArray(astBlock));
      });

      ast.push(JsLang.astMemberMethod(asyncMethodNaming(name), Object.keys(paramMeta), astBody, false, true, true, replaceAll(_.kebabCase(name), '-', ' ')));
    });

    return ast;
  }

  _processParams(acceptParams, compileContext) {
    let paramMeta = {};
    acceptParams.forEach((param, i) => {
      OolToAst.compileParam(i, param, compileContext);
      paramMeta[param.name] = param;
      compileContext.variables[param.name] = {
        source: 'argument'
      };
    });
    return paramMeta;
  }

}

module.exports = DaoModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9tb2RlbGVyL0Rhby5qcyJdLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsIl8iLCJmcyIsInBhc2NhbENhc2UiLCJyZXBsYWNlQWxsIiwicHV0SW50b0J1Y2tldCIsInN3aWciLCJPb2xUeXBlcyIsIkpzTGFuZyIsIk9vbFRvQXN0IiwiU25pcHBldHMiLCJDaGFpbmFibGVUeXBlIiwiQVNUX0JMS19WQUxJREFUT1JfQ0FMTCIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX0FDVElWQVRPUl9DQUxMIiwiZ2V0RmllbGROYW1lIiwidCIsInNwbGl0IiwicG9wIiwiaXNDaGFpbmFibGUiLCJjdXJyZW50IiwibmV4dCIsImluZGV4T2YiLCJ0eXBlIiwidGFyZ2V0IiwiY2hhaW5DYWxsIiwibGFzdEJsb2NrIiwibGFzdFR5cGUiLCJjdXJyZW50QmxvY2siLCJjdXJyZW50VHlwZSIsImFzdEJpbkV4cCIsImFyZ3VtZW50cyIsImFzeW5jTWV0aG9kTmFtaW5nIiwibmFtZSIsImluZGVudExpbmVzIiwibGluZXMiLCJpbmRlbnRhdGlvbiIsIm1hcCIsImxpbmUiLCJpIiwicmVwZWF0Iiwiam9pbiIsIk9PTF9NT0RJRklFUl9SRVRVUk4iLCJNb2RpZmllciIsIlZBTElEQVRPUiIsImFzdFJldHVybiIsIlBST0NFU1NPUiIsImFyZ3MiLCJhc3RJZCIsIkFDVElWQVRPUiIsIkRhb01vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwibW9kZWxQYXRoIiwibWFuaWZlc3RQYXRoIiwibW9kZWxpbmdfIiwic2NoZW1hIiwibG9nIiwiX2dlbmVyYXRlU2NoZW1hTW9kZWwiLCJfZ2VuZXJhdGVFbnRpdHlNb2RlbCIsIl9nZW5lcmF0ZUVudGl0eU1hbmlmZXN0IiwiY2FwaXRhbGl6ZWQiLCJsb2NhbHMiLCJkcml2ZXIiLCJjbGFzc05hbWUiLCJzY2hlbWFOYW1lIiwiZW50aXRpZXMiLCJKU09OIiwic3RyaW5naWZ5IiwiT2JqZWN0Iiwia2V5cyIsImNsYXNzVGVtcGxhdGUiLCJyZXNvbHZlIiwiX19kaXJuYW1lIiwiY2xhc3NDb2RlIiwicmVuZGVyRmlsZSIsIm1vZGVsRmlsZVBhdGgiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJfZ2VuZXJhdGVFbnVtVHlwZXMiLCJmb3JPd24iLCJlbnRpdHkiLCJlbnRpdHlJbnN0YW5jZU5hbWUiLCJmaWVsZHMiLCJmaWVsZCIsImZpZWxkTmFtZSIsInNoYXJlZENvbnRleHQiLCJtYXBPZkZ1bmN0b3JUb0ZpbGUiLCJuZXdGdW5jdG9yRmlsZXMiLCJhc3QiLCJhc3RDbGFzc01haW4iLCJmaWVsZFJlZmVyZW5jZXMiLCJfcHJvY2Vzc0ZpZWxkTW9kaWZpZXJzIiwidW5pcXVlS2V5cyIsImNhc3RBcnJheSIsImtleSIsImluZGV4ZXMiLCJmb3JFYWNoIiwiaW5kZXgiLCJ1bmlxdWUiLCJwdXNoIiwibW9kZWxNZXRhIiwia2V5RmllbGQiLCJtYXBWYWx1ZXMiLCJmIiwib21pdCIsInRvSlNPTiIsImZlYXR1cmVzIiwiYmFzZUNsYXNzZXMiLCJpc0VtcHR5IiwiYXNzb2NpYXRpb25zIiwiZmllbGREZXBlbmRlbmNpZXMiLCJpbnRlcmZhY2VzIiwiYXN0SW50ZXJmYWNlcyIsIl9idWlsZEludGVyZmFjZXMiLCJjb25jYXQiLCJpbXBvcnRMaW5lcyIsImZpbGVOYW1lIiwiZnVuY3Rpb25OYW1lIiwiYXN0VG9Db2RlIiwiYXN0UmVxdWlyZSIsImVhY2giLCJlbnRyeSIsIl9nZW5lcmF0ZUZ1bmN0aW9uVGVtcGxhdGVGaWxlIiwibWl4aW5zIiwiaW5mbyIsIm1peGluc0RpclBhdGgiLCJlbnN1cmVEaXJTeW5jIiwibSIsIm1peGluTmFtZSIsIm1peGluRmlsZVBhdGgiLCJwYXRoRXhpc3RzU3luYyIsIm1peGluVmFyTmFtZSIsImltcG9ydHMiLCJlbnRpdHlNZXRhIiwiY2xhc3NCb2R5IiwiYmxvY2siLCJmdW5jdG9ycyIsImFzdFZhbHVlIiwicmVkdWNlIiwicmVzdWx0IiwiZnVuY3RvciIsInNvcnQiLCJ2Iiwib3V0cHV0RmlsZVBhdGgiLCJjb21waWxlQ29udGV4dCIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwib29sTW9kdWxlIiwidmFyaWFibGVzIiwic291cmNlIiwiZmluYWxpemVkIiwiYWxsRmluaXNoZWQiLCJjcmVhdGVUb3BvSWQiLCJ0b3BvSWQiLCJjb21waWxlRmllbGQiLCJkZXBlbmRzT24iLCJ3cml0ZU9uY2UiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJyZWZlcmVuY2UiLCJ3cml0ZVByb3RlY3QiLCJkZXBzIiwidG9wb1NvcnQiLCJmaWx0ZXIiLCJkZXAiLCJtYXBPZlRva2VuVG9NZXRhIiwiaGFzIiwibWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCIsImxhc3RGaWVsZHNHcm91cCIsIm1ldGhvZEJvZHlDYWNoZSIsImxhc3RBc3RUeXBlIiwiX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlIiwicmVmZXJlbmNlcyIsImFzdENhY2hlIiwicmVxdWlyZVRhcmdldEZpZWxkIiwiY2hlY2tlciIsIl9maWVsZFJlcXVpcmVtZW50Q2hlY2siLCJzb3VyY2VNYXAiLCJnZXQiLCJhc3RCbG9jayIsImFzdE1hcCIsInRhcmdldEZpZWxkTmFtZSIsImxlbmd0aCIsImZpZWxkUmVmZXJlbmNlIiwicmVmIiwid2hlbk51bGwiLCJ1bmRlZmluZWQiLCJuZXh0VHlwZSIsIl92YWxpZGF0ZUNoZWNrIiwiYXN0QXNzaWduIiwiYXN0VmFyUmVmIiwiX2NoZWNrQW5kQXNzaWduIiwiRXJyb3IiLCJhc3RNZW1iZXJNZXRob2QiLCJfYXBwbHlNb2RpZmllcnNIZWFkZXIiLCJmdW5jdG9yVHlwZSIsImZpbGVQYXRoIiwiZXhpc3RzU3luYyIsInVwcGVyRmlyc3QiLCJhc3RQcm9ncmFtIiwiYXN0UHVzaEluQm9keSIsImFzdEZ1bmN0aW9uIiwibW9kZWxNZXRhSW5pdCIsIm1ldGhvZCIsImFzdEJvZHkiLCJhc3RWYXJEZWNsYXJlIiwicGFyYW1NZXRhIiwiYWNjZXB0IiwiX3Byb2Nlc3NQYXJhbXMiLCJwYXJhbXMiLCJ2YWx1ZXMiLCJpbXBsZW1lbnRhdGlvbiIsIm9wZXJhdGlvbiIsImNvbXBpbGVEYk9wZXJhdGlvbiIsIm1haW5TdGFydElkIiwicmV0dXJuIiwiY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuIiwibmVlZERlY2xhcmUiLCJrZWJhYkNhc2UiLCJhY2NlcHRQYXJhbXMiLCJwYXJhbSIsImNvbXBpbGVQYXJhbSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsRUFBTDtBQUFTQyxFQUFBQSxVQUFUO0FBQXFCQyxFQUFBQSxVQUFyQjtBQUFpQ0MsRUFBQUE7QUFBakMsSUFBb0RMLE9BQU8sQ0FBQyxVQUFELENBQWpFOztBQUNBLE1BQU1NLElBQUksR0FBSU4sT0FBTyxDQUFDLGdCQUFELENBQXJCOztBQUVBLE1BQU1PLFFBQVEsR0FBR1AsT0FBTyxDQUFDLGtCQUFELENBQXhCOztBQUNBLE1BQU1RLE1BQU0sR0FBR1IsT0FBTyxDQUFDLGVBQUQsQ0FBdEI7O0FBQ0EsTUFBTVMsUUFBUSxHQUFHVCxPQUFPLENBQUMsb0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVUsUUFBUSxHQUFHVixPQUFPLENBQUMsZ0JBQUQsQ0FBeEI7O0FBRUEsTUFBTVcsYUFBYSxHQUFHLENBQ2xCRixRQUFRLENBQUNHLHNCQURTLEVBRWxCSCxRQUFRLENBQUNJLHNCQUZTLEVBR2xCSixRQUFRLENBQUNLLHNCQUhTLENBQXRCOztBQU1BLE1BQU1DLFlBQVksR0FBR0MsQ0FBQyxJQUFJQSxDQUFDLENBQUNDLEtBQUYsQ0FBUSxHQUFSLEVBQWFDLEdBQWIsRUFBMUI7O0FBQ0EsTUFBTUMsV0FBVyxHQUFHLENBQUNDLE9BQUQsRUFBVUMsSUFBVixLQUFtQlYsYUFBYSxDQUFDVyxPQUFkLENBQXNC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XG5jb25zdCB7IF8sIGZzLCBwYXNjYWxDYXNlLCByZXBsYWNlQWxsLCBwdXRJbnRvQnVja2V0IH0gID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHN3aWcgID0gcmVxdWlyZSgnc3dpZy10ZW1wbGF0ZXMnKTtcblxuY29uc3QgT29sVHlwZXMgPSByZXF1aXJlKCcuLi9sYW5nL09vbFR5cGVzJyk7XG5jb25zdCBKc0xhbmcgPSByZXF1aXJlKCcuL3V0aWwvYXN0LmpzJyk7XG5jb25zdCBPb2xUb0FzdCA9IHJlcXVpcmUoJy4vdXRpbC9vb2xUb0FzdC5qcycpO1xuY29uc3QgU25pcHBldHMgPSByZXF1aXJlKCcuL2Rhby9zbmlwcGV0cycpO1xuXG5jb25zdCBDaGFpbmFibGVUeXBlID0gW1xuICAgIE9vbFRvQXN0LkFTVF9CTEtfVkFMSURBVE9SX0NBTEwsIFxuICAgIE9vbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgT29sVG9Bc3QuQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTFxuXTtcblxuY29uc3QgZ2V0RmllbGROYW1lID0gdCA9PiB0LnNwbGl0KCcuJykucG9wKCk7XG5jb25zdCBpc0NoYWluYWJsZSA9IChjdXJyZW50LCBuZXh0KSA9PiBDaGFpbmFibGVUeXBlLmluZGV4T2YoY3VycmVudC50eXBlKSA+IC0xXG4gICAgJiYgY3VycmVudC50YXJnZXQgPT09IG5leHQudGFyZ2V0XG4gICAgJiYgbmV4dC50eXBlID09PSBjdXJyZW50LnR5cGU7XG5jb25zdCBjaGFpbkNhbGwgPSAobGFzdEJsb2NrLCBsYXN0VHlwZSwgY3VycmVudEJsb2NrLCBjdXJyZW50VHlwZSkgPT4ge1xuICAgIGlmIChsYXN0QmxvY2spIHtcbiAgICAgICAgaWYgKGxhc3RUeXBlID09PSAnVmFsaWRhdG9yQ2FsbCcpIHtcbiAgICAgICAgICAgIGFzc2VydDogY3VycmVudFR5cGUgPT09ICdWYWxpZGF0b3JDYWxsJywgJ1VuZXhwZWN0ZWQgY3VycmVudFR5cGUnO1xuXG4gICAgICAgICAgICBjdXJyZW50QmxvY2sgPSBKc0xhbmcuYXN0QmluRXhwKGxhc3RCbG9jaywgJyYmJywgY3VycmVudEJsb2NrKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc2VydDogY3VycmVudFR5cGUgPT09ICdQcm9jZXNzb3JDYWxsJywgJ1VuZXhwZWN0ZWQgY3VycmVudFR5cGU6ICcgKyBjdXJyZW50VHlwZSArICcgbGFzdDogJyArIGxhc3RUeXBlO1xuXG4gICAgICAgICAgICBjdXJyZW50QmxvY2suYXJndW1lbnRzWzBdID0gbGFzdEJsb2NrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGN1cnJlbnRCbG9jaztcbn07XG5jb25zdCBhc3luY01ldGhvZE5hbWluZyA9IChuYW1lKSA9PiBuYW1lICsgJ18nO1xuXG5jb25zdCBpbmRlbnRMaW5lcyA9IChsaW5lcywgaW5kZW50YXRpb24pID0+IGxpbmVzLnNwbGl0KCdcXG4nKS5tYXAoKGxpbmUsIGkpID0+IGkgPT09IDAgPyBsaW5lIDogKF8ucmVwZWF0KCcgJywgaW5kZW50YXRpb24pICsgbGluZSkpLmpvaW4oJ1xcbicpO1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfUkVUVVJOID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAoKSA9PiBbIEpzTGFuZy5hc3RSZXR1cm4odHJ1ZSkgXSxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogYXJncyA9PiBbIEpzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKGFyZ3NbMF0pKSBdLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAoKSA9PiBbIEpzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKFwidW5kZWZpbmVkXCIpKSBdXG59O1xuXG4vKipcbiAqIE9vbG9uZyBkYXRhYmFzZSBhY2Nlc3Mgb2JqZWN0IChEQU8pIG1vZGVsZXIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRGFvTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAgIFxuICAgICAqIEBwcm9wZXJ0eSB7R2VtbExpbmtlcn0gY29udGV4dC5saW5rZXIgLSBHZW1sIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0Lm1vZGVsUGF0aCAtIEdlbmVyYXRlZCBtb2RlbCBvdXRwdXQgcGF0aFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0Lm1hbmlmZXN0UGF0aCAtIEVudGl0aWVzIG1hbmlmZXN0IG91dHB1dCBwYXRoXG4gICAgICogQHBhcmFtIHtDb25uZWN0b3J9IGNvbm5lY3RvciAgICAgIFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvcikgeyAgICAgICBcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5tb2RlbFBhdGg7XG4gICAgICAgIHRoaXMubWFuaWZlc3RQYXRoID0gY29udGV4dC5tYW5pZmVzdFBhdGg7XG5cbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7ICAgICAgICBcbiAgICB9XG5cbiAgICBtb2RlbGluZ18oc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIGVudGl0eSBtb2RlbHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIHRoaXMuX2dlbmVyYXRlU2NoZW1hTW9kZWwoc2NoZW1hKTsgICAgICAgIFxuICAgICAgICB0aGlzLl9nZW5lcmF0ZUVudGl0eU1vZGVsKHNjaGVtYSk7XG4gICAgICAgIC8vdGhpcy5fZ2VuZXJhdGVFbnVtVHlwZXMoc2NoZW1hKTtcbiAgICAgICAgLy90aGlzLl9nZW5lcmF0ZVZpZXdNb2RlbCgpO1xuXG4gICAgICAgIGlmICh0aGlzLm1hbmlmZXN0UGF0aCkge1xuICAgICAgICAgICAgdGhpcy5fZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdChzY2hlbWEpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlU2NoZW1hTW9kZWwoc2NoZW1hKSB7XG4gICAgICAgIGxldCBjYXBpdGFsaXplZCA9IHBhc2NhbENhc2Uoc2NoZW1hLm5hbWUpO1xuXG4gICAgICAgIGxldCBsb2NhbHMgPSB7XG4gICAgICAgICAgICBkcml2ZXI6IHRoaXMuY29ubmVjdG9yLmRyaXZlcixcbiAgICAgICAgICAgIGNsYXNzTmFtZTogY2FwaXRhbGl6ZWQsXG4gICAgICAgICAgICBzY2hlbWFOYW1lOiBzY2hlbWEubmFtZSxcbiAgICAgICAgICAgIGVudGl0aWVzOiBKU09OLnN0cmluZ2lmeShPYmplY3Qua2V5cyhzY2hlbWEuZW50aXRpZXMpKVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBjbGFzc1RlbXBsYXRlID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJ2RhdGFiYXNlJywgdGhpcy5jb25uZWN0b3IuZHJpdmVyLCAnRGF0YWJhc2UuanMuc3dpZycpO1xuICAgICAgICBsZXQgY2xhc3NDb2RlID0gc3dpZy5yZW5kZXJGaWxlKGNsYXNzVGVtcGxhdGUsIGxvY2Fscyk7XG5cbiAgICAgICAgbGV0IG1vZGVsRmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBjYXBpdGFsaXplZCArICcuanMnKTtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCwgY2xhc3NDb2RlKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRhdGFiYXNlIG1vZGVsOiAnICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW51bVR5cGVzKHNjaGVtYSkge1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZpZWxkcywgKGZpZWxkLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2VudW0nKSB7XG5cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5TW9kZWwoc2NoZW1hKSB7XG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5SW5zdGFuY2VOYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBwYXNjYWxDYXNlKGVudGl0eUluc3RhbmNlTmFtZSk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIC8vc2hhcmVkIGluZm9ybWF0aW9uIHdpdGggbW9kZWwgQ1JVRCBhbmQgY3VzdG9taXplZCBpbnRlcmZhY2VzXG4gICAgICAgICAgICBsZXQgc2hhcmVkQ29udGV4dCA9IHtcbiAgICAgICAgICAgICAgICBtYXBPZkZ1bmN0b3JUb0ZpbGU6IHt9LFxuICAgICAgICAgICAgICAgIG5ld0Z1bmN0b3JGaWxlczogW11cbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGxldCB7IGFzdDogYXN0Q2xhc3NNYWluLCBmaWVsZFJlZmVyZW5jZXMgfSA9IHRoaXMuX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyhlbnRpdHksIHNoYXJlZENvbnRleHQpO1xuICAgICAgICAgICAgYXN0Q2xhc3NNYWluID0gWyBhc3RDbGFzc01haW4gXTtcblxuICAgICAgICAgICAgLy9wcmVwYXJlIG1ldGEgZGF0YVxuICAgICAgICAgICAgbGV0IHVuaXF1ZUtleXMgPSBbIF8uY2FzdEFycmF5KGVudGl0eS5rZXkpIF07XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcykge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB1bmlxdWVLZXlzLnB1c2goaW5kZXguZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbW9kZWxNZXRhID0ge1xuICAgICAgICAgICAgICAgIHNjaGVtYU5hbWU6IHNjaGVtYS5uYW1lLFxuICAgICAgICAgICAgICAgIG5hbWU6IGVudGl0eUluc3RhbmNlTmFtZSxcbiAgICAgICAgICAgICAgICBrZXlGaWVsZDogZW50aXR5LmtleSwgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZmllbGRzOiBfLm1hcFZhbHVlcyhlbnRpdHkuZmllbGRzLCBmID0+IF8ub21pdChmLnRvSlNPTigpLCAnbW9kaWZpZXJzJykpLFxuICAgICAgICAgICAgICAgIGZlYXR1cmVzOiBlbnRpdHkuZmVhdHVyZXMgfHwge30sXG4gICAgICAgICAgICAgICAgdW5pcXVlS2V5c1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5iYXNlQ2xhc3Nlcykge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5iYXNlQ2xhc3NlcyA9IGVudGl0eS5iYXNlQ2xhc3NlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZGV4ZXMpKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmluZGV4ZXMgPSBlbnRpdHkuaW5kZXhlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmZlYXR1cmVzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5mZWF0dXJlcyA9IGVudGl0eS5mZWF0dXJlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuYXNzb2NpYXRpb25zID0gZW50aXR5LmFzc29jaWF0aW9ucztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZmllbGRSZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5maWVsZERlcGVuZGVuY2llcyA9IGZpZWxkUmVmZXJlbmNlcztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgLy9idWlsZCBjdXN0b21pemVkIGludGVyZmFjZXMgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW50ZXJmYWNlcykge1xuICAgICAgICAgICAgICAgIGxldCBhc3RJbnRlcmZhY2VzID0gdGhpcy5fYnVpbGRJbnRlcmZhY2VzKGVudGl0eSwgbW9kZWxNZXRhLCBzaGFyZWRDb250ZXh0KTtcbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUubG9nKGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgICAgIC8vbGV0IGFzdENsYXNzID0gYXN0Q2xhc3NNYWluW2FzdENsYXNzTWFpbi5sZW5ndGggLSAxXTtcbiAgICAgICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdENsYXNzLCBhc3RJbnRlcmZhY2VzKTtcbiAgICAgICAgICAgICAgICBhc3RDbGFzc01haW4gPSBhc3RDbGFzc01haW4uY29uY2F0KGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgaW1wb3J0TGluZXMgPSBbXTtcblxuICAgICAgICAgICAgLy9nZW5lcmF0ZSBmdW5jdG9ycyBpZiBhbnlcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSkge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlLCAoZmlsZU5hbWUsIGZ1bmN0aW9uTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpbXBvcnRMaW5lcy5wdXNoKEpzTGFuZy5hc3RUb0NvZGUoSnNMYW5nLmFzdFJlcXVpcmUoZnVuY3Rpb25OYW1lLCBmaWxlTmFtZSkpKVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMsIGVudHJ5ID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZShzY2hlbWEsIGVudHJ5KTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbWl4aW5zID0gW107XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLm1peGlucykpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWl4aW5zRGlyUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIHNjaGVtYS5uYW1lLCAnbWl4aW5zJyk7XG4gICAgICAgICAgICAgICAgZnMuZW5zdXJlRGlyU3luYyhtaXhpbnNEaXJQYXRoKTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLm1peGlucy5mb3JFYWNoKG0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbWl4aW5OYW1lID0gcGFzY2FsQ2FzZShtKTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbWl4aW5GaWxlUGF0aCA9IHBhdGguam9pbihtaXhpbnNEaXJQYXRoLCBtaXhpbk5hbWUgKyAnLmpzJyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZnMucGF0aEV4aXN0c1N5bmMobWl4aW5GaWxlUGF0aCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMobWl4aW5GaWxlUGF0aCwgYGNvbnN0IHtcbiAgICBFcnJvcnM6IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yIH0sXG4gICAgUHJvY2Vzc29ycyxcbiAgICBWYWxpZGF0b3JzXG59ID0gcmVxdWlyZShcIkBnZW54L2RhdGFcIik7XG5jb25zdCB7IF8gfSA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcblxubW9kdWxlLmV4cG9ydHMgPSAke2NhcGl0YWxpemVkfSA9PiBjbGFzcyBleHRlbmRzICR7Y2FwaXRhbGl6ZWR9IHtcbiAgICAvL3RvZG86IGFkZCBzdGFpYyBtZXRob2RzXG59O2ApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IG1peGluVmFyTmFtZSA9ICdtaXhpbicgKyBtaXhpbk5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGltcG9ydExpbmVzLnB1c2goSnNMYW5nLmFzdFRvQ29kZShKc0xhbmcuYXN0UmVxdWlyZShtaXhpblZhck5hbWUsICcuL21peGlucy8nICsgbWl4aW5OYW1lKSkpO1xuICAgICAgICAgICAgICAgICAgICBtaXhpbnMucHVzaChtaXhpblZhck5hbWUpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL2Fzc2VtYmxlIHRoZSBzb3VyY2UgY29kZSBmaWxlXG4gICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgYXN0Q2xhc3NNYWluKTtcblxuICAgICAgICAgICAgLy9Kc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIGVudGl0eS5maWVsZHMubWFwKCh2LCBrKSA9PiBKc0xhbmcuYXN0QXNzaWduKGNhcGl0YWxpemVkICsgJy5GXycgKyBfLnNuYWtlQ2FzZShrKS50b1VwcGVyQ2FzZSgpLCBrKSkpOyAgIFxuXG4gICAgICAgICAgICBsZXQgbG9jYWxzID0ge1xuICAgICAgICAgICAgICAgIGltcG9ydHM6IGltcG9ydExpbmVzLmpvaW4oJ1xcbicpLFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZTogY2FwaXRhbGl6ZWQsXG4gICAgICAgICAgICAgICAgZW50aXR5TWV0YTogaW5kZW50TGluZXMoSlNPTi5zdHJpbmdpZnkobW9kZWxNZXRhLCBudWxsLCA0KSwgNCksXG4gICAgICAgICAgICAgICAgY2xhc3NCb2R5OiBpbmRlbnRMaW5lcyhhc3RDbGFzc01haW4ubWFwKGJsb2NrID0+IEpzTGFuZy5hc3RUb0NvZGUoYmxvY2spKS5qb2luKCdcXG5cXG4nKSwgOCksXG4gICAgICAgICAgICAgICAgZnVuY3RvcnM6IGluZGVudExpbmVzKEpzTGFuZy5hc3RUb0NvZGUoSnNMYW5nLmFzdFZhbHVlKF8ucmVkdWNlKHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzLCAocmVzdWx0LCBmdW5jdG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFsnJCcgKyBmdW5jdG9yLmZ1bmN0aW9uTmFtZV0gPSBKc0xhbmcuYXN0SWQoZnVuY3Rvci5mdW5jdGlvbk5hbWUpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH0sIHt9KSkpLCA0KSxcbiAgICAgICAgICAgICAgICBtaXhpbnMgXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgY2xhc3NUZW1wbGF0ZSA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICdkYXRhYmFzZScsIHRoaXMuY29ubmVjdG9yLmRyaXZlciwgJ0VudGl0eU1vZGVsLmpzLnN3aWcnKTtcbiAgICAgICAgICAgIGxldCBjbGFzc0NvZGUgPSBzd2lnLnJlbmRlckZpbGUoY2xhc3NUZW1wbGF0ZSwgbG9jYWxzKTtcblxuICAgICAgICAgICAgbGV0IG1vZGVsRmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBzY2hlbWEubmFtZSwgY2FwaXRhbGl6ZWQgKyAnLmpzJyk7XG4gICAgICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCwgY2xhc3NDb2RlKTtcblxuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBlbnRpdHkgbW9kZWw6ICcgKyBtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5TWFuaWZlc3Qoc2NoZW1hKSB7XG4gICAgICAgIGxldCBlbnRpdGllcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5lbnRpdGllcykuc29ydCgpLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7IHJlc3VsdFt2XSA9IHt9OyByZXR1cm4gcmVzdWx0OyB9LCB7fSk7XG4gICAgICAgIC8qXG4gICAgICAgIGxldCBtYW5pZmVzdCA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5yZXN0ZnVsKSB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKGVudGl0eS5pbmZvLnJlc3RmdWwsICh7IHR5cGUsIG1ldGhvZHMgfSwgcmVsYXRpdmVVcmkpID0+IHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgYXBpSW5mbyA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBtZXRob2RzOiB7fSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdlbnRpdHknKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLmVudGl0eSA9IGVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLmRpc3BsYXlOYW1lID0gZW50aXR5LmRpc3BsYXlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZW50aXR5LmNvbW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLmRlc2NyaXB0aW9uID0gZW50aXR5LmNvbW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBfLmVhY2gobWV0aG9kcywgKG1ldGEsIG1ldGhvZE5hbWUpID0+IHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChtZXRob2ROYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnY3JlYXRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5tZXRob2RzWydwb3N0OicgKyByZWxhdGl2ZVVyaV0gPSBtZXRhO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZmluZE9uZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdmaW5lQWxsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZU9uZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICd1cGRhdGVNYW55JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2RlbGV0ZU9uZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdkZWxldGVNYW55JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgICovXG4gICAgICAgIGxldCBvdXRwdXRGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm1hbmlmZXN0UGF0aCwgc2NoZW1hLm5hbWUgKyAnLm1hbmlmZXN0Lmpzb24nKTtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMob3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dEZpbGVQYXRoLCBKU09OLnN0cmluZ2lmeShlbnRpdGllcywgbnVsbCwgNCkpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgc2NoZW1hIG1hbmlmZXN0OiAnICsgb3V0cHV0RmlsZVBhdGgpO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2dlbmVyYXRlVmlld01vZGVsKHNjaGVtYSwgZGJTZXJ2aWNlKSB7ICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLnZpZXdzLCAodmlld0luZm8sIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci5pbmZvKCdCdWlsZGluZyB2aWV3OiAnICsgdmlld05hbWUpO1xuXG4gICAgICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBfLnVwcGVyRmlyc3Qodmlld05hbWUpO1xuXG4gICAgICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oKTtcblxuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZSgnTW93YScsICdtb3dhJykpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0VmFyRGVjbGFyZSgnVXRpbCcsIEpzTGFuZy5hc3RWYXJSZWYoJ01vd2EuVXRpbCcpLCB0cnVlKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RWYXJEZWNsYXJlKCdfJywgSnNMYW5nLmFzdFZhclJlZignVXRpbC5fJyksIHRydWUpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFJlcXVpcmUoJ1ZpZXcnLCAnbW93YS9saWIvb29sb25nL3J1bnRpbWUvdmlldycpKTtcblxuICAgICAgICAgICAgbGV0IGNvbXBpbGVDb250ZXh0ID0gT29sVG9Bc3QuY3JlYXRlQ29tcGlsZUNvbnRleHQodmlld05hbWUsIGRiU2VydmljZS5zZXJ2aWNlSWQsIHRoaXMubGlua2VyKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQubW9kZWxWYXJzLmFkZCh2aWV3SW5mby5lbnRpdHkpO1xuXG4gICAgICAgICAgICBsZXQgcGFyYW1NZXRhO1xuXG4gICAgICAgICAgICBpZiAodmlld0luZm8ucGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgcGFyYW1NZXRhID0gdGhpcy5fcHJvY2Vzc1BhcmFtcyh2aWV3SW5mby5wYXJhbXMsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHZpZXdNZXRhID0ge1xuICAgICAgICAgICAgICAgIGlzTGlzdDogdmlld0luZm8uaXNMaXN0LFxuICAgICAgICAgICAgICAgIHBhcmFtczogcGFyYW1NZXRhXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgdmlld0JvZHlUb3BvSWQgPSBPb2xUb0FzdC5jcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckdmlldycpO1xuICAgICAgICAgICAgT29sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdmlld0JvZHlUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgdmlld01vZGVsZXIgPSByZXF1aXJlKHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuL2Rhby92aWV3JywgZGJTZXJ2aWNlLmRiVHlwZSArICcuanMnKSk7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdmlld0JvZHlUb3BvSWRdID0gdmlld01vZGVsZXIoZGJTZXJ2aWNlLCB2aWV3TmFtZSwgdmlld0luZm8pO1xuICAgICAgICAgICAgT29sVG9Bc3QuYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB2aWV3Qm9keVRvcG9JZCwge1xuICAgICAgICAgICAgICAgIHR5cGU6IE9vbFRvQXN0LkFTVF9CTEtfVklFV19PUEVSQVRJT05cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgcmV0dXJuVG9wb0lkID0gT29sVG9Bc3QuY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgICAgICAgICAgT29sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB2aWV3Qm9keVRvcG9JZCwgcmV0dXJuVG9wb0lkKTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmNvbXBpbGVSZXR1cm4ocmV0dXJuVG9wb0lkLCB7XG4gICAgICAgICAgICAgICAgXCJvb2xUeXBlXCI6IFwiT2JqZWN0UmVmZXJlbmNlXCIsXG4gICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwidmlld0RhdGFcIlxuICAgICAgICAgICAgfSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKGRlcCA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBuZWNlc3Nhcnkgc291cmNlIGNvZGU6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgbGV0IGFzdERvTG9hZE1haW4gPSBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoJyRtZXRhJywgSnNMYW5nLmFzdFZhclJlZigndGhpcy5tZXRhJyksIHRydWUsIGZhbHNlLCAnUmV0cmlldmluZyB0aGUgbWV0YSBkYXRhJylcbiAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgIF8uZWFjaChkZXBzLCBkZXAgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBhc3RNZXRhID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcblxuICAgICAgICAgICAgICAgIGxldCBhc3RCbG9jayA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdO1xuICAgICAgICAgICAgICAgIGFzc2VydDogYXN0QmxvY2ssICdFbXB0eSBhc3QgYmxvY2snO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzdE1ldGEudHlwZSA9PT0gJ01vZGlmaWVyQ2FsbCcpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkTmFtZSA9IGdldEZpZWxkTmFtZShhc3RNZXRhLnRhcmdldCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IEpzTGFuZy5hc3RBc3NpZ24oSnNMYW5nLmFzdFZhclJlZihhc3RNZXRhLnRhcmdldCksIGFzdEJsb2NrLCBgTW9kaWZ5aW5nICR7ZmllbGROYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICBhc3REb0xvYWRNYWluLnB1c2goYXN0Q2FjaGUpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXN0RG9Mb2FkTWFpbiA9IGFzdERvTG9hZE1haW4uY29uY2F0KF8uY2FzdEFycmF5KGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdKSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSkge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSwgKGZpbGVOYW1lLCBmdW5jdGlvbk5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZShmdW5jdGlvbk5hbWUsICcuJyArIGZpbGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goY29tcGlsZUNvbnRleHQubmV3RnVuY3RvckZpbGVzLCBlbnRyeSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2dlbmVyYXRlRnVuY3Rpb25UZW1wbGF0ZUZpbGUoZGJTZXJ2aWNlLCBlbnRyeSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdENsYXNzRGVjbGFyZShjYXBpdGFsaXplZCwgJ1ZpZXcnLCBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdE1lbWJlck1ldGhvZCgnX2RvTG9hZCcsIE9iamVjdC5rZXlzKHBhcmFtTWV0YSksXG4gICAgICAgICAgICAgICAgICAgIGFzdERvTG9hZE1haW4sXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLCB0cnVlLCBmYWxzZSwgJ1BvcHVsYXRlIHZpZXcgZGF0YSdcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICBdLCBgJHtjYXBpdGFsaXplZH0gdmlld2ApKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbihjYXBpdGFsaXplZCArICcubWV0YScsIEpzTGFuZy5hc3RWYWx1ZSh2aWV3TWV0YSkpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbignbW9kdWxlLmV4cG9ydHMnLCBKc0xhbmcuYXN0VmFyUmVmKGNhcGl0YWxpemVkKSkpO1xuXG4gICAgICAgICAgICBsZXQgbW9kZWxGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIGRiU2VydmljZS5kYlR5cGUsIGRiU2VydmljZS5uYW1lLCAndmlld3MnLCB2aWV3TmFtZSArICcuanMnKTtcbiAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoICsgJy5qc29uJywgSlNPTi5zdHJpbmdpZnkoYXN0LCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIERhb01vZGVsZXIuX2V4cG9ydFNvdXJjZUNvZGUoYXN0LCBtb2RlbEZpbGVQYXRoKTtcblxuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCB2aWV3IG1vZGVsOiAnICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgKi9cblxuICAgIF9wcm9jZXNzRmllbGRNb2RpZmllcnMoZW50aXR5LCBzaGFyZWRDb250ZXh0KSB7XG4gICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IE9vbFRvQXN0LmNyZWF0ZUNvbXBpbGVDb250ZXh0KGVudGl0eS5vb2xNb2R1bGUubmFtZSwgdGhpcy5saW5rZXIsIHNoYXJlZENvbnRleHQpO1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbJ3JhdyddID0geyBzb3VyY2U6ICdjb250ZXh0JywgZmluYWxpemVkOiB0cnVlIH07XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1snaTE4biddID0geyBzb3VyY2U6ICdjb250ZXh0JywgZmluYWxpemVkOiB0cnVlIH07XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1snY29ubmVjdG9yJ10gPSB7IHNvdXJjZTogJ2NvbnRleHQnLCBmaW5hbGl6ZWQ6IHRydWUgfTtcbiAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzWydsYXRlc3QnXSA9IHsgc291cmNlOiAnY29udGV4dCcgfTtcblxuICAgICAgICBjb25zdCBhbGxGaW5pc2hlZCA9IE9vbFRvQXN0LmNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJ2RvbmUuJyk7XG5cbiAgICAgICAgLy9tYXAgb2YgZmllbGQgbmFtZSB0byBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGZpZWxkUmVmZXJlbmNlcyA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKGVudGl0eS5maWVsZHMsIChmaWVsZCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkID0gT29sVG9Bc3QuY29tcGlsZUZpZWxkKGZpZWxkTmFtZSwgZmllbGQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdG9wb0lkLCBhbGxGaW5pc2hlZCk7XG5cbiAgICAgICAgICAgIGlmIChmaWVsZC53cml0ZU9uY2UgfHwgZmllbGQuZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChmaWVsZFJlZmVyZW5jZXMsIGZpZWxkTmFtZSwgeyByZWZlcmVuY2U6IGZpZWxkTmFtZSwgd3JpdGVQcm90ZWN0OiB0cnVlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgZGVwZW5kZW5jaWVzOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKGRlcCA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgbmVjZXNzYXJ5IHNvdXJjZSBjb2RlOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgbGV0IG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwgPSBbXSwgbGFzdEZpZWxkc0dyb3VwLCBcbiAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSA9IFtdLCBcbiAgICAgICAgICAgIGxhc3RCbG9jaywgbGFzdEFzdFR5cGU7Ly8sIGhhc1ZhbGlkYXRvciA9IGZhbHNlO1xuXG4gICAgICAgIGNvbnN0IF9tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSA9IGZ1bmN0aW9uIChmaWVsZE5hbWUsIHJlZmVyZW5jZXMsIGFzdENhY2hlLCByZXF1aXJlVGFyZ2V0RmllbGQpIHsgXG4gICAgICAgICAgICBsZXQgZmllbGRzID0gWyBmaWVsZE5hbWUgXS5jb25jYXQocmVmZXJlbmNlcyk7XG4gICAgICAgICAgICBsZXQgY2hlY2tlciA9IGZpZWxkcy5qb2luKCcsJyk7XG5cbiAgICAgICAgICAgIGlmIChsYXN0RmllbGRzR3JvdXAgJiYgbGFzdEZpZWxkc0dyb3VwLmNoZWNrZXIgIT09IGNoZWNrZXIpIHtcbiAgICAgICAgICAgICAgICBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbC5jb25jYXQoXG4gICAgICAgICAgICAgICAgICAgIFNuaXBwZXRzLl9maWVsZFJlcXVpcmVtZW50Q2hlY2sobGFzdEZpZWxkc0dyb3VwLmZpZWxkTmFtZSwgbGFzdEZpZWxkc0dyb3VwLnJlZmVyZW5jZXMsIG1ldGhvZEJvZHlDYWNoZSwgbGFzdEZpZWxkc0dyb3VwLnJlcXVpcmVUYXJnZXRGaWVsZClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSA9IFtdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUgPSBtZXRob2RCb2R5Q2FjaGUuY29uY2F0KGFzdENhY2hlKTtcbiAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cCA9IHtcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgcmVmZXJlbmNlcyxcbiAgICAgICAgICAgICAgICByZXF1aXJlVGFyZ2V0RmllbGQsICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNoZWNrZXIsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIoY29tcGlsZUNvbnRleHQuYXN0TWFwWydtb2JpbGV+aXNNb2JpbGVQaG9uZTphcmdbMV18PnN0cmluZ0Rhc2hlcml6ZSddLCB7IGRlcHRoOiA4IH0pOyBcblxuICAgICAgICBfLmVhY2goZGVwcywgKGRlcCwgaSkgPT4ge1xuICAgICAgICAgICAgLy9nZXQgbWV0YWRhdGEgb2Ygc291cmNlIGNvZGUgYmxvY2tcbiAgICAgICAgICAgIGxldCBzb3VyY2VNYXAgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldChkZXApO1xuXG4gICAgICAgICAgICAvL2dldCBzb3VyY2UgY29kZSBibG9ja1xuICAgICAgICAgICAgbGV0IGFzdEJsb2NrID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW2RlcF07XG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRGaWVsZE5hbWUgPSBnZXRGaWVsZE5hbWUoc291cmNlTWFwLnRhcmdldCk7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChzb3VyY2VNYXAucmVmZXJlbmNlcyAmJiBzb3VyY2VNYXAucmVmZXJlbmNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUmVmZXJlbmNlID0gZmllbGRSZWZlcmVuY2VzW3RhcmdldEZpZWxkTmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKCFmaWVsZFJlZmVyZW5jZSkge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZFJlZmVyZW5jZXNbdGFyZ2V0RmllbGROYW1lXSA9IGZpZWxkUmVmZXJlbmNlID0gW107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBPb2xUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIHNvdXJjZU1hcC5yZWZlcmVuY2VzLmZvckVhY2gocmVmID0+IHsgZmllbGRSZWZlcmVuY2UucHVzaCh7IHJlZmVyZW5jZTogcmVmLCB3aGVuTnVsbDogdHJ1ZSB9KTsgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc291cmNlTWFwLnJlZmVyZW5jZXMuZm9yRWFjaChyZWYgPT4geyBpZiAoZmllbGRSZWZlcmVuY2UuaW5kZXhPZihyZWYpID09PSAtMSkgZmllbGRSZWZlcmVuY2UucHVzaChyZWYpOyB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChsYXN0QmxvY2spIHtcbiAgICAgICAgICAgICAgICBhc3RCbG9jayA9IGNoYWluQ2FsbChsYXN0QmxvY2ssIGxhc3RBc3RUeXBlLCBhc3RCbG9jaywgc291cmNlTWFwLnR5cGUpO1xuICAgICAgICAgICAgICAgIGxhc3RCbG9jayA9IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGkgPCBkZXBzLmxlbmd0aC0xKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5leHRUeXBlID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwc1tpKzFdKTtcblxuICAgICAgICAgICAgICAgIGlmIChpc0NoYWluYWJsZShzb3VyY2VNYXAsIG5leHRUeXBlKSkge1xuICAgICAgICAgICAgICAgICAgICBsYXN0QmxvY2sgPSBhc3RCbG9jaztcbiAgICAgICAgICAgICAgICAgICAgbGFzdEFzdFR5cGUgPSBzb3VyY2VNYXAudHlwZTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBPb2xUb0FzdC5BU1RfQkxLX1ZBTElEQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNWYWxpZGF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IFNuaXBwZXRzLl92YWxpZGF0ZUNoZWNrKHRhcmdldEZpZWxkTmFtZSwgYXN0QmxvY2spO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIF9tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSh0YXJnZXRGaWVsZE5hbWUsIHNvdXJjZU1hcC5yZWZlcmVuY2VzLCBhc3RDYWNoZSwgdHJ1ZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IE9vbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBKc0xhbmcuYXN0QXNzaWduKEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksIGFzdEJsb2NrLCBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgc291cmNlTWFwLnJlZmVyZW5jZXMsIGFzdENhY2hlLCB0cnVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IE9vbFRvQXN0LkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBTbmlwcGV0cy5fY2hlY2tBbmRBc3NpZ24oYXN0QmxvY2ssIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksIGBBY3RpdmF0aW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUodGFyZ2V0RmllbGROYW1lLCBzb3VyY2VNYXAucmVmZXJlbmNlcywgYXN0Q2FjaGUsIGZhbHNlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUbyBiZSBpbXBsZW1lbnRlZC4nKTtcbiAgICAgICAgICAgICAgICAvL2FzdEJsb2NrID0gXy5jYXN0QXJyYXkoYXN0QmxvY2spOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL19tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSh0YXJnZXRGaWVsZE5hbWUsIFtdLCBhc3RCbG9jayk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLyogQ2hhbmdlZCB0byB0aHJvdyBlcnJvciBpbnN0ZWFkIG9mIHJldHVybmluZyBhIGVycm9yIG9iamVjdFxuICAgICAgICBpZiAoaGFzVmFsaWRhdG9yKSB7XG4gICAgICAgICAgICBsZXQgZGVjbGFyZSA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhbGlkU3RhdGVOYW1lLCBmYWxzZSk7XG4gICAgICAgICAgICBtZXRob2RCb2R5Q3JlYXRlLnVuc2hpZnQoZGVjbGFyZSk7XG4gICAgICAgICAgICBtZXRob2RCb2R5VXBkYXRlLnVuc2hpZnQoZGVjbGFyZSk7XG4gICAgICAgIH1cbiAgICAgICAgKi9cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShtZXRob2RCb2R5Q2FjaGUpKSB7XG4gICAgICAgICAgICBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbC5jb25jYXQoXG4gICAgICAgICAgICAgICAgU25pcHBldHMuX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayhsYXN0RmllbGRzR3JvdXAuZmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlZmVyZW5jZXMsIFxuICAgICAgICAgICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUsIFxuICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAucmVxdWlyZVRhcmdldEZpZWxkXG4gICAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICB9ICAgICAgXG4gICAgICAgIFxuICAgICAgICAvKlxuICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oZmFsc2UpO1xuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RDbGFzc0RlY2xhcmUoJ0FiYycsICdNb2RlbCcsIFtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoYXN5bmNNZXRob2ROYW1pbmcoJ3ByZXBhcmVFbnRpdHlEYXRhXycpLCBbICdjb250ZXh0JyBdLFxuICAgICAgICAgICAgU25pcHBldHMuX2RvVmFsaWRhdGVBbmRGaWxsSGVhZGVyLmNvbmNhdChtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsKS5jb25jYXQoWyBKc0xhbmcuYXN0UmV0dXJuKEpzTGFuZy5hc3RJZCgnY29udGV4dCcpKSBdKSxcbiAgICAgICAgICAgIGZhbHNlLCB0cnVlLCB0cnVlXG4gICAgICAgICldLCAnY29tbWVudCcpKTtcbiAgICAgICAgKi9cblxuICAgICAgICByZXR1cm4geyBhc3Q6IEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoYXN5bmNNZXRob2ROYW1pbmcoJ2FwcGx5TW9kaWZpZXJzJyksIFsgJ2NvbnRleHQnLCAnaXNVcGRhdGluZycgXSxcbiAgICAgICAgICAgIFNuaXBwZXRzLl9hcHBseU1vZGlmaWVyc0hlYWRlci5jb25jYXQobWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCkuY29uY2F0KFsgSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoJ2NvbnRleHQnKSkgXSksXG4gICAgICAgICAgICBmYWxzZSwgdHJ1ZSwgdHJ1ZSwgJ0FwcGx5aW5nIHByZWRlZmluZWQgbW9kaWZpZXJzIHRvIGVudGl0eSBmaWVsZHMuJ1xuICAgICAgICApLCBmaWVsZFJlZmVyZW5jZXMgfTtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZShzY2hlbWEsIHsgZnVuY3Rpb25OYW1lLCBmdW5jdG9yVHlwZSwgZmlsZU5hbWUsIGFyZ3MgfSkge1xuICAgICAgICBsZXQgZmlsZVBhdGggPSBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICB0aGlzLm91dHB1dFBhdGgsXG4gICAgICAgICAgICBzY2hlbWEubmFtZSxcbiAgICAgICAgICAgIGZpbGVOYW1lXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKGZzLmV4aXN0c1N5bmMoZmlsZVBhdGgpKSB7XG4gICAgICAgICAgICAvL3RvZG86IGFuYWx5c2UgY29kZSwgY29tcGFyZSBhcmd1bWVudHNcbiAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsIGAkeyBfLnVwcGVyRmlyc3QoZnVuY3RvclR5cGUpIH0gXCIke2ZpbGVOYW1lfVwiIGV4aXN0cy4gRmlsZSBnZW5lcmF0aW5nIHNraXBwZWQuYCk7XG5cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhc3QgPSBKc0xhbmcuYXN0UHJvZ3JhbSgpO1xuICAgICAgICBcbiAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcmdzLCBPT0xfTU9ESUZJRVJfUkVUVVJOW2Z1bmN0b3JUeXBlXShhcmdzKSkpO1xuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RBc3NpZ24oJ21vZHVsZS5leHBvcnRzJywgSnNMYW5nLmFzdFZhclJlZihmdW5jdGlvbk5hbWUpKSk7XG5cbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBKc0xhbmcuYXN0VG9Db2RlKGFzdCkpO1xuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCBgR2VuZXJhdGVkICR7IGZ1bmN0b3JUeXBlIH0gZmlsZTogJHtmaWxlUGF0aH1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRJbnRlcmZhY2VzKGVudGl0eSwgbW9kZWxNZXRhSW5pdCwgc2hhcmVkQ29udGV4dCkge1xuICAgICAgICBsZXQgYXN0ID0gW107XG5cbiAgICAgICAgXy5mb3JPd24oZW50aXR5LmludGVyZmFjZXMsIChtZXRob2QsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLmluZm8oJ0J1aWxkaW5nIGludGVyZmFjZTogJyArIG5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgYXN0Qm9keSA9IFtcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZSgnJG1ldGEnLCBKc0xhbmcuYXN0VmFyUmVmKCd0aGlzLm1ldGEuaW50ZXJmYWNlcy4nICsgbmFtZSksIHRydWUsIGZhbHNlLCAnUmV0cmlldmluZyB0aGUgbWV0YSBkYXRhJylcbiAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IE9vbFRvQXN0LmNyZWF0ZUNvbXBpbGVDb250ZXh0KGVudGl0eS5vb2xNb2R1bGUubmFtZSwgdGhpcy5saW5rZXIsIHNoYXJlZENvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcGFyYW1NZXRhO1xuXG4gICAgICAgICAgICBpZiAobWV0aG9kLmFjY2VwdCkge1xuICAgICAgICAgICAgICAgIHBhcmFtTWV0YSA9IHRoaXMuX3Byb2Nlc3NQYXJhbXMobWV0aG9kLmFjY2VwdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAvL21ldGFkYXRhXG4gICAgICAgICAgICBtb2RlbE1ldGFJbml0WydpbnRlcmZhY2VzJ10gfHwgKG1vZGVsTWV0YUluaXRbJ2ludGVyZmFjZXMnXSA9IHt9KTtcbiAgICAgICAgICAgIG1vZGVsTWV0YUluaXRbJ2ludGVyZmFjZXMnXVtuYW1lXSA9IHsgcGFyYW1zOiBPYmplY3QudmFsdWVzKHBhcmFtTWV0YSkgfTtcblxuICAgICAgICAgICAgXy5lYWNoKG1ldGhvZC5pbXBsZW1lbnRhdGlvbiwgKG9wZXJhdGlvbiwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgICAvL2xldCBsYXN0VG9wb0lkID0gXG4gICAgICAgICAgICAgICAgT29sVG9Bc3QuY29tcGlsZURiT3BlcmF0aW9uKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChtZXRob2QucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgT29sVG9Bc3QuY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG1ldGhvZC5yZXR1cm4sIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGRlcHMgPSBjb21waWxlQ29udGV4dC50b3BvU29ydC5zb3J0KCk7XG4gICAgICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKGRlcCA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIG5lY2Vzc2FyeSBzb3VyY2UgY29kZTpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBfLmVhY2goZGVwcywgZGVwID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgc291cmNlTWFwID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0QmxvY2sgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXTtcblxuICAgICAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQ29kZSBwb2ludCBcIicgKyBkZXAgKyAnXCI6XFxuJyArIEpTT04uc3RyaW5naWZ5KHNvdXJjZU1hcCwgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRhcmdldEZpZWxkTmFtZSA9IHNvdXJjZU1hcC50YXJnZXQ7IC8vZ2V0RmllbGROYW1lKHNvdXJjZU1hcC50YXJnZXQpOyAgICAgIFxuXG4gICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBPb2xUb0FzdC5BU1RfQkxLX1ZBTElEQVRPUl9DQUxMKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBTbmlwcGV0cy5fdmFsaWRhdGVDaGVjayh0YXJnZXRGaWVsZE5hbWUsIGFzdEJsb2NrKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IE9vbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC5uZWVkRGVjbGFyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQpLCBhc3RCbG9jaywgZmFsc2UsIGZhbHNlLCBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdEFzc2lnbihKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLCBhc3RCbG9jaywgYFByb2Nlc3NpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gT29sVG9Bc3QuQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc291cmNlTWFwLm5lZWREZWNsYXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCksIGFzdEJsb2NrLCBmYWxzZSwgZmFsc2UsIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0QXNzaWduKEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksIGFzdEJsb2NrLCBgQWN0aXZhdGluZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYCk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXN0Qm9keSA9IGFzdEJvZHkuY29uY2F0KF8uY2FzdEFycmF5KGFzdEJsb2NrKSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgYXN0LnB1c2goSnNMYW5nLmFzdE1lbWJlck1ldGhvZChhc3luY01ldGhvZE5hbWluZyhuYW1lKSwgT2JqZWN0LmtleXMocGFyYW1NZXRhKSwgYXN0Qm9keSwgZmFsc2UsIHRydWUsIHRydWUsIHJlcGxhY2VBbGwoXy5rZWJhYkNhc2UobmFtZSksICctJywgJyAnKSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXN0O1xuICAgIH07XG5cbiAgICBfcHJvY2Vzc1BhcmFtcyhhY2NlcHRQYXJhbXMsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgICAgIGxldCBwYXJhbU1ldGEgPSB7fTtcblxuICAgICAgICBhY2NlcHRQYXJhbXMuZm9yRWFjaCgocGFyYW0sIGkpID0+IHtcbiAgICAgICAgICAgIE9vbFRvQXN0LmNvbXBpbGVQYXJhbShpLCBwYXJhbSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgcGFyYW1NZXRhW3BhcmFtLm5hbWVdID0gcGFyYW07XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcGFyYW0ubmFtZV0gPSB7IHNvdXJjZTogJ2FyZ3VtZW50JyB9O1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGFyYW1NZXRhO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRGFvTW9kZWxlcjsiXX0=