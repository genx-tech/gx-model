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
              validationSchema[input.name] = {
                type: "object",
                schema: JsLang.astCall(_.camelCase(dep)),
                ...DaoModeler_.pick(input, ["optional"])
              };
            }
          } else {
            const field = entity.fields[input.name];

            if (!field) {
              throw new Error(`Field "${input.name}" not found in entity [${entityInstanceName}].`);
            }

            validationSchema[input.name] = JsLang.astValue({ ..._.pick(fields, ["type", "values"]),
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9tb2RlbGVyL0Rhby5qcyJdLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsIl8iLCJmcyIsInBhc2NhbENhc2UiLCJyZXBsYWNlQWxsIiwicHV0SW50b0J1Y2tldCIsInN3aWciLCJHZW1sVHlwZXMiLCJKc0xhbmciLCJHZW1sVG9Bc3QiLCJTbmlwcGV0cyIsIkNoYWluYWJsZVR5cGUiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCIsIkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwiLCJnZXRGaWVsZE5hbWUiLCJ0Iiwic3BsaXQiLCJwb3AiLCJpc0NoYWluYWJsZSIsImN1cnJlbnQiLCJuZXh0IiwiaW5kZXhPZiIsInR5cGUiLCJ0YXJnZXQiLCJjaGFpbkNhbGwiLCJsYXN0QmxvY2siLCJsYXN0VHlwZSIsImN1cnJlbnRCbG9jayIsImN1cnJlbnRUeXBlIiwiYXN0QmluRXhwIiwiYXJndW1lbnRzIiwiYXN5bmNNZXRob2ROYW1pbmciLCJuYW1lIiwiaW5kZW50TGluZXMiLCJsaW5lcyIsImluZGVudGF0aW9uIiwibWFwIiwibGluZSIsImkiLCJyZXBlYXQiLCJqb2luIiwiT09MX01PRElGSUVSX1JFVFVSTiIsIk1vZGlmaWVyIiwiVkFMSURBVE9SIiwiYXN0UmV0dXJuIiwiUFJPQ0VTU09SIiwiYXJncyIsImFzdElkIiwiQUNUSVZBVE9SIiwiRGFvTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImxpbmtlciIsImNvbm5lY3RvciIsIm91dHB1dFBhdGgiLCJtb2RlbFBhdGgiLCJtYW5pZmVzdFBhdGgiLCJtb2RlbGluZ18iLCJzY2hlbWEiLCJsb2ciLCJfZ2VuZXJhdGVTY2hlbWFNb2RlbCIsIl9nZW5lcmF0ZUVudGl0eU1vZGVsIiwiX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEiLCJfZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdCIsImNhcGl0YWxpemVkIiwibG9jYWxzIiwiZHJpdmVyIiwiY2xhc3NOYW1lIiwic2NoZW1hTmFtZSIsImVudGl0aWVzIiwiSlNPTiIsInN0cmluZ2lmeSIsIk9iamVjdCIsImtleXMiLCJjbGFzc1RlbXBsYXRlIiwicmVzb2x2ZSIsIl9fZGlybmFtZSIsImNsYXNzQ29kZSIsInJlbmRlckZpbGUiLCJtb2RlbEZpbGVQYXRoIiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiX2dlbmVyYXRlRW51bVR5cGVzIiwiZm9yT3duIiwiZW50aXR5IiwiZW50aXR5SW5zdGFuY2VOYW1lIiwiZmllbGRzIiwiZmllbGQiLCJmaWVsZE5hbWUiLCJzaGFyZWRDb250ZXh0IiwibWFwT2ZGdW5jdG9yVG9GaWxlIiwibmV3RnVuY3RvckZpbGVzIiwiYXN0IiwiYXN0Q2xhc3NNYWluIiwiZmllbGRSZWZlcmVuY2VzIiwiX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyIsInVuaXF1ZUtleXMiLCJjYXN0QXJyYXkiLCJrZXkiLCJpbmRleGVzIiwiZm9yRWFjaCIsImluZGV4IiwidW5pcXVlIiwicHVzaCIsIm1vZGVsTWV0YSIsImtleUZpZWxkIiwibWFwVmFsdWVzIiwiZiIsIm9taXQiLCJ0b0pTT04iLCJmZWF0dXJlcyIsImJhc2VDbGFzc2VzIiwiaXNFbXB0eSIsImFzc29jaWF0aW9ucyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaW50ZXJmYWNlcyIsImFzdEludGVyZmFjZXMiLCJfYnVpbGRJbnRlcmZhY2VzIiwiY29uY2F0IiwiaW1wb3J0TGluZXMiLCJmaWxlTmFtZSIsImZ1bmN0aW9uTmFtZSIsImFzdFRvQ29kZSIsImFzdFJlcXVpcmUiLCJlYWNoIiwiZW50cnkiLCJfZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZSIsImltcG9ydHMiLCJlbnRpdHlNZXRhIiwiY2xhc3NCb2R5IiwiYmxvY2siLCJmdW5jdG9ycyIsImFzdFZhbHVlIiwicmVkdWNlIiwicmVzdWx0IiwiZnVuY3RvciIsImlucHV0cyIsImlucHV0U2V0TmFtZSIsInZhbGlkYXRpb25TY2hlbWEiLCJkZXBlbmRlbmNpZXMiLCJTZXQiLCJhc3RQcm9ncmFtIiwiaW5wdXQiLCJzdGFydHNXaXRoIiwiYXNzb2MiLCJzdWJzdHIiLCJhc3NvY01ldGEiLCJFcnJvciIsInNwZWMiLCJkZXAiLCJhZGQiLCJsaXN0IiwiZWxlbWVudFNjaGVtYSIsImFzdENhbGwiLCJjYW1lbENhc2UiLCJwaWNrIiwiRGFvTW9kZWxlcl8iLCJBcnJheSIsImZyb20iLCJhc3RQdXNoSW5Cb2R5IiwiYXN0QXNzaWduIiwiYXN0VmFyUmVmIiwiYXN0QXJyb3dGdW5jdGlvbiIsImlucHV0U2NoZW1hRmlsZVBhdGgiLCJlbnRpdHlPdXRwdXRGaWxlUGF0aCIsInNvcnQiLCJ2IiwicmVhZE9ubHkiLCJmaWVsZFNjaGVtYSIsInZhbHVlcyIsIm9wdGlvbmFsIiwiY29tcGlsZUNvbnRleHQiLCJjcmVhdGVDb21waWxlQ29udGV4dCIsImdlbWxNb2R1bGUiLCJ2YXJpYWJsZXMiLCJzb3VyY2UiLCJmaW5hbGl6ZWQiLCJhbGxGaW5pc2hlZCIsImNyZWF0ZVRvcG9JZCIsInRvcG9JZCIsImNvbXBpbGVGaWVsZCIsImRlcGVuZHNPbiIsIndyaXRlT25jZSIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsInJlZmVyZW5jZSIsIndyaXRlUHJvdGVjdCIsImRlcHMiLCJ0b3BvU29ydCIsImZpbHRlciIsIm1hcE9mVG9rZW5Ub01ldGEiLCJoYXMiLCJtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsIiwibGFzdEZpZWxkc0dyb3VwIiwibWV0aG9kQm9keUNhY2hlIiwibGFzdEFzdFR5cGUiLCJfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUiLCJyZWZlcmVuY2VzIiwiYXN0Q2FjaGUiLCJyZXF1aXJlVGFyZ2V0RmllbGQiLCJjaGVja2VyIiwiX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayIsInNvdXJjZU1hcCIsImdldCIsImFzdEJsb2NrIiwiYXN0TWFwIiwidGFyZ2V0RmllbGROYW1lIiwibGVuZ3RoIiwiZmllbGRSZWZlcmVuY2UiLCJyZWYiLCJ3aGVuTnVsbCIsInVuZGVmaW5lZCIsIm5leHRUeXBlIiwiX3ZhbGlkYXRlQ2hlY2siLCJfY2hlY2tBbmRBc3NpZ24iLCJhc3RNZW1iZXJNZXRob2QiLCJfYXBwbHlNb2RpZmllcnNIZWFkZXIiLCJmdW5jdG9yVHlwZSIsImZpbGVQYXRoIiwiZXhpc3RzU3luYyIsInVwcGVyRmlyc3QiLCJhc3RGdW5jdGlvbiIsIm1vZGVsTWV0YUluaXQiLCJtZXRob2QiLCJpbmZvIiwiYXN0Qm9keSIsImFzdFZhckRlY2xhcmUiLCJwYXJhbU1ldGEiLCJhY2NlcHQiLCJfcHJvY2Vzc1BhcmFtcyIsInBhcmFtcyIsImltcGxlbWVudGF0aW9uIiwib3BlcmF0aW9uIiwiY29tcGlsZURiT3BlcmF0aW9uIiwibWFpblN0YXJ0SWQiLCJyZXR1cm4iLCJjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4iLCJuZWVkRGVjbGFyZSIsImtlYmFiQ2FzZSIsImFjY2VwdFBhcmFtcyIsInBhcmFtIiwiY29tcGlsZVBhcmFtIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBLFVBQVQ7QUFBcUJDLEVBQUFBLFVBQXJCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFtREwsT0FBTyxDQUFDLFVBQUQsQ0FBaEU7O0FBQ0EsTUFBTU0sSUFBSSxHQUFHTixPQUFPLENBQUMsZ0JBQUQsQ0FBcEI7O0FBRUEsTUFBTU8sU0FBUyxHQUFHUCxPQUFPLENBQUMsbUJBQUQsQ0FBekI7O0FBQ0EsTUFBTVEsTUFBTSxHQUFHUixPQUFPLENBQUMsZUFBRCxDQUF0Qjs7QUFDQSxNQUFNUyxTQUFTLEdBQUdULE9BQU8sQ0FBQyxxQkFBRCxDQUF6Qjs7QUFDQSxNQUFNVSxRQUFRLEdBQUdWLE9BQU8sQ0FBQyxnQkFBRCxDQUF4Qjs7QUFFQSxNQUFNVyxhQUFhLEdBQUcsQ0FDbEJGLFNB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aUcsU0FBRixDQUFZMEcsUUFBWixDQUFmLENBQVY7QUFDSCxPQTdDRDs7QUErQ0EvRyxNQUFBQSxHQUFHLENBQUNXLElBQUosQ0FDSWhHLE1BQU0sQ0FBQytNLGVBQVAsQ0FDSXZMLGlCQUFpQixDQUFDQyxJQUFELENBRHJCLEVBRUl3QyxNQUFNLENBQUNDLElBQVAsQ0FBWXlKLFNBQVosQ0FGSixFQUdJRixPQUhKLEVBSUksS0FKSixFQUtJLElBTEosRUFNSSxJQU5KLEVBT0k3TixVQUFVLENBQUNILENBQUMsQ0FBQzZPLFNBQUYsQ0FBWTdNLElBQVosQ0FBRCxFQUFvQixHQUFwQixFQUF5QixHQUF6QixDQVBkLENBREo7QUFXSCxLQWxHRDs7QUFvR0EsV0FBTzRELEdBQVA7QUFDSDs7QUFFRHdJLEVBQUFBLGNBQWMsQ0FBQ1UsWUFBRCxFQUFlbkUsY0FBZixFQUErQjtBQUN6QyxRQUFJdUQsU0FBUyxHQUFHLEVBQWhCO0FBRUFZLElBQUFBLFlBQVksQ0FBQzFJLE9BQWIsQ0FBcUIsQ0FBQzJJLEtBQUQsRUFBUXpNLENBQVIsS0FBYztBQUMvQjlCLE1BQUFBLFNBQVMsQ0FBQ3dPLFlBQVYsQ0FBdUIxTSxDQUF2QixFQUEwQnlNLEtBQTFCLEVBQWlDcEUsY0FBakM7QUFDQXVELE1BQUFBLFNBQVMsQ0FBQ2EsS0FBSyxDQUFDL00sSUFBUCxDQUFULEdBQXdCK00sS0FBeEI7QUFDQXBFLE1BQUFBLGNBQWMsQ0FBQ0csU0FBZixDQUF5QmlFLEtBQUssQ0FBQy9NLElBQS9CLElBQXVDO0FBQUUrSSxRQUFBQSxNQUFNLEVBQUU7QUFBVixPQUF2QztBQUNILEtBSkQ7QUFNQSxXQUFPbUQsU0FBUDtBQUNIOztBQWp5Qlk7O0FBb3lCakJlLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmpNLFVBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IHBhdGggPSByZXF1aXJlKFwicGF0aFwiKTtcbmNvbnN0IHsgXywgZnMsIHBhc2NhbENhc2UsIHJlcGxhY2VBbGwsIHB1dEludG9CdWNrZXQgfSA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcbmNvbnN0IHN3aWcgPSByZXF1aXJlKFwic3dpZy10ZW1wbGF0ZXNcIik7XG5cbmNvbnN0IEdlbWxUeXBlcyA9IHJlcXVpcmUoXCIuLi9sYW5nL0dlbWxUeXBlc1wiKTtcbmNvbnN0IEpzTGFuZyA9IHJlcXVpcmUoXCIuL3V0aWwvYXN0LmpzXCIpO1xuY29uc3QgR2VtbFRvQXN0ID0gcmVxdWlyZShcIi4vdXRpbC9nZW1sVG9Bc3QuanNcIik7XG5jb25zdCBTbmlwcGV0cyA9IHJlcXVpcmUoXCIuL2Rhby9zbmlwcGV0c1wiKTtcblxuY29uc3QgQ2hhaW5hYmxlVHlwZSA9IFtcbiAgICBHZW1sVG9Bc3QuQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBHZW1sVG9Bc3QuQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBHZW1sVG9Bc3QuQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCxcbl07XG5cbmNvbnN0IGdldEZpZWxkTmFtZSA9ICh0KSA9PiB0LnNwbGl0KFwiLlwiKS5wb3AoKTtcbmNvbnN0IGlzQ2hhaW5hYmxlID0gKGN1cnJlbnQsIG5leHQpID0+XG4gICAgQ2hhaW5hYmxlVHlwZS5pbmRleE9mKGN1cnJlbnQudHlwZSkgPiAtMSAmJiBjdXJyZW50LnRhcmdldCA9PT0gbmV4dC50YXJnZXQgJiYgbmV4dC50eXBlID09PSBjdXJyZW50LnR5cGU7XG5jb25zdCBjaGFpbkNhbGwgPSAobGFzdEJsb2NrLCBsYXN0VHlwZSwgY3VycmVudEJsb2NrLCBjdXJyZW50VHlwZSkgPT4ge1xuICAgIGlmIChsYXN0QmxvY2spIHtcbiAgICAgICAgaWYgKGxhc3RUeXBlID09PSBcIlZhbGlkYXRvckNhbGxcIikge1xuICAgICAgICAgICAgYXNzZXJ0OiBjdXJyZW50VHlwZSA9PT0gXCJWYWxpZGF0b3JDYWxsXCIsIFwiVW5leHBlY3RlZCBjdXJyZW50VHlwZVwiO1xuXG4gICAgICAgICAgICBjdXJyZW50QmxvY2sgPSBKc0xhbmcuYXN0QmluRXhwKGxhc3RCbG9jaywgXCImJlwiLCBjdXJyZW50QmxvY2spO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzZXJ0OiBjdXJyZW50VHlwZSA9PT0gXCJQcm9jZXNzb3JDYWxsXCIsIFwiVW5leHBlY3RlZCBjdXJyZW50VHlwZTogXCIgKyBjdXJyZW50VHlwZSArIFwiIGxhc3Q6IFwiICsgbGFzdFR5cGU7XG5cbiAgICAgICAgICAgIGN1cnJlbnRCbG9jay5hcmd1bWVudHNbMF0gPSBsYXN0QmxvY2s7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gY3VycmVudEJsb2NrO1xufTtcbmNvbnN0IGFzeW5jTWV0aG9kTmFtaW5nID0gKG5hbWUpID0+IG5hbWUgKyBcIl9cIjtcblxuY29uc3QgaW5kZW50TGluZXMgPSAobGluZXMsIGluZGVudGF0aW9uKSA9PlxuICAgIGxpbmVzXG4gICAgICAgIC5zcGxpdChcIlxcblwiKVxuICAgICAgICAubWFwKChsaW5lLCBpKSA9PiAoaSA9PT0gMCA/IGxpbmUgOiBfLnJlcGVhdChcIiBcIiwgaW5kZW50YXRpb24pICsgbGluZSkpXG4gICAgICAgIC5qb2luKFwiXFxuXCIpO1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfUkVUVVJOID0ge1xuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogKCkgPT4gW0pzTGFuZy5hc3RSZXR1cm4odHJ1ZSldLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogKGFyZ3MpID0+IFtKc0xhbmcuYXN0UmV0dXJuKEpzTGFuZy5hc3RJZChhcmdzWzBdKSldLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogKCkgPT4gW0pzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKFwidW5kZWZpbmVkXCIpKV0sXG59O1xuXG4vKipcbiAqIE9vbG9uZyBkYXRhYmFzZSBhY2Nlc3Mgb2JqZWN0IChEQU8pIG1vZGVsZXIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRGFvTW9kZWxlciB7XG4gICAgLyoqXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0dlbWxMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gR2VtbCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5tb2RlbFBhdGggLSBHZW5lcmF0ZWQgbW9kZWwgb3V0cHV0IHBhdGhcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5tYW5pZmVzdFBhdGggLSBFbnRpdGllcyBtYW5pZmVzdCBvdXRwdXQgcGF0aFxuICAgICAqIEBwYXJhbSB7Q29ubmVjdG9yfSBjb25uZWN0b3JcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBsaW5rZXIsIGNvbm5lY3Rvcikge1xuICAgICAgICB0aGlzLmxpbmtlciA9IGxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5tb2RlbFBhdGg7XG4gICAgICAgIHRoaXMubWFuaWZlc3RQYXRoID0gY29udGV4dC5tYW5pZmVzdFBhdGg7XG5cbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG4gICAgfVxuXG4gICAgbW9kZWxpbmdfKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsICdHZW5lcmF0aW5nIGVudGl0eSBtb2RlbHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIHRoaXMuX2dlbmVyYXRlU2NoZW1hTW9kZWwoc2NoZW1hKTtcbiAgICAgICAgdGhpcy5fZ2VuZXJhdGVFbnRpdHlNb2RlbChzY2hlbWEpO1xuICAgICAgICB0aGlzLl9nZW5lcmF0ZUVudGl0eUlucHV0U2NoZW1hKHNjaGVtYSk7XG4gICAgICAgIC8vdGhpcy5fZ2VuZXJhdGVFbnVtVHlwZXMoc2NoZW1hKTtcbiAgICAgICAgLy90aGlzLl9nZW5lcmF0ZVZpZXdNb2RlbCgpO1xuXG4gICAgICAgIGlmICh0aGlzLm1hbmlmZXN0UGF0aCkge1xuICAgICAgICAgICAgdGhpcy5fZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdChzY2hlbWEpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlU2NoZW1hTW9kZWwoc2NoZW1hKSB7XG4gICAgICAgIGxldCBjYXBpdGFsaXplZCA9IHBhc2NhbENhc2Uoc2NoZW1hLm5hbWUpO1xuXG4gICAgICAgIGxldCBsb2NhbHMgPSB7XG4gICAgICAgICAgICBkcml2ZXI6IHRoaXMuY29ubmVjdG9yLmRyaXZlcixcbiAgICAgICAgICAgIGNsYXNzTmFtZTogY2FwaXRhbGl6ZWQsXG4gICAgICAgICAgICBzY2hlbWFOYW1lOiBzY2hlbWEubmFtZSxcbiAgICAgICAgICAgIGVudGl0aWVzOiBKU09OLnN0cmluZ2lmeShPYmplY3Qua2V5cyhzY2hlbWEuZW50aXRpZXMpKSxcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgY2xhc3NUZW1wbGF0ZSA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiZGF0YWJhc2VcIiwgdGhpcy5jb25uZWN0b3IuZHJpdmVyLCBcIkRhdGFiYXNlLmpzLnN3aWdcIik7XG4gICAgICAgIGxldCBjbGFzc0NvZGUgPSBzd2lnLnJlbmRlckZpbGUoY2xhc3NUZW1wbGF0ZSwgbG9jYWxzKTtcblxuICAgICAgICBsZXQgbW9kZWxGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIGNhcGl0YWxpemVkICsgXCIuanNcIik7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgsIGNsYXNzQ29kZSk7XG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBcIkdlbmVyYXRlZCBkYXRhYmFzZSBtb2RlbDogXCIgKyBtb2RlbEZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVFbnVtVHlwZXMoc2NoZW1hKSB7XG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5SW5zdGFuY2VOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmllbGRzLCAoZmllbGQsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSBcImVudW1cIikge1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVFbnRpdHlNb2RlbChzY2hlbWEpIHtcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlJbnN0YW5jZU5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCBjYXBpdGFsaXplZCA9IHBhc2NhbENhc2UoZW50aXR5SW5zdGFuY2VOYW1lKTtcblxuICAgICAgICAgICAgLy9zaGFyZWQgaW5mb3JtYXRpb24gd2l0aCBtb2RlbCBDUlVEIGFuZCBjdXN0b21pemVkIGludGVyZmFjZXNcbiAgICAgICAgICAgIGxldCBzaGFyZWRDb250ZXh0ID0ge1xuICAgICAgICAgICAgICAgIG1hcE9mRnVuY3RvclRvRmlsZToge30sXG4gICAgICAgICAgICAgICAgbmV3RnVuY3RvckZpbGVzOiBbXSxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGxldCB7IGFzdDogYXN0Q2xhc3NNYWluLCBmaWVsZFJlZmVyZW5jZXMgfSA9IHRoaXMuX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyhlbnRpdHksIHNoYXJlZENvbnRleHQpO1xuICAgICAgICAgICAgYXN0Q2xhc3NNYWluID0gW2FzdENsYXNzTWFpbl07XG5cbiAgICAgICAgICAgIC8vcHJlcGFyZSBtZXRhIGRhdGFcbiAgICAgICAgICAgIGxldCB1bmlxdWVLZXlzID0gW18uY2FzdEFycmF5KGVudGl0eS5rZXkpXTtcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaCgoaW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdW5pcXVlS2V5cy5wdXNoKGluZGV4LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IG1vZGVsTWV0YSA9IHtcbiAgICAgICAgICAgICAgICBzY2hlbWFOYW1lOiBzY2hlbWEubmFtZSxcbiAgICAgICAgICAgICAgICBuYW1lOiBlbnRpdHlJbnN0YW5jZU5hbWUsXG4gICAgICAgICAgICAgICAga2V5RmllbGQ6IGVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgZmllbGRzOiBfLm1hcFZhbHVlcyhlbnRpdHkuZmllbGRzLCAoZikgPT4gXy5vbWl0KGYudG9KU09OKCksIFwibW9kaWZpZXJzXCIpKSxcbiAgICAgICAgICAgICAgICBmZWF0dXJlczogZW50aXR5LmZlYXR1cmVzIHx8IHt9LFxuICAgICAgICAgICAgICAgIHVuaXF1ZUtleXMsXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmJhc2VDbGFzc2VzKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmJhc2VDbGFzc2VzID0gZW50aXR5LmJhc2VDbGFzc2VzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5kZXhlcykpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuaW5kZXhlcyA9IGVudGl0eS5pbmRleGVzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuZmVhdHVyZXMpKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmZlYXR1cmVzID0gZW50aXR5LmZlYXR1cmVzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5hc3NvY2lhdGlvbnMgPSBlbnRpdHkuYXNzb2NpYXRpb25zO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShmaWVsZFJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmZpZWxkRGVwZW5kZW5jaWVzID0gZmllbGRSZWZlcmVuY2VzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL2J1aWxkIGN1c3RvbWl6ZWQgaW50ZXJmYWNlc1xuICAgICAgICAgICAgaWYgKGVudGl0eS5pbnRlcmZhY2VzKSB7XG4gICAgICAgICAgICAgICAgbGV0IGFzdEludGVyZmFjZXMgPSB0aGlzLl9idWlsZEludGVyZmFjZXMoZW50aXR5LCBtb2RlbE1ldGEsIHNoYXJlZENvbnRleHQpO1xuICAgICAgICAgICAgICAgIC8vY29uc29sZS5sb2coYXN0SW50ZXJmYWNlcyk7XG4gICAgICAgICAgICAgICAgLy9sZXQgYXN0Q2xhc3MgPSBhc3RDbGFzc01haW5bYXN0Q2xhc3NNYWluLmxlbmd0aCAtIDFdO1xuICAgICAgICAgICAgICAgIC8vSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0Q2xhc3MsIGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgICAgIGFzdENsYXNzTWFpbiA9IGFzdENsYXNzTWFpbi5jb25jYXQoYXN0SW50ZXJmYWNlcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBpbXBvcnRMaW5lcyA9IFtdO1xuXG4gICAgICAgICAgICAvL2dlbmVyYXRlIGZ1bmN0b3JzIGlmIGFueVxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc2hhcmVkQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oc2hhcmVkQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUsIChmaWxlTmFtZSwgZnVuY3Rpb25OYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGltcG9ydExpbmVzLnB1c2goSnNMYW5nLmFzdFRvQ29kZShKc0xhbmcuYXN0UmVxdWlyZShmdW5jdGlvbk5hbWUsIFwiLlwiICsgZmlsZU5hbWUpKSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzKSkge1xuICAgICAgICAgICAgICAgIF8uZWFjaChzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcywgKGVudHJ5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2dlbmVyYXRlRnVuY3Rpb25UZW1wbGF0ZUZpbGUoc2NoZW1hLCBlbnRyeSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICBsZXQgbWl4aW5zID0gW107XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLm1peGlucykpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWl4aW5zRGlyUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIHNjaGVtYS5uYW1lLCAnbWl4aW5zJyk7XG4gICAgICAgICAgICAgICAgZnMuZW5zdXJlRGlyU3luYyhtaXhpbnNEaXJQYXRoKTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLm1peGlucy5mb3JFYWNoKG0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBsZXQgbWl4aW5OYW1lID0gcGFzY2FsQ2FzZShtKTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbWl4aW5GaWxlUGF0aCA9IHBhdGguam9pbihtaXhpbnNEaXJQYXRoLCBtaXhpbk5hbWUgKyAnLmpzJyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZnMucGF0aEV4aXN0c1N5bmMobWl4aW5GaWxlUGF0aCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMobWl4aW5GaWxlUGF0aCwgYGNvbnN0IHtcbiAgICBFcnJvcnM6IHsgVmFsaWRhdGlvbkVycm9yLCBEYXRhYmFzZUVycm9yIH0sXG4gICAgUHJvY2Vzc29ycyxcbiAgICBWYWxpZGF0b3JzXG59ID0gcmVxdWlyZShcIkBnZW54L2RhdGFcIik7XG5jb25zdCB7IF8gfSA9IHJlcXVpcmUoXCJyay11dGlsc1wiKTtcblxubW9kdWxlLmV4cG9ydHMgPSAke2NhcGl0YWxpemVkfSA9PiBjbGFzcyBleHRlbmRzICR7Y2FwaXRhbGl6ZWR9IHtcbiAgICAvL3RvZG86IGFkZCBzdGFpYyBtZXRob2RzXG59O2ApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IG1peGluVmFyTmFtZSA9ICdtaXhpbicgKyBtaXhpbk5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGltcG9ydExpbmVzLnB1c2goSnNMYW5nLmFzdFRvQ29kZShKc0xhbmcuYXN0UmVxdWlyZShtaXhpblZhck5hbWUsICcuL21peGlucy8nICsgbWl4aW5OYW1lKSkpO1xuICAgICAgICAgICAgICAgICAgICBtaXhpbnMucHVzaChtaXhpblZhck5hbWUpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgIC8vYXNzZW1ibGUgdGhlIHNvdXJjZSBjb2RlIGZpbGVcbiAgICAgICAgICAgIC8vSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBhc3RDbGFzc01haW4pO1xuXG4gICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgZW50aXR5LmZpZWxkcy5tYXAoKHYsIGspID0+IEpzTGFuZy5hc3RBc3NpZ24oY2FwaXRhbGl6ZWQgKyAnLkZfJyArIF8uc25ha2VDYXNlKGspLnRvVXBwZXJDYXNlKCksIGspKSk7XG5cbiAgICAgICAgICAgIGxldCBsb2NhbHMgPSB7XG4gICAgICAgICAgICAgICAgaW1wb3J0czogaW1wb3J0TGluZXMuam9pbihcIlxcblwiKSxcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU6IGNhcGl0YWxpemVkLFxuICAgICAgICAgICAgICAgIGVudGl0eU1ldGE6IGluZGVudExpbmVzKEpTT04uc3RyaW5naWZ5KG1vZGVsTWV0YSwgbnVsbCwgNCksIDQpLFxuICAgICAgICAgICAgICAgIGNsYXNzQm9keTogaW5kZW50TGluZXMoYXN0Q2xhc3NNYWluLm1hcCgoYmxvY2spID0+IEpzTGFuZy5hc3RUb0NvZGUoYmxvY2spKS5qb2luKFwiXFxuXFxuXCIpLCA4KSxcbiAgICAgICAgICAgICAgICBmdW5jdG9yczogaW5kZW50TGluZXMoXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RUb0NvZGUoXG4gICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFsdWUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXy5yZWR1Y2UoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAocmVzdWx0LCBmdW5jdG9yKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXN1bHRbXCIkXCIgKyBmdW5jdG9yLmZ1bmN0aW9uTmFtZV0gPSBKc0xhbmcuYXN0SWQoZnVuY3Rvci5mdW5jdGlvbk5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge31cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgIDRcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIC8vbWl4aW5zXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgY2xhc3NUZW1wbGF0ZSA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiZGF0YWJhc2VcIiwgdGhpcy5jb25uZWN0b3IuZHJpdmVyLCBcIkVudGl0eU1vZGVsLmpzLnN3aWdcIik7XG4gICAgICAgICAgICBsZXQgY2xhc3NDb2RlID0gc3dpZy5yZW5kZXJGaWxlKGNsYXNzVGVtcGxhdGUsIGxvY2Fscyk7XG5cbiAgICAgICAgICAgIGxldCBtb2RlbEZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMub3V0cHV0UGF0aCwgc2NoZW1hLm5hbWUsIFwiYmFzZVwiLCBjYXBpdGFsaXplZCArIFwiLmpzXCIpO1xuICAgICAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCk7XG4gICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgsIGNsYXNzQ29kZSk7XG5cbiAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgXCJHZW5lcmF0ZWQgZW50aXR5IG1vZGVsOiBcIiArIG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVFbnRpdHlJbnB1dFNjaGVtYShzY2hlbWEpIHtcbiAgICAgICAgLy9nZW5lcmF0ZSB2YWxpZGF0b3IgY29uZmlnXG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5SW5zdGFuY2VOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2goZW50aXR5LmlucHV0cywgKGlucHV0cywgaW5wdXRTZXROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgdmFsaWRhdGlvblNjaGVtYSA9IHt9O1xuICAgICAgICAgICAgICAgIGNvbnN0IGRlcGVuZGVuY2llcyA9IG5ldyBTZXQoKTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3QgPSBKc0xhbmcuYXN0UHJvZ3JhbSgpO1xuXG4gICAgICAgICAgICAgICAgaW5wdXRzLmZvckVhY2goKGlucHV0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIC8vOmFkZHJlc3NcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlucHV0Lm5hbWUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jID0gaW5wdXQubmFtZS5zdWJzdHIoMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhc3NvY01ldGEgPSBlbnRpdHkuYXNzb2NpYXRpb25zW2Fzc29jXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFzc29jaWF0aW9uIFwiJHthc3NvY31cIiBub3QgZm91bmQgaW4gZW50aXR5IFske2VudGl0eUluc3RhbmNlTmFtZX1dLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlucHV0LnNwZWMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBJbnB1dCBcInNwZWNcIiBpcyByZXF1aXJlZCBmb3IgZW50aXR5IHJlZmVyZW5jZS4gSW5wdXQgc2V0OiAke2lucHV0U2V0TmFtZX0sIGxvY2FsOiAke2Fzc29jfSwgcmVmZXJlbmNlZEVudGl0eTogJHthc3NvY01ldGEuZW50aXR5fWBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkZXAgPSBgJHthc3NvY01ldGEuZW50aXR5fS0ke2lucHV0LnNwZWN9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlcGVuZGVuY2llcy5hZGQoZGVwKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtpbnB1dC5uYW1lXSA9IEpzTGFuZy5hc3RWYWx1ZSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiYXJyYXlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZWxlbWVudFNjaGVtYToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNjaGVtYTogSnNMYW5nLmFzdENhbGwoXy5jYW1lbENhc2UoZGVwKSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLl8ucGljayhpbnB1dCwgW1wib3B0aW9uYWxcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2lucHV0Lm5hbWVdID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzY2hlbWE6IEpzTGFuZy5hc3RDYWxsKF8uY2FtZWxDYXNlKGRlcCkpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5EYW9Nb2RlbGVyXy5waWNrKGlucHV0LCBbXCJvcHRpb25hbFwiXSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpZWxkID0gZW50aXR5LmZpZWxkc1tpbnB1dC5uYW1lXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmllbGQgXCIke2lucHV0Lm5hbWV9XCIgbm90IGZvdW5kIGluIGVudGl0eSBbJHtlbnRpdHlJbnN0YW5jZU5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtpbnB1dC5uYW1lXSA9IEpzTGFuZy5hc3RWYWx1ZSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uXy5waWNrKGZpZWxkcywgW1widHlwZVwiLCBcInZhbHVlc1wiXSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uXy5waWNrKGlucHV0LCBbXCJvcHRpb25hbFwiXSksXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgQXJyYXkuZnJvbShkZXBlbmRlbmNpZXMpLmZvckVhY2goKGRlcCkgPT5cbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZShfLmNhbWVsQ2FzZShkZXApLCBgLi8ke2RlcH1gKSlcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoXG4gICAgICAgICAgICAgICAgICAgIGFzdCxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoXCJtb2R1bGUuZXhwb3J0c1wiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RBcnJvd0Z1bmN0aW9uKFtdLCBKc0xhbmcuYXN0VmFsdWUodmFsaWRhdGlvblNjaGVtYSkpXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGlucHV0U2NoZW1hRmlsZVBhdGggPSBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMub3V0cHV0UGF0aCxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwiaW5wdXRzXCIsXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eUluc3RhbmNlTmFtZSArIFwiLVwiICsgaW5wdXRTZXROYW1lICsgXCIuanNcIlxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoaW5wdXRTY2hlbWFGaWxlUGF0aCk7XG4gICAgICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhpbnB1dFNjaGVtYUZpbGVQYXRoLCBKc0xhbmcuYXN0VG9Db2RlKGFzdCkpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBcIkdlbmVyYXRlZCBlbnRpdHkgbWFuaWZlc3Q6IFwiICsgZW50aXR5T3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUVudGl0eU1hbmlmZXN0KHNjaGVtYSkge1xuICAgICAgICBsZXQgZW50aXRpZXMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZW50aXRpZXMpXG4gICAgICAgICAgICAuc29ydCgpXG4gICAgICAgICAgICAucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbdl0gPSB7fTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAvKlxuICAgICAgICBsZXQgbWFuaWZlc3QgPSB7fTtcblxuICAgICAgICBfLmVhY2goc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8ucmVzdGZ1bCkge1xuICAgICAgICAgICAgICAgIF8uZWFjaChlbnRpdHkuaW5mby5yZXN0ZnVsLCAoeyB0eXBlLCBtZXRob2RzIH0sIHJlbGF0aXZlVXJpKSA9PiB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGFwaUluZm8gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kczoge30gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0eXBlID09PSAnZW50aXR5Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5lbnRpdHkgPSBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5kaXNwbGF5TmFtZSA9IGVudGl0eS5kaXNwbGF5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGVudGl0eS5jb21tZW50KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5kZXNjcmlwdGlvbiA9IGVudGl0eS5jb21tZW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgXy5lYWNoKG1ldGhvZHMsIChtZXRhLCBtZXRob2ROYW1lKSA9PiB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAobWV0aG9kTmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwaUluZm8ubWV0aG9kc1sncG9zdDonICsgcmVsYXRpdmVVcmldID0gbWV0YTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2ZpbmRPbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZmluZUFsbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICd1cGRhdGVPbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAndXBkYXRlTWFueSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdkZWxldGVPbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZGVsZXRlTWFueSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuICAgICAgICAvKlxuICAgICAgICBsZXQgb3V0cHV0RmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5tYW5pZmVzdFBhdGgsIHNjaGVtYS5uYW1lICsgJy5tYW5pZmVzdC5qc29uJyk7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhvdXRwdXRGaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkoZW50aXRpZXMsIG51bGwsIDQpKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIHNjaGVtYSBtYW5pZmVzdDogJyArIG91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgKi9cblxuICAgICAgICAvL2dlbmVyYXRlIHZhbGlkYXRvciBjb25maWdcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlJbnN0YW5jZU5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB2YWxpZGF0aW9uU2NoZW1hID0ge307XG5cbiAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5maWVsZHMsIChmaWVsZCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnJlYWRPbmx5KSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgZmllbGRTY2hlbWEgPSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IGZpZWxkLnR5cGUsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSBcImVudW1cIikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZFNjaGVtYS52YWx1ZXMgPSBmaWVsZC52YWx1ZXM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkU2NoZW1hLm9wdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2ZpZWxkTmFtZV0gPSBmaWVsZFNjaGVtYTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgZW50aXR5T3V0cHV0RmlsZVBhdGggPSBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICAgICAgdGhpcy5tYW5pZmVzdFBhdGgsXG4gICAgICAgICAgICAgICAgc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICAgICAgXCJ2YWxpZGF0aW9uXCIsXG4gICAgICAgICAgICAgICAgZW50aXR5SW5zdGFuY2VOYW1lICsgXCIubWFuaWZlc3QuanNvblwiXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZW50aXR5T3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhlbnRpdHlPdXRwdXRGaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkodmFsaWRhdGlvblNjaGVtYSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGVudGl0eSBtYW5pZmVzdDogXCIgKyBlbnRpdHlPdXRwdXRGaWxlUGF0aCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2dlbmVyYXRlVmlld01vZGVsKHNjaGVtYSwgZGJTZXJ2aWNlKSB7ICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLnZpZXdzLCAodmlld0luZm8sIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci5pbmZvKCdCdWlsZGluZyB2aWV3OiAnICsgdmlld05hbWUpO1xuXG4gICAgICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBfLnVwcGVyRmlyc3Qodmlld05hbWUpO1xuXG4gICAgICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oKTtcblxuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZSgnTW93YScsICdtb3dhJykpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0VmFyRGVjbGFyZSgnVXRpbCcsIEpzTGFuZy5hc3RWYXJSZWYoJ01vd2EuVXRpbCcpLCB0cnVlKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RWYXJEZWNsYXJlKCdfJywgSnNMYW5nLmFzdFZhclJlZignVXRpbC5fJyksIHRydWUpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFJlcXVpcmUoJ1ZpZXcnLCAnbW93YS9saWIvb29sb25nL3J1bnRpbWUvdmlldycpKTtcblxuICAgICAgICAgICAgbGV0IGNvbXBpbGVDb250ZXh0ID0gT29sVG9Bc3QuY3JlYXRlQ29tcGlsZUNvbnRleHQodmlld05hbWUsIGRiU2VydmljZS5zZXJ2aWNlSWQsIHRoaXMubGlua2VyKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQubW9kZWxWYXJzLmFkZCh2aWV3SW5mby5lbnRpdHkpO1xuXG4gICAgICAgICAgICBsZXQgcGFyYW1NZXRhO1xuXG4gICAgICAgICAgICBpZiAodmlld0luZm8ucGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgcGFyYW1NZXRhID0gdGhpcy5fcHJvY2Vzc1BhcmFtcyh2aWV3SW5mby5wYXJhbXMsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHZpZXdNZXRhID0ge1xuICAgICAgICAgICAgICAgIGlzTGlzdDogdmlld0luZm8uaXNMaXN0LFxuICAgICAgICAgICAgICAgIHBhcmFtczogcGFyYW1NZXRhXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgdmlld0JvZHlUb3BvSWQgPSBPb2xUb0FzdC5jcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckdmlldycpO1xuICAgICAgICAgICAgT29sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdmlld0JvZHlUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgdmlld01vZGVsZXIgPSByZXF1aXJlKHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuL2Rhby92aWV3JywgZGJTZXJ2aWNlLmRiVHlwZSArICcuanMnKSk7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdmlld0JvZHlUb3BvSWRdID0gdmlld01vZGVsZXIoZGJTZXJ2aWNlLCB2aWV3TmFtZSwgdmlld0luZm8pO1xuICAgICAgICAgICAgT29sVG9Bc3QuYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB2aWV3Qm9keVRvcG9JZCwge1xuICAgICAgICAgICAgICAgIHR5cGU6IE9vbFRvQXN0LkFTVF9CTEtfVklFV19PUEVSQVRJT05cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgcmV0dXJuVG9wb0lkID0gT29sVG9Bc3QuY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgICAgICAgICAgT29sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB2aWV3Qm9keVRvcG9JZCwgcmV0dXJuVG9wb0lkKTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmNvbXBpbGVSZXR1cm4ocmV0dXJuVG9wb0lkLCB7XG4gICAgICAgICAgICAgICAgXCJvb2xUeXBlXCI6IFwiT2JqZWN0UmVmZXJlbmNlXCIsXG4gICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwidmlld0RhdGFcIlxuICAgICAgICAgICAgfSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKGRlcCA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBuZWNlc3Nhcnkgc291cmNlIGNvZGU6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgbGV0IGFzdERvTG9hZE1haW4gPSBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoJyRtZXRhJywgSnNMYW5nLmFzdFZhclJlZigndGhpcy5tZXRhJyksIHRydWUsIGZhbHNlLCAnUmV0cmlldmluZyB0aGUgbWV0YSBkYXRhJylcbiAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgIF8uZWFjaChkZXBzLCBkZXAgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBhc3RNZXRhID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcblxuICAgICAgICAgICAgICAgIGxldCBhc3RCbG9jayA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdO1xuICAgICAgICAgICAgICAgIGFzc2VydDogYXN0QmxvY2ssICdFbXB0eSBhc3QgYmxvY2snO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzdE1ldGEudHlwZSA9PT0gJ01vZGlmaWVyQ2FsbCcpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkTmFtZSA9IGdldEZpZWxkTmFtZShhc3RNZXRhLnRhcmdldCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IEpzTGFuZy5hc3RBc3NpZ24oSnNMYW5nLmFzdFZhclJlZihhc3RNZXRhLnRhcmdldCksIGFzdEJsb2NrLCBgTW9kaWZ5aW5nICR7ZmllbGROYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICBhc3REb0xvYWRNYWluLnB1c2goYXN0Q2FjaGUpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXN0RG9Mb2FkTWFpbiA9IGFzdERvTG9hZE1haW4uY29uY2F0KF8uY2FzdEFycmF5KGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdKSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSkge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSwgKGZpbGVOYW1lLCBmdW5jdGlvbk5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZShmdW5jdGlvbk5hbWUsICcuJyArIGZpbGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goY29tcGlsZUNvbnRleHQubmV3RnVuY3RvckZpbGVzLCBlbnRyeSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2dlbmVyYXRlRnVuY3Rpb25UZW1wbGF0ZUZpbGUoZGJTZXJ2aWNlLCBlbnRyeSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdENsYXNzRGVjbGFyZShjYXBpdGFsaXplZCwgJ1ZpZXcnLCBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdE1lbWJlck1ldGhvZCgnX2RvTG9hZCcsIE9iamVjdC5rZXlzKHBhcmFtTWV0YSksXG4gICAgICAgICAgICAgICAgICAgIGFzdERvTG9hZE1haW4sXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLCB0cnVlLCBmYWxzZSwgJ1BvcHVsYXRlIHZpZXcgZGF0YSdcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICBdLCBgJHtjYXBpdGFsaXplZH0gdmlld2ApKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbihjYXBpdGFsaXplZCArICcubWV0YScsIEpzTGFuZy5hc3RWYWx1ZSh2aWV3TWV0YSkpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbignbW9kdWxlLmV4cG9ydHMnLCBKc0xhbmcuYXN0VmFyUmVmKGNhcGl0YWxpemVkKSkpO1xuXG4gICAgICAgICAgICBsZXQgbW9kZWxGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIGRiU2VydmljZS5kYlR5cGUsIGRiU2VydmljZS5uYW1lLCAndmlld3MnLCB2aWV3TmFtZSArICcuanMnKTtcbiAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoICsgJy5qc29uJywgSlNPTi5zdHJpbmdpZnkoYXN0LCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIERhb01vZGVsZXIuX2V4cG9ydFNvdXJjZUNvZGUoYXN0LCBtb2RlbEZpbGVQYXRoKTtcblxuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCB2aWV3IG1vZGVsOiAnICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgKi9cblxuICAgIF9wcm9jZXNzRmllbGRNb2RpZmllcnMoZW50aXR5LCBzaGFyZWRDb250ZXh0KSB7XG4gICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IEdlbWxUb0FzdC5jcmVhdGVDb21waWxlQ29udGV4dChlbnRpdHkuZ2VtbE1vZHVsZS5uYW1lLCB0aGlzLmxpbmtlciwgc2hhcmVkQ29udGV4dCk7XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tcInJhd1wiXSA9IHsgc291cmNlOiBcImNvbnRleHRcIiwgZmluYWxpemVkOiB0cnVlIH07XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tcImkxOG5cIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIsIGZpbmFsaXplZDogdHJ1ZSB9O1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXCJjb25uZWN0b3JcIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIsIGZpbmFsaXplZDogdHJ1ZSB9O1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXCJsYXRlc3RcIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIgfTtcblxuICAgICAgICBjb25zdCBhbGxGaW5pc2hlZCA9IEdlbWxUb0FzdC5jcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIFwiZG9uZS5cIik7XG5cbiAgICAgICAgLy9tYXAgb2YgZmllbGQgbmFtZSB0byBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGZpZWxkUmVmZXJlbmNlcyA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKGVudGl0eS5maWVsZHMsIChmaWVsZCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkID0gR2VtbFRvQXN0LmNvbXBpbGVGaWVsZChmaWVsZE5hbWUsIGZpZWxkLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBHZW1sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIGFsbEZpbmlzaGVkKTtcblxuICAgICAgICAgICAgaWYgKGZpZWxkLndyaXRlT25jZSB8fCBmaWVsZC5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGZpZWxkUmVmZXJlbmNlcywgZmllbGROYW1lLCB7IHJlZmVyZW5jZTogZmllbGROYW1lLCB3cml0ZVByb3RlY3Q6IHRydWUgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBkZXBzID0gY29tcGlsZUNvbnRleHQudG9wb1NvcnQuc29ydCgpO1xuICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICBkZXBzID0gZGVwcy5maWx0ZXIoKGRlcCkgPT4gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5oYXMoZGVwKSk7XG4gICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIG5lY2Vzc2FyeSBzb3VyY2UgY29kZTpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgIGxldCBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gW10sXG4gICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAsXG4gICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUgPSBbXSxcbiAgICAgICAgICAgIGxhc3RCbG9jayxcbiAgICAgICAgICAgIGxhc3RBc3RUeXBlOyAvLywgaGFzVmFsaWRhdG9yID0gZmFsc2U7XG5cbiAgICAgICAgY29uc3QgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlID0gZnVuY3Rpb24gKGZpZWxkTmFtZSwgcmVmZXJlbmNlcywgYXN0Q2FjaGUsIHJlcXVpcmVUYXJnZXRGaWVsZCkge1xuICAgICAgICAgICAgbGV0IGZpZWxkcyA9IFtmaWVsZE5hbWVdLmNvbmNhdChyZWZlcmVuY2VzKTtcbiAgICAgICAgICAgIGxldCBjaGVja2VyID0gZmllbGRzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgICAgICBpZiAobGFzdEZpZWxkc0dyb3VwICYmIGxhc3RGaWVsZHNHcm91cC5jaGVja2VyICE9PSBjaGVja2VyKSB7XG4gICAgICAgICAgICAgICAgbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCA9IG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwuY29uY2F0KFxuICAgICAgICAgICAgICAgICAgICBTbmlwcGV0cy5fZmllbGRSZXF1aXJlbWVudENoZWNrKFxuICAgICAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLmZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5yZWZlcmVuY2VzLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlLFxuICAgICAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlcXVpcmVUYXJnZXRGaWVsZFxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUgPSBbXTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlID0gbWV0aG9kQm9keUNhY2hlLmNvbmNhdChhc3RDYWNoZSk7XG4gICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAgPSB7XG4gICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgIHJlZmVyZW5jZXMsXG4gICAgICAgICAgICAgICAgcmVxdWlyZVRhcmdldEZpZWxkLFxuICAgICAgICAgICAgICAgIGNoZWNrZXIsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIoY29tcGlsZUNvbnRleHQuYXN0TWFwWydtb2JpbGV+aXNNb2JpbGVQaG9uZTphcmdbMV18PnN0cmluZ0Rhc2hlcml6ZSddLCB7IGRlcHRoOiA4IH0pO1xuXG4gICAgICAgIF8uZWFjaChkZXBzLCAoZGVwLCBpKSA9PiB7XG4gICAgICAgICAgICAvL2dldCBtZXRhZGF0YSBvZiBzb3VyY2UgY29kZSBibG9ja1xuICAgICAgICAgICAgbGV0IHNvdXJjZU1hcCA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KGRlcCk7XG5cbiAgICAgICAgICAgIC8vZ2V0IHNvdXJjZSBjb2RlIGJsb2NrXG4gICAgICAgICAgICBsZXQgYXN0QmxvY2sgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXTtcblxuICAgICAgICAgICAgbGV0IHRhcmdldEZpZWxkTmFtZSA9IGdldEZpZWxkTmFtZShzb3VyY2VNYXAudGFyZ2V0KTtcblxuICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC5yZWZlcmVuY2VzICYmIHNvdXJjZU1hcC5yZWZlcmVuY2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRSZWZlcmVuY2UgPSBmaWVsZFJlZmVyZW5jZXNbdGFyZ2V0RmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICBpZiAoIWZpZWxkUmVmZXJlbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkUmVmZXJlbmNlc1t0YXJnZXRGaWVsZE5hbWVdID0gZmllbGRSZWZlcmVuY2UgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIHNvdXJjZU1hcC5yZWZlcmVuY2VzLmZvckVhY2goKHJlZikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRSZWZlcmVuY2UucHVzaCh7IHJlZmVyZW5jZTogcmVmLCB3aGVuTnVsbDogdHJ1ZSB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc291cmNlTWFwLnJlZmVyZW5jZXMuZm9yRWFjaCgocmVmKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRSZWZlcmVuY2UuaW5kZXhPZihyZWYpID09PSAtMSkgZmllbGRSZWZlcmVuY2UucHVzaChyZWYpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChsYXN0QmxvY2spIHtcbiAgICAgICAgICAgICAgICBhc3RCbG9jayA9IGNoYWluQ2FsbChsYXN0QmxvY2ssIGxhc3RBc3RUeXBlLCBhc3RCbG9jaywgc291cmNlTWFwLnR5cGUpO1xuICAgICAgICAgICAgICAgIGxhc3RCbG9jayA9IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGkgPCBkZXBzLmxlbmd0aCAtIDEpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmV4dFR5cGUgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldChkZXBzW2kgKyAxXSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNDaGFpbmFibGUoc291cmNlTWFwLCBuZXh0VHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgbGFzdEJsb2NrID0gYXN0QmxvY2s7XG4gICAgICAgICAgICAgICAgICAgIGxhc3RBc3RUeXBlID0gc291cmNlTWFwLnR5cGU7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfVkFMSURBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAvL2hhc1ZhbGlkYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhY2hlID0gU25pcHBldHMuX3ZhbGlkYXRlQ2hlY2sodGFyZ2V0RmllbGROYW1lLCBhc3RCbG9jayk7XG5cbiAgICAgICAgICAgICAgICBfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUodGFyZ2V0RmllbGROYW1lLCBzb3VyY2VNYXAucmVmZXJlbmNlcywgYXN0Q2FjaGUsIHRydWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBKc0xhbmcuYXN0QXNzaWduKFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLFxuICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgYFByb2Nlc3NpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgc291cmNlTWFwLnJlZmVyZW5jZXMsIGFzdENhY2hlLCB0cnVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhY2hlID0gU25pcHBldHMuX2NoZWNrQW5kQXNzaWduKFxuICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0LCB0cnVlKSxcbiAgICAgICAgICAgICAgICAgICAgYEFjdGl2YXRpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgc291cmNlTWFwLnJlZmVyZW5jZXMsIGFzdENhY2hlLCBmYWxzZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRvIGJlIGltcGxlbWVudGVkLlwiKTtcbiAgICAgICAgICAgICAgICAvL2FzdEJsb2NrID0gXy5jYXN0QXJyYXkoYXN0QmxvY2spO1xuICAgICAgICAgICAgICAgIC8vX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgW10sIGFzdEJsb2NrKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLyogQ2hhbmdlZCB0byB0aHJvdyBlcnJvciBpbnN0ZWFkIG9mIHJldHVybmluZyBhIGVycm9yIG9iamVjdFxuICAgICAgICBpZiAoaGFzVmFsaWRhdG9yKSB7XG4gICAgICAgICAgICBsZXQgZGVjbGFyZSA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhbGlkU3RhdGVOYW1lLCBmYWxzZSk7XG4gICAgICAgICAgICBtZXRob2RCb2R5Q3JlYXRlLnVuc2hpZnQoZGVjbGFyZSk7XG4gICAgICAgICAgICBtZXRob2RCb2R5VXBkYXRlLnVuc2hpZnQoZGVjbGFyZSk7XG4gICAgICAgIH1cbiAgICAgICAgKi9cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShtZXRob2RCb2R5Q2FjaGUpKSB7XG4gICAgICAgICAgICBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbC5jb25jYXQoXG4gICAgICAgICAgICAgICAgU25pcHBldHMuX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayhcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLmZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlZmVyZW5jZXMsXG4gICAgICAgICAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSxcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlcXVpcmVUYXJnZXRGaWVsZFxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvKlxuICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oZmFsc2UpO1xuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RDbGFzc0RlY2xhcmUoJ0FiYycsICdNb2RlbCcsIFtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoYXN5bmNNZXRob2ROYW1pbmcoJ3ByZXBhcmVFbnRpdHlEYXRhXycpLCBbICdjb250ZXh0JyBdLFxuICAgICAgICAgICAgU25pcHBldHMuX2RvVmFsaWRhdGVBbmRGaWxsSGVhZGVyLmNvbmNhdChtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsKS5jb25jYXQoWyBKc0xhbmcuYXN0UmV0dXJuKEpzTGFuZy5hc3RJZCgnY29udGV4dCcpKSBdKSxcbiAgICAgICAgICAgIGZhbHNlLCB0cnVlLCB0cnVlXG4gICAgICAgICldLCAnY29tbWVudCcpKTtcbiAgICAgICAgKi9cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYXN0OiBKc0xhbmcuYXN0TWVtYmVyTWV0aG9kKFxuICAgICAgICAgICAgICAgIGFzeW5jTWV0aG9kTmFtaW5nKFwiYXBwbHlNb2RpZmllcnNcIiksXG4gICAgICAgICAgICAgICAgW1wiY29udGV4dFwiLCBcImlzVXBkYXRpbmdcIl0sXG4gICAgICAgICAgICAgICAgU25pcHBldHMuX2FwcGx5TW9kaWZpZXJzSGVhZGVyXG4gICAgICAgICAgICAgICAgICAgIC5jb25jYXQobWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbClcbiAgICAgICAgICAgICAgICAgICAgLmNvbmNhdChbSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoXCJjb250ZXh0XCIpKV0pLFxuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICBcIkFwcGx5aW5nIHByZWRlZmluZWQgbW9kaWZpZXJzIHRvIGVudGl0eSBmaWVsZHMuXCJcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBmaWVsZFJlZmVyZW5jZXMsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRnVuY3Rpb25UZW1wbGF0ZUZpbGUoc2NoZW1hLCB7IGZ1bmN0aW9uTmFtZSwgZnVuY3RvclR5cGUsIGZpbGVOYW1lLCBhcmdzIH0pIHtcbiAgICAgICAgbGV0IGZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMub3V0cHV0UGF0aCwgc2NoZW1hLm5hbWUsIGZpbGVOYW1lKTtcblxuICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhmaWxlUGF0aCkpIHtcbiAgICAgICAgICAgIC8vdG9kbzogYW5hbHlzZSBjb2RlLCBjb21wYXJlIGFyZ3VtZW50c1xuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBgJHtfLnVwcGVyRmlyc3QoZnVuY3RvclR5cGUpfSBcIiR7ZmlsZU5hbWV9XCIgZXhpc3RzLiBGaWxlIGdlbmVyYXRpbmcgc2tpcHBlZC5gKTtcblxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFzdCA9IEpzTGFuZy5hc3RQcm9ncmFtKCk7XG5cbiAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcmdzLCBPT0xfTU9ESUZJRVJfUkVUVVJOW2Z1bmN0b3JUeXBlXShhcmdzKSkpO1xuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RBc3NpZ24oXCJtb2R1bGUuZXhwb3J0c1wiLCBKc0xhbmcuYXN0VmFyUmVmKGZ1bmN0aW9uTmFtZSkpKTtcblxuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIEpzTGFuZy5hc3RUb0NvZGUoYXN0KSk7XG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgYEdlbmVyYXRlZCAke2Z1bmN0b3JUeXBlfSBmaWxlOiAke2ZpbGVQYXRofWApO1xuICAgIH1cblxuICAgIF9idWlsZEludGVyZmFjZXMoZW50aXR5LCBtb2RlbE1ldGFJbml0LCBzaGFyZWRDb250ZXh0KSB7XG4gICAgICAgIGxldCBhc3QgPSBbXTtcblxuICAgICAgICBfLmZvck93bihlbnRpdHkuaW50ZXJmYWNlcywgKG1ldGhvZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5saW5rZXIuaW5mbyhcIkJ1aWxkaW5nIGludGVyZmFjZTogXCIgKyBuYW1lKTtcblxuICAgICAgICAgICAgbGV0IGFzdEJvZHkgPSBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoXG4gICAgICAgICAgICAgICAgICAgIFwiJG1ldGFcIixcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihcInRoaXMubWV0YS5pbnRlcmZhY2VzLlwiICsgbmFtZSksXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBcIlJldHJpZXZpbmcgdGhlIG1ldGEgZGF0YVwiXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IEdlbWxUb0FzdC5jcmVhdGVDb21waWxlQ29udGV4dChlbnRpdHkuZ2VtbE1vZHVsZS5uYW1lLCB0aGlzLmxpbmtlciwgc2hhcmVkQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCBwYXJhbU1ldGE7XG5cbiAgICAgICAgICAgIGlmIChtZXRob2QuYWNjZXB0KSB7XG4gICAgICAgICAgICAgICAgcGFyYW1NZXRhID0gdGhpcy5fcHJvY2Vzc1BhcmFtcyhtZXRob2QuYWNjZXB0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbWV0YWRhdGFcbiAgICAgICAgICAgIG1vZGVsTWV0YUluaXRbXCJpbnRlcmZhY2VzXCJdIHx8IChtb2RlbE1ldGFJbml0W1wiaW50ZXJmYWNlc1wiXSA9IHt9KTtcbiAgICAgICAgICAgIG1vZGVsTWV0YUluaXRbXCJpbnRlcmZhY2VzXCJdW25hbWVdID0geyBwYXJhbXM6IE9iamVjdC52YWx1ZXMocGFyYW1NZXRhKSB9O1xuXG4gICAgICAgICAgICBfLmVhY2gobWV0aG9kLmltcGxlbWVudGF0aW9uLCAob3BlcmF0aW9uLCBpbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgIC8vbGV0IGxhc3RUb3BvSWQgPVxuICAgICAgICAgICAgICAgIEdlbWxUb0FzdC5jb21waWxlRGJPcGVyYXRpb24oaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAobWV0aG9kLnJldHVybikge1xuICAgICAgICAgICAgICAgIEdlbWxUb0FzdC5jb21waWxlRXhjZXB0aW9uYWxSZXR1cm4obWV0aG9kLnJldHVybiwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIGRlcGVuZGVuY2llczpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBkZXBzID0gZGVwcy5maWx0ZXIoKGRlcCkgPT4gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5oYXMoZGVwKSk7XG4gICAgICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBuZWNlc3Nhcnkgc291cmNlIGNvZGU6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgXy5lYWNoKGRlcHMsIChkZXApID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgc291cmNlTWFwID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0QmxvY2sgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXTtcblxuICAgICAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQ29kZSBwb2ludCBcIicgKyBkZXAgKyAnXCI6XFxuJyArIEpTT04uc3RyaW5naWZ5KHNvdXJjZU1hcCwgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRhcmdldEZpZWxkTmFtZSA9IHNvdXJjZU1hcC50YXJnZXQ7IC8vZ2V0RmllbGROYW1lKHNvdXJjZU1hcC50YXJnZXQpO1xuXG4gICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19WQUxJREFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IFNuaXBwZXRzLl92YWxpZGF0ZUNoZWNrKHRhcmdldEZpZWxkTmFtZSwgYXN0QmxvY2spO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX1BST0NFU1NPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzb3VyY2VNYXAubmVlZERlY2xhcmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdFZhckRlY2xhcmUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC5uZWVkRGVjbGFyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0QXNzaWduKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYEFjdGl2YXRpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3RCb2R5ID0gYXN0Qm9keS5jb25jYXQoXy5jYXN0QXJyYXkoYXN0QmxvY2spKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhc3QucHVzaChcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0TWVtYmVyTWV0aG9kKFxuICAgICAgICAgICAgICAgICAgICBhc3luY01ldGhvZE5hbWluZyhuYW1lKSxcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXMocGFyYW1NZXRhKSxcbiAgICAgICAgICAgICAgICAgICAgYXN0Qm9keSxcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlcGxhY2VBbGwoXy5rZWJhYkNhc2UobmFtZSksIFwiLVwiLCBcIiBcIilcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXN0O1xuICAgIH1cblxuICAgIF9wcm9jZXNzUGFyYW1zKGFjY2VwdFBhcmFtcywgY29tcGlsZUNvbnRleHQpIHtcbiAgICAgICAgbGV0IHBhcmFtTWV0YSA9IHt9O1xuXG4gICAgICAgIGFjY2VwdFBhcmFtcy5mb3JFYWNoKChwYXJhbSwgaSkgPT4ge1xuICAgICAgICAgICAgR2VtbFRvQXN0LmNvbXBpbGVQYXJhbShpLCBwYXJhbSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgcGFyYW1NZXRhW3BhcmFtLm5hbWVdID0gcGFyYW07XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcGFyYW0ubmFtZV0gPSB7IHNvdXJjZTogXCJhcmd1bWVudFwiIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwYXJhbU1ldGE7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IERhb01vZGVsZXI7XG4iXX0=