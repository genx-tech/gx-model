"use strict";

require("source-map-support/register");

const path = require("path");

const {
  _,
  fs,
  pascalCase,
  replaceAll,
  putIntoBucket
} = require("rk-utils");

const swig = require("swig-templates");

const GemlTypes = require("../lang/GemlTypes");

const JsLang = require("./util/ast.js");

const GemlToAst = require("./util/gemlToAst.js");

const Snippets = require("./dao/snippets");

const ChainableType = [GemlToAst.AST_BLK_VALIDATOR_CALL, GemlToAst.AST_BLK_PROCESSOR_CALL, GemlToAst.AST_BLK_ACTIVATOR_CALL];

const getFieldName = t => t.split(".").pop();

const isChainable = (current, next) => ChainableType.indexOf(current.type) > -1 && current.target === next.target && next.type === current.type;

const chainCall = (lastBlock, lastType, currentBlock, currentType) => {
  if (lastBlock) {
    if (lastType === "ValidatorCall") {
      currentBlock = JsLang.astBinExp(lastBlock, "&&", currentBlock);
    } else {
      currentBlock.arguments[0] = lastBlock;
    }
  }

  return currentBlock;
};

const asyncMethodNaming = name => name + "_";

const indentLines = (lines, indentation) => lines.split("\n").map((line, i) => i === 0 ? line : _.repeat(" ", indentation) + line).join("\n");

const OOL_MODIFIER_RETURN = {
  [GemlTypes.Modifier.VALIDATOR]: () => [JsLang.astReturn(true)],
  [GemlTypes.Modifier.PROCESSOR]: args => [JsLang.astReturn(JsLang.astId(args[0]))],
  [GemlTypes.Modifier.ACTIVATOR]: () => [JsLang.astReturn(JsLang.astId("undefined"))]
};

class DaoModeler {
  constructor(context, linker, connector) {
    this.linker = linker;
    this.outputPath = context.modelPath;
    this.manifestPath = context.manifestPath;
    this.connector = connector;
  }

  modeling_(schema) {
    this.linker.log("info", 'Generating entity models for schema "' + schema.name + '"...');

    this._generateSchemaModel(schema);

    this._generateEntityModel(schema);

    this._generateEntityInputSchema(schema);

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
    let classTemplate = path.resolve(__dirname, "database", this.connector.driver, "Database.js.swig");
    let classCode = swig.renderFile(classTemplate, locals);
    let modelFilePath = path.resolve(this.outputPath, capitalized + ".js");
    fs.ensureFileSync(modelFilePath);
    fs.writeFileSync(modelFilePath, classCode);
    this.linker.log("info", "Generated database model: " + modelFilePath);
  }

  _generateEnumTypes(schema) {
    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      _.forOwn(entity.fields, (field, fieldName) => {
        if (field.type === "enum") {}
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
        fields: _.mapValues(entity.fields, f => _.omit(f.toJSON(), "modifiers")),
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
          importLines.push(JsLang.astToCode(JsLang.astRequire(functionName, "." + fileName)));
        });
      }

      if (!_.isEmpty(sharedContext.newFunctorFiles)) {
        _.each(sharedContext.newFunctorFiles, entry => {
          this._generateFunctionTemplateFile(schema, entry);
        });
      }

      let locals = {
        imports: importLines.join("\n"),
        className: capitalized,
        entityMeta: indentLines(JSON.stringify(modelMeta, null, 4), 4),
        classBody: indentLines(astClassMain.map(block => JsLang.astToCode(block)).join("\n\n"), 8),
        functors: indentLines(JsLang.astToCode(JsLang.astValue(_.reduce(sharedContext.newFunctorFiles, (result, functor) => {
          result["$" + functor.functionName] = JsLang.astId(functor.functionName);
          return result;
        }, {}))), 4)
      };
      let classTemplate = path.resolve(__dirname, "database", this.connector.driver, "EntityModel.js.swig");
      let classCode = swig.renderFile(classTemplate, locals);
      let modelFilePath = path.resolve(this.outputPath, schema.name, "base", capitalized + ".js");
      fs.ensureFileSync(modelFilePath);
      fs.writeFileSync(modelFilePath, classCode);
      this.linker.log("info", "Generated entity model: " + modelFilePath);
    });
  }

  _generateEntityInputSchema(schema) {
    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      _.each(entity.inputs, (inputs, inputSetName) => {
        const validationSchema = {};
        const dependencies = new Set();
        const ast = JsLang.astProgram();
        inputs.forEach(input => {
          if (input.name.startsWith(":")) {
            const assoc = input.name.substr(1);
            const assocMeta = entity.associations[assoc];

            if (!assocMeta) {
              throw new Error(`Association "${assoc}" not found in entity [${entityInstanceName}].`);
            }

            if (!input.spec) {
              throw new Error(`Input "spec" is required for entity reference. Input set: ${inputSetName}, local: ${assoc}, referencedEntity: ${assocMeta.entity}`);
            }

            const dep = `${assocMeta.entity}-${input.spec}`;
            dependencies.add(dep);

            if (assocMeta.list) {
              validationSchema[input.name] = JsLang.astValue({
                type: "array",
                elementSchema: {
                  type: "object",
                  schema: JsLang.astCall(_.camelCase(dep))
                },
                ..._.pick(input, ["optional"])
              });
            } else {
              validationSchema[input.name] = JsLang.astValue({
                type: "object",
                schema: JsLang.astCall(_.camelCase(dep)),
                ..._.pick(input, ["optional"])
              });
            }
          } else {
            const field = entity.fields[input.name];

            if (!field) {
              throw new Error(`Field "${input.name}" not found in entity [${entityInstanceName}].`);
            }

            validationSchema[input.name] = JsLang.astValue({ ..._.pick(field, ["type", "values"]),
              ..._.pick(input, ["optional"])
            });
          }
        });
        Array.from(dependencies).forEach(dep => JsLang.astPushInBody(ast, JsLang.astRequire(_.camelCase(dep), `./${dep}`)));
        JsLang.astPushInBody(ast, JsLang.astAssign(JsLang.astVarRef("module.exports"), JsLang.astArrowFunction([], JsLang.astValue(validationSchema))));
        let inputSchemaFilePath = path.resolve(this.outputPath, schema.name, "inputs", entityInstanceName + "-" + inputSetName + ".js");
        fs.ensureFileSync(inputSchemaFilePath);
        fs.writeFileSync(inputSchemaFilePath, JsLang.astToCode(ast));
        this.linker.log("info", "Generated entity manifest: " + entityOutputFilePath);
      });
    });
  }

  _generateEntityManifest(schema) {
    let entities = Object.keys(schema.entities).sort().reduce((result, v) => {
      result[v] = {};
      return result;
    }, {});

    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      let validationSchema = {};

      _.forOwn(entity.fields, (field, fieldName) => {
        if (field.readOnly) return;
        let fieldSchema = {
          type: field.type
        };

        if (field.type === "enum") {
          fieldSchema.values = field.values;
        }

        if (field.optional) {
          fieldSchema.optional = true;
        }

        validationSchema[fieldName] = fieldSchema;
      });

      let entityOutputFilePath = path.resolve(this.manifestPath, schema.name, "validation", entityInstanceName + ".manifest.json");
      fs.ensureFileSync(entityOutputFilePath);
      fs.writeFileSync(entityOutputFilePath, JSON.stringify(validationSchema, null, 4));
      this.linker.log("info", "Generated entity manifest: " + entityOutputFilePath);
    });
  }

  _processFieldModifiers(entity, sharedContext) {
    let compileContext = GemlToAst.createCompileContext(entity.gemlModule.name, this.linker, sharedContext);
    compileContext.variables["raw"] = {
      source: "context",
      finalized: true
    };
    compileContext.variables["i18n"] = {
      source: "context",
      finalized: true
    };
    compileContext.variables["connector"] = {
      source: "context",
      finalized: true
    };
    compileContext.variables["latest"] = {
      source: "context"
    };
    const allFinished = GemlToAst.createTopoId(compileContext, "done.");
    let fieldReferences = {};

    _.forOwn(entity.fields, (field, fieldName) => {
      let topoId = GemlToAst.compileField(fieldName, field, compileContext);
      GemlToAst.dependsOn(compileContext, topoId, allFinished);

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
      let checker = fields.join(",");

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

        if (sourceMap.type === GemlToAst.AST_BLK_ACTIVATOR_CALL) {
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

      if (sourceMap.type === GemlToAst.AST_BLK_VALIDATOR_CALL) {
        let astCache = Snippets._validateCheck(targetFieldName, astBlock);

        _mergeDoValidateAndFillCode(targetFieldName, sourceMap.references, astCache, true);
      } else if (sourceMap.type === GemlToAst.AST_BLK_PROCESSOR_CALL) {
        let astCache = JsLang.astAssign(JsLang.astVarRef(sourceMap.target, true), astBlock, `Processing "${targetFieldName}"`);

        _mergeDoValidateAndFillCode(targetFieldName, sourceMap.references, astCache, true);
      } else if (sourceMap.type === GemlToAst.AST_BLK_ACTIVATOR_CALL) {
        let astCache = Snippets._checkAndAssign(astBlock, JsLang.astVarRef(sourceMap.target, true), `Activating "${targetFieldName}"`);

        _mergeDoValidateAndFillCode(targetFieldName, sourceMap.references, astCache, false);
      } else {
        throw new Error("To be implemented.");
      }
    });

    if (!_.isEmpty(methodBodyCache)) {
      methodBodyValidateAndFill = methodBodyValidateAndFill.concat(Snippets._fieldRequirementCheck(lastFieldsGroup.fieldName, lastFieldsGroup.references, methodBodyCache, lastFieldsGroup.requireTargetField));
    }

    return {
      ast: JsLang.astMemberMethod(asyncMethodNaming("applyModifiers"), ["context", "isUpdating"], Snippets._applyModifiersHeader.concat(methodBodyValidateAndFill).concat([JsLang.astReturn(JsLang.astId("context"))]), false, true, true, "Applying predefined modifiers to entity fields."),
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
      this.linker.log("info", `${_.upperFirst(functorType)} "${fileName}" exists. File generating skipped.`);
      return;
    }

    let ast = JsLang.astProgram();
    JsLang.astPushInBody(ast, JsLang.astFunction(functionName, args, OOL_MODIFIER_RETURN[functorType](args)));
    JsLang.astPushInBody(ast, JsLang.astAssign("module.exports", JsLang.astVarRef(functionName)));
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, JsLang.astToCode(ast));
    this.linker.log("info", `Generated ${functorType} file: ${filePath}`);
  }

  _buildInterfaces(entity, modelMetaInit, sharedContext) {
    let ast = [];

    _.forOwn(entity.interfaces, (method, name) => {
      this.linker.info("Building interface: " + name);
      let astBody = [JsLang.astVarDeclare("$meta", JsLang.astVarRef("this.meta.interfaces." + name), true, false, "Retrieving the meta data")];
      let compileContext = GemlToAst.createCompileContext(entity.gemlModule.name, this.linker, sharedContext);
      let paramMeta;

      if (method.accept) {
        paramMeta = this._processParams(method.accept, compileContext);
      }

      modelMetaInit["interfaces"] || (modelMetaInit["interfaces"] = {});
      modelMetaInit["interfaces"][name] = {
        params: Object.values(paramMeta)
      };

      _.each(method.implementation, (operation, index) => {
        GemlToAst.compileDbOperation(index, operation, compileContext, compileContext.mainStartId);
      });

      if (method.return) {
        GemlToAst.compileExceptionalReturn(method.return, compileContext);
      }

      let deps = compileContext.topoSort.sort();
      deps = deps.filter(dep => compileContext.mapOfTokenToMeta.has(dep));

      _.each(deps, dep => {
        let sourceMap = compileContext.mapOfTokenToMeta.get(dep);
        let astBlock = compileContext.astMap[dep];
        let targetFieldName = sourceMap.target;

        if (sourceMap.type === GemlToAst.AST_BLK_VALIDATOR_CALL) {
          astBlock = Snippets._validateCheck(targetFieldName, astBlock);
        } else if (sourceMap.type === GemlToAst.AST_BLK_PROCESSOR_CALL) {
          if (sourceMap.needDeclare) {
            astBlock = JsLang.astVarDeclare(JsLang.astVarRef(sourceMap.target), astBlock, false, false, `Processing "${targetFieldName}"`);
          } else {
            astBlock = JsLang.astAssign(JsLang.astVarRef(sourceMap.target, true), astBlock, `Processing "${targetFieldName}"`);
          }
        } else if (sourceMap.type === GemlToAst.AST_BLK_ACTIVATOR_CALL) {
          if (sourceMap.needDeclare) {
            astBlock = JsLang.astVarDeclare(JsLang.astVarRef(sourceMap.target), astBlock, false, false, `Processing "${targetFieldName}"`);
          } else {
            astBlock = JsLang.astAssign(JsLang.astVarRef(sourceMap.target, true), astBlock, `Activating "${targetFieldName}"`);
          }
        }

        astBody = astBody.concat(_.castArray(astBlock));
      });

      ast.push(JsLang.astMemberMethod(asyncMethodNaming(name), Object.keys(paramMeta), astBody, false, true, true, replaceAll(_.kebabCase(name), "-", " ")));
    });

    return ast;
  }

  _processParams(acceptParams, compileContext) {
    let paramMeta = {};
    acceptParams.forEach((param, i) => {
      GemlToAst.compileParam(i, param, compileContext);
      paramMeta[param.name] = param;
      compileContext.variables[param.name] = {
        source: "argument"
      };
    });
    return paramMeta;
  }

}

module.exports = DaoModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9tb2RlbGVyL0Rhby5qcyJdLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsIl8iLCJmcyIsInBhc2NhbENhc2UiLCJyZXBsYWNlQWxsIiwicHV0SW50b0J1Y2tldCIsInN3aWciLCJHZW1sVHlwZXMiLCJKc0xhbmciLCJHZW1sVG9Bc3QiLCJTbmlwcGV0cyIsIkNoYWluYWJsZVR5cGUiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCIsIkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwiLCJnZXRGaWVsZE5hbWUiLCJ0Iiwic3BsaXQiLCJwb3AiLCJpc0NoYWluYWJsZSIsImN1cnJlbnQiLCJuZXh0IiwiaW5kZXhPZiIsInR5cGUiLCJ0YXJnZXQiLCJjaGFpbkNhbGwiLCJsYXN0QmxvY2siLCJsYXN0VHlwZSIsImN1cnJlbnRCbG9jayIsImN1cnJlbnRUeXBlIiwiYXN0QmluRXhwIiwiYXJndW1lbnRzIiwiYXN5bmNNZXRob2ROYW1pbmciLCJuYW1lIiwiaW5kZW50TGluZXMiLCJsaW5lcyIsImluZGVudGF0aW9uIiwibWFwIiwibGluZSIsImkiLCJyZXBlYXQiLCJqb2luIiwiT09MX01PRElGSUVSX1JFVFVSTiIsIk1vZGlmaWVyIiwiVkFMSURBVE9SIiwiYXN0UmV0dXJuIiwiUFJPQ0VTU09SIiwiYXJncyIsImFzdElkIiwiQUNUSVZBVE9SIiwiRGFvTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImxpbmtlciIsImNvbm5lY3RvciIsIm91dHB1dFBhdGgiLCJtb2RlbFBhdGgiLCJtYW5pZmVzdFBhdGgiLCJtb2RlbGluZ18iLCJzY2hlbWEiLCJsb2ciLCJfZ2VuZXJhdGVTY2hlbWFNb2RlbCIsIl9nZW5lcmF0ZUVudGl0eU1vZGVsIiwiX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEiLCJfZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdCIsImNhcGl0YWxpemVkIiwibG9jYWxzIiwiZHJpdmVyIiwiY2xhc3NOYW1lIiwic2NoZW1hTmFtZSIsImVudGl0aWVzIiwiSlNPTiIsInN0cmluZ2lmeSIsIk9iamVjdCIsImtleXMiLCJjbGFzc1RlbXBsYXRlIiwicmVzb2x2ZSIsIl9fZGlybmFtZSIsImNsYXNzQ29kZSIsInJlbmRlckZpbGUiLCJtb2RlbEZpbGVQYXRoIiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiX2dlbmVyYXRlRW51bVR5cGVzIiwiZm9yT3duIiwiZW50aXR5IiwiZW50aXR5SW5zdGFuY2VOYW1lIiwiZmllbGRzIiwiZmllbGQiLCJmaWVsZE5hbWUiLCJzaGFyZWRDb250ZXh0IiwibWFwT2ZGdW5jdG9yVG9GaWxlIiwibmV3RnVuY3RvckZpbGVzIiwiYXN0IiwiYXN0Q2xhc3NNYWluIiwiZmllbGRSZWZlcmVuY2VzIiwiX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyIsInVuaXF1ZUtleXMiLCJjYXN0QXJyYXkiLCJrZXkiLCJpbmRleGVzIiwiZm9yRWFjaCIsImluZGV4IiwidW5pcXVlIiwicHVzaCIsIm1vZGVsTWV0YSIsImtleUZpZWxkIiwibWFwVmFsdWVzIiwiZiIsIm9taXQiLCJ0b0pTT04iLCJmZWF0dXJlcyIsImJhc2VDbGFzc2VzIiwiaXNFbXB0eSIsImFzc29jaWF0aW9ucyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaW50ZXJmYWNlcyIsImFzdEludGVyZmFjZXMiLCJfYnVpbGRJbnRlcmZhY2VzIiwiY29uY2F0IiwiaW1wb3J0TGluZXMiLCJmaWxlTmFtZSIsImZ1bmN0aW9uTmFtZSIsImFzdFRvQ29kZSIsImFzdFJlcXVpcmUiLCJlYWNoIiwiZW50cnkiLCJfZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZSIsImltcG9ydHMiLCJlbnRpdHlNZXRhIiwiY2xhc3NCb2R5IiwiYmxvY2siLCJmdW5jdG9ycyIsImFzdFZhbHVlIiwicmVkdWNlIiwicmVzdWx0IiwiZnVuY3RvciIsImlucHV0cyIsImlucHV0U2V0TmFtZSIsInZhbGlkYXRpb25TY2hlbWEiLCJkZXBlbmRlbmNpZXMiLCJTZXQiLCJhc3RQcm9ncmFtIiwiaW5wdXQiLCJzdGFydHNXaXRoIiwiYXNzb2MiLCJzdWJzdHIiLCJhc3NvY01ldGEiLCJFcnJvciIsInNwZWMiLCJkZXAiLCJhZGQiLCJsaXN0IiwiZWxlbWVudFNjaGVtYSIsImFzdENhbGwiLCJjYW1lbENhc2UiLCJwaWNrIiwiQXJyYXkiLCJmcm9tIiwiYXN0UHVzaEluQm9keSIsImFzdEFzc2lnbiIsImFzdFZhclJlZiIsImFzdEFycm93RnVuY3Rpb24iLCJpbnB1dFNjaGVtYUZpbGVQYXRoIiwiZW50aXR5T3V0cHV0RmlsZVBhdGgiLCJzb3J0IiwidiIsInJlYWRPbmx5IiwiZmllbGRTY2hlbWEiLCJ2YWx1ZXMiLCJvcHRpb25hbCIsImNvbXBpbGVDb250ZXh0IiwiY3JlYXRlQ29tcGlsZUNvbnRleHQiLCJnZW1sTW9kdWxlIiwidmFyaWFibGVzIiwic291cmNlIiwiZmluYWxpemVkIiwiYWxsRmluaXNoZWQiLCJjcmVhdGVUb3BvSWQiLCJ0b3BvSWQiLCJjb21waWxlRmllbGQiLCJkZXBlbmRzT24iLCJ3cml0ZU9uY2UiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJyZWZlcmVuY2UiLCJ3cml0ZVByb3RlY3QiLCJkZXBzIiwidG9wb1NvcnQiLCJmaWx0ZXIiLCJtYXBPZlRva2VuVG9NZXRhIiwiaGFzIiwibWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCIsImxhc3RGaWVsZHNHcm91cCIsIm1ldGhvZEJvZHlDYWNoZSIsImxhc3RBc3RUeXBlIiwiX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlIiwicmVmZXJlbmNlcyIsImFzdENhY2hlIiwicmVxdWlyZVRhcmdldEZpZWxkIiwiY2hlY2tlciIsIl9maWVsZFJlcXVpcmVtZW50Q2hlY2siLCJzb3VyY2VNYXAiLCJnZXQiLCJhc3RCbG9jayIsImFzdE1hcCIsInRhcmdldEZpZWxkTmFtZSIsImxlbmd0aCIsImZpZWxkUmVmZXJlbmNlIiwicmVmIiwid2hlbk51bGwiLCJ1bmRlZmluZWQiLCJuZXh0VHlwZSIsIl92YWxpZGF0ZUNoZWNrIiwiX2NoZWNrQW5kQXNzaWduIiwiYXN0TWVtYmVyTWV0aG9kIiwiX2FwcGx5TW9kaWZpZXJzSGVhZGVyIiwiZnVuY3RvclR5cGUiLCJmaWxlUGF0aCIsImV4aXN0c1N5bmMiLCJ1cHBlckZpcnN0IiwiYXN0RnVuY3Rpb24iLCJtb2RlbE1ldGFJbml0IiwibWV0aG9kIiwiaW5mbyIsImFzdEJvZHkiLCJhc3RWYXJEZWNsYXJlIiwicGFyYW1NZXRhIiwiYWNjZXB0IiwiX3Byb2Nlc3NQYXJhbXMiLCJwYXJhbXMiLCJpbXBsZW1lbnRhdGlvbiIsIm9wZXJhdGlvbiIsImNvbXBpbGVEYk9wZXJhdGlvbiIsIm1haW5TdGFydElkIiwicmV0dXJuIiwiY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuIiwibmVlZERlY2xhcmUiLCJrZWJhYkNhc2UiLCJhY2NlcHRQYXJhbXMiLCJwYXJhbSIsImNvbXBpbGVQYXJhbSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsRUFBTDtBQUFTQyxFQUFBQSxVQUFUO0FBQXFCQyxFQUFBQSxVQUFyQjtBQUFpQ0MsRUFBQUE7QUFBakMsSUFBbURMLE9BQU8sQ0FBQyxVQUFELENBQWhFOztBQUNBLE1BQU1NLElBQUksR0FBR04sT0FBTyxDQUFDLGdCQUFELENBQXBCOztBQUVBLE1BQU1PLFNBQVMsR0FBR1AsT0FBTyxDQUFDLG1CQUFELENBQXpCOztBQUNBLE1BQU1RLE1BQU0sR0FBR1IsT0FBTyxDQUFDLGVBQUQsQ0FBdEI7O0FBQ0EsTUFBTVMsU0FBUyxHQUFHVCxPQUFPLENBQUMscUJBQUQsQ0FBekI7O0FBQ0EsTUFBTVUsUUFBUSxHQUFHVixPQUFPLENBQUMsZ0JBQUQsQ0FBeEI7O0FBRUEsTUFBTVcsYUFBYSxHQUFHLENBQ2xCRixTQUFTLENBQUNHLHNCQURR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Q0FBZXRILENBQUMsQ0FBQ2lHLFNBQUYsQ0FBWXlHLFFBQVosQ0FBZixDQUFWO0FBQ0gsT0E3Q0Q7O0FBK0NBOUcsTUFBQUEsR0FBRyxDQUFDVyxJQUFKLENBQ0loRyxNQUFNLENBQUM4TSxlQUFQLENBQ0l0TCxpQkFBaUIsQ0FBQ0MsSUFBRCxDQURyQixFQUVJd0MsTUFBTSxDQUFDQyxJQUFQLENBQVl3SixTQUFaLENBRkosRUFHSUYsT0FISixFQUlJLEtBSkosRUFLSSxJQUxKLEVBTUksSUFOSixFQU9JNU4sVUFBVSxDQUFDSCxDQUFDLENBQUM0TyxTQUFGLENBQVk1TSxJQUFaLENBQUQsRUFBb0IsR0FBcEIsRUFBeUIsR0FBekIsQ0FQZCxDQURKO0FBV0gsS0FsR0Q7O0FBb0dBLFdBQU80RCxHQUFQO0FBQ0g7O0FBRUR1SSxFQUFBQSxjQUFjLENBQUNVLFlBQUQsRUFBZW5FLGNBQWYsRUFBK0I7QUFDekMsUUFBSXVELFNBQVMsR0FBRyxFQUFoQjtBQUVBWSxJQUFBQSxZQUFZLENBQUN6SSxPQUFiLENBQXFCLENBQUMwSSxLQUFELEVBQVF4TSxDQUFSLEtBQWM7QUFDL0I5QixNQUFBQSxTQUFTLENBQUN1TyxZQUFWLENBQXVCek0sQ0FBdkIsRUFBMEJ3TSxLQUExQixFQUFpQ3BFLGNBQWpDO0FBQ0F1RCxNQUFBQSxTQUFTLENBQUNhLEtBQUssQ0FBQzlNLElBQVAsQ0FBVCxHQUF3QjhNLEtBQXhCO0FBQ0FwRSxNQUFBQSxjQUFjLENBQUNHLFNBQWYsQ0FBeUJpRSxLQUFLLENBQUM5TSxJQUEvQixJQUF1QztBQUFFOEksUUFBQUEsTUFBTSxFQUFFO0FBQVYsT0FBdkM7QUFDSCxLQUpEO0FBTUEsV0FBT21ELFNBQVA7QUFDSDs7QUFqeUJZOztBQW95QmpCZSxNQUFNLENBQUNDLE9BQVAsR0FBaUJoTSxVQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBwYXRoID0gcmVxdWlyZShcInBhdGhcIik7XG5jb25zdCB7IF8sIGZzLCBwYXNjYWxDYXNlLCByZXBsYWNlQWxsLCBwdXRJbnRvQnVja2V0IH0gPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5jb25zdCBzd2lnID0gcmVxdWlyZShcInN3aWctdGVtcGxhdGVzXCIpO1xuXG5jb25zdCBHZW1sVHlwZXMgPSByZXF1aXJlKFwiLi4vbGFuZy9HZW1sVHlwZXNcIik7XG5jb25zdCBKc0xhbmcgPSByZXF1aXJlKFwiLi91dGlsL2FzdC5qc1wiKTtcbmNvbnN0IEdlbWxUb0FzdCA9IHJlcXVpcmUoXCIuL3V0aWwvZ2VtbFRvQXN0LmpzXCIpO1xuY29uc3QgU25pcHBldHMgPSByZXF1aXJlKFwiLi9kYW8vc25pcHBldHNcIik7XG5cbmNvbnN0IENoYWluYWJsZVR5cGUgPSBbXG4gICAgR2VtbFRvQXN0LkFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgR2VtbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgR2VtbFRvQXN0LkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwsXG5dO1xuXG5jb25zdCBnZXRGaWVsZE5hbWUgPSAodCkgPT4gdC5zcGxpdChcIi5cIikucG9wKCk7XG5jb25zdCBpc0NoYWluYWJsZSA9IChjdXJyZW50LCBuZXh0KSA9PlxuICAgIENoYWluYWJsZVR5cGUuaW5kZXhPZihjdXJyZW50LnR5cGUpID4gLTEgJiYgY3VycmVudC50YXJnZXQgPT09IG5leHQudGFyZ2V0ICYmIG5leHQudHlwZSA9PT0gY3VycmVudC50eXBlO1xuY29uc3QgY2hhaW5DYWxsID0gKGxhc3RCbG9jaywgbGFzdFR5cGUsIGN1cnJlbnRCbG9jaywgY3VycmVudFR5cGUpID0+IHtcbiAgICBpZiAobGFzdEJsb2NrKSB7XG4gICAgICAgIGlmIChsYXN0VHlwZSA9PT0gXCJWYWxpZGF0b3JDYWxsXCIpIHtcbiAgICAgICAgICAgIGFzc2VydDogY3VycmVudFR5cGUgPT09IFwiVmFsaWRhdG9yQ2FsbFwiLCBcIlVuZXhwZWN0ZWQgY3VycmVudFR5cGVcIjtcblxuICAgICAgICAgICAgY3VycmVudEJsb2NrID0gSnNMYW5nLmFzdEJpbkV4cChsYXN0QmxvY2ssIFwiJiZcIiwgY3VycmVudEJsb2NrKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc2VydDogY3VycmVudFR5cGUgPT09IFwiUHJvY2Vzc29yQ2FsbFwiLCBcIlVuZXhwZWN0ZWQgY3VycmVudFR5cGU6IFwiICsgY3VycmVudFR5cGUgKyBcIiBsYXN0OiBcIiArIGxhc3RUeXBlO1xuXG4gICAgICAgICAgICBjdXJyZW50QmxvY2suYXJndW1lbnRzWzBdID0gbGFzdEJsb2NrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGN1cnJlbnRCbG9jaztcbn07XG5jb25zdCBhc3luY01ldGhvZE5hbWluZyA9IChuYW1lKSA9PiBuYW1lICsgXCJfXCI7XG5cbmNvbnN0IGluZGVudExpbmVzID0gKGxpbmVzLCBpbmRlbnRhdGlvbikgPT5cbiAgICBsaW5lc1xuICAgICAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAgICAgLm1hcCgobGluZSwgaSkgPT4gKGkgPT09IDAgPyBsaW5lIDogXy5yZXBlYXQoXCIgXCIsIGluZGVudGF0aW9uKSArIGxpbmUpKVxuICAgICAgICAuam9pbihcIlxcblwiKTtcblxuY29uc3QgT09MX01PRElGSUVSX1JFVFVSTiA9IHtcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICgpID0+IFtKc0xhbmcuYXN0UmV0dXJuKHRydWUpXSxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IChhcmdzKSA9PiBbSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoYXJnc1swXSkpXSxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICgpID0+IFtKc0xhbmcuYXN0UmV0dXJuKEpzTGFuZy5hc3RJZChcInVuZGVmaW5lZFwiKSldLFxufTtcblxuLyoqXG4gKiBPb2xvbmcgZGF0YWJhc2UgYWNjZXNzIG9iamVjdCAoREFPKSBtb2RlbGVyLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIERhb01vZGVsZXIge1xuICAgIC8qKlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtHZW1sTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIEdlbWwgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQubW9kZWxQYXRoIC0gR2VuZXJhdGVkIG1vZGVsIG91dHB1dCBwYXRoXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQubWFuaWZlc3RQYXRoIC0gRW50aXRpZXMgbWFuaWZlc3Qgb3V0cHV0IHBhdGhcbiAgICAgKiBAcGFyYW0ge0Nvbm5lY3Rvcn0gY29ubmVjdG9yXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgbGlua2VyLCBjb25uZWN0b3IpIHtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBsaW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQubW9kZWxQYXRoO1xuICAgICAgICB0aGlzLm1hbmlmZXN0UGF0aCA9IGNvbnRleHQubWFuaWZlc3RQYXRoO1xuXG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuICAgIH1cblxuICAgIG1vZGVsaW5nXyhzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCAnR2VuZXJhdGluZyBlbnRpdHkgbW9kZWxzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICB0aGlzLl9nZW5lcmF0ZVNjaGVtYU1vZGVsKHNjaGVtYSk7XG4gICAgICAgIHRoaXMuX2dlbmVyYXRlRW50aXR5TW9kZWwoc2NoZW1hKTtcbiAgICAgICAgdGhpcy5fZ2VuZXJhdGVFbnRpdHlJbnB1dFNjaGVtYShzY2hlbWEpO1xuICAgICAgICAvL3RoaXMuX2dlbmVyYXRlRW51bVR5cGVzKHNjaGVtYSk7XG4gICAgICAgIC8vdGhpcy5fZ2VuZXJhdGVWaWV3TW9kZWwoKTtcblxuICAgICAgICBpZiAodGhpcy5tYW5pZmVzdFBhdGgpIHtcbiAgICAgICAgICAgIHRoaXMuX2dlbmVyYXRlRW50aXR5TWFuaWZlc3Qoc2NoZW1hKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9nZW5lcmF0ZVNjaGVtYU1vZGVsKHNjaGVtYSkge1xuICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBwYXNjYWxDYXNlKHNjaGVtYS5uYW1lKTtcblxuICAgICAgICBsZXQgbG9jYWxzID0ge1xuICAgICAgICAgICAgZHJpdmVyOiB0aGlzLmNvbm5lY3Rvci5kcml2ZXIsXG4gICAgICAgICAgICBjbGFzc05hbWU6IGNhcGl0YWxpemVkLFxuICAgICAgICAgICAgc2NoZW1hTmFtZTogc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICBlbnRpdGllczogSlNPTi5zdHJpbmdpZnkoT2JqZWN0LmtleXMoc2NoZW1hLmVudGl0aWVzKSksXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGNsYXNzVGVtcGxhdGUgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRhdGFiYXNlXCIsIHRoaXMuY29ubmVjdG9yLmRyaXZlciwgXCJEYXRhYmFzZS5qcy5zd2lnXCIpO1xuICAgICAgICBsZXQgY2xhc3NDb2RlID0gc3dpZy5yZW5kZXJGaWxlKGNsYXNzVGVtcGxhdGUsIGxvY2Fscyk7XG5cbiAgICAgICAgbGV0IG1vZGVsRmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBjYXBpdGFsaXplZCArIFwiLmpzXCIpO1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoLCBjbGFzc0NvZGUpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgXCJHZW5lcmF0ZWQgZGF0YWJhc2UgbW9kZWw6IFwiICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW51bVR5cGVzKHNjaGVtYSkge1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZpZWxkcywgKGZpZWxkLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gXCJlbnVtXCIpIHtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5TW9kZWwoc2NoZW1hKSB7XG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5SW5zdGFuY2VOYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBwYXNjYWxDYXNlKGVudGl0eUluc3RhbmNlTmFtZSk7XG5cbiAgICAgICAgICAgIC8vc2hhcmVkIGluZm9ybWF0aW9uIHdpdGggbW9kZWwgQ1JVRCBhbmQgY3VzdG9taXplZCBpbnRlcmZhY2VzXG4gICAgICAgICAgICBsZXQgc2hhcmVkQ29udGV4dCA9IHtcbiAgICAgICAgICAgICAgICBtYXBPZkZ1bmN0b3JUb0ZpbGU6IHt9LFxuICAgICAgICAgICAgICAgIG5ld0Z1bmN0b3JGaWxlczogW10sXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgeyBhc3Q6IGFzdENsYXNzTWFpbiwgZmllbGRSZWZlcmVuY2VzIH0gPSB0aGlzLl9wcm9jZXNzRmllbGRNb2RpZmllcnMoZW50aXR5LCBzaGFyZWRDb250ZXh0KTtcbiAgICAgICAgICAgIGFzdENsYXNzTWFpbiA9IFthc3RDbGFzc01haW5dO1xuXG4gICAgICAgICAgICAvL3ByZXBhcmUgbWV0YSBkYXRhXG4gICAgICAgICAgICBsZXQgdW5pcXVlS2V5cyA9IFtfLmNhc3RBcnJheShlbnRpdHkua2V5KV07XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcykge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goKGluZGV4KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVuaXF1ZUtleXMucHVzaChpbmRleC5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBtb2RlbE1ldGEgPSB7XG4gICAgICAgICAgICAgICAgc2NoZW1hTmFtZTogc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICAgICAgbmFtZTogZW50aXR5SW5zdGFuY2VOYW1lLFxuICAgICAgICAgICAgICAgIGtleUZpZWxkOiBlbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgIGZpZWxkczogXy5tYXBWYWx1ZXMoZW50aXR5LmZpZWxkcywgKGYpID0+IF8ub21pdChmLnRvSlNPTigpLCBcIm1vZGlmaWVyc1wiKSksXG4gICAgICAgICAgICAgICAgZmVhdHVyZXM6IGVudGl0eS5mZWF0dXJlcyB8fCB7fSxcbiAgICAgICAgICAgICAgICB1bmlxdWVLZXlzLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5iYXNlQ2xhc3Nlcykge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5iYXNlQ2xhc3NlcyA9IGVudGl0eS5iYXNlQ2xhc3NlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZGV4ZXMpKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmluZGV4ZXMgPSBlbnRpdHkuaW5kZXhlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmZlYXR1cmVzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5mZWF0dXJlcyA9IGVudGl0eS5mZWF0dXJlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuYXNzb2NpYXRpb25zID0gZW50aXR5LmFzc29jaWF0aW9ucztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZmllbGRSZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5maWVsZERlcGVuZGVuY2llcyA9IGZpZWxkUmVmZXJlbmNlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9idWlsZCBjdXN0b21pemVkIGludGVyZmFjZXNcbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW50ZXJmYWNlcykge1xuICAgICAgICAgICAgICAgIGxldCBhc3RJbnRlcmZhY2VzID0gdGhpcy5fYnVpbGRJbnRlcmZhY2VzKGVudGl0eSwgbW9kZWxNZXRhLCBzaGFyZWRDb250ZXh0KTtcbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUubG9nKGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgICAgIC8vbGV0IGFzdENsYXNzID0gYXN0Q2xhc3NNYWluW2FzdENsYXNzTWFpbi5sZW5ndGggLSAxXTtcbiAgICAgICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdENsYXNzLCBhc3RJbnRlcmZhY2VzKTtcbiAgICAgICAgICAgICAgICBhc3RDbGFzc01haW4gPSBhc3RDbGFzc01haW4uY29uY2F0KGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgaW1wb3J0TGluZXMgPSBbXTtcblxuICAgICAgICAgICAgLy9nZW5lcmF0ZSBmdW5jdG9ycyBpZiBhbnlcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSkge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlLCAoZmlsZU5hbWUsIGZ1bmN0aW9uTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpbXBvcnRMaW5lcy5wdXNoKEpzTGFuZy5hc3RUb0NvZGUoSnNMYW5nLmFzdFJlcXVpcmUoZnVuY3Rpb25OYW1lLCBcIi5cIiArIGZpbGVOYW1lKSkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMsIChlbnRyeSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9nZW5lcmF0ZUZ1bmN0aW9uVGVtcGxhdGVGaWxlKHNjaGVtYSwgZW50cnkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgbGV0IG1peGlucyA9IFtdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5taXhpbnMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1peGluc0RpclBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBzY2hlbWEubmFtZSwgJ21peGlucycpO1xuICAgICAgICAgICAgICAgIGZzLmVuc3VyZURpclN5bmMobWl4aW5zRGlyUGF0aCk7XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5taXhpbnMuZm9yRWFjaChtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IG1peGluTmFtZSA9IHBhc2NhbENhc2UobSk7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IG1peGluRmlsZVBhdGggPSBwYXRoLmpvaW4obWl4aW5zRGlyUGF0aCwgbWl4aW5OYW1lICsgJy5qcycpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZzLnBhdGhFeGlzdHNTeW5jKG1peGluRmlsZVBhdGgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG1peGluRmlsZVBhdGgsIGBjb25zdCB7XG4gICAgRXJyb3JzOiB7IFZhbGlkYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciB9LFxuICAgIFByb2Nlc3NvcnMsXG4gICAgVmFsaWRhdG9yc1xufSA9IHJlcXVpcmUoXCJAZ2VueC9kYXRhXCIpO1xuY29uc3QgeyBfIH0gPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5cbm1vZHVsZS5leHBvcnRzID0gJHtjYXBpdGFsaXplZH0gPT4gY2xhc3MgZXh0ZW5kcyAke2NhcGl0YWxpemVkfSB7XG4gICAgLy90b2RvOiBhZGQgc3RhaWMgbWV0aG9kc1xufTtgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBtaXhpblZhck5hbWUgPSAnbWl4aW4nICsgbWl4aW5OYW1lO1xuICAgICAgICAgICAgICAgICAgICBpbXBvcnRMaW5lcy5wdXNoKEpzTGFuZy5hc3RUb0NvZGUoSnNMYW5nLmFzdFJlcXVpcmUobWl4aW5WYXJOYW1lLCAnLi9taXhpbnMvJyArIG1peGluTmFtZSkpKTtcbiAgICAgICAgICAgICAgICAgICAgbWl4aW5zLnB1c2gobWl4aW5WYXJOYW1lKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAvL2Fzc2VtYmxlIHRoZSBzb3VyY2UgY29kZSBmaWxlXG4gICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgYXN0Q2xhc3NNYWluKTtcblxuICAgICAgICAgICAgLy9Kc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIGVudGl0eS5maWVsZHMubWFwKCh2LCBrKSA9PiBKc0xhbmcuYXN0QXNzaWduKGNhcGl0YWxpemVkICsgJy5GXycgKyBfLnNuYWtlQ2FzZShrKS50b1VwcGVyQ2FzZSgpLCBrKSkpO1xuXG4gICAgICAgICAgICBsZXQgbG9jYWxzID0ge1xuICAgICAgICAgICAgICAgIGltcG9ydHM6IGltcG9ydExpbmVzLmpvaW4oXCJcXG5cIiksXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lOiBjYXBpdGFsaXplZCxcbiAgICAgICAgICAgICAgICBlbnRpdHlNZXRhOiBpbmRlbnRMaW5lcyhKU09OLnN0cmluZ2lmeShtb2RlbE1ldGEsIG51bGwsIDQpLCA0KSxcbiAgICAgICAgICAgICAgICBjbGFzc0JvZHk6IGluZGVudExpbmVzKGFzdENsYXNzTWFpbi5tYXAoKGJsb2NrKSA9PiBKc0xhbmcuYXN0VG9Db2RlKGJsb2NrKSkuam9pbihcIlxcblxcblwiKSwgOCksXG4gICAgICAgICAgICAgICAgZnVuY3RvcnM6IGluZGVudExpbmVzKFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VG9Db2RlKFxuICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhbHVlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF8ucmVkdWNlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKHJlc3VsdCwgZnVuY3RvcikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzdWx0W1wiJFwiICsgZnVuY3Rvci5mdW5jdGlvbk5hbWVdID0gSnNMYW5nLmFzdElkKGZ1bmN0b3IuZnVuY3Rpb25OYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHt9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICA0XG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAvL21peGluc1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgbGV0IGNsYXNzVGVtcGxhdGUgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRhdGFiYXNlXCIsIHRoaXMuY29ubmVjdG9yLmRyaXZlciwgXCJFbnRpdHlNb2RlbC5qcy5zd2lnXCIpO1xuICAgICAgICAgICAgbGV0IGNsYXNzQ29kZSA9IHN3aWcucmVuZGVyRmlsZShjbGFzc1RlbXBsYXRlLCBsb2NhbHMpO1xuXG4gICAgICAgICAgICBsZXQgbW9kZWxGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIHNjaGVtYS5uYW1lLCBcImJhc2VcIiwgY2FwaXRhbGl6ZWQgKyBcIi5qc1wiKTtcbiAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoLCBjbGFzc0NvZGUpO1xuXG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGVudGl0eSBtb2RlbDogXCIgKyBtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEoc2NoZW1hKSB7XG4gICAgICAgIC8vZ2VuZXJhdGUgdmFsaWRhdG9yIGNvbmZpZ1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKGVudGl0eS5pbnB1dHMsIChpbnB1dHMsIGlucHV0U2V0TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHZhbGlkYXRpb25TY2hlbWEgPSB7fTtcbiAgICAgICAgICAgICAgICBjb25zdCBkZXBlbmRlbmNpZXMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oKTtcblxuICAgICAgICAgICAgICAgIGlucHV0cy5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAvLzphZGRyZXNzXG4gICAgICAgICAgICAgICAgICAgIGlmIChpbnB1dC5uYW1lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhc3NvYyA9IGlucHV0Lm5hbWUuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gZW50aXR5LmFzc29jaWF0aW9uc1thc3NvY107XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIgbm90IGZvdW5kIGluIGVudGl0eSBbJHtlbnRpdHlJbnN0YW5jZU5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpbnB1dC5zcGVjKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgSW5wdXQgXCJzcGVjXCIgaXMgcmVxdWlyZWQgZm9yIGVudGl0eSByZWZlcmVuY2UuIElucHV0IHNldDogJHtpbnB1dFNldE5hbWV9LCBsb2NhbDogJHthc3NvY30sIHJlZmVyZW5jZWRFbnRpdHk6ICR7YXNzb2NNZXRhLmVudGl0eX1gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGVwID0gYCR7YXNzb2NNZXRhLmVudGl0eX0tJHtpbnB1dC5zcGVjfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXBlbmRlbmNpZXMuYWRkKGRlcCk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbGlkYXRpb25TY2hlbWFbaW5wdXQubmFtZV0gPSBKc0xhbmcuYXN0VmFsdWUoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcImFycmF5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVsZW1lbnRTY2hlbWE6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzY2hlbWE6IEpzTGFuZy5hc3RDYWxsKF8uY2FtZWxDYXNlKGRlcCkpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5fLnBpY2soaW5wdXQsIFtcIm9wdGlvbmFsXCJdKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtpbnB1dC5uYW1lXSA9IEpzTGFuZy5hc3RWYWx1ZSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNjaGVtYTogSnNMYW5nLmFzdENhbGwoXy5jYW1lbENhc2UoZGVwKSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLl8ucGljayhpbnB1dCwgW1wib3B0aW9uYWxcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmllbGQgPSBlbnRpdHkuZmllbGRzW2lucHV0Lm5hbWVdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWVsZCBcIiR7aW5wdXQubmFtZX1cIiBub3QgZm91bmQgaW4gZW50aXR5IFske2VudGl0eUluc3RhbmNlTmFtZX1dLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2lucHV0Lm5hbWVdID0gSnNMYW5nLmFzdFZhbHVlKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5fLnBpY2soZmllbGQsIFtcInR5cGVcIiwgXCJ2YWx1ZXNcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLl8ucGljayhpbnB1dCwgW1wib3B0aW9uYWxcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIEFycmF5LmZyb20oZGVwZW5kZW5jaWVzKS5mb3JFYWNoKChkZXApID0+XG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFJlcXVpcmUoXy5jYW1lbENhc2UoZGVwKSwgYC4vJHtkZXB9YCkpXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KFxuICAgICAgICAgICAgICAgICAgICBhc3QsXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RBc3NpZ24oXG4gICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKFwibW9kdWxlLmV4cG9ydHNcIiksXG4gICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QXJyb3dGdW5jdGlvbihbXSwgSnNMYW5nLmFzdFZhbHVlKHZhbGlkYXRpb25TY2hlbWEpKVxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGxldCBpbnB1dFNjaGVtYUZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLm91dHB1dFBhdGgsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBcImlucHV0c1wiLFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHlJbnN0YW5jZU5hbWUgKyBcIi1cIiArIGlucHV0U2V0TmFtZSArIFwiLmpzXCJcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGlucHV0U2NoZW1hRmlsZVBhdGgpO1xuICAgICAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMoaW5wdXRTY2hlbWFGaWxlUGF0aCwgSnNMYW5nLmFzdFRvQ29kZShhc3QpKTtcblxuICAgICAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgXCJHZW5lcmF0ZWQgZW50aXR5IG1hbmlmZXN0OiBcIiArIGVudGl0eU91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdChzY2hlbWEpIHtcbiAgICAgICAgbGV0IGVudGl0aWVzID0gT2JqZWN0LmtleXMoc2NoZW1hLmVudGl0aWVzKVxuICAgICAgICAgICAgLnNvcnQoKVxuICAgICAgICAgICAgLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0ge307XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgLypcbiAgICAgICAgbGV0IG1hbmlmZXN0ID0ge307XG5cbiAgICAgICAgXy5lYWNoKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLnJlc3RmdWwpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goZW50aXR5LmluZm8ucmVzdGZ1bCwgKHsgdHlwZSwgbWV0aG9kcyB9LCByZWxhdGl2ZVVyaSkgPT4geyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBhcGlJbmZvID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZHM6IHt9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZSA9PT0gJ2VudGl0eScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFwaUluZm8uZW50aXR5ID0gZW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFwaUluZm8uZGlzcGxheU5hbWUgPSBlbnRpdHkuZGlzcGxheU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlbnRpdHkuY29tbWVudCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwaUluZm8uZGVzY3JpcHRpb24gPSBlbnRpdHkuY29tbWVudDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIF8uZWFjaChtZXRob2RzLCAobWV0YSwgbWV0aG9kTmFtZSkgPT4ge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKG1ldGhvZE5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdjcmVhdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLm1ldGhvZHNbJ3Bvc3Q6JyArIHJlbGF0aXZlVXJpXSA9IG1ldGE7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdmaW5kT25lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2ZpbmVBbGwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAndXBkYXRlT25lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZU1hbnknOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZGVsZXRlT25lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2RlbGV0ZU1hbnknOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgKi9cbiAgICAgICAgLypcbiAgICAgICAgbGV0IG91dHB1dEZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMubWFuaWZlc3RQYXRoLCBzY2hlbWEubmFtZSArICcubWFuaWZlc3QuanNvbicpO1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhvdXRwdXRGaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMob3V0cHV0RmlsZVBhdGgsIEpTT04uc3RyaW5naWZ5KGVudGl0aWVzLCBudWxsLCA0KSk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBzY2hlbWEgbWFuaWZlc3Q6ICcgKyBvdXRwdXRGaWxlUGF0aCk7XG4gICAgICAgICovXG5cbiAgICAgICAgLy9nZW5lcmF0ZSB2YWxpZGF0b3IgY29uZmlnXG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5SW5zdGFuY2VOYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgdmFsaWRhdGlvblNjaGVtYSA9IHt9O1xuXG4gICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmllbGRzLCAoZmllbGQsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZC5yZWFkT25seSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkU2NoZW1hID0ge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBmaWVsZC50eXBlLFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gXCJlbnVtXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGRTY2hlbWEudmFsdWVzID0gZmllbGQudmFsdWVzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZFNjaGVtYS5vcHRpb25hbCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtmaWVsZE5hbWVdID0gZmllbGRTY2hlbWE7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IGVudGl0eU91dHB1dEZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKFxuICAgICAgICAgICAgICAgIHRoaXMubWFuaWZlc3RQYXRoLFxuICAgICAgICAgICAgICAgIHNjaGVtYS5uYW1lLFxuICAgICAgICAgICAgICAgIFwidmFsaWRhdGlvblwiLFxuICAgICAgICAgICAgICAgIGVudGl0eUluc3RhbmNlTmFtZSArIFwiLm1hbmlmZXN0Lmpzb25cIlxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGVudGl0eU91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZW50aXR5T3V0cHV0RmlsZVBhdGgsIEpTT04uc3RyaW5naWZ5KHZhbGlkYXRpb25TY2hlbWEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBcIkdlbmVyYXRlZCBlbnRpdHkgbWFuaWZlc3Q6IFwiICsgZW50aXR5T3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKlxuICAgIF9nZW5lcmF0ZVZpZXdNb2RlbChzY2hlbWEsIGRiU2VydmljZSkgeyAgICAgICAgXG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS52aWV3cywgKHZpZXdJbmZvLCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5saW5rZXIuaW5mbygnQnVpbGRpbmcgdmlldzogJyArIHZpZXdOYW1lKTtcblxuICAgICAgICAgICAgbGV0IGNhcGl0YWxpemVkID0gXy51cHBlckZpcnN0KHZpZXdOYW1lKTtcblxuICAgICAgICAgICAgbGV0IGFzdCA9IEpzTGFuZy5hc3RQcm9ncmFtKCk7XG5cbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFJlcXVpcmUoJ01vd2EnLCAnbW93YScpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFZhckRlY2xhcmUoJ1V0aWwnLCBKc0xhbmcuYXN0VmFyUmVmKCdNb3dhLlV0aWwnKSwgdHJ1ZSkpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0VmFyRGVjbGFyZSgnXycsIEpzTGFuZy5hc3RWYXJSZWYoJ1V0aWwuXycpLCB0cnVlKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RSZXF1aXJlKCdWaWV3JywgJ21vd2EvbGliL29vbG9uZy9ydW50aW1lL3ZpZXcnKSk7XG5cbiAgICAgICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IE9vbFRvQXN0LmNyZWF0ZUNvbXBpbGVDb250ZXh0KHZpZXdOYW1lLCBkYlNlcnZpY2Uuc2VydmljZUlkLCB0aGlzLmxpbmtlcik7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycy5hZGQodmlld0luZm8uZW50aXR5KTtcblxuICAgICAgICAgICAgbGV0IHBhcmFtTWV0YTtcblxuICAgICAgICAgICAgaWYgKHZpZXdJbmZvLnBhcmFtcykge1xuICAgICAgICAgICAgICAgIHBhcmFtTWV0YSA9IHRoaXMuX3Byb2Nlc3NQYXJhbXModmlld0luZm8ucGFyYW1zLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB2aWV3TWV0YSA9IHtcbiAgICAgICAgICAgICAgICBpc0xpc3Q6IHZpZXdJbmZvLmlzTGlzdCxcbiAgICAgICAgICAgICAgICBwYXJhbXM6IHBhcmFtTWV0YVxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgbGV0IHZpZXdCb2R5VG9wb0lkID0gT29sVG9Bc3QuY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHZpZXcnKTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQsIHZpZXdCb2R5VG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IHZpZXdNb2RlbGVyID0gcmVxdWlyZShwYXRoLnJlc29sdmUoX19kaXJuYW1lLCAnLi9kYW8vdmlldycsIGRiU2VydmljZS5kYlR5cGUgKyAnLmpzJykpO1xuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZpZXdCb2R5VG9wb0lkXSA9IHZpZXdNb2RlbGVyKGRiU2VydmljZSwgdmlld05hbWUsIHZpZXdJbmZvKTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdmlld0JvZHlUb3BvSWQsIHtcbiAgICAgICAgICAgICAgICB0eXBlOiBPb2xUb0FzdC5BU1RfQkxLX1ZJRVdfT1BFUkFUSU9OXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgbGV0IHJldHVyblRvcG9JZCA9IE9vbFRvQXN0LmNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm46dmFsdWUnKTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdmlld0JvZHlUb3BvSWQsIHJldHVyblRvcG9JZCk7XG4gICAgICAgICAgICBPb2xUb0FzdC5jb21waWxlUmV0dXJuKHJldHVyblRvcG9JZCwge1xuICAgICAgICAgICAgICAgIFwib29sVHlwZVwiOiBcIk9iamVjdFJlZmVyZW5jZVwiLFxuICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcInZpZXdEYXRhXCJcbiAgICAgICAgICAgIH0sIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IGRlcHMgPSBjb21waWxlQ29udGV4dC50b3BvU29ydC5zb3J0KCk7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgZGVwZW5kZW5jaWVzOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIGRlcHMgPSBkZXBzLmZpbHRlcihkZXAgPT4gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5oYXMoZGVwKSk7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgbmVjZXNzYXJ5IHNvdXJjZSBjb2RlOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIGxldCBhc3REb0xvYWRNYWluID0gW1xuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKCckbWV0YScsIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMubWV0YScpLCB0cnVlLCBmYWxzZSwgJ1JldHJpZXZpbmcgdGhlIG1ldGEgZGF0YScpXG4gICAgICAgICAgICBdO1xuXG4gICAgICAgICAgICBfLmVhY2goZGVwcywgZGVwID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0TWV0YSA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KGRlcCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYXN0QmxvY2sgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXTtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGFzdEJsb2NrLCAnRW1wdHkgYXN0IGJsb2NrJztcblxuICAgICAgICAgICAgICAgIGlmIChhc3RNZXRhLnR5cGUgPT09ICdNb2RpZmllckNhbGwnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZE5hbWUgPSBnZXRGaWVsZE5hbWUoYXN0TWV0YS50YXJnZXQpO1xuICAgICAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBKc0xhbmcuYXN0QXNzaWduKEpzTGFuZy5hc3RWYXJSZWYoYXN0TWV0YS50YXJnZXQpLCBhc3RCbG9jaywgYE1vZGlmeWluZyAke2ZpZWxkTmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgYXN0RG9Mb2FkTWFpbi5wdXNoKGFzdENhY2hlKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzdERvTG9hZE1haW4gPSBhc3REb0xvYWRNYWluLmNvbmNhdChfLmNhc3RBcnJheShjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXSkpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSkpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUsIChmaWxlTmFtZSwgZnVuY3Rpb25OYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFJlcXVpcmUoZnVuY3Rpb25OYW1lLCAnLicgKyBmaWxlTmFtZSkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb21waWxlQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMpKSB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcywgZW50cnkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9nZW5lcmF0ZUZ1bmN0aW9uVGVtcGxhdGVGaWxlKGRiU2VydmljZSwgZW50cnkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RDbGFzc0RlY2xhcmUoY2FwaXRhbGl6ZWQsICdWaWV3JywgW1xuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoJ19kb0xvYWQnLCBPYmplY3Qua2V5cyhwYXJhbU1ldGEpLFxuICAgICAgICAgICAgICAgICAgICBhc3REb0xvYWRNYWluLFxuICAgICAgICAgICAgICAgICAgICBmYWxzZSwgdHJ1ZSwgZmFsc2UsICdQb3B1bGF0ZSB2aWV3IGRhdGEnXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgXSwgYCR7Y2FwaXRhbGl6ZWR9IHZpZXdgKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RBc3NpZ24oY2FwaXRhbGl6ZWQgKyAnLm1ldGEnLCBKc0xhbmcuYXN0VmFsdWUodmlld01ldGEpKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RBc3NpZ24oJ21vZHVsZS5leHBvcnRzJywgSnNMYW5nLmFzdFZhclJlZihjYXBpdGFsaXplZCkpKTtcblxuICAgICAgICAgICAgbGV0IG1vZGVsRmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBkYlNlcnZpY2UuZGJUeXBlLCBkYlNlcnZpY2UubmFtZSwgJ3ZpZXdzJywgdmlld05hbWUgKyAnLmpzJyk7XG4gICAgICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCArICcuanNvbicsIEpTT04uc3RyaW5naWZ5KGFzdCwgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBEYW9Nb2RlbGVyLl9leHBvcnRTb3VyY2VDb2RlKGFzdCwgbW9kZWxGaWxlUGF0aCk7XG5cbiAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgdmlldyBtb2RlbDogJyArIG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgICovXG5cbiAgICBfcHJvY2Vzc0ZpZWxkTW9kaWZpZXJzKGVudGl0eSwgc2hhcmVkQ29udGV4dCkge1xuICAgICAgICBsZXQgY29tcGlsZUNvbnRleHQgPSBHZW1sVG9Bc3QuY3JlYXRlQ29tcGlsZUNvbnRleHQoZW50aXR5LmdlbWxNb2R1bGUubmFtZSwgdGhpcy5saW5rZXIsIHNoYXJlZENvbnRleHQpO1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXCJyYXdcIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIsIGZpbmFsaXplZDogdHJ1ZSB9O1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXCJpMThuXCJdID0geyBzb3VyY2U6IFwiY29udGV4dFwiLCBmaW5hbGl6ZWQ6IHRydWUgfTtcbiAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW1wiY29ubmVjdG9yXCJdID0geyBzb3VyY2U6IFwiY29udGV4dFwiLCBmaW5hbGl6ZWQ6IHRydWUgfTtcbiAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW1wibGF0ZXN0XCJdID0geyBzb3VyY2U6IFwiY29udGV4dFwiIH07XG5cbiAgICAgICAgY29uc3QgYWxsRmluaXNoZWQgPSBHZW1sVG9Bc3QuY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBcImRvbmUuXCIpO1xuXG4gICAgICAgIC8vbWFwIG9mIGZpZWxkIG5hbWUgdG8gZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBmaWVsZFJlZmVyZW5jZXMgPSB7fTtcblxuICAgICAgICBfLmZvck93bihlbnRpdHkuZmllbGRzLCAoZmllbGQsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgbGV0IHRvcG9JZCA9IEdlbWxUb0FzdC5jb21waWxlRmllbGQoZmllbGROYW1lLCBmaWVsZCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgR2VtbFRvQXN0LmRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdG9wb0lkLCBhbGxGaW5pc2hlZCk7XG5cbiAgICAgICAgICAgIGlmIChmaWVsZC53cml0ZU9uY2UgfHwgZmllbGQuZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgcHV0SW50b0J1Y2tldChmaWVsZFJlZmVyZW5jZXMsIGZpZWxkTmFtZSwgeyByZWZlcmVuY2U6IGZpZWxkTmFtZSwgd3JpdGVQcm90ZWN0OiB0cnVlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgZGVwZW5kZW5jaWVzOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKChkZXApID0+IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuaGFzKGRlcCkpO1xuICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBuZWNlc3Nhcnkgc291cmNlIGNvZGU6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICBsZXQgbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCA9IFtdLFxuICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLFxuICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlID0gW10sXG4gICAgICAgICAgICBsYXN0QmxvY2ssXG4gICAgICAgICAgICBsYXN0QXN0VHlwZTsgLy8sIGhhc1ZhbGlkYXRvciA9IGZhbHNlO1xuXG4gICAgICAgIGNvbnN0IF9tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSA9IGZ1bmN0aW9uIChmaWVsZE5hbWUsIHJlZmVyZW5jZXMsIGFzdENhY2hlLCByZXF1aXJlVGFyZ2V0RmllbGQpIHtcbiAgICAgICAgICAgIGxldCBmaWVsZHMgPSBbZmllbGROYW1lXS5jb25jYXQocmVmZXJlbmNlcyk7XG4gICAgICAgICAgICBsZXQgY2hlY2tlciA9IGZpZWxkcy5qb2luKFwiLFwiKTtcblxuICAgICAgICAgICAgaWYgKGxhc3RGaWVsZHNHcm91cCAmJiBsYXN0RmllbGRzR3JvdXAuY2hlY2tlciAhPT0gY2hlY2tlcikge1xuICAgICAgICAgICAgICAgIG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwgPSBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsLmNvbmNhdChcbiAgICAgICAgICAgICAgICAgICAgU25pcHBldHMuX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayhcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5maWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAucmVmZXJlbmNlcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5yZXF1aXJlVGFyZ2V0RmllbGRcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlID0gW107XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSA9IG1ldGhvZEJvZHlDYWNoZS5jb25jYXQoYXN0Q2FjaGUpO1xuICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwID0ge1xuICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICByZWZlcmVuY2VzLFxuICAgICAgICAgICAgICAgIHJlcXVpcmVUYXJnZXRGaWVsZCxcbiAgICAgICAgICAgICAgICBjaGVja2VyLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfTtcblxuICAgICAgICAvL2NvbnNvbGUuZGlyKGNvbXBpbGVDb250ZXh0LmFzdE1hcFsnbW9iaWxlfmlzTW9iaWxlUGhvbmU6YXJnWzFdfD5zdHJpbmdEYXNoZXJpemUnXSwgeyBkZXB0aDogOCB9KTtcblxuICAgICAgICBfLmVhY2goZGVwcywgKGRlcCwgaSkgPT4ge1xuICAgICAgICAgICAgLy9nZXQgbWV0YWRhdGEgb2Ygc291cmNlIGNvZGUgYmxvY2tcbiAgICAgICAgICAgIGxldCBzb3VyY2VNYXAgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldChkZXApO1xuXG4gICAgICAgICAgICAvL2dldCBzb3VyY2UgY29kZSBibG9ja1xuICAgICAgICAgICAgbGV0IGFzdEJsb2NrID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW2RlcF07XG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRGaWVsZE5hbWUgPSBnZXRGaWVsZE5hbWUoc291cmNlTWFwLnRhcmdldCk7XG5cbiAgICAgICAgICAgIGlmIChzb3VyY2VNYXAucmVmZXJlbmNlcyAmJiBzb3VyY2VNYXAucmVmZXJlbmNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUmVmZXJlbmNlID0gZmllbGRSZWZlcmVuY2VzW3RhcmdldEZpZWxkTmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKCFmaWVsZFJlZmVyZW5jZSkge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZFJlZmVyZW5jZXNbdGFyZ2V0RmllbGROYW1lXSA9IGZpZWxkUmVmZXJlbmNlID0gW107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgICAgICBzb3VyY2VNYXAucmVmZXJlbmNlcy5mb3JFYWNoKChyZWYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkUmVmZXJlbmNlLnB1c2goeyByZWZlcmVuY2U6IHJlZiwgd2hlbk51bGw6IHRydWUgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNvdXJjZU1hcC5yZWZlcmVuY2VzLmZvckVhY2goKHJlZikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkUmVmZXJlbmNlLmluZGV4T2YocmVmKSA9PT0gLTEpIGZpZWxkUmVmZXJlbmNlLnB1c2gocmVmKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobGFzdEJsb2NrKSB7XG4gICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBjaGFpbkNhbGwobGFzdEJsb2NrLCBsYXN0QXN0VHlwZSwgYXN0QmxvY2ssIHNvdXJjZU1hcC50eXBlKTtcbiAgICAgICAgICAgICAgICBsYXN0QmxvY2sgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpIDwgZGVwcy5sZW5ndGggLSAxKSB7XG4gICAgICAgICAgICAgICAgbGV0IG5leHRUeXBlID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwc1tpICsgMV0pO1xuXG4gICAgICAgICAgICAgICAgaWYgKGlzQ2hhaW5hYmxlKHNvdXJjZU1hcCwgbmV4dFR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxhc3RCbG9jayA9IGFzdEJsb2NrO1xuICAgICAgICAgICAgICAgICAgICBsYXN0QXN0VHlwZSA9IHNvdXJjZU1hcC50eXBlO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX1ZBTElEQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgLy9oYXNWYWxpZGF0b3IgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IFNuaXBwZXRzLl92YWxpZGF0ZUNoZWNrKHRhcmdldEZpZWxkTmFtZSwgYXN0QmxvY2spO1xuXG4gICAgICAgICAgICAgICAgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgc291cmNlTWFwLnJlZmVyZW5jZXMsIGFzdENhY2hlLCB0cnVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX1BST0NFU1NPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhY2hlID0gSnNMYW5nLmFzdEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0LCB0cnVlKSxcbiAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIF9tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSh0YXJnZXRGaWVsZE5hbWUsIHNvdXJjZU1hcC5yZWZlcmVuY2VzLCBhc3RDYWNoZSwgdHJ1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IFNuaXBwZXRzLl9jaGVja0FuZEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksXG4gICAgICAgICAgICAgICAgICAgIGBBY3RpdmF0aW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIF9tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSh0YXJnZXRGaWVsZE5hbWUsIHNvdXJjZU1hcC5yZWZlcmVuY2VzLCBhc3RDYWNoZSwgZmFsc2UpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUbyBiZSBpbXBsZW1lbnRlZC5cIik7XG4gICAgICAgICAgICAgICAgLy9hc3RCbG9jayA9IF8uY2FzdEFycmF5KGFzdEJsb2NrKTtcbiAgICAgICAgICAgICAgICAvL19tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSh0YXJnZXRGaWVsZE5hbWUsIFtdLCBhc3RCbG9jayk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8qIENoYW5nZWQgdG8gdGhyb3cgZXJyb3IgaW5zdGVhZCBvZiByZXR1cm5pbmcgYSBlcnJvciBvYmplY3RcbiAgICAgICAgaWYgKGhhc1ZhbGlkYXRvcikge1xuICAgICAgICAgICAgbGV0IGRlY2xhcmUgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZSh2YWxpZFN0YXRlTmFtZSwgZmFsc2UpO1xuICAgICAgICAgICAgbWV0aG9kQm9keUNyZWF0ZS51bnNoaWZ0KGRlY2xhcmUpO1xuICAgICAgICAgICAgbWV0aG9kQm9keVVwZGF0ZS51bnNoaWZ0KGRlY2xhcmUpO1xuICAgICAgICB9XG4gICAgICAgICovXG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkobWV0aG9kQm9keUNhY2hlKSkge1xuICAgICAgICAgICAgbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCA9IG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwuY29uY2F0KFxuICAgICAgICAgICAgICAgIFNuaXBwZXRzLl9maWVsZFJlcXVpcmVtZW50Q2hlY2soXG4gICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5maWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5yZWZlcmVuY2VzLFxuICAgICAgICAgICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUsXG4gICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5yZXF1aXJlVGFyZ2V0RmllbGRcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLypcbiAgICAgICAgbGV0IGFzdCA9IEpzTGFuZy5hc3RQcm9ncmFtKGZhbHNlKTtcbiAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0Q2xhc3NEZWNsYXJlKCdBYmMnLCAnTW9kZWwnLCBbXG4gICAgICAgICAgICBKc0xhbmcuYXN0TWVtYmVyTWV0aG9kKGFzeW5jTWV0aG9kTmFtaW5nKCdwcmVwYXJlRW50aXR5RGF0YV8nKSwgWyAnY29udGV4dCcgXSxcbiAgICAgICAgICAgIFNuaXBwZXRzLl9kb1ZhbGlkYXRlQW5kRmlsbEhlYWRlci5jb25jYXQobWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCkuY29uY2F0KFsgSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoJ2NvbnRleHQnKSkgXSksXG4gICAgICAgICAgICBmYWxzZSwgdHJ1ZSwgdHJ1ZVxuICAgICAgICApXSwgJ2NvbW1lbnQnKSk7XG4gICAgICAgICovXG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGFzdDogSnNMYW5nLmFzdE1lbWJlck1ldGhvZChcbiAgICAgICAgICAgICAgICBhc3luY01ldGhvZE5hbWluZyhcImFwcGx5TW9kaWZpZXJzXCIpLFxuICAgICAgICAgICAgICAgIFtcImNvbnRleHRcIiwgXCJpc1VwZGF0aW5nXCJdLFxuICAgICAgICAgICAgICAgIFNuaXBwZXRzLl9hcHBseU1vZGlmaWVyc0hlYWRlclxuICAgICAgICAgICAgICAgICAgICAuY29uY2F0KG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwpXG4gICAgICAgICAgICAgICAgICAgIC5jb25jYXQoW0pzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKFwiY29udGV4dFwiKSldKSxcbiAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgXCJBcHBseWluZyBwcmVkZWZpbmVkIG1vZGlmaWVycyB0byBlbnRpdHkgZmllbGRzLlwiXG4gICAgICAgICAgICApLFxuICAgICAgICAgICAgZmllbGRSZWZlcmVuY2VzLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUZ1bmN0aW9uVGVtcGxhdGVGaWxlKHNjaGVtYSwgeyBmdW5jdGlvbk5hbWUsIGZ1bmN0b3JUeXBlLCBmaWxlTmFtZSwgYXJncyB9KSB7XG4gICAgICAgIGxldCBmaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIHNjaGVtYS5uYW1lLCBmaWxlTmFtZSk7XG5cbiAgICAgICAgaWYgKGZzLmV4aXN0c1N5bmMoZmlsZVBhdGgpKSB7XG4gICAgICAgICAgICAvL3RvZG86IGFuYWx5c2UgY29kZSwgY29tcGFyZSBhcmd1bWVudHNcbiAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgYCR7Xy51cHBlckZpcnN0KGZ1bmN0b3JUeXBlKX0gXCIke2ZpbGVOYW1lfVwiIGV4aXN0cy4gRmlsZSBnZW5lcmF0aW5nIHNraXBwZWQuYCk7XG5cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhc3QgPSBKc0xhbmcuYXN0UHJvZ3JhbSgpO1xuXG4gICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgYXJncywgT09MX01PRElGSUVSX1JFVFVSTltmdW5jdG9yVHlwZV0oYXJncykpKTtcbiAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0QXNzaWduKFwibW9kdWxlLmV4cG9ydHNcIiwgSnNMYW5nLmFzdFZhclJlZihmdW5jdGlvbk5hbWUpKSk7XG5cbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBKc0xhbmcuYXN0VG9Db2RlKGFzdCkpO1xuICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIGBHZW5lcmF0ZWQgJHtmdW5jdG9yVHlwZX0gZmlsZTogJHtmaWxlUGF0aH1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRJbnRlcmZhY2VzKGVudGl0eSwgbW9kZWxNZXRhSW5pdCwgc2hhcmVkQ29udGV4dCkge1xuICAgICAgICBsZXQgYXN0ID0gW107XG5cbiAgICAgICAgXy5mb3JPd24oZW50aXR5LmludGVyZmFjZXMsIChtZXRob2QsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLmluZm8oXCJCdWlsZGluZyBpbnRlcmZhY2U6IFwiICsgbmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBhc3RCb2R5ID0gW1xuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKFxuICAgICAgICAgICAgICAgICAgICBcIiRtZXRhXCIsXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoXCJ0aGlzLm1ldGEuaW50ZXJmYWNlcy5cIiArIG5hbWUpLFxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgXCJSZXRyaWV2aW5nIHRoZSBtZXRhIGRhdGFcIlxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICBdO1xuXG4gICAgICAgICAgICBsZXQgY29tcGlsZUNvbnRleHQgPSBHZW1sVG9Bc3QuY3JlYXRlQ29tcGlsZUNvbnRleHQoZW50aXR5LmdlbWxNb2R1bGUubmFtZSwgdGhpcy5saW5rZXIsIHNoYXJlZENvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcGFyYW1NZXRhO1xuXG4gICAgICAgICAgICBpZiAobWV0aG9kLmFjY2VwdCkge1xuICAgICAgICAgICAgICAgIHBhcmFtTWV0YSA9IHRoaXMuX3Byb2Nlc3NQYXJhbXMobWV0aG9kLmFjY2VwdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL21ldGFkYXRhXG4gICAgICAgICAgICBtb2RlbE1ldGFJbml0W1wiaW50ZXJmYWNlc1wiXSB8fCAobW9kZWxNZXRhSW5pdFtcImludGVyZmFjZXNcIl0gPSB7fSk7XG4gICAgICAgICAgICBtb2RlbE1ldGFJbml0W1wiaW50ZXJmYWNlc1wiXVtuYW1lXSA9IHsgcGFyYW1zOiBPYmplY3QudmFsdWVzKHBhcmFtTWV0YSkgfTtcblxuICAgICAgICAgICAgXy5lYWNoKG1ldGhvZC5pbXBsZW1lbnRhdGlvbiwgKG9wZXJhdGlvbiwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgICAvL2xldCBsYXN0VG9wb0lkID1cbiAgICAgICAgICAgICAgICBHZW1sVG9Bc3QuY29tcGlsZURiT3BlcmF0aW9uKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKG1ldGhvZC5yZXR1cm4pIHtcbiAgICAgICAgICAgICAgICBHZW1sVG9Bc3QuY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG1ldGhvZC5yZXR1cm4sIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGRlcHMgPSBjb21waWxlQ29udGV4dC50b3BvU29ydC5zb3J0KCk7XG4gICAgICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKChkZXApID0+IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuaGFzKGRlcCkpO1xuICAgICAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgbmVjZXNzYXJ5IHNvdXJjZSBjb2RlOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIF8uZWFjaChkZXBzLCAoZGVwKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IHNvdXJjZU1hcCA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KGRlcCk7XG4gICAgICAgICAgICAgICAgbGV0IGFzdEJsb2NrID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW2RlcF07XG5cbiAgICAgICAgICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0NvZGUgcG9pbnQgXCInICsgZGVwICsgJ1wiOlxcbicgKyBKU09OLnN0cmluZ2lmeShzb3VyY2VNYXAsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgICAgIGxldCB0YXJnZXRGaWVsZE5hbWUgPSBzb3VyY2VNYXAudGFyZ2V0OyAvL2dldEZpZWxkTmFtZShzb3VyY2VNYXAudGFyZ2V0KTtcblxuICAgICAgICAgICAgICAgIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfVkFMSURBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBTbmlwcGV0cy5fdmFsaWRhdGVDaGVjayh0YXJnZXRGaWVsZE5hbWUsIGFzdEJsb2NrKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc291cmNlTWFwLm5lZWREZWNsYXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb2Nlc3NpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IEpzTGFuZy5hc3RBc3NpZ24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0LCB0cnVlKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzb3VyY2VNYXAubmVlZERlY2xhcmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdFZhckRlY2xhcmUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBBY3RpdmF0aW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXN0Qm9keSA9IGFzdEJvZHkuY29uY2F0KF8uY2FzdEFycmF5KGFzdEJsb2NrKSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgYXN0LnB1c2goXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdE1lbWJlck1ldGhvZChcbiAgICAgICAgICAgICAgICAgICAgYXN5bmNNZXRob2ROYW1pbmcobmFtZSksXG4gICAgICAgICAgICAgICAgICAgIE9iamVjdC5rZXlzKHBhcmFtTWV0YSksXG4gICAgICAgICAgICAgICAgICAgIGFzdEJvZHksXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgICAgICAgICByZXBsYWNlQWxsKF8ua2ViYWJDYXNlKG5hbWUpLCBcIi1cIiwgXCIgXCIpXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFzdDtcbiAgICB9XG5cbiAgICBfcHJvY2Vzc1BhcmFtcyhhY2NlcHRQYXJhbXMsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgICAgIGxldCBwYXJhbU1ldGEgPSB7fTtcblxuICAgICAgICBhY2NlcHRQYXJhbXMuZm9yRWFjaCgocGFyYW0sIGkpID0+IHtcbiAgICAgICAgICAgIEdlbWxUb0FzdC5jb21waWxlUGFyYW0oaSwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIHBhcmFtTWV0YVtwYXJhbS5uYW1lXSA9IHBhcmFtO1xuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3BhcmFtLm5hbWVdID0geyBzb3VyY2U6IFwiYXJndW1lbnRcIiB9O1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcGFyYW1NZXRhO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBEYW9Nb2RlbGVyO1xuIl19