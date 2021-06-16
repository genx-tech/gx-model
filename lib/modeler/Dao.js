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
              throw new Error(`Input "spec" is required for entity reference. Input set: ${inputSetName}, entity: ${entityInstanceName}, local: ${assoc}, referencedEntity: ${assocMeta.entity}`);
            }

            const dep = `${assocMeta.entity}-${input.spec}`;
            dependencies.add(dep);

            if (assocMeta.list) {
              validationSchema[input.name] = JsLang.astValue({
                type: "array",
                elementSchema: {
                  type: "object",
                  schema: JsLang.astCall(_.camelCase(dep), [])
                },
                ..._.pick(input, ["optional"])
              });
            } else {
              validationSchema[input.name] = JsLang.astValue({
                type: "object",
                schema: JsLang.astCall(_.camelCase(dep), []),
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
        const exportBody = Array.from(dependencies).map(dep => JsLang.astRequire(_.camelCase(dep), `./${dep}`));
        JsLang.astPushInBody(ast, JsLang.astAssign(JsLang.astVarRef("module.exports"), JsLang.astAnonymousFunction([], exportBody.concat(JsLang.astReturn(validationSchema)))));
        let inputSchemaFilePath = path.resolve(this.outputPath, schema.name, "inputs", entityInstanceName + "-" + inputSetName + ".js");
        fs.ensureFileSync(inputSchemaFilePath);
        fs.writeFileSync(inputSchemaFilePath, JsLang.astToCode(ast));
        this.linker.log("info", "Generated entity input schema: " + inputSchemaFilePath);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9tb2RlbGVyL0Rhby5qcyJdLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsIl8iLCJmcyIsInBhc2NhbENhc2UiLCJyZXBsYWNlQWxsIiwicHV0SW50b0J1Y2tldCIsInN3aWciLCJHZW1sVHlwZXMiLCJKc0xhbmciLCJHZW1sVG9Bc3QiLCJTbmlwcGV0cyIsIkNoYWluYWJsZVR5cGUiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCIsIkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwiLCJnZXRGaWVsZE5hbWUiLCJ0Iiwic3BsaXQiLCJwb3AiLCJpc0NoYWluYWJsZSIsImN1cnJlbnQiLCJuZXh0IiwiaW5kZXhPZiIsInR5cGUiLCJ0YXJnZXQiLCJjaGFpbkNhbGwiLCJsYXN0QmxvY2siLCJsYXN0VHlwZSIsImN1cnJlbnRCbG9jayIsImN1cnJlbnRUeXBlIiwiYXN0QmluRXhwIiwiYXJndW1lbnRzIiwiYXN5bmNNZXRob2ROYW1pbmciLCJuYW1lIiwiaW5kZW50TGluZXMiLCJsaW5lcyIsImluZGVudGF0aW9uIiwibWFwIiwibGluZSIsImkiLCJyZXBlYXQiLCJqb2luIiwiT09MX01PRElGSUVSX1JFVFVSTiIsIk1vZGlmaWVyIiwiVkFMSURBVE9SIiwiYXN0UmV0dXJuIiwiUFJPQ0VTU09SIiwiYXJncyIsImFzdElkIiwiQUNUSVZBVE9SIiwiRGFvTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImxpbmtlciIsImNvbm5lY3RvciIsIm91dHB1dFBhdGgiLCJtb2RlbFBhdGgiLCJtYW5pZmVzdFBhdGgiLCJtb2RlbGluZ18iLCJzY2hlbWEiLCJsb2ciLCJfZ2VuZXJhdGVTY2hlbWFNb2RlbCIsIl9nZW5lcmF0ZUVudGl0eU1vZGVsIiwiX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEiLCJfZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdCIsImNhcGl0YWxpemVkIiwibG9jYWxzIiwiZHJpdmVyIiwiY2xhc3NOYW1lIiwic2NoZW1hTmFtZSIsImVudGl0aWVzIiwiSlNPTiIsInN0cmluZ2lmeSIsIk9iamVjdCIsImtleXMiLCJjbGFzc1RlbXBsYXRlIiwicmVzb2x2ZSIsIl9fZGlybmFtZSIsImNsYXNzQ29kZSIsInJlbmRlckZpbGUiLCJtb2RlbEZpbGVQYXRoIiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiX2dlbmVyYXRlRW51bVR5cGVzIiwiZm9yT3duIiwiZW50aXR5IiwiZW50aXR5SW5zdGFuY2VOYW1lIiwiZmllbGRzIiwiZmllbGQiLCJmaWVsZE5hbWUiLCJzaGFyZWRDb250ZXh0IiwibWFwT2ZGdW5jdG9yVG9GaWxlIiwibmV3RnVuY3RvckZpbGVzIiwiYXN0IiwiYXN0Q2xhc3NNYWluIiwiZmllbGRSZWZlcmVuY2VzIiwiX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyIsInVuaXF1ZUtleXMiLCJjYXN0QXJyYXkiLCJrZXkiLCJpbmRleGVzIiwiZm9yRWFjaCIsImluZGV4IiwidW5pcXVlIiwicHVzaCIsIm1vZGVsTWV0YSIsImtleUZpZWxkIiwibWFwVmFsdWVzIiwiZiIsIm9taXQiLCJ0b0pTT04iLCJmZWF0dXJlcyIsImJhc2VDbGFzc2VzIiwiaXNFbXB0eSIsImFzc29jaWF0aW9ucyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaW50ZXJmYWNlcyIsImFzdEludGVyZmFjZXMiLCJfYnVpbGRJbnRlcmZhY2VzIiwiY29uY2F0IiwiaW1wb3J0TGluZXMiLCJmaWxlTmFtZSIsImZ1bmN0aW9uTmFtZSIsImFzdFRvQ29kZSIsImFzdFJlcXVpcmUiLCJlYWNoIiwiZW50cnkiLCJfZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZSIsImltcG9ydHMiLCJlbnRpdHlNZXRhIiwiY2xhc3NCb2R5IiwiYmxvY2siLCJmdW5jdG9ycyIsImFzdFZhbHVlIiwicmVkdWNlIiwicmVzdWx0IiwiZnVuY3RvciIsImlucHV0cyIsImlucHV0U2V0TmFtZSIsInZhbGlkYXRpb25TY2hlbWEiLCJkZXBlbmRlbmNpZXMiLCJTZXQiLCJhc3RQcm9ncmFtIiwiaW5wdXQiLCJzdGFydHNXaXRoIiwiYXNzb2MiLCJzdWJzdHIiLCJhc3NvY01ldGEiLCJFcnJvciIsInNwZWMiLCJkZXAiLCJhZGQiLCJsaXN0IiwiZWxlbWVudFNjaGVtYSIsImFzdENhbGwiLCJjYW1lbENhc2UiLCJwaWNrIiwiZXhwb3J0Qm9keSIsIkFycmF5IiwiZnJvbSIsImFzdFB1c2hJbkJvZHkiLCJhc3RBc3NpZ24iLCJhc3RWYXJSZWYiLCJhc3RBbm9ueW1vdXNGdW5jdGlvbiIsImlucHV0U2NoZW1hRmlsZVBhdGgiLCJzb3J0IiwidiIsInJlYWRPbmx5IiwiZmllbGRTY2hlbWEiLCJ2YWx1ZXMiLCJvcHRpb25hbCIsImVudGl0eU91dHB1dEZpbGVQYXRoIiwiY29tcGlsZUNvbnRleHQiLCJjcmVhdGVDb21waWxlQ29udGV4dCIsImdlbWxNb2R1bGUiLCJ2YXJpYWJsZXMiLCJzb3VyY2UiLCJmaW5hbGl6ZWQiLCJhbGxGaW5pc2hlZCIsImNyZWF0ZVRvcG9JZCIsInRvcG9JZCIsImNvbXBpbGVGaWVsZCIsImRlcGVuZHNPbiIsIndyaXRlT25jZSIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsInJlZmVyZW5jZSIsIndyaXRlUHJvdGVjdCIsImRlcHMiLCJ0b3BvU29ydCIsImZpbHRlciIsIm1hcE9mVG9rZW5Ub01ldGEiLCJoYXMiLCJtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsIiwibGFzdEZpZWxkc0dyb3VwIiwibWV0aG9kQm9keUNhY2hlIiwibGFzdEFzdFR5cGUiLCJfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUiLCJyZWZlcmVuY2VzIiwiYXN0Q2FjaGUiLCJyZXF1aXJlVGFyZ2V0RmllbGQiLCJjaGVja2VyIiwiX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayIsInNvdXJjZU1hcCIsImdldCIsImFzdEJsb2NrIiwiYXN0TWFwIiwidGFyZ2V0RmllbGROYW1lIiwibGVuZ3RoIiwiZmllbGRSZWZlcmVuY2UiLCJyZWYiLCJ3aGVuTnVsbCIsInVuZGVmaW5lZCIsIm5leHRUeXBlIiwiX3ZhbGlkYXRlQ2hlY2siLCJfY2hlY2tBbmRBc3NpZ24iLCJhc3RNZW1iZXJNZXRob2QiLCJfYXBwbHlNb2RpZmllcnNIZWFkZXIiLCJmdW5jdG9yVHlwZSIsImZpbGVQYXRoIiwiZXhpc3RzU3luYyIsInVwcGVyRmlyc3QiLCJhc3RGdW5jdGlvbiIsIm1vZGVsTWV0YUluaXQiLCJtZXRob2QiLCJpbmZvIiwiYXN0Qm9keSIsImFzdFZhckRlY2xhcmUiLCJwYXJhbU1ldGEiLCJhY2NlcHQiLCJfcHJvY2Vzc1BhcmFtcyIsInBhcmFtcyIsImltcGxlbWVudGF0aW9uIiwib3BlcmF0aW9uIiwiY29tcGlsZURiT3BlcmF0aW9uIiwibWFpblN0YXJ0SWQiLCJyZXR1cm4iLCJjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4iLCJuZWVkRGVjbGFyZSIsImtlYmFiQ2FzZSIsImFjY2VwdFBhcmFtcyIsInBhcmFtIiwiY29tcGlsZVBhcmFtIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBLFVBQVQ7QUFBcUJDLEVBQUFBLFVBQXJCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFtREwsT0FBTyxDQUFDLFVBQUQsQ0FBaEU7O0FBQ0EsTUFBTU0sSUFBSSxHQUFHTixPQUFPLENBQUMsZ0JBQUQsQ0FBcEI7O0FBRUEsTUFBTU8sU0FBUyxHQUFHUCxPQUFPLENBQUMsbUJBQUQsQ0FBekI7O0FBQ0EsTUFBTVEsTUFBTSxHQUFHUixPQUFPLENBQUMsZUFBRCxDQUF0Qjs7QUFDQSxNQUFNUyxTQUFTLEdBQUdULE9BQU8sQ0FBQyxxQkFBRCxDQUF6Qjs7QUFDQSxNQUFNVSxRQUFRLEdBQUdWLE9BQU8sQ0FBQyxnQkFBRCxDQUF4Qjs7QUFFQSxNQUFNVyxhQUFhLEdBQUcsQ0FDbEJGLFNBQVMsQ0FBQ0csc0JBRFEsRUFFbEJILFNBQVMsQ0FBQ0ksc0JBRlEsRUFHbEJKLFNBQVMsQ0FBQ0ssc0JBSFEsQ0FBdEI7O0FBTUEsTUFBTUMsWUFBWSxHQUFJQyxDQUFELElBQU9BLENBQUMsQ0FBQ0MsS0FBRixDQUFRLEdBQVIsRUFBYUMsR0FBYixFQUE1Qjs7QUFDQSxNQUFNQyxXQUFXLEdBQUcsQ0FBQ0MsT0FBRCxFQUFVQyxJQUFWLEtBQ2hCVixhQUFhLENBQUNXLE9BQWQsQ0FBc0JGLE9BQU8sQ0FBQ0csSUFBOUIsSUFBc0MsQ0FBQyxDQUF2QyxJQUE0Q0gsT0FBTyxDQUFDSSxNQUFSLEtBQW1CSCxJQUFJLENBQUNHLE1BQXBFLElBQThFSCxJQUFJLENBQUNFLElBQUwsS0FBY0gsT0FBTyxDQUFDRyxJQUR4Rzs7QUFFQSxNQUFNRSxTQUFTLEdBQUcsQ0FBQ0MsU0FBRCxFQUFZQyxRQUFaLEVBQXNCQyxZQUF0QixFQUFvQ0MsV0FBcEMsS0FBb0Q7QUFDbEUsTUFBSUgsU0FBSixFQUFlO0FBQ1gsUUFBSUMsUUFBUSxLQUFLLGVBQWpCLEVBQWtDO0FBRzlCQyxNQUFBQSxZQUFZLEdBQUdwQixNQUFNLENBQUNzQixTQUFQLENBQWlCSixTQUFqQixFQUE0QixJQUE1QixFQUFrQ0UsWUFBbEMsQ0FBZjtBQUNILEtBSkQsTUFJTztBQUdIQSxNQUFBQSxZQUFZLENBQUNHLFNBQWIsQ0FBdUIsQ0FBdkIsSUFBNEJMLFNBQTVCO0FBQ0g7QUFDSjs7QUFFRCxTQUFPRSxZQUFQO0FBQ0gsQ0FkRDs7QUFlQSxNQUFNSSxpQkFBaUIsR0FBSUMsSUFBRCxJQUFVQSxJQUFJLEdBQUcsR0FBM0M7O0FBRUEsTUFBTUMsV0FBVyxHQUFHLENBQUNDLEtBQUQsRUFBUUMsV0FBUixLQUNoQkQsS0FBSyxDQUNBbEIsS0FETCxDQUNXLElBRFgsRUFFS29CLEdBRkwsQ0FFUyxDQUFDQyxJQUFELEVBQU9DLENBQVAsS0FBY0EsQ0FBQyxLQUFLLENBQU4sR0FBVUQsSUFBVixHQUFpQnJDLENBQUMsQ0FBQ3VDLE1BQUYsQ0FBUyxHQUFULEVBQWNKLFdBQWQsSUFBNkJFLElBRnJFLEVBR0tHLElBSEwsQ0FHVSxJQUhWLENBREo7O0FBTUEsTUFBTUMsbUJBQW1CLEdBQUc7QUFDeEIsR0FBQ25DLFNBQVMsQ0FBQ29DLFFBQVYsQ0FBbUJDLFNBQXBCLEdBQWdDLE1BQU0sQ0FBQ3BDLE1BQU0sQ0FBQ3FDLFNBQVAsQ0FBaUIsSUFBakIsQ0FBRCxDQURkO0FBRXhCLEdBQUN0QyxTQUFTLENBQUNvQyxRQUFWLENBQW1CRyxTQUFwQixHQUFpQ0MsSUFBRCxJQUFVLENBQUN2QyxNQUFNLENBQUNxQyxTQUFQLENBQWlCckMsTUFBTSxDQUFDd0MsS0FBUCxDQUFhRCxJQUFJLENBQUMsQ0FBRCxDQUFqQixDQUFqQixDQUFELENBRmxCO0FBR3hCLEdBQUN4QyxTQUFTLENBQUNvQyxRQUFWLENBQW1CTSxTQUFwQixHQUFnQyxNQUFNLENBQUN6QyxNQUFNLENBQUNxQyxTQUFQLENBQWlCckMsTUFBTSxDQUFDd0MsS0FBUCxDQUFhLFdBQWIsQ0FBakIsQ0FBRDtBQUhkLENBQTVCOztBQVVBLE1BQU1FLFVBQU4sQ0FBaUI7QUFRYkMsRUFBQUEsV0FBVyxDQUFDQyxPQUFELEVBQVVDLE1BQVYsRUFBa0JDLFNBQWxCLEVBQTZCO0FBQ3BDLFNBQUtELE1BQUwsR0FBY0EsTUFBZDtBQUNBLFNBQUtFLFVBQUwsR0FBa0JILE9BQU8sQ0FBQ0ksU0FBMUI7QUFDQSxTQUFLQyxZQUFMLEdBQW9CTCxPQUFPLENBQUNLLFlBQTVCO0FBRUEsU0FBS0gsU0FBTCxHQUFpQkEsU0FBakI7QUFDSDs7QUFFREksRUFBQUEsU0FBUyxDQUFDQyxNQUFELEVBQVM7QUFDZCxTQUFLTixNQUFMLENBQVlPLEdBQVosQ0FBZ0IsTUFBaEIsRUFBd0IsMENBQTBDRCxNQUFNLENBQUMxQixJQUFqRCxHQUF3RCxNQUFoRjs7QUFFQSxTQUFLNEIsb0JBQUwsQ0FBMEJGLE1BQTFCOztBQUNBLFNBQUtHLG9CQUFMLENBQTBCSCxNQUExQjs7QUFDQSxTQUFLSSwwQkFBTCxDQUFnQ0osTUFBaEM7O0FBSUEsUUFBSSxLQUFLRixZQUFULEVBQXVCO0FBQ25CLFdBQUtPLHVCQUFMLENBQTZCTCxNQUE3QjtBQUNIO0FBQ0o7O0FBRURFLEVBQUFBLG9CQUFvQixDQUFDRixNQUFELEVBQVM7QUFDekIsUUFBSU0sV0FBVyxHQUFHOUQsVUFBVSxDQUFDd0QsTUFBTSxDQUFDMUIsSUFBUixDQUE1QjtBQUVBLFFBQUlpQyxNQUFNLEdBQUc7QUFDVEMsTUFBQUEsTUFBTSxFQUFFLEtBQUtiLFNBQUwsQ0FBZWEsTUFEZDtBQUVUQyxNQUFBQSxTQUFTLEVBQUVILFdBRkY7QUFHVEksTUFBQUEsVUFBVSxFQUFFVixNQUFNLENBQUMxQixJQUhWO0FBSVRxQyxNQUFBQSxRQUFRLEVBQUVDLElBQUksQ0FBQ0MsU0FBTCxDQUFlQyxNQUFNLENBQUNDLElBQVAsQ0FBWWYsTUFBTSxDQUFDVyxRQUFuQixDQUFmO0FBSkQsS0FBYjtBQU9BLFFBQUlLLGFBQWEsR0FBRzVFLElBQUksQ0FBQzZFLE9BQUwsQ0FBYUMsU0FBYixFQUF3QixVQUF4QixFQUFvQyxLQUFLdkIsU0FBTCxDQUFlYSxNQUFuRCxFQUEyRCxrQkFBM0QsQ0FBcEI7QUFDQSxRQUFJVyxTQUFTLEdBQUd4RSxJQUFJLENBQUN5RSxVQUFMLENBQWdCSixhQUFoQixFQUErQlQsTUFBL0IsQ0FBaEI7QUFFQSxRQUFJYyxhQUFhLEdBQUdqRixJQUFJLENBQUM2RSxPQUFMLENBQWEsS0FBS3JCLFVBQWxCLEVBQThCVSxXQUFXLEdBQUcsS0FBNUMsQ0FBcEI7QUFDQS9ELElBQUFBLEVBQUUsQ0FBQytFLGNBQUgsQ0FBa0JELGFBQWxCO0FBQ0E5RSxJQUFBQSxFQUFFLENBQUNnRixhQUFILENBQWlCRixhQUFqQixFQUFnQ0YsU0FBaEM7QUFFQSxTQUFLekIsTUFBTCxDQUFZTyxHQUFaLENBQWdCLE1BQWhCLEVBQXdCLCtCQUErQm9CLGFBQXZEO0FBQ0g7O0FBRURHLEVBQUFBLGtCQUFrQixDQUFDeEIsTUFBRCxFQUFTO0FBQ3ZCMUQsSUFBQUEsQ0FBQyxDQUFDbUYsTUFBRixDQUFTekIsTUFBTSxDQUFDVyxRQUFoQixFQUEwQixDQUFDZSxNQUFELEVBQVNDLGtCQUFULEtBQWdDO0FBQ3REckYsTUFBQUEsQ0FBQyxDQUFDbUYsTUFBRixDQUFTQyxNQUFNLENBQUNFLE1BQWhCLEVBQXdCLENBQUNDLEtBQUQsRUFBUUMsU0FBUixLQUFzQjtBQUMxQyxZQUFJRCxLQUFLLENBQUNqRSxJQUFOLEtBQWUsTUFBbkIsRUFBMkIsQ0FDMUI7QUFDSixPQUhEO0FBSUgsS0FMRDtBQU1IOztBQUVEdUMsRUFBQUEsb0JBQW9CLENBQUNILE1BQUQsRUFBUztBQUN6QjFELElBQUFBLENBQUMsQ0FBQ21GLE1BQUYsQ0FBU3pCLE1BQU0sQ0FBQ1csUUFBaEIsRUFBMEIsQ0FBQ2UsTUFBRCxFQUFTQyxrQkFBVCxLQUFnQztBQUN0RCxVQUFJckIsV0FBVyxHQUFHOUQsVUFBVSxDQUFDbUYsa0JBQUQsQ0FBNUI7QUFHQSxVQUFJSSxhQUFhLEdBQUc7QUFDaEJDLFFBQUFBLGtCQUFrQixFQUFFLEVBREo7QUFFaEJDLFFBQUFBLGVBQWUsRUFBRTtBQUZELE9BQXBCOztBQUtBLFVBQUk7QUFBRUMsUUFBQUEsR0FBRyxFQUFFQyxZQUFQO0FBQXFCQyxRQUFBQTtBQUFyQixVQUF5QyxLQUFLQyxzQkFBTCxDQUE0QlgsTUFBNUIsRUFBb0NLLGFBQXBDLENBQTdDOztBQUNBSSxNQUFBQSxZQUFZLEdBQUcsQ0FBQ0EsWUFBRCxDQUFmO0FBR0EsVUFBSUcsVUFBVSxHQUFHLENBQUNoRyxDQUFDLENBQUNpRyxTQUFGLENBQVliLE1BQU0sQ0FBQ2MsR0FBbkIsQ0FBRCxDQUFqQjs7QUFFQSxVQUFJZCxNQUFNLENBQUNlLE9BQVgsRUFBb0I7QUFDaEJmLFFBQUFBLE1BQU0sQ0FBQ2UsT0FBUCxDQUFlQyxPQUFmLENBQXdCQyxLQUFELElBQVc7QUFDOUIsY0FBSUEsS0FBSyxDQUFDQyxNQUFWLEVBQWtCO0FBQ2ROLFlBQUFBLFVBQVUsQ0FBQ08sSUFBWCxDQUFnQkYsS0FBSyxDQUFDZixNQUF0QjtBQUNIO0FBQ0osU0FKRDtBQUtIOztBQUVELFVBQUlrQixTQUFTLEdBQUc7QUFDWnBDLFFBQUFBLFVBQVUsRUFBRVYsTUFBTSxDQUFDMUIsSUFEUDtBQUVaQSxRQUFBQSxJQUFJLEVBQUVxRCxrQkFGTTtBQUdab0IsUUFBQUEsUUFBUSxFQUFFckIsTUFBTSxDQUFDYyxHQUhMO0FBSVpaLFFBQUFBLE1BQU0sRUFBRXRGLENBQUMsQ0FBQzBHLFNBQUYsQ0FBWXRCLE1BQU0sQ0FBQ0UsTUFBbkIsRUFBNEJxQixDQUFELElBQU8zRyxDQUFDLENBQUM0RyxJQUFGLENBQU9ELENBQUMsQ0FBQ0UsTUFBRixFQUFQLEVBQW1CLFdBQW5CLENBQWxDLENBSkk7QUFLWkMsUUFBQUEsUUFBUSxFQUFFMUIsTUFBTSxDQUFDMEIsUUFBUCxJQUFtQixFQUxqQjtBQU1aZCxRQUFBQTtBQU5ZLE9BQWhCOztBQVNBLFVBQUlaLE1BQU0sQ0FBQzJCLFdBQVgsRUFBd0I7QUFDcEJQLFFBQUFBLFNBQVMsQ0FBQ08sV0FBVixHQUF3QjNCLE1BQU0sQ0FBQzJCLFdBQS9CO0FBQ0g7O0FBRUQsVUFBSSxDQUFDL0csQ0FBQyxDQUFDZ0gsT0FBRixDQUFVNUIsTUFBTSxDQUFDZSxPQUFqQixDQUFMLEVBQWdDO0FBQzVCSyxRQUFBQSxTQUFTLENBQUNMLE9BQVYsR0FBb0JmLE1BQU0sQ0FBQ2UsT0FBM0I7QUFDSDs7QUFFRCxVQUFJLENBQUNuRyxDQUFDLENBQUNnSCxPQUFGLENBQVU1QixNQUFNLENBQUMwQixRQUFqQixDQUFMLEVBQWlDO0FBQzdCTixRQUFBQSxTQUFTLENBQUNNLFFBQVYsR0FBcUIxQixNQUFNLENBQUMwQixRQUE1QjtBQUNIOztBQUVELFVBQUksQ0FBQzlHLENBQUMsQ0FBQ2dILE9BQUYsQ0FBVTVCLE1BQU0sQ0FBQzZCLFlBQWpCLENBQUwsRUFBcUM7QUFDakNULFFBQUFBLFNBQVMsQ0FBQ1MsWUFBVixHQUF5QjdCLE1BQU0sQ0FBQzZCLFlBQWhDO0FBQ0g7O0FBRUQsVUFBSSxDQUFDakgsQ0FBQyxDQUFDZ0gsT0FBRixDQUFVbEIsZUFBVixDQUFMLEVBQWlDO0FBQzdCVSxRQUFBQSxTQUFTLENBQUNVLGlCQUFWLEdBQThCcEIsZUFBOUI7QUFDSDs7QUFHRCxVQUFJVixNQUFNLENBQUMrQixVQUFYLEVBQXVCO0FBQ25CLFlBQUlDLGFBQWEsR0FBRyxLQUFLQyxnQkFBTCxDQUFzQmpDLE1BQXRCLEVBQThCb0IsU0FBOUIsRUFBeUNmLGFBQXpDLENBQXBCOztBQUlBSSxRQUFBQSxZQUFZLEdBQUdBLFlBQVksQ0FBQ3lCLE1BQWIsQ0FBb0JGLGFBQXBCLENBQWY7QUFDSDs7QUFFRCxVQUFJRyxXQUFXLEdBQUcsRUFBbEI7O0FBR0EsVUFBSSxDQUFDdkgsQ0FBQyxDQUFDZ0gsT0FBRixDQUFVdkIsYUFBYSxDQUFDQyxrQkFBeEIsQ0FBTCxFQUFrRDtBQUM5QzFGLFFBQUFBLENBQUMsQ0FBQ21GLE1BQUYsQ0FBU00sYUFBYSxDQUFDQyxrQkFBdkIsRUFBMkMsQ0FBQzhCLFFBQUQsRUFBV0MsWUFBWCxLQUE0QjtBQUNuRUYsVUFBQUEsV0FBVyxDQUFDaEIsSUFBWixDQUFpQmhHLE1BQU0sQ0FBQ21ILFNBQVAsQ0FBaUJuSCxNQUFNLENBQUNvSCxVQUFQLENBQWtCRixZQUFsQixFQUFnQyxNQUFNRCxRQUF0QyxDQUFqQixDQUFqQjtBQUNILFNBRkQ7QUFHSDs7QUFFRCxVQUFJLENBQUN4SCxDQUFDLENBQUNnSCxPQUFGLENBQVV2QixhQUFhLENBQUNFLGVBQXhCLENBQUwsRUFBK0M7QUFDM0MzRixRQUFBQSxDQUFDLENBQUM0SCxJQUFGLENBQU9uQyxhQUFhLENBQUNFLGVBQXJCLEVBQXVDa0MsS0FBRCxJQUFXO0FBQzdDLGVBQUtDLDZCQUFMLENBQW1DcEUsTUFBbkMsRUFBMkNtRSxLQUEzQztBQUNILFNBRkQ7QUFHSDs7QUFxQ0QsVUFBSTVELE1BQU0sR0FBRztBQUNUOEQsUUFBQUEsT0FBTyxFQUFFUixXQUFXLENBQUMvRSxJQUFaLENBQWlCLElBQWpCLENBREE7QUFFVDJCLFFBQUFBLFNBQVMsRUFBRUgsV0FGRjtBQUdUZ0UsUUFBQUEsVUFBVSxFQUFFL0YsV0FBVyxDQUFDcUMsSUFBSSxDQUFDQyxTQUFMLENBQWVpQyxTQUFmLEVBQTBCLElBQTFCLEVBQWdDLENBQWhDLENBQUQsRUFBcUMsQ0FBckMsQ0FIZDtBQUlUeUIsUUFBQUEsU0FBUyxFQUFFaEcsV0FBVyxDQUFDNEQsWUFBWSxDQUFDekQsR0FBYixDQUFrQjhGLEtBQUQsSUFBVzNILE1BQU0sQ0FBQ21ILFNBQVAsQ0FBaUJRLEtBQWpCLENBQTVCLEVBQXFEMUYsSUFBckQsQ0FBMEQsTUFBMUQsQ0FBRCxFQUFvRSxDQUFwRSxDQUpiO0FBS1QyRixRQUFBQSxRQUFRLEVBQUVsRyxXQUFXLENBQ2pCMUIsTUFBTSxDQUFDbUgsU0FBUCxDQUNJbkgsTUFBTSxDQUFDNkgsUUFBUCxDQUNJcEksQ0FBQyxDQUFDcUksTUFBRixDQUNJNUMsYUFBYSxDQUFDRSxlQURsQixFQUVJLENBQUMyQyxNQUFELEVBQVNDLE9BQVQsS0FBcUI7QUFDakJELFVBQUFBLE1BQU0sQ0FBQyxNQUFNQyxPQUFPLENBQUNkLFlBQWYsQ0FBTixHQUFxQ2xILE1BQU0sQ0FBQ3dDLEtBQVAsQ0FBYXdGLE9BQU8sQ0FBQ2QsWUFBckIsQ0FBckM7QUFDQSxpQkFBT2EsTUFBUDtBQUNILFNBTEwsRUFNSSxFQU5KLENBREosQ0FESixDQURpQixFQWFqQixDQWJpQjtBQUxaLE9BQWI7QUF1QkEsVUFBSTVELGFBQWEsR0FBRzVFLElBQUksQ0FBQzZFLE9BQUwsQ0FBYUMsU0FBYixFQUF3QixVQUF4QixFQUFvQyxLQUFLdkIsU0FBTCxDQUFlYSxNQUFuRCxFQUEyRCxxQkFBM0QsQ0FBcEI7QUFDQSxVQUFJVyxTQUFTLEdBQUd4RSxJQUFJLENBQUN5RSxVQUFMLENBQWdCSixhQUFoQixFQUErQlQsTUFBL0IsQ0FBaEI7QUFFQSxVQUFJYyxhQUFhLEdBQUdqRixJQUFJLENBQUM2RSxPQUFMLENBQWEsS0FBS3JCLFVBQWxCLEVBQThCSSxNQUFNLENBQUMxQixJQUFyQyxFQUEyQyxNQUEzQyxFQUFtRGdDLFdBQVcsR0FBRyxLQUFqRSxDQUFwQjtBQUNBL0QsTUFBQUEsRUFBRSxDQUFDK0UsY0FBSCxDQUFrQkQsYUFBbEI7QUFDQTlFLE1BQUFBLEVBQUUsQ0FBQ2dGLGFBQUgsQ0FBaUJGLGFBQWpCLEVBQWdDRixTQUFoQztBQUVBLFdBQUt6QixNQUFMLENBQVlPLEdBQVosQ0FBZ0IsTUFBaEIsRUFBd0IsNkJBQTZCb0IsYUFBckQ7QUFDSCxLQTlJRDtBQStJSDs7QUFFRGpCLEVBQUFBLDBCQUEwQixDQUFDSixNQUFELEVBQVM7QUFFL0IxRCxJQUFBQSxDQUFDLENBQUNtRixNQUFGLENBQVN6QixNQUFNLENBQUNXLFFBQWhCLEVBQTBCLENBQUNlLE1BQUQsRUFBU0Msa0JBQVQsS0FBZ0M7QUFDdERyRixNQUFBQSxDQUFDLENBQUM0SCxJQUFGLENBQU94QyxNQUFNLENBQUNvRCxNQUFkLEVBQXNCLENBQUNBLE1BQUQsRUFBU0MsWUFBVCxLQUEwQjtBQUM1QyxjQUFNQyxnQkFBZ0IsR0FBRyxFQUF6QjtBQUNBLGNBQU1DLFlBQVksR0FBRyxJQUFJQyxHQUFKLEVBQXJCO0FBQ0EsY0FBTWhELEdBQUcsR0FBR3JGLE1BQU0sQ0FBQ3NJLFVBQVAsRUFBWjtBQUVBTCxRQUFBQSxNQUFNLENBQUNwQyxPQUFQLENBQWdCMEMsS0FBRCxJQUFXO0FBRXRCLGNBQUlBLEtBQUssQ0FBQzlHLElBQU4sQ0FBVytHLFVBQVgsQ0FBc0IsR0FBdEIsQ0FBSixFQUFnQztBQUM1QixrQkFBTUMsS0FBSyxHQUFHRixLQUFLLENBQUM5RyxJQUFOLENBQVdpSCxNQUFYLENBQWtCLENBQWxCLENBQWQ7QUFDQSxrQkFBTUMsU0FBUyxHQUFHOUQsTUFBTSxDQUFDNkIsWUFBUCxDQUFvQitCLEtBQXBCLENBQWxCOztBQUVBLGdCQUFJLENBQUNFLFNBQUwsRUFBZ0I7QUFDWixvQkFBTSxJQUFJQyxLQUFKLENBQVcsZ0JBQWVILEtBQU0sMEJBQXlCM0Qsa0JBQW1CLElBQTVFLENBQU47QUFDSDs7QUFFRCxnQkFBSSxDQUFDeUQsS0FBSyxDQUFDTSxJQUFYLEVBQWlCO0FBQ2Isb0JBQU0sSUFBSUQsS0FBSixDQUNELDZEQUE0RFYsWUFBYSxhQUFZcEQsa0JBQW1CLFlBQVcyRCxLQUFNLHVCQUFzQkUsU0FBUyxDQUFDOUQsTUFBTyxFQUQvSixDQUFOO0FBR0g7O0FBRUQsa0JBQU1pRSxHQUFHLEdBQUksR0FBRUgsU0FBUyxDQUFDOUQsTUFBTyxJQUFHMEQsS0FBSyxDQUFDTSxJQUFLLEVBQTlDO0FBQ0FULFlBQUFBLFlBQVksQ0FBQ1csR0FBYixDQUFpQkQsR0FBakI7O0FBRUEsZ0JBQUlILFNBQVMsQ0FBQ0ssSUFBZCxFQUFvQjtBQUNoQmIsY0FBQUEsZ0JBQWdCLENBQUNJLEtBQUssQ0FBQzlHLElBQVAsQ0FBaEIsR0FBK0J6QixNQUFNLENBQUM2SCxRQUFQLENBQWdCO0FBQzNDOUcsZ0JBQUFBLElBQUksRUFBRSxPQURxQztBQUUzQ2tJLGdCQUFBQSxhQUFhLEVBQUU7QUFDWGxJLGtCQUFBQSxJQUFJLEVBQUUsUUFESztBQUVYb0Msa0JBQUFBLE1BQU0sRUFBRW5ELE1BQU0sQ0FBQ2tKLE9BQVAsQ0FBZXpKLENBQUMsQ0FBQzBKLFNBQUYsQ0FBWUwsR0FBWixDQUFmLEVBQWlDLEVBQWpDO0FBRkcsaUJBRjRCO0FBTTNDLG1CQUFHckosQ0FBQyxDQUFDMkosSUFBRixDQUFPYixLQUFQLEVBQWMsQ0FBQyxVQUFELENBQWQ7QUFOd0MsZUFBaEIsQ0FBL0I7QUFRSCxhQVRELE1BU087QUFDSEosY0FBQUEsZ0JBQWdCLENBQUNJLEtBQUssQ0FBQzlHLElBQVAsQ0FBaEIsR0FBK0J6QixNQUFNLENBQUM2SCxRQUFQLENBQWdCO0FBQzNDOUcsZ0JBQUFBLElBQUksRUFBRSxRQURxQztBQUUzQ29DLGdCQUFBQSxNQUFNLEVBQUVuRCxNQUFNLENBQUNrSixPQUFQLENBQWV6SixDQUFDLENBQUMwSixTQUFGLENBQVlMLEdBQVosQ0FBZixFQUFpQyxFQUFqQyxDQUZtQztBQUczQyxtQkFBR3JKLENBQUMsQ0FBQzJKLElBQUYsQ0FBT2IsS0FBUCxFQUFjLENBQUMsVUFBRCxDQUFkO0FBSHdDLGVBQWhCLENBQS9CO0FBS0g7QUFDSixXQWpDRCxNQWlDTztBQUNILGtCQUFNdkQsS0FBSyxHQUFHSCxNQUFNLENBQUNFLE1BQVAsQ0FBY3dELEtBQUssQ0FBQzlHLElBQXBCLENBQWQ7O0FBRUEsZ0JBQUksQ0FBQ3VELEtBQUwsRUFBWTtBQUNSLG9CQUFNLElBQUk0RCxLQUFKLENBQVcsVUFBU0wsS0FBSyxDQUFDOUcsSUFBSywwQkFBeUJxRCxrQkFBbUIsSUFBM0UsQ0FBTjtBQUNIOztBQUVEcUQsWUFBQUEsZ0JBQWdCLENBQUNJLEtBQUssQ0FBQzlHLElBQVAsQ0FBaEIsR0FBK0J6QixNQUFNLENBQUM2SCxRQUFQLENBQWdCLEVBQzNDLEdBQUdwSSxDQUFDLENBQUMySixJQUFGLENBQU9wRSxLQUFQLEVBQWMsQ0FBQyxNQUFELEVBQVMsUUFBVCxDQUFkLENBRHdDO0FBRTNDLGlCQUFHdkYsQ0FBQyxDQUFDMkosSUFBRixDQUFPYixLQUFQLEVBQWMsQ0FBQyxVQUFELENBQWQ7QUFGd0MsYUFBaEIsQ0FBL0I7QUFJSDtBQUNKLFNBL0NEO0FBbURBLGNBQU1jLFVBQVUsR0FBR0MsS0FBSyxDQUFDQyxJQUFOLENBQVduQixZQUFYLEVBQXlCdkcsR0FBekIsQ0FBOEJpSCxHQUFELElBQzVDOUksTUFBTSxDQUFDb0gsVUFBUCxDQUFrQjNILENBQUMsQ0FBQzBKLFNBQUYsQ0FBWUwsR0FBWixDQUFsQixFQUFxQyxLQUFJQSxHQUFJLEVBQTdDLENBRGUsQ0FBbkI7QUFJQTlJLFFBQUFBLE1BQU0sQ0FBQ3dKLGFBQVAsQ0FDSW5FLEdBREosRUFFSXJGLE1BQU0sQ0FBQ3lKLFNBQVAsQ0FDSXpKLE1BQU0sQ0FBQzBKLFNBQVAsQ0FBaUIsZ0JBQWpCLENBREosRUFFSTFKLE1BQU0sQ0FBQzJKLG9CQUFQLENBQTRCLEVBQTVCLEVBQWdDTixVQUFVLENBQUN0QyxNQUFYLENBQWtCL0csTUFBTSxDQUFDcUMsU0FBUCxDQUFpQjhGLGdCQUFqQixDQUFsQixDQUFoQyxDQUZKLENBRko7QUFRQSxZQUFJeUIsbUJBQW1CLEdBQUdySyxJQUFJLENBQUM2RSxPQUFMLENBQ3RCLEtBQUtyQixVQURpQixFQUV0QkksTUFBTSxDQUFDMUIsSUFGZSxFQUd0QixRQUhzQixFQUl0QnFELGtCQUFrQixHQUFHLEdBQXJCLEdBQTJCb0QsWUFBM0IsR0FBMEMsS0FKcEIsQ0FBMUI7QUFNQXhJLFFBQUFBLEVBQUUsQ0FBQytFLGNBQUgsQ0FBa0JtRixtQkFBbEI7QUFDQWxLLFFBQUFBLEVBQUUsQ0FBQ2dGLGFBQUgsQ0FBaUJrRixtQkFBakIsRUFBc0M1SixNQUFNLENBQUNtSCxTQUFQLENBQWlCOUIsR0FBakIsQ0FBdEM7QUFFQSxhQUFLeEMsTUFBTCxDQUFZTyxHQUFaLENBQWdCLE1BQWhCLEVBQXdCLG9DQUFvQ3dHLG1CQUE1RDtBQUNILE9BOUVEO0FBK0VILEtBaEZEO0FBaUZIOztBQUVEcEcsRUFBQUEsdUJBQXVCLENBQUNMLE1BQUQsRUFBUztBQUM1QixRQUFJVyxRQUFRLEdBQUdHLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZZixNQUFNLENBQUNXLFFBQW5CLEVBQ1YrRixJQURVLEdBRVYvQixNQUZVLENBRUgsQ0FBQ0MsTUFBRCxFQUFTK0IsQ0FBVCxLQUFlO0FBQ25CL0IsTUFBQUEsTUFBTSxDQUFDK0IsQ0FBRCxDQUFOLEdBQVksRUFBWjtBQUNBLGFBQU8vQixNQUFQO0FBQ0gsS0FMVSxFQUtSLEVBTFEsQ0FBZjs7QUFrRUF0SSxJQUFBQSxDQUFDLENBQUNtRixNQUFGLENBQVN6QixNQUFNLENBQUNXLFFBQWhCLEVBQTBCLENBQUNlLE1BQUQsRUFBU0Msa0JBQVQsS0FBZ0M7QUFDdEQsVUFBSXFELGdCQUFnQixHQUFHLEVBQXZCOztBQUVBMUksTUFBQUEsQ0FBQyxDQUFDbUYsTUFBRixDQUFTQyxNQUFNLENBQUNFLE1BQWhCLEVBQXdCLENBQUNDLEtBQUQsRUFBUUMsU0FBUixLQUFzQjtBQUMxQyxZQUFJRCxLQUFLLENBQUMrRSxRQUFWLEVBQW9CO0FBRXBCLFlBQUlDLFdBQVcsR0FBRztBQUNkakosVUFBQUEsSUFBSSxFQUFFaUUsS0FBSyxDQUFDakU7QUFERSxTQUFsQjs7QUFJQSxZQUFJaUUsS0FBSyxDQUFDakUsSUFBTixLQUFlLE1BQW5CLEVBQTJCO0FBQ3ZCaUosVUFBQUEsV0FBVyxDQUFDQyxNQUFaLEdBQXFCakYsS0FBSyxDQUFDaUYsTUFBM0I7QUFDSDs7QUFFRCxZQUFJakYsS0FBSyxDQUFDa0YsUUFBVixFQUFvQjtBQUNoQkYsVUFBQUEsV0FBVyxDQUFDRSxRQUFaLEdBQXVCLElBQXZCO0FBQ0g7O0FBRUQvQixRQUFBQSxnQkFBZ0IsQ0FBQ2xELFNBQUQsQ0FBaEIsR0FBOEIrRSxXQUE5QjtBQUNILE9BaEJEOztBQWtCQSxVQUFJRyxvQkFBb0IsR0FBRzVLLElBQUksQ0FBQzZFLE9BQUwsQ0FDdkIsS0FBS25CLFlBRGtCLEVBRXZCRSxNQUFNLENBQUMxQixJQUZnQixFQUd2QixZQUh1QixFQUl2QnFELGtCQUFrQixHQUFHLGdCQUpFLENBQTNCO0FBTUFwRixNQUFBQSxFQUFFLENBQUMrRSxjQUFILENBQWtCMEYsb0JBQWxCO0FBQ0F6SyxNQUFBQSxFQUFFLENBQUNnRixhQUFILENBQWlCeUYsb0JBQWpCLEVBQXVDcEcsSUFBSSxDQUFDQyxTQUFMLENBQWVtRSxnQkFBZixFQUFpQyxJQUFqQyxFQUF1QyxDQUF2QyxDQUF2QztBQUVBLFdBQUt0RixNQUFMLENBQVlPLEdBQVosQ0FBZ0IsTUFBaEIsRUFBd0IsZ0NBQWdDK0csb0JBQXhEO0FBQ0gsS0EvQkQ7QUFnQ0g7O0FBeUdEM0UsRUFBQUEsc0JBQXNCLENBQUNYLE1BQUQsRUFBU0ssYUFBVCxFQUF3QjtBQUMxQyxRQUFJa0YsY0FBYyxHQUFHbkssU0FBUyxDQUFDb0ssb0JBQVYsQ0FBK0J4RixNQUFNLENBQUN5RixVQUFQLENBQWtCN0ksSUFBakQsRUFBdUQsS0FBS29CLE1BQTVELEVBQW9FcUMsYUFBcEUsQ0FBckI7QUFDQWtGLElBQUFBLGNBQWMsQ0FBQ0csU0FBZixDQUF5QixLQUF6QixJQUFrQztBQUFFQyxNQUFBQSxNQUFNLEVBQUUsU0FBVjtBQUFxQkMsTUFBQUEsU0FBUyxFQUFFO0FBQWhDLEtBQWxDO0FBQ0FMLElBQUFBLGNBQWMsQ0FBQ0csU0FBZixDQUF5QixNQUF6QixJQUFtQztBQUFFQyxNQUFBQSxNQUFNLEVBQUUsU0FBVjtBQUFxQkMsTUFBQUEsU0FBUyxFQUFFO0FBQWhDLEtBQW5DO0FBQ0FMLElBQUFBLGNBQWMsQ0FBQ0csU0FBZixDQUF5QixXQUF6QixJQUF3QztBQUFFQyxNQUFBQSxNQUFNLEVBQUUsU0FBVjtBQUFxQkMsTUFBQUEsU0FBUyxFQUFFO0FBQWhDLEtBQXhDO0FBQ0FMLElBQUFBLGNBQWMsQ0FBQ0csU0FBZixDQUF5QixRQUF6QixJQUFxQztBQUFFQyxNQUFBQSxNQUFNLEVBQUU7QUFBVixLQUFyQztBQUVBLFVBQU1FLFdBQVcsR0FBR3pLLFNBQVMsQ0FBQzBLLFlBQVYsQ0FBdUJQLGNBQXZCLEVBQXVDLE9BQXZDLENBQXBCO0FBR0EsUUFBSTdFLGVBQWUsR0FBRyxFQUF0Qjs7QUFFQTlGLElBQUFBLENBQUMsQ0FBQ21GLE1BQUYsQ0FBU0MsTUFBTSxDQUFDRSxNQUFoQixFQUF3QixDQUFDQyxLQUFELEVBQVFDLFNBQVIsS0FBc0I7QUFDMUMsVUFBSTJGLE1BQU0sR0FBRzNLLFNBQVMsQ0FBQzRLLFlBQVYsQ0FBdUI1RixTQUF2QixFQUFrQ0QsS0FBbEMsRUFBeUNvRixjQUF6QyxDQUFiO0FBQ0FuSyxNQUFBQSxTQUFTLENBQUM2SyxTQUFWLENBQW9CVixjQUFwQixFQUFvQ1EsTUFBcEMsRUFBNENGLFdBQTVDOztBQUVBLFVBQUkxRixLQUFLLENBQUMrRixTQUFOLElBQW1CL0YsS0FBSyxDQUFDZ0cscUJBQTdCLEVBQW9EO0FBQ2hEbkwsUUFBQUEsYUFBYSxDQUFDMEYsZUFBRCxFQUFrQk4sU0FBbEIsRUFBNkI7QUFBRWdHLFVBQUFBLFNBQVMsRUFBRWhHLFNBQWI7QUFBd0JpRyxVQUFBQSxZQUFZLEVBQUU7QUFBdEMsU0FBN0IsQ0FBYjtBQUNIO0FBQ0osS0FQRDs7QUFTQSxRQUFJQyxJQUFJLEdBQUdmLGNBQWMsQ0FBQ2dCLFFBQWYsQ0FBd0J2QixJQUF4QixFQUFYO0FBR0FzQixJQUFBQSxJQUFJLEdBQUdBLElBQUksQ0FBQ0UsTUFBTCxDQUFhdkMsR0FBRCxJQUFTc0IsY0FBYyxDQUFDa0IsZ0JBQWYsQ0FBZ0NDLEdBQWhDLENBQW9DekMsR0FBcEMsQ0FBckIsQ0FBUDtBQUdBLFFBQUkwQyx5QkFBeUIsR0FBRyxFQUFoQztBQUFBLFFBQ0lDLGVBREo7QUFBQSxRQUVJQyxlQUFlLEdBQUcsRUFGdEI7QUFBQSxRQUdJeEssU0FISjtBQUFBLFFBSUl5SyxXQUpKOztBQU1BLFVBQU1DLDJCQUEyQixHQUFHLFVBQVUzRyxTQUFWLEVBQXFCNEcsVUFBckIsRUFBaUNDLFFBQWpDLEVBQTJDQyxrQkFBM0MsRUFBK0Q7QUFDL0YsVUFBSWhILE1BQU0sR0FBRyxDQUFDRSxTQUFELEVBQVk4QixNQUFaLENBQW1COEUsVUFBbkIsQ0FBYjtBQUNBLFVBQUlHLE9BQU8sR0FBR2pILE1BQU0sQ0FBQzlDLElBQVAsQ0FBWSxHQUFaLENBQWQ7O0FBRUEsVUFBSXdKLGVBQWUsSUFBSUEsZUFBZSxDQUFDTyxPQUFoQixLQUE0QkEsT0FBbkQsRUFBNEQ7QUFDeERSLFFBQUFBLHlCQUF5QixHQUFHQSx5QkFBeUIsQ0FBQ3pFLE1BQTFCLENBQ3hCN0csUUFBUSxDQUFDK0wsc0JBQVQsQ0FDSVIsZUFBZSxDQUFDeEcsU0FEcEIsRUFFSXdHLGVBQWUsQ0FBQ0ksVUFGcEIsRUFHSUgsZUFISixFQUlJRCxlQUFlLENBQUNNLGtCQUpwQixDQUR3QixDQUE1QjtBQVFBTCxRQUFBQSxlQUFlLEdBQUcsRUFBbEI7QUFDSDs7QUFFREEsTUFBQUEsZUFBZSxHQUFHQSxlQUFlLENBQUMzRSxNQUFoQixDQUF1QitFLFFBQXZCLENBQWxCO0FBQ0FMLE1BQUFBLGVBQWUsR0FBRztBQUNkeEcsUUFBQUEsU0FEYztBQUVkNEcsUUFBQUEsVUFGYztBQUdkRSxRQUFBQSxrQkFIYztBQUlkQyxRQUFBQTtBQUpjLE9BQWxCO0FBTUgsS0F2QkQ7O0FBMkJBdk0sSUFBQUEsQ0FBQyxDQUFDNEgsSUFBRixDQUFPOEQsSUFBUCxFQUFhLENBQUNyQyxHQUFELEVBQU0vRyxDQUFOLEtBQVk7QUFFckIsVUFBSW1LLFNBQVMsR0FBRzlCLGNBQWMsQ0FBQ2tCLGdCQUFmLENBQWdDYSxHQUFoQyxDQUFvQ3JELEdBQXBDLENBQWhCO0FBR0EsVUFBSXNELFFBQVEsR0FBR2hDLGNBQWMsQ0FBQ2lDLE1BQWYsQ0FBc0J2RCxHQUF0QixDQUFmO0FBRUEsVUFBSXdELGVBQWUsR0FBRy9MLFlBQVksQ0FBQzJMLFNBQVMsQ0FBQ2xMLE1BQVgsQ0FBbEM7O0FBRUEsVUFBSWtMLFNBQVMsQ0FBQ0wsVUFBVixJQUF3QkssU0FBUyxDQUFDTCxVQUFWLENBQXFCVSxNQUFyQixHQUE4QixDQUExRCxFQUE2RDtBQUN6RCxZQUFJQyxjQUFjLEdBQUdqSCxlQUFlLENBQUMrRyxlQUFELENBQXBDOztBQUNBLFlBQUksQ0FBQ0UsY0FBTCxFQUFxQjtBQUNqQmpILFVBQUFBLGVBQWUsQ0FBQytHLGVBQUQsQ0FBZixHQUFtQ0UsY0FBYyxHQUFHLEVBQXBEO0FBQ0g7O0FBRUQsWUFBSU4sU0FBUyxDQUFDbkwsSUFBVixLQUFtQmQsU0FBUyxDQUFDSyxzQkFBakMsRUFBeUQ7QUFDckQ0TCxVQUFBQSxTQUFTLENBQUNMLFVBQVYsQ0FBcUJoRyxPQUFyQixDQUE4QjRHLEdBQUQsSUFBUztBQUNsQ0QsWUFBQUEsY0FBYyxDQUFDeEcsSUFBZixDQUFvQjtBQUFFaUYsY0FBQUEsU0FBUyxFQUFFd0IsR0FBYjtBQUFrQkMsY0FBQUEsUUFBUSxFQUFFO0FBQTVCLGFBQXBCO0FBQ0gsV0FGRDtBQUdILFNBSkQsTUFJTztBQUNIUixVQUFBQSxTQUFTLENBQUNMLFVBQVYsQ0FBcUJoRyxPQUFyQixDQUE4QjRHLEdBQUQsSUFBUztBQUNsQyxnQkFBSUQsY0FBYyxDQUFDMUwsT0FBZixDQUF1QjJMLEdBQXZCLE1BQWdDLENBQUMsQ0FBckMsRUFBd0NELGNBQWMsQ0FBQ3hHLElBQWYsQ0FBb0J5RyxHQUFwQjtBQUMzQyxXQUZEO0FBR0g7QUFDSjs7QUFFRCxVQUFJdkwsU0FBSixFQUFlO0FBQ1hrTCxRQUFBQSxRQUFRLEdBQUduTCxTQUFTLENBQUNDLFNBQUQsRUFBWXlLLFdBQVosRUFBeUJTLFFBQXpCLEVBQW1DRixTQUFTLENBQUNuTCxJQUE3QyxDQUFwQjtBQUNBRyxRQUFBQSxTQUFTLEdBQUd5TCxTQUFaO0FBQ0g7O0FBRUQsVUFBSTVLLENBQUMsR0FBR29KLElBQUksQ0FBQ29CLE1BQUwsR0FBYyxDQUF0QixFQUF5QjtBQUNyQixZQUFJSyxRQUFRLEdBQUd4QyxjQUFjLENBQUNrQixnQkFBZixDQUFnQ2EsR0FBaEMsQ0FBb0NoQixJQUFJLENBQUNwSixDQUFDLEdBQUcsQ0FBTCxDQUF4QyxDQUFmOztBQUVBLFlBQUlwQixXQUFXLENBQUN1TCxTQUFELEVBQVlVLFFBQVosQ0FBZixFQUFzQztBQUNsQzFMLFVBQUFBLFNBQVMsR0FBR2tMLFFBQVo7QUFDQVQsVUFBQUEsV0FBVyxHQUFHTyxTQUFTLENBQUNuTCxJQUF4QjtBQUNBO0FBQ0g7QUFDSjs7QUFFRCxVQUFJbUwsU0FBUyxDQUFDbkwsSUFBVixLQUFtQmQsU0FBUyxDQUFDRyxzQkFBakMsRUFBeUQ7QUFFckQsWUFBSTBMLFFBQVEsR0FBRzVMLFFBQVEsQ0FBQzJNLGNBQVQsQ0FBd0JQLGVBQXhCLEVBQXlDRixRQUF6QyxDQUFmOztBQUVBUixRQUFBQSwyQkFBMkIsQ0FBQ1UsZUFBRCxFQUFrQkosU0FBUyxDQUFDTCxVQUE1QixFQUF3Q0MsUUFBeEMsRUFBa0QsSUFBbEQsQ0FBM0I7QUFDSCxPQUxELE1BS08sSUFBSUksU0FBUyxDQUFDbkwsSUFBVixLQUFtQmQsU0FBUyxDQUFDSSxzQkFBakMsRUFBeUQ7QUFDNUQsWUFBSXlMLFFBQVEsR0FBRzlMLE1BQU0sQ0FBQ3lKLFNBQVAsQ0FDWHpKLE1BQU0sQ0FBQzBKLFNBQVAsQ0FBaUJ3QyxTQUFTLENBQUNsTCxNQUEzQixFQUFtQyxJQUFuQyxDQURXLEVBRVhvTCxRQUZXLEVBR1YsZUFBY0UsZUFBZ0IsR0FIcEIsQ0FBZjs7QUFNQVYsUUFBQUEsMkJBQTJCLENBQUNVLGVBQUQsRUFBa0JKLFNBQVMsQ0FBQ0wsVUFBNUIsRUFBd0NDLFFBQXhDLEVBQWtELElBQWxELENBQTNCO0FBQ0gsT0FSTSxNQVFBLElBQUlJLFNBQVMsQ0FBQ25MLElBQVYsS0FBbUJkLFNBQVMsQ0FBQ0ssc0JBQWpDLEVBQXlEO0FBQzVELFlBQUl3TCxRQUFRLEdBQUc1TCxRQUFRLENBQUM0TSxlQUFULENBQ1hWLFFBRFcsRUFFWHBNLE1BQU0sQ0FBQzBKLFNBQVAsQ0FBaUJ3QyxTQUFTLENBQUNsTCxNQUEzQixFQUFtQyxJQUFuQyxDQUZXLEVBR1YsZUFBY3NMLGVBQWdCLEdBSHBCLENBQWY7O0FBTUFWLFFBQUFBLDJCQUEyQixDQUFDVSxlQUFELEVBQWtCSixTQUFTLENBQUNMLFVBQTVCLEVBQXdDQyxRQUF4QyxFQUFrRCxLQUFsRCxDQUEzQjtBQUNILE9BUk0sTUFRQTtBQUNILGNBQU0sSUFBSWxELEtBQUosQ0FBVSxvQkFBVixDQUFOO0FBR0g7QUFDSixLQW5FRDs7QUE2RUEsUUFBSSxDQUFDbkosQ0FBQyxDQUFDZ0gsT0FBRixDQUFVaUYsZUFBVixDQUFMLEVBQWlDO0FBQzdCRixNQUFBQSx5QkFBeUIsR0FBR0EseUJBQXlCLENBQUN6RSxNQUExQixDQUN4QjdHLFFBQVEsQ0FBQytMLHNCQUFULENBQ0lSLGVBQWUsQ0FBQ3hHLFNBRHBCLEVBRUl3RyxlQUFlLENBQUNJLFVBRnBCLEVBR0lILGVBSEosRUFJSUQsZUFBZSxDQUFDTSxrQkFKcEIsQ0FEd0IsQ0FBNUI7QUFRSDs7QUFXRCxXQUFPO0FBQ0gxRyxNQUFBQSxHQUFHLEVBQUVyRixNQUFNLENBQUMrTSxlQUFQLENBQ0R2TCxpQkFBaUIsQ0FBQyxnQkFBRCxDQURoQixFQUVELENBQUMsU0FBRCxFQUFZLFlBQVosQ0FGQyxFQUdEdEIsUUFBUSxDQUFDOE0scUJBQVQsQ0FDS2pHLE1BREwsQ0FDWXlFLHlCQURaLEVBRUt6RSxNQUZMLENBRVksQ0FBQy9HLE1BQU0sQ0FBQ3FDLFNBQVAsQ0FBaUJyQyxNQUFNLENBQUN3QyxLQUFQLENBQWEsU0FBYixDQUFqQixDQUFELENBRlosQ0FIQyxFQU1ELEtBTkMsRUFPRCxJQVBDLEVBUUQsSUFSQyxFQVNELGlEQVRDLENBREY7QUFZSCtDLE1BQUFBO0FBWkcsS0FBUDtBQWNIOztBQUVEZ0MsRUFBQUEsNkJBQTZCLENBQUNwRSxNQUFELEVBQVM7QUFBRStELElBQUFBLFlBQUY7QUFBZ0IrRixJQUFBQSxXQUFoQjtBQUE2QmhHLElBQUFBLFFBQTdCO0FBQXVDMUUsSUFBQUE7QUFBdkMsR0FBVCxFQUF3RDtBQUNqRixRQUFJMkssUUFBUSxHQUFHM04sSUFBSSxDQUFDNkUsT0FBTCxDQUFhLEtBQUtyQixVQUFsQixFQUE4QkksTUFBTSxDQUFDMUIsSUFBckMsRUFBMkN3RixRQUEzQyxDQUFmOztBQUVBLFFBQUl2SCxFQUFFLENBQUN5TixVQUFILENBQWNELFFBQWQsQ0FBSixFQUE2QjtBQUV6QixXQUFLckssTUFBTCxDQUFZTyxHQUFaLENBQWdCLE1BQWhCLEVBQXlCLEdBQUUzRCxDQUFDLENBQUMyTixVQUFGLENBQWFILFdBQWIsQ0FBMEIsS0FBSWhHLFFBQVMsb0NBQWxFO0FBRUE7QUFDSDs7QUFFRCxRQUFJNUIsR0FBRyxHQUFHckYsTUFBTSxDQUFDc0ksVUFBUCxFQUFWO0FBRUF0SSxJQUFBQSxNQUFNLENBQUN3SixhQUFQLENBQXFCbkUsR0FBckIsRUFBMEJyRixNQUFNLENBQUNxTixXQUFQLENBQW1CbkcsWUFBbkIsRUFBaUMzRSxJQUFqQyxFQUF1Q0wsbUJBQW1CLENBQUMrSyxXQUFELENBQW5CLENBQWlDMUssSUFBakMsQ0FBdkMsQ0FBMUI7QUFDQXZDLElBQUFBLE1BQU0sQ0FBQ3dKLGFBQVAsQ0FBcUJuRSxHQUFyQixFQUEwQnJGLE1BQU0sQ0FBQ3lKLFNBQVAsQ0FBaUIsZ0JBQWpCLEVBQW1DekosTUFBTSxDQUFDMEosU0FBUCxDQUFpQnhDLFlBQWpCLENBQW5DLENBQTFCO0FBRUF4SCxJQUFBQSxFQUFFLENBQUMrRSxjQUFILENBQWtCeUksUUFBbEI7QUFDQXhOLElBQUFBLEVBQUUsQ0FBQ2dGLGFBQUgsQ0FBaUJ3SSxRQUFqQixFQUEyQmxOLE1BQU0sQ0FBQ21ILFNBQVAsQ0FBaUI5QixHQUFqQixDQUEzQjtBQUNBLFNBQUt4QyxNQUFMLENBQVlPLEdBQVosQ0FBZ0IsTUFBaEIsRUFBeUIsYUFBWTZKLFdBQVksVUFBU0MsUUFBUyxFQUFuRTtBQUNIOztBQUVEcEcsRUFBQUEsZ0JBQWdCLENBQUNqQyxNQUFELEVBQVN5SSxhQUFULEVBQXdCcEksYUFBeEIsRUFBdUM7QUFDbkQsUUFBSUcsR0FBRyxHQUFHLEVBQVY7O0FBRUE1RixJQUFBQSxDQUFDLENBQUNtRixNQUFGLENBQVNDLE1BQU0sQ0FBQytCLFVBQWhCLEVBQTRCLENBQUMyRyxNQUFELEVBQVM5TCxJQUFULEtBQWtCO0FBQzFDLFdBQUtvQixNQUFMLENBQVkySyxJQUFaLENBQWlCLHlCQUF5Qi9MLElBQTFDO0FBRUEsVUFBSWdNLE9BQU8sR0FBRyxDQUNWek4sTUFBTSxDQUFDME4sYUFBUCxDQUNJLE9BREosRUFFSTFOLE1BQU0sQ0FBQzBKLFNBQVAsQ0FBaUIsMEJBQTBCakksSUFBM0MsQ0FGSixFQUdJLElBSEosRUFJSSxLQUpKLEVBS0ksMEJBTEosQ0FEVSxDQUFkO0FBVUEsVUFBSTJJLGNBQWMsR0FBR25LLFNBQVMsQ0FBQ29LLG9CQUFWLENBQStCeEYsTUFBTSxDQUFDeUYsVUFBUCxDQUFrQjdJLElBQWpELEVBQXVELEtBQUtvQixNQUE1RCxFQUFvRXFDLGFBQXBFLENBQXJCO0FBRUEsVUFBSXlJLFNBQUo7O0FBRUEsVUFBSUosTUFBTSxDQUFDSyxNQUFYLEVBQW1CO0FBQ2ZELFFBQUFBLFNBQVMsR0FBRyxLQUFLRSxjQUFMLENBQW9CTixNQUFNLENBQUNLLE1BQTNCLEVBQW1DeEQsY0FBbkMsQ0FBWjtBQUNIOztBQUdEa0QsTUFBQUEsYUFBYSxDQUFDLFlBQUQsQ0FBYixLQUFnQ0EsYUFBYSxDQUFDLFlBQUQsQ0FBYixHQUE4QixFQUE5RDtBQUNBQSxNQUFBQSxhQUFhLENBQUMsWUFBRCxDQUFiLENBQTRCN0wsSUFBNUIsSUFBb0M7QUFBRXFNLFFBQUFBLE1BQU0sRUFBRTdKLE1BQU0sQ0FBQ2dHLE1BQVAsQ0FBYzBELFNBQWQ7QUFBVixPQUFwQzs7QUFFQWxPLE1BQUFBLENBQUMsQ0FBQzRILElBQUYsQ0FBT2tHLE1BQU0sQ0FBQ1EsY0FBZCxFQUE4QixDQUFDQyxTQUFELEVBQVlsSSxLQUFaLEtBQXNCO0FBRWhEN0YsUUFBQUEsU0FBUyxDQUFDZ08sa0JBQVYsQ0FBNkJuSSxLQUE3QixFQUFvQ2tJLFNBQXBDLEVBQStDNUQsY0FBL0MsRUFBK0RBLGNBQWMsQ0FBQzhELFdBQTlFO0FBQ0gsT0FIRDs7QUFLQSxVQUFJWCxNQUFNLENBQUNZLE1BQVgsRUFBbUI7QUFDZmxPLFFBQUFBLFNBQVMsQ0FBQ21PLHdCQUFWLENBQW1DYixNQUFNLENBQUNZLE1BQTFDLEVBQWtEL0QsY0FBbEQ7QUFDSDs7QUFFRCxVQUFJZSxJQUFJLEdBQUdmLGNBQWMsQ0FBQ2dCLFFBQWYsQ0FBd0J2QixJQUF4QixFQUFYO0FBR0FzQixNQUFBQSxJQUFJLEdBQUdBLElBQUksQ0FBQ0UsTUFBTCxDQUFhdkMsR0FBRCxJQUFTc0IsY0FBYyxDQUFDa0IsZ0JBQWYsQ0FBZ0NDLEdBQWhDLENBQW9DekMsR0FBcEMsQ0FBckIsQ0FBUDs7QUFHQXJKLE1BQUFBLENBQUMsQ0FBQzRILElBQUYsQ0FBTzhELElBQVAsRUFBY3JDLEdBQUQsSUFBUztBQUNsQixZQUFJb0QsU0FBUyxHQUFHOUIsY0FBYyxDQUFDa0IsZ0JBQWYsQ0FBZ0NhLEdBQWhDLENBQW9DckQsR0FBcEMsQ0FBaEI7QUFDQSxZQUFJc0QsUUFBUSxHQUFHaEMsY0FBYyxDQUFDaUMsTUFBZixDQUFzQnZELEdBQXRCLENBQWY7QUFJQSxZQUFJd0QsZUFBZSxHQUFHSixTQUFTLENBQUNsTCxNQUFoQzs7QUFFQSxZQUFJa0wsU0FBUyxDQUFDbkwsSUFBVixLQUFtQmQsU0FBUyxDQUFDRyxzQkFBakMsRUFBeUQ7QUFDckRnTSxVQUFBQSxRQUFRLEdBQUdsTSxRQUFRLENBQUMyTSxjQUFULENBQXdCUCxlQUF4QixFQUF5Q0YsUUFBekMsQ0FBWDtBQUNILFNBRkQsTUFFTyxJQUFJRixTQUFTLENBQUNuTCxJQUFWLEtBQW1CZCxTQUFTLENBQUNJLHNCQUFqQyxFQUF5RDtBQUM1RCxjQUFJNkwsU0FBUyxDQUFDbUMsV0FBZCxFQUEyQjtBQUN2QmpDLFlBQUFBLFFBQVEsR0FBR3BNLE1BQU0sQ0FBQzBOLGFBQVAsQ0FDUDFOLE1BQU0sQ0FBQzBKLFNBQVAsQ0FBaUJ3QyxTQUFTLENBQUNsTCxNQUEzQixDQURPLEVBRVBvTCxRQUZPLEVBR1AsS0FITyxFQUlQLEtBSk8sRUFLTixlQUFjRSxlQUFnQixHQUx4QixDQUFYO0FBT0gsV0FSRCxNQVFPO0FBQ0hGLFlBQUFBLFFBQVEsR0FBR3BNLE1BQU0sQ0FBQ3lKLFNBQVAsQ0FDUHpKLE1BQU0sQ0FBQzBKLFNBQVAsQ0FBaUJ3QyxTQUFTLENBQUNsTCxNQUEzQixFQUFtQyxJQUFuQyxDQURPLEVBRVBvTCxRQUZPLEVBR04sZUFBY0UsZUFBZ0IsR0FIeEIsQ0FBWDtBQUtIO0FBQ0osU0FoQk0sTUFnQkEsSUFBSUosU0FBUyxDQUFDbkwsSUFBVixLQUFtQmQsU0FBUyxDQUFDSyxzQkFBakMsRUFBeUQ7QUFDNUQsY0FBSTRMLFNBQVMsQ0FBQ21DLFdBQWQsRUFBMkI7QUFDdkJqQyxZQUFBQSxRQUFRLEdBQUdwTSxNQUFNLENBQUMwTixhQUFQLENBQ1AxTixNQUFNLENBQUMwSixTQUFQLENBQWlCd0MsU0FBUyxDQUFDbEwsTUFBM0IsQ0FETyxFQUVQb0wsUUFGTyxFQUdQLEtBSE8sRUFJUCxLQUpPLEVBS04sZUFBY0UsZUFBZ0IsR0FMeEIsQ0FBWDtBQU9ILFdBUkQsTUFRTztBQUNIRixZQUFBQSxRQUFRLEdBQUdwTSxNQUFNLENBQUN5SixTQUFQLENBQ1B6SixNQUFNLENBQUMwSixTQUFQLENBQWlCd0MsU0FBUyxDQUFDbEwsTUFBM0IsRUFBbUMsSUFBbkMsQ0FETyxFQUVQb0wsUUFGTyxFQUdOLGVBQWNFLGVBQWdCLEdBSHhCLENBQVg7QUFLSDtBQUNKOztBQUVEbUIsUUFBQUEsT0FBTyxHQUFHQSxPQUFPLENBQUMxRyxNQUFSLENBQWV0SCxDQUFDLENBQUNpRyxTQUFGLENBQVkwRyxRQUFaLENBQWYsQ0FBVjtBQUNILE9BN0NEOztBQStDQS9HLE1BQUFBLEdBQUcsQ0FBQ1csSUFBSixDQUNJaEcsTUFBTSxDQUFDK00sZUFBUCxDQUNJdkwsaUJBQWlCLENBQUNDLElBQUQsQ0FEckIsRUFFSXdDLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZeUosU0FBWixDQUZKLEVBR0lGLE9BSEosRUFJSSxLQUpKLEVBS0ksSUFMSixFQU1JLElBTkosRUFPSTdOLFVBQVUsQ0FBQ0gsQ0FBQyxDQUFDNk8sU0FBRixDQUFZN00sSUFBWixDQUFELEVBQW9CLEdBQXBCLEVBQXlCLEdBQXpCLENBUGQsQ0FESjtBQVdILEtBbEdEOztBQW9HQSxXQUFPNEQsR0FBUDtBQUNIOztBQUVEd0ksRUFBQUEsY0FBYyxDQUFDVSxZQUFELEVBQWVuRSxjQUFmLEVBQStCO0FBQ3pDLFFBQUl1RCxTQUFTLEdBQUcsRUFBaEI7QUFFQVksSUFBQUEsWUFBWSxDQUFDMUksT0FBYixDQUFxQixDQUFDMkksS0FBRCxFQUFRek0sQ0FBUixLQUFjO0FBQy9COUIsTUFBQUEsU0FBUyxDQUFDd08sWUFBVixDQUF1QjFNLENBQXZCLEVBQTBCeU0sS0FBMUIsRUFBaUNwRSxjQUFqQztBQUNBdUQsTUFBQUEsU0FBUyxDQUFDYSxLQUFLLENBQUMvTSxJQUFQLENBQVQsR0FBd0IrTSxLQUF4QjtBQUNBcEUsTUFBQUEsY0FBYyxDQUFDRyxTQUFmLENBQXlCaUUsS0FBSyxDQUFDL00sSUFBL0IsSUFBdUM7QUFBRStJLFFBQUFBLE1BQU0sRUFBRTtBQUFWLE9BQXZDO0FBQ0gsS0FKRDtBQU1BLFdBQU9tRCxTQUFQO0FBQ0g7O0FBbnlCWTs7QUFzeUJqQmUsTUFBTSxDQUFDQyxPQUFQLEdBQWlCak0sVUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgcGF0aCA9IHJlcXVpcmUoXCJwYXRoXCIpO1xuY29uc3QgeyBfLCBmcywgcGFzY2FsQ2FzZSwgcmVwbGFjZUFsbCwgcHV0SW50b0J1Y2tldCB9ID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3Qgc3dpZyA9IHJlcXVpcmUoXCJzd2lnLXRlbXBsYXRlc1wiKTtcblxuY29uc3QgR2VtbFR5cGVzID0gcmVxdWlyZShcIi4uL2xhbmcvR2VtbFR5cGVzXCIpO1xuY29uc3QgSnNMYW5nID0gcmVxdWlyZShcIi4vdXRpbC9hc3QuanNcIik7XG5jb25zdCBHZW1sVG9Bc3QgPSByZXF1aXJlKFwiLi91dGlsL2dlbWxUb0FzdC5qc1wiKTtcbmNvbnN0IFNuaXBwZXRzID0gcmVxdWlyZShcIi4vZGFvL3NuaXBwZXRzXCIpO1xuXG5jb25zdCBDaGFpbmFibGVUeXBlID0gW1xuICAgIEdlbWxUb0FzdC5BU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIEdlbWxUb0FzdC5BU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMLFxuXTtcblxuY29uc3QgZ2V0RmllbGROYW1lID0gKHQpID0+IHQuc3BsaXQoXCIuXCIpLnBvcCgpO1xuY29uc3QgaXNDaGFpbmFibGUgPSAoY3VycmVudCwgbmV4dCkgPT5cbiAgICBDaGFpbmFibGVUeXBlLmluZGV4T2YoY3VycmVudC50eXBlKSA+IC0xICYmIGN1cnJlbnQudGFyZ2V0ID09PSBuZXh0LnRhcmdldCAmJiBuZXh0LnR5cGUgPT09IGN1cnJlbnQudHlwZTtcbmNvbnN0IGNoYWluQ2FsbCA9IChsYXN0QmxvY2ssIGxhc3RUeXBlLCBjdXJyZW50QmxvY2ssIGN1cnJlbnRUeXBlKSA9PiB7XG4gICAgaWYgKGxhc3RCbG9jaykge1xuICAgICAgICBpZiAobGFzdFR5cGUgPT09IFwiVmFsaWRhdG9yQ2FsbFwiKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IGN1cnJlbnRUeXBlID09PSBcIlZhbGlkYXRvckNhbGxcIiwgXCJVbmV4cGVjdGVkIGN1cnJlbnRUeXBlXCI7XG5cbiAgICAgICAgICAgIGN1cnJlbnRCbG9jayA9IEpzTGFuZy5hc3RCaW5FeHAobGFzdEJsb2NrLCBcIiYmXCIsIGN1cnJlbnRCbG9jayk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NlcnQ6IGN1cnJlbnRUeXBlID09PSBcIlByb2Nlc3NvckNhbGxcIiwgXCJVbmV4cGVjdGVkIGN1cnJlbnRUeXBlOiBcIiArIGN1cnJlbnRUeXBlICsgXCIgbGFzdDogXCIgKyBsYXN0VHlwZTtcblxuICAgICAgICAgICAgY3VycmVudEJsb2NrLmFyZ3VtZW50c1swXSA9IGxhc3RCbG9jaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjdXJyZW50QmxvY2s7XG59O1xuY29uc3QgYXN5bmNNZXRob2ROYW1pbmcgPSAobmFtZSkgPT4gbmFtZSArIFwiX1wiO1xuXG5jb25zdCBpbmRlbnRMaW5lcyA9IChsaW5lcywgaW5kZW50YXRpb24pID0+XG4gICAgbGluZXNcbiAgICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAgIC5tYXAoKGxpbmUsIGkpID0+IChpID09PSAwID8gbGluZSA6IF8ucmVwZWF0KFwiIFwiLCBpbmRlbnRhdGlvbikgKyBsaW5lKSlcbiAgICAgICAgLmpvaW4oXCJcXG5cIik7XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9SRVRVUk4gPSB7XG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAoKSA9PiBbSnNMYW5nLmFzdFJldHVybih0cnVlKV0sXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAoYXJncykgPT4gW0pzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKGFyZ3NbMF0pKV0sXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAoKSA9PiBbSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoXCJ1bmRlZmluZWRcIikpXSxcbn07XG5cbi8qKlxuICogT29sb25nIGRhdGFiYXNlIGFjY2VzcyBvYmplY3QgKERBTykgbW9kZWxlci5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBEYW9Nb2RlbGVyIHtcbiAgICAvKipcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7R2VtbExpbmtlcn0gY29udGV4dC5saW5rZXIgLSBHZW1sIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0Lm1vZGVsUGF0aCAtIEdlbmVyYXRlZCBtb2RlbCBvdXRwdXQgcGF0aFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0Lm1hbmlmZXN0UGF0aCAtIEVudGl0aWVzIG1hbmlmZXN0IG91dHB1dCBwYXRoXG4gICAgICogQHBhcmFtIHtDb25uZWN0b3J9IGNvbm5lY3RvclxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGxpbmtlciwgY29ubmVjdG9yKSB7XG4gICAgICAgIHRoaXMubGlua2VyID0gbGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0Lm1vZGVsUGF0aDtcbiAgICAgICAgdGhpcy5tYW5pZmVzdFBhdGggPSBjb250ZXh0Lm1hbmlmZXN0UGF0aDtcblxuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcbiAgICB9XG5cbiAgICBtb2RlbGluZ18oc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgJ0dlbmVyYXRpbmcgZW50aXR5IG1vZGVscyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgdGhpcy5fZ2VuZXJhdGVTY2hlbWFNb2RlbChzY2hlbWEpO1xuICAgICAgICB0aGlzLl9nZW5lcmF0ZUVudGl0eU1vZGVsKHNjaGVtYSk7XG4gICAgICAgIHRoaXMuX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEoc2NoZW1hKTtcbiAgICAgICAgLy90aGlzLl9nZW5lcmF0ZUVudW1UeXBlcyhzY2hlbWEpO1xuICAgICAgICAvL3RoaXMuX2dlbmVyYXRlVmlld01vZGVsKCk7XG5cbiAgICAgICAgaWYgKHRoaXMubWFuaWZlc3RQYXRoKSB7XG4gICAgICAgICAgICB0aGlzLl9nZW5lcmF0ZUVudGl0eU1hbmlmZXN0KHNjaGVtYSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVTY2hlbWFNb2RlbChzY2hlbWEpIHtcbiAgICAgICAgbGV0IGNhcGl0YWxpemVkID0gcGFzY2FsQ2FzZShzY2hlbWEubmFtZSk7XG5cbiAgICAgICAgbGV0IGxvY2FscyA9IHtcbiAgICAgICAgICAgIGRyaXZlcjogdGhpcy5jb25uZWN0b3IuZHJpdmVyLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiBjYXBpdGFsaXplZCxcbiAgICAgICAgICAgIHNjaGVtYU5hbWU6IHNjaGVtYS5uYW1lLFxuICAgICAgICAgICAgZW50aXRpZXM6IEpTT04uc3RyaW5naWZ5KE9iamVjdC5rZXlzKHNjaGVtYS5lbnRpdGllcykpLFxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBjbGFzc1RlbXBsYXRlID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCJkYXRhYmFzZVwiLCB0aGlzLmNvbm5lY3Rvci5kcml2ZXIsIFwiRGF0YWJhc2UuanMuc3dpZ1wiKTtcbiAgICAgICAgbGV0IGNsYXNzQ29kZSA9IHN3aWcucmVuZGVyRmlsZShjbGFzc1RlbXBsYXRlLCBsb2NhbHMpO1xuXG4gICAgICAgIGxldCBtb2RlbEZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMub3V0cHV0UGF0aCwgY2FwaXRhbGl6ZWQgKyBcIi5qc1wiKTtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCwgY2xhc3NDb2RlKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGRhdGFiYXNlIG1vZGVsOiBcIiArIG1vZGVsRmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUVudW1UeXBlcyhzY2hlbWEpIHtcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlJbnN0YW5jZU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5maWVsZHMsIChmaWVsZCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09IFwiZW51bVwiKSB7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUVudGl0eU1vZGVsKHNjaGVtYSkge1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgbGV0IGNhcGl0YWxpemVkID0gcGFzY2FsQ2FzZShlbnRpdHlJbnN0YW5jZU5hbWUpO1xuXG4gICAgICAgICAgICAvL3NoYXJlZCBpbmZvcm1hdGlvbiB3aXRoIG1vZGVsIENSVUQgYW5kIGN1c3RvbWl6ZWQgaW50ZXJmYWNlc1xuICAgICAgICAgICAgbGV0IHNoYXJlZENvbnRleHQgPSB7XG4gICAgICAgICAgICAgICAgbWFwT2ZGdW5jdG9yVG9GaWxlOiB7fSxcbiAgICAgICAgICAgICAgICBuZXdGdW5jdG9yRmlsZXM6IFtdLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgbGV0IHsgYXN0OiBhc3RDbGFzc01haW4sIGZpZWxkUmVmZXJlbmNlcyB9ID0gdGhpcy5fcHJvY2Vzc0ZpZWxkTW9kaWZpZXJzKGVudGl0eSwgc2hhcmVkQ29udGV4dCk7XG4gICAgICAgICAgICBhc3RDbGFzc01haW4gPSBbYXN0Q2xhc3NNYWluXTtcblxuICAgICAgICAgICAgLy9wcmVwYXJlIG1ldGEgZGF0YVxuICAgICAgICAgICAgbGV0IHVuaXF1ZUtleXMgPSBbXy5jYXN0QXJyYXkoZW50aXR5LmtleSldO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKChpbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB1bmlxdWVLZXlzLnB1c2goaW5kZXguZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbW9kZWxNZXRhID0ge1xuICAgICAgICAgICAgICAgIHNjaGVtYU5hbWU6IHNjaGVtYS5uYW1lLFxuICAgICAgICAgICAgICAgIG5hbWU6IGVudGl0eUluc3RhbmNlTmFtZSxcbiAgICAgICAgICAgICAgICBrZXlGaWVsZDogZW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICBmaWVsZHM6IF8ubWFwVmFsdWVzKGVudGl0eS5maWVsZHMsIChmKSA9PiBfLm9taXQoZi50b0pTT04oKSwgXCJtb2RpZmllcnNcIikpLFxuICAgICAgICAgICAgICAgIGZlYXR1cmVzOiBlbnRpdHkuZmVhdHVyZXMgfHwge30sXG4gICAgICAgICAgICAgICAgdW5pcXVlS2V5cyxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuYmFzZUNsYXNzZXMpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuYmFzZUNsYXNzZXMgPSBlbnRpdHkuYmFzZUNsYXNzZXM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmRleGVzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5pbmRleGVzID0gZW50aXR5LmluZGV4ZXM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5mZWF0dXJlcykpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuZmVhdHVyZXMgPSBlbnRpdHkuZmVhdHVyZXM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5hc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmFzc29jaWF0aW9ucyA9IGVudGl0eS5hc3NvY2lhdGlvbnM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGZpZWxkUmVmZXJlbmNlcykpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuZmllbGREZXBlbmRlbmNpZXMgPSBmaWVsZFJlZmVyZW5jZXM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vYnVpbGQgY3VzdG9taXplZCBpbnRlcmZhY2VzXG4gICAgICAgICAgICBpZiAoZW50aXR5LmludGVyZmFjZXMpIHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0SW50ZXJmYWNlcyA9IHRoaXMuX2J1aWxkSW50ZXJmYWNlcyhlbnRpdHksIG1vZGVsTWV0YSwgc2hhcmVkQ29udGV4dCk7XG4gICAgICAgICAgICAgICAgLy9jb25zb2xlLmxvZyhhc3RJbnRlcmZhY2VzKTtcbiAgICAgICAgICAgICAgICAvL2xldCBhc3RDbGFzcyA9IGFzdENsYXNzTWFpblthc3RDbGFzc01haW4ubGVuZ3RoIC0gMV07XG4gICAgICAgICAgICAgICAgLy9Kc0xhbmcuYXN0UHVzaEluQm9keShhc3RDbGFzcywgYXN0SW50ZXJmYWNlcyk7XG4gICAgICAgICAgICAgICAgYXN0Q2xhc3NNYWluID0gYXN0Q2xhc3NNYWluLmNvbmNhdChhc3RJbnRlcmZhY2VzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGltcG9ydExpbmVzID0gW107XG5cbiAgICAgICAgICAgIC8vZ2VuZXJhdGUgZnVuY3RvcnMgaWYgYW55XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzaGFyZWRDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSkpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihzaGFyZWRDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSwgKGZpbGVOYW1lLCBmdW5jdGlvbk5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0TGluZXMucHVzaChKc0xhbmcuYXN0VG9Db2RlKEpzTGFuZy5hc3RSZXF1aXJlKGZ1bmN0aW9uTmFtZSwgXCIuXCIgKyBmaWxlTmFtZSkpKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMpKSB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzLCAoZW50cnkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZShzY2hlbWEsIGVudHJ5KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIGxldCBtaXhpbnMgPSBbXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8ubWl4aW5zKSkge1xuICAgICAgICAgICAgICAgIGxldCBtaXhpbnNEaXJQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMub3V0cHV0UGF0aCwgc2NoZW1hLm5hbWUsICdtaXhpbnMnKTtcbiAgICAgICAgICAgICAgICBmcy5lbnN1cmVEaXJTeW5jKG1peGluc0RpclBhdGgpO1xuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8ubWl4aW5zLmZvckVhY2gobSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBtaXhpbk5hbWUgPSBwYXNjYWxDYXNlKG0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBtaXhpbkZpbGVQYXRoID0gcGF0aC5qb2luKG1peGluc0RpclBhdGgsIG1peGluTmFtZSArICcuanMnKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmcy5wYXRoRXhpc3RzU3luYyhtaXhpbkZpbGVQYXRoKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtaXhpbkZpbGVQYXRoLCBgY29uc3Qge1xuICAgIEVycm9yczogeyBWYWxpZGF0aW9uRXJyb3IsIERhdGFiYXNlRXJyb3IgfSxcbiAgICBQcm9jZXNzb3JzLFxuICAgIFZhbGlkYXRvcnNcbn0gPSByZXF1aXJlKFwiQGdlbngvZGF0YVwiKTtcbmNvbnN0IHsgXyB9ID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9ICR7Y2FwaXRhbGl6ZWR9ID0+IGNsYXNzIGV4dGVuZHMgJHtjYXBpdGFsaXplZH0ge1xuICAgIC8vdG9kbzogYWRkIHN0YWljIG1ldGhvZHNcbn07YCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgbWl4aW5WYXJOYW1lID0gJ21peGluJyArIG1peGluTmFtZTtcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0TGluZXMucHVzaChKc0xhbmcuYXN0VG9Db2RlKEpzTGFuZy5hc3RSZXF1aXJlKG1peGluVmFyTmFtZSwgJy4vbWl4aW5zLycgKyBtaXhpbk5hbWUpKSk7XG4gICAgICAgICAgICAgICAgICAgIG1peGlucy5wdXNoKG1peGluVmFyTmFtZSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgLy9hc3NlbWJsZSB0aGUgc291cmNlIGNvZGUgZmlsZVxuICAgICAgICAgICAgLy9Kc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIGFzdENsYXNzTWFpbik7XG5cbiAgICAgICAgICAgIC8vSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBlbnRpdHkuZmllbGRzLm1hcCgodiwgaykgPT4gSnNMYW5nLmFzdEFzc2lnbihjYXBpdGFsaXplZCArICcuRl8nICsgXy5zbmFrZUNhc2UoaykudG9VcHBlckNhc2UoKSwgaykpKTtcblxuICAgICAgICAgICAgbGV0IGxvY2FscyA9IHtcbiAgICAgICAgICAgICAgICBpbXBvcnRzOiBpbXBvcnRMaW5lcy5qb2luKFwiXFxuXCIpLFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZTogY2FwaXRhbGl6ZWQsXG4gICAgICAgICAgICAgICAgZW50aXR5TWV0YTogaW5kZW50TGluZXMoSlNPTi5zdHJpbmdpZnkobW9kZWxNZXRhLCBudWxsLCA0KSwgNCksXG4gICAgICAgICAgICAgICAgY2xhc3NCb2R5OiBpbmRlbnRMaW5lcyhhc3RDbGFzc01haW4ubWFwKChibG9jaykgPT4gSnNMYW5nLmFzdFRvQ29kZShibG9jaykpLmpvaW4oXCJcXG5cXG5cIiksIDgpLFxuICAgICAgICAgICAgICAgIGZ1bmN0b3JzOiBpbmRlbnRMaW5lcyhcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFRvQ29kZShcbiAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYWx1ZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBfLnJlZHVjZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChyZXN1bHQsIGZ1bmN0b3IpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlc3VsdFtcIiRcIiArIGZ1bmN0b3IuZnVuY3Rpb25OYW1lXSA9IEpzTGFuZy5hc3RJZChmdW5jdG9yLmZ1bmN0aW9uTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgNFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgLy9taXhpbnNcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGxldCBjbGFzc1RlbXBsYXRlID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCJkYXRhYmFzZVwiLCB0aGlzLmNvbm5lY3Rvci5kcml2ZXIsIFwiRW50aXR5TW9kZWwuanMuc3dpZ1wiKTtcbiAgICAgICAgICAgIGxldCBjbGFzc0NvZGUgPSBzd2lnLnJlbmRlckZpbGUoY2xhc3NUZW1wbGF0ZSwgbG9jYWxzKTtcblxuICAgICAgICAgICAgbGV0IG1vZGVsRmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBzY2hlbWEubmFtZSwgXCJiYXNlXCIsIGNhcGl0YWxpemVkICsgXCIuanNcIik7XG4gICAgICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgICAgIGZzLndyaXRlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCwgY2xhc3NDb2RlKTtcblxuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBcIkdlbmVyYXRlZCBlbnRpdHkgbW9kZWw6IFwiICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUVudGl0eUlucHV0U2NoZW1hKHNjaGVtYSkge1xuICAgICAgICAvL2dlbmVyYXRlIHZhbGlkYXRvciBjb25maWdcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlJbnN0YW5jZU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChlbnRpdHkuaW5wdXRzLCAoaW5wdXRzLCBpbnB1dFNldE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB2YWxpZGF0aW9uU2NoZW1hID0ge307XG4gICAgICAgICAgICAgICAgY29uc3QgZGVwZW5kZW5jaWVzID0gbmV3IFNldCgpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzdCA9IEpzTGFuZy5hc3RQcm9ncmFtKCk7XG5cbiAgICAgICAgICAgICAgICBpbnB1dHMuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgLy86YWRkcmVzc1xuICAgICAgICAgICAgICAgICAgICBpZiAoaW5wdXQubmFtZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYXNzb2MgPSBpbnB1dC5uYW1lLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGFzc29jTWV0YSA9IGVudGl0eS5hc3NvY2lhdGlvbnNbYXNzb2NdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQXNzb2NpYXRpb24gXCIke2Fzc29jfVwiIG5vdCBmb3VuZCBpbiBlbnRpdHkgWyR7ZW50aXR5SW5zdGFuY2VOYW1lfV0uYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaW5wdXQuc3BlYykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYElucHV0IFwic3BlY1wiIGlzIHJlcXVpcmVkIGZvciBlbnRpdHkgcmVmZXJlbmNlLiBJbnB1dCBzZXQ6ICR7aW5wdXRTZXROYW1lfSwgZW50aXR5OiAke2VudGl0eUluc3RhbmNlTmFtZX0sIGxvY2FsOiAke2Fzc29jfSwgcmVmZXJlbmNlZEVudGl0eTogJHthc3NvY01ldGEuZW50aXR5fWBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkZXAgPSBgJHthc3NvY01ldGEuZW50aXR5fS0ke2lucHV0LnNwZWN9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlcGVuZGVuY2llcy5hZGQoZGVwKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jTWV0YS5saXN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtpbnB1dC5uYW1lXSA9IEpzTGFuZy5hc3RWYWx1ZSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiYXJyYXlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZWxlbWVudFNjaGVtYToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNjaGVtYTogSnNMYW5nLmFzdENhbGwoXy5jYW1lbENhc2UoZGVwKSwgW10pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5fLnBpY2soaW5wdXQsIFtcIm9wdGlvbmFsXCJdKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtpbnB1dC5uYW1lXSA9IEpzTGFuZy5hc3RWYWx1ZSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNjaGVtYTogSnNMYW5nLmFzdENhbGwoXy5jYW1lbENhc2UoZGVwKSwgW10pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5fLnBpY2soaW5wdXQsIFtcIm9wdGlvbmFsXCJdKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpZWxkID0gZW50aXR5LmZpZWxkc1tpbnB1dC5uYW1lXTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmllbGQgXCIke2lucHV0Lm5hbWV9XCIgbm90IGZvdW5kIGluIGVudGl0eSBbJHtlbnRpdHlJbnN0YW5jZU5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvblNjaGVtYVtpbnB1dC5uYW1lXSA9IEpzTGFuZy5hc3RWYWx1ZSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uXy5waWNrKGZpZWxkLCBbXCJ0eXBlXCIsIFwidmFsdWVzXCJdKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5fLnBpY2soaW5wdXQsIFtcIm9wdGlvbmFsXCJdKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUuZGlyKEpzTGFuZy5hc3RWYWx1ZSh2YWxpZGF0aW9uU2NoZW1hKSwge2RlcHRoOiAyMH0pO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgZXhwb3J0Qm9keSA9IEFycmF5LmZyb20oZGVwZW5kZW5jaWVzKS5tYXAoKGRlcCkgPT5cbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFJlcXVpcmUoXy5jYW1lbENhc2UoZGVwKSwgYC4vJHtkZXB9YClcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoXG4gICAgICAgICAgICAgICAgICAgIGFzdCxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoXCJtb2R1bGUuZXhwb3J0c1wiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RBbm9ueW1vdXNGdW5jdGlvbihbXSwgZXhwb3J0Qm9keS5jb25jYXQoSnNMYW5nLmFzdFJldHVybih2YWxpZGF0aW9uU2NoZW1hKSkpXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGlucHV0U2NoZW1hRmlsZVBhdGggPSBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMub3V0cHV0UGF0aCxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwiaW5wdXRzXCIsXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eUluc3RhbmNlTmFtZSArIFwiLVwiICsgaW5wdXRTZXROYW1lICsgXCIuanNcIlxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoaW5wdXRTY2hlbWFGaWxlUGF0aCk7XG4gICAgICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhpbnB1dFNjaGVtYUZpbGVQYXRoLCBKc0xhbmcuYXN0VG9Db2RlKGFzdCkpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBcIkdlbmVyYXRlZCBlbnRpdHkgaW5wdXQgc2NoZW1hOiBcIiArIGlucHV0U2NoZW1hRmlsZVBhdGgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIF9nZW5lcmF0ZUVudGl0eU1hbmlmZXN0KHNjaGVtYSkge1xuICAgICAgICBsZXQgZW50aXRpZXMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZW50aXRpZXMpXG4gICAgICAgICAgICAuc29ydCgpXG4gICAgICAgICAgICAucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbdl0gPSB7fTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAvKlxuICAgICAgICBsZXQgbWFuaWZlc3QgPSB7fTtcblxuICAgICAgICBfLmVhY2goc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8ucmVzdGZ1bCkge1xuICAgICAgICAgICAgICAgIF8uZWFjaChlbnRpdHkuaW5mby5yZXN0ZnVsLCAoeyB0eXBlLCBtZXRob2RzIH0sIHJlbGF0aXZlVXJpKSA9PiB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGFwaUluZm8gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kczoge30gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0eXBlID09PSAnZW50aXR5Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5lbnRpdHkgPSBlbnRpdHlOYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5kaXNwbGF5TmFtZSA9IGVudGl0eS5kaXNwbGF5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGVudGl0eS5jb21tZW50KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5kZXNjcmlwdGlvbiA9IGVudGl0eS5jb21tZW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgXy5lYWNoKG1ldGhvZHMsIChtZXRhLCBtZXRob2ROYW1lKSA9PiB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAobWV0aG9kTmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwaUluZm8ubWV0aG9kc1sncG9zdDonICsgcmVsYXRpdmVVcmldID0gbWV0YTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2ZpbmRPbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZmluZUFsbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICd1cGRhdGVPbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAndXBkYXRlTWFueSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdkZWxldGVPbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZGVsZXRlTWFueSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuICAgICAgICAvKlxuICAgICAgICBsZXQgb3V0cHV0RmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5tYW5pZmVzdFBhdGgsIHNjaGVtYS5uYW1lICsgJy5tYW5pZmVzdC5qc29uJyk7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhvdXRwdXRGaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkoZW50aXRpZXMsIG51bGwsIDQpKTtcblxuICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIHNjaGVtYSBtYW5pZmVzdDogJyArIG91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgKi9cblxuICAgICAgICAvL2dlbmVyYXRlIHZhbGlkYXRvciBjb25maWdcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlJbnN0YW5jZU5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB2YWxpZGF0aW9uU2NoZW1hID0ge307XG5cbiAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5maWVsZHMsIChmaWVsZCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnJlYWRPbmx5KSByZXR1cm47XG5cbiAgICAgICAgICAgICAgICBsZXQgZmllbGRTY2hlbWEgPSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IGZpZWxkLnR5cGUsXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSBcImVudW1cIikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZFNjaGVtYS52YWx1ZXMgPSBmaWVsZC52YWx1ZXM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkU2NoZW1hLm9wdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2ZpZWxkTmFtZV0gPSBmaWVsZFNjaGVtYTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgZW50aXR5T3V0cHV0RmlsZVBhdGggPSBwYXRoLnJlc29sdmUoXG4gICAgICAgICAgICAgICAgdGhpcy5tYW5pZmVzdFBhdGgsXG4gICAgICAgICAgICAgICAgc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICAgICAgXCJ2YWxpZGF0aW9uXCIsXG4gICAgICAgICAgICAgICAgZW50aXR5SW5zdGFuY2VOYW1lICsgXCIubWFuaWZlc3QuanNvblwiXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZW50aXR5T3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhlbnRpdHlPdXRwdXRGaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkodmFsaWRhdGlvblNjaGVtYSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGVudGl0eSBtYW5pZmVzdDogXCIgKyBlbnRpdHlPdXRwdXRGaWxlUGF0aCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2dlbmVyYXRlVmlld01vZGVsKHNjaGVtYSwgZGJTZXJ2aWNlKSB7ICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oc2NoZW1hLnZpZXdzLCAodmlld0luZm8sIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci5pbmZvKCdCdWlsZGluZyB2aWV3OiAnICsgdmlld05hbWUpO1xuXG4gICAgICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBfLnVwcGVyRmlyc3Qodmlld05hbWUpO1xuXG4gICAgICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oKTtcblxuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZSgnTW93YScsICdtb3dhJykpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0VmFyRGVjbGFyZSgnVXRpbCcsIEpzTGFuZy5hc3RWYXJSZWYoJ01vd2EuVXRpbCcpLCB0cnVlKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RWYXJEZWNsYXJlKCdfJywgSnNMYW5nLmFzdFZhclJlZignVXRpbC5fJyksIHRydWUpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFJlcXVpcmUoJ1ZpZXcnLCAnbW93YS9saWIvb29sb25nL3J1bnRpbWUvdmlldycpKTtcblxuICAgICAgICAgICAgbGV0IGNvbXBpbGVDb250ZXh0ID0gT29sVG9Bc3QuY3JlYXRlQ29tcGlsZUNvbnRleHQodmlld05hbWUsIGRiU2VydmljZS5zZXJ2aWNlSWQsIHRoaXMubGlua2VyKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQubW9kZWxWYXJzLmFkZCh2aWV3SW5mby5lbnRpdHkpO1xuXG4gICAgICAgICAgICBsZXQgcGFyYW1NZXRhO1xuXG4gICAgICAgICAgICBpZiAodmlld0luZm8ucGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgcGFyYW1NZXRhID0gdGhpcy5fcHJvY2Vzc1BhcmFtcyh2aWV3SW5mby5wYXJhbXMsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHZpZXdNZXRhID0ge1xuICAgICAgICAgICAgICAgIGlzTGlzdDogdmlld0luZm8uaXNMaXN0LFxuICAgICAgICAgICAgICAgIHBhcmFtczogcGFyYW1NZXRhXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgdmlld0JvZHlUb3BvSWQgPSBPb2xUb0FzdC5jcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckdmlldycpO1xuICAgICAgICAgICAgT29sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdmlld0JvZHlUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgdmlld01vZGVsZXIgPSByZXF1aXJlKHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuL2Rhby92aWV3JywgZGJTZXJ2aWNlLmRiVHlwZSArICcuanMnKSk7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdmlld0JvZHlUb3BvSWRdID0gdmlld01vZGVsZXIoZGJTZXJ2aWNlLCB2aWV3TmFtZSwgdmlld0luZm8pO1xuICAgICAgICAgICAgT29sVG9Bc3QuYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB2aWV3Qm9keVRvcG9JZCwge1xuICAgICAgICAgICAgICAgIHR5cGU6IE9vbFRvQXN0LkFTVF9CTEtfVklFV19PUEVSQVRJT05cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBsZXQgcmV0dXJuVG9wb0lkID0gT29sVG9Bc3QuY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgICAgICAgICAgT29sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB2aWV3Qm9keVRvcG9JZCwgcmV0dXJuVG9wb0lkKTtcbiAgICAgICAgICAgIE9vbFRvQXN0LmNvbXBpbGVSZXR1cm4ocmV0dXJuVG9wb0lkLCB7XG4gICAgICAgICAgICAgICAgXCJvb2xUeXBlXCI6IFwiT2JqZWN0UmVmZXJlbmNlXCIsXG4gICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwidmlld0RhdGFcIlxuICAgICAgICAgICAgfSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgZGVwcyA9IGRlcHMuZmlsdGVyKGRlcCA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBuZWNlc3Nhcnkgc291cmNlIGNvZGU6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgbGV0IGFzdERvTG9hZE1haW4gPSBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoJyRtZXRhJywgSnNMYW5nLmFzdFZhclJlZigndGhpcy5tZXRhJyksIHRydWUsIGZhbHNlLCAnUmV0cmlldmluZyB0aGUgbWV0YSBkYXRhJylcbiAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgIF8uZWFjaChkZXBzLCBkZXAgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBhc3RNZXRhID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcblxuICAgICAgICAgICAgICAgIGxldCBhc3RCbG9jayA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdO1xuICAgICAgICAgICAgICAgIGFzc2VydDogYXN0QmxvY2ssICdFbXB0eSBhc3QgYmxvY2snO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzdE1ldGEudHlwZSA9PT0gJ01vZGlmaWVyQ2FsbCcpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkTmFtZSA9IGdldEZpZWxkTmFtZShhc3RNZXRhLnRhcmdldCk7XG4gICAgICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IEpzTGFuZy5hc3RBc3NpZ24oSnNMYW5nLmFzdFZhclJlZihhc3RNZXRhLnRhcmdldCksIGFzdEJsb2NrLCBgTW9kaWZ5aW5nICR7ZmllbGROYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICBhc3REb0xvYWRNYWluLnB1c2goYXN0Q2FjaGUpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXN0RG9Mb2FkTWFpbiA9IGFzdERvTG9hZE1haW4uY29uY2F0KF8uY2FzdEFycmF5KGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdKSk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSkge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSwgKGZpbGVOYW1lLCBmdW5jdGlvbk5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZShmdW5jdGlvbk5hbWUsICcuJyArIGZpbGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goY29tcGlsZUNvbnRleHQubmV3RnVuY3RvckZpbGVzLCBlbnRyeSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2dlbmVyYXRlRnVuY3Rpb25UZW1wbGF0ZUZpbGUoZGJTZXJ2aWNlLCBlbnRyeSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdENsYXNzRGVjbGFyZShjYXBpdGFsaXplZCwgJ1ZpZXcnLCBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdE1lbWJlck1ldGhvZCgnX2RvTG9hZCcsIE9iamVjdC5rZXlzKHBhcmFtTWV0YSksXG4gICAgICAgICAgICAgICAgICAgIGFzdERvTG9hZE1haW4sXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLCB0cnVlLCBmYWxzZSwgJ1BvcHVsYXRlIHZpZXcgZGF0YSdcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICBdLCBgJHtjYXBpdGFsaXplZH0gdmlld2ApKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbihjYXBpdGFsaXplZCArICcubWV0YScsIEpzTGFuZy5hc3RWYWx1ZSh2aWV3TWV0YSkpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbignbW9kdWxlLmV4cG9ydHMnLCBKc0xhbmcuYXN0VmFyUmVmKGNhcGl0YWxpemVkKSkpO1xuXG4gICAgICAgICAgICBsZXQgbW9kZWxGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIGRiU2VydmljZS5kYlR5cGUsIGRiU2VydmljZS5uYW1lLCAndmlld3MnLCB2aWV3TmFtZSArICcuanMnKTtcbiAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoICsgJy5qc29uJywgSlNPTi5zdHJpbmdpZnkoYXN0LCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIERhb01vZGVsZXIuX2V4cG9ydFNvdXJjZUNvZGUoYXN0LCBtb2RlbEZpbGVQYXRoKTtcblxuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCB2aWV3IG1vZGVsOiAnICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgKi9cblxuICAgIF9wcm9jZXNzRmllbGRNb2RpZmllcnMoZW50aXR5LCBzaGFyZWRDb250ZXh0KSB7XG4gICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IEdlbWxUb0FzdC5jcmVhdGVDb21waWxlQ29udGV4dChlbnRpdHkuZ2VtbE1vZHVsZS5uYW1lLCB0aGlzLmxpbmtlciwgc2hhcmVkQ29udGV4dCk7XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tcInJhd1wiXSA9IHsgc291cmNlOiBcImNvbnRleHRcIiwgZmluYWxpemVkOiB0cnVlIH07XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tcImkxOG5cIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIsIGZpbmFsaXplZDogdHJ1ZSB9O1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXCJjb25uZWN0b3JcIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIsIGZpbmFsaXplZDogdHJ1ZSB9O1xuICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXCJsYXRlc3RcIl0gPSB7IHNvdXJjZTogXCJjb250ZXh0XCIgfTtcblxuICAgICAgICBjb25zdCBhbGxGaW5pc2hlZCA9IEdlbWxUb0FzdC5jcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIFwiZG9uZS5cIik7XG5cbiAgICAgICAgLy9tYXAgb2YgZmllbGQgbmFtZSB0byBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGZpZWxkUmVmZXJlbmNlcyA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKGVudGl0eS5maWVsZHMsIChmaWVsZCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkID0gR2VtbFRvQXN0LmNvbXBpbGVGaWVsZChmaWVsZE5hbWUsIGZpZWxkLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBHZW1sVG9Bc3QuZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIGFsbEZpbmlzaGVkKTtcblxuICAgICAgICAgICAgaWYgKGZpZWxkLndyaXRlT25jZSB8fCBmaWVsZC5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICBwdXRJbnRvQnVja2V0KGZpZWxkUmVmZXJlbmNlcywgZmllbGROYW1lLCB7IHJlZmVyZW5jZTogZmllbGROYW1lLCB3cml0ZVByb3RlY3Q6IHRydWUgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBkZXBzID0gY29tcGlsZUNvbnRleHQudG9wb1NvcnQuc29ydCgpO1xuICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBkZXBlbmRlbmNpZXM6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICBkZXBzID0gZGVwcy5maWx0ZXIoKGRlcCkgPT4gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5oYXMoZGVwKSk7XG4gICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIG5lY2Vzc2FyeSBzb3VyY2UgY29kZTpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgIGxldCBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gW10sXG4gICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAsXG4gICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUgPSBbXSxcbiAgICAgICAgICAgIGxhc3RCbG9jayxcbiAgICAgICAgICAgIGxhc3RBc3RUeXBlOyAvLywgaGFzVmFsaWRhdG9yID0gZmFsc2U7XG5cbiAgICAgICAgY29uc3QgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlID0gZnVuY3Rpb24gKGZpZWxkTmFtZSwgcmVmZXJlbmNlcywgYXN0Q2FjaGUsIHJlcXVpcmVUYXJnZXRGaWVsZCkge1xuICAgICAgICAgICAgbGV0IGZpZWxkcyA9IFtmaWVsZE5hbWVdLmNvbmNhdChyZWZlcmVuY2VzKTtcbiAgICAgICAgICAgIGxldCBjaGVja2VyID0gZmllbGRzLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgICAgICBpZiAobGFzdEZpZWxkc0dyb3VwICYmIGxhc3RGaWVsZHNHcm91cC5jaGVja2VyICE9PSBjaGVja2VyKSB7XG4gICAgICAgICAgICAgICAgbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbCA9IG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwuY29uY2F0KFxuICAgICAgICAgICAgICAgICAgICBTbmlwcGV0cy5fZmllbGRSZXF1aXJlbWVudENoZWNrKFxuICAgICAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLmZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cC5yZWZlcmVuY2VzLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlLFxuICAgICAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlcXVpcmVUYXJnZXRGaWVsZFxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUgPSBbXTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlID0gbWV0aG9kQm9keUNhY2hlLmNvbmNhdChhc3RDYWNoZSk7XG4gICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAgPSB7XG4gICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgIHJlZmVyZW5jZXMsXG4gICAgICAgICAgICAgICAgcmVxdWlyZVRhcmdldEZpZWxkLFxuICAgICAgICAgICAgICAgIGNoZWNrZXIsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIoY29tcGlsZUNvbnRleHQuYXN0TWFwWydtb2JpbGV+aXNNb2JpbGVQaG9uZTphcmdbMV18PnN0cmluZ0Rhc2hlcml6ZSddLCB7IGRlcHRoOiA4IH0pO1xuXG4gICAgICAgIF8uZWFjaChkZXBzLCAoZGVwLCBpKSA9PiB7XG4gICAgICAgICAgICAvL2dldCBtZXRhZGF0YSBvZiBzb3VyY2UgY29kZSBibG9ja1xuICAgICAgICAgICAgbGV0IHNvdXJjZU1hcCA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KGRlcCk7XG5cbiAgICAgICAgICAgIC8vZ2V0IHNvdXJjZSBjb2RlIGJsb2NrXG4gICAgICAgICAgICBsZXQgYXN0QmxvY2sgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXTtcblxuICAgICAgICAgICAgbGV0IHRhcmdldEZpZWxkTmFtZSA9IGdldEZpZWxkTmFtZShzb3VyY2VNYXAudGFyZ2V0KTtcblxuICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC5yZWZlcmVuY2VzICYmIHNvdXJjZU1hcC5yZWZlcmVuY2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRSZWZlcmVuY2UgPSBmaWVsZFJlZmVyZW5jZXNbdGFyZ2V0RmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICBpZiAoIWZpZWxkUmVmZXJlbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkUmVmZXJlbmNlc1t0YXJnZXRGaWVsZE5hbWVdID0gZmllbGRSZWZlcmVuY2UgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIHNvdXJjZU1hcC5yZWZlcmVuY2VzLmZvckVhY2goKHJlZikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRSZWZlcmVuY2UucHVzaCh7IHJlZmVyZW5jZTogcmVmLCB3aGVuTnVsbDogdHJ1ZSB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc291cmNlTWFwLnJlZmVyZW5jZXMuZm9yRWFjaCgocmVmKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRSZWZlcmVuY2UuaW5kZXhPZihyZWYpID09PSAtMSkgZmllbGRSZWZlcmVuY2UucHVzaChyZWYpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChsYXN0QmxvY2spIHtcbiAgICAgICAgICAgICAgICBhc3RCbG9jayA9IGNoYWluQ2FsbChsYXN0QmxvY2ssIGxhc3RBc3RUeXBlLCBhc3RCbG9jaywgc291cmNlTWFwLnR5cGUpO1xuICAgICAgICAgICAgICAgIGxhc3RCbG9jayA9IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGkgPCBkZXBzLmxlbmd0aCAtIDEpIHtcbiAgICAgICAgICAgICAgICBsZXQgbmV4dFR5cGUgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldChkZXBzW2kgKyAxXSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNDaGFpbmFibGUoc291cmNlTWFwLCBuZXh0VHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgbGFzdEJsb2NrID0gYXN0QmxvY2s7XG4gICAgICAgICAgICAgICAgICAgIGxhc3RBc3RUeXBlID0gc291cmNlTWFwLnR5cGU7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfVkFMSURBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAvL2hhc1ZhbGlkYXRvciA9IHRydWU7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhY2hlID0gU25pcHBldHMuX3ZhbGlkYXRlQ2hlY2sodGFyZ2V0RmllbGROYW1lLCBhc3RCbG9jayk7XG5cbiAgICAgICAgICAgICAgICBfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUodGFyZ2V0RmllbGROYW1lLCBzb3VyY2VNYXAucmVmZXJlbmNlcywgYXN0Q2FjaGUsIHRydWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBKc0xhbmcuYXN0QXNzaWduKFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLFxuICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgYFByb2Nlc3NpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgc291cmNlTWFwLnJlZmVyZW5jZXMsIGFzdENhY2hlLCB0cnVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhY2hlID0gU25pcHBldHMuX2NoZWNrQW5kQXNzaWduKFxuICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0LCB0cnVlKSxcbiAgICAgICAgICAgICAgICAgICAgYEFjdGl2YXRpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgc291cmNlTWFwLnJlZmVyZW5jZXMsIGFzdENhY2hlLCBmYWxzZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRvIGJlIGltcGxlbWVudGVkLlwiKTtcbiAgICAgICAgICAgICAgICAvL2FzdEJsb2NrID0gXy5jYXN0QXJyYXkoYXN0QmxvY2spO1xuICAgICAgICAgICAgICAgIC8vX21lcmdlRG9WYWxpZGF0ZUFuZEZpbGxDb2RlKHRhcmdldEZpZWxkTmFtZSwgW10sIGFzdEJsb2NrKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgLyogQ2hhbmdlZCB0byB0aHJvdyBlcnJvciBpbnN0ZWFkIG9mIHJldHVybmluZyBhIGVycm9yIG9iamVjdFxuICAgICAgICBpZiAoaGFzVmFsaWRhdG9yKSB7XG4gICAgICAgICAgICBsZXQgZGVjbGFyZSA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhbGlkU3RhdGVOYW1lLCBmYWxzZSk7XG4gICAgICAgICAgICBtZXRob2RCb2R5Q3JlYXRlLnVuc2hpZnQoZGVjbGFyZSk7XG4gICAgICAgICAgICBtZXRob2RCb2R5VXBkYXRlLnVuc2hpZnQoZGVjbGFyZSk7XG4gICAgICAgIH1cbiAgICAgICAgKi9cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShtZXRob2RCb2R5Q2FjaGUpKSB7XG4gICAgICAgICAgICBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbC5jb25jYXQoXG4gICAgICAgICAgICAgICAgU25pcHBldHMuX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayhcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLmZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlZmVyZW5jZXMsXG4gICAgICAgICAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSxcbiAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlcXVpcmVUYXJnZXRGaWVsZFxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvKlxuICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oZmFsc2UpO1xuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RDbGFzc0RlY2xhcmUoJ0FiYycsICdNb2RlbCcsIFtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoYXN5bmNNZXRob2ROYW1pbmcoJ3ByZXBhcmVFbnRpdHlEYXRhXycpLCBbICdjb250ZXh0JyBdLFxuICAgICAgICAgICAgU25pcHBldHMuX2RvVmFsaWRhdGVBbmRGaWxsSGVhZGVyLmNvbmNhdChtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsKS5jb25jYXQoWyBKc0xhbmcuYXN0UmV0dXJuKEpzTGFuZy5hc3RJZCgnY29udGV4dCcpKSBdKSxcbiAgICAgICAgICAgIGZhbHNlLCB0cnVlLCB0cnVlXG4gICAgICAgICldLCAnY29tbWVudCcpKTtcbiAgICAgICAgKi9cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYXN0OiBKc0xhbmcuYXN0TWVtYmVyTWV0aG9kKFxuICAgICAgICAgICAgICAgIGFzeW5jTWV0aG9kTmFtaW5nKFwiYXBwbHlNb2RpZmllcnNcIiksXG4gICAgICAgICAgICAgICAgW1wiY29udGV4dFwiLCBcImlzVXBkYXRpbmdcIl0sXG4gICAgICAgICAgICAgICAgU25pcHBldHMuX2FwcGx5TW9kaWZpZXJzSGVhZGVyXG4gICAgICAgICAgICAgICAgICAgIC5jb25jYXQobWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbClcbiAgICAgICAgICAgICAgICAgICAgLmNvbmNhdChbSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoXCJjb250ZXh0XCIpKV0pLFxuICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICBcIkFwcGx5aW5nIHByZWRlZmluZWQgbW9kaWZpZXJzIHRvIGVudGl0eSBmaWVsZHMuXCJcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBmaWVsZFJlZmVyZW5jZXMsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRnVuY3Rpb25UZW1wbGF0ZUZpbGUoc2NoZW1hLCB7IGZ1bmN0aW9uTmFtZSwgZnVuY3RvclR5cGUsIGZpbGVOYW1lLCBhcmdzIH0pIHtcbiAgICAgICAgbGV0IGZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMub3V0cHV0UGF0aCwgc2NoZW1hLm5hbWUsIGZpbGVOYW1lKTtcblxuICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhmaWxlUGF0aCkpIHtcbiAgICAgICAgICAgIC8vdG9kbzogYW5hbHlzZSBjb2RlLCBjb21wYXJlIGFyZ3VtZW50c1xuICAgICAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBgJHtfLnVwcGVyRmlyc3QoZnVuY3RvclR5cGUpfSBcIiR7ZmlsZU5hbWV9XCIgZXhpc3RzLiBGaWxlIGdlbmVyYXRpbmcgc2tpcHBlZC5gKTtcblxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFzdCA9IEpzTGFuZy5hc3RQcm9ncmFtKCk7XG5cbiAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0RnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcmdzLCBPT0xfTU9ESUZJRVJfUkVUVVJOW2Z1bmN0b3JUeXBlXShhcmdzKSkpO1xuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RBc3NpZ24oXCJtb2R1bGUuZXhwb3J0c1wiLCBKc0xhbmcuYXN0VmFyUmVmKGZ1bmN0aW9uTmFtZSkpKTtcblxuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIEpzTGFuZy5hc3RUb0NvZGUoYXN0KSk7XG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgYEdlbmVyYXRlZCAke2Z1bmN0b3JUeXBlfSBmaWxlOiAke2ZpbGVQYXRofWApO1xuICAgIH1cblxuICAgIF9idWlsZEludGVyZmFjZXMoZW50aXR5LCBtb2RlbE1ldGFJbml0LCBzaGFyZWRDb250ZXh0KSB7XG4gICAgICAgIGxldCBhc3QgPSBbXTtcblxuICAgICAgICBfLmZvck93bihlbnRpdHkuaW50ZXJmYWNlcywgKG1ldGhvZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5saW5rZXIuaW5mbyhcIkJ1aWxkaW5nIGludGVyZmFjZTogXCIgKyBuYW1lKTtcblxuICAgICAgICAgICAgbGV0IGFzdEJvZHkgPSBbXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoXG4gICAgICAgICAgICAgICAgICAgIFwiJG1ldGFcIixcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihcInRoaXMubWV0YS5pbnRlcmZhY2VzLlwiICsgbmFtZSksXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBcIlJldHJpZXZpbmcgdGhlIG1ldGEgZGF0YVwiXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgIGxldCBjb21waWxlQ29udGV4dCA9IEdlbWxUb0FzdC5jcmVhdGVDb21waWxlQ29udGV4dChlbnRpdHkuZ2VtbE1vZHVsZS5uYW1lLCB0aGlzLmxpbmtlciwgc2hhcmVkQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCBwYXJhbU1ldGE7XG5cbiAgICAgICAgICAgIGlmIChtZXRob2QuYWNjZXB0KSB7XG4gICAgICAgICAgICAgICAgcGFyYW1NZXRhID0gdGhpcy5fcHJvY2Vzc1BhcmFtcyhtZXRob2QuYWNjZXB0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbWV0YWRhdGFcbiAgICAgICAgICAgIG1vZGVsTWV0YUluaXRbXCJpbnRlcmZhY2VzXCJdIHx8IChtb2RlbE1ldGFJbml0W1wiaW50ZXJmYWNlc1wiXSA9IHt9KTtcbiAgICAgICAgICAgIG1vZGVsTWV0YUluaXRbXCJpbnRlcmZhY2VzXCJdW25hbWVdID0geyBwYXJhbXM6IE9iamVjdC52YWx1ZXMocGFyYW1NZXRhKSB9O1xuXG4gICAgICAgICAgICBfLmVhY2gobWV0aG9kLmltcGxlbWVudGF0aW9uLCAob3BlcmF0aW9uLCBpbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgIC8vbGV0IGxhc3RUb3BvSWQgPVxuICAgICAgICAgICAgICAgIEdlbWxUb0FzdC5jb21waWxlRGJPcGVyYXRpb24oaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAobWV0aG9kLnJldHVybikge1xuICAgICAgICAgICAgICAgIEdlbWxUb0FzdC5jb21waWxlRXhjZXB0aW9uYWxSZXR1cm4obWV0aG9kLnJldHVybiwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZGVwcyA9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LnNvcnQoKTtcbiAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIGRlcGVuZGVuY2llczpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBkZXBzID0gZGVwcy5maWx0ZXIoKGRlcCkgPT4gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5oYXMoZGVwKSk7XG4gICAgICAgICAgICAvL3RoaXMubGlua2VyLnZlcmJvc2UoJ0FsbCBuZWNlc3Nhcnkgc291cmNlIGNvZGU6XFxuJyArIEpTT04uc3RyaW5naWZ5KGRlcHMsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgXy5lYWNoKGRlcHMsIChkZXApID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgc291cmNlTWFwID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0QmxvY2sgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbZGVwXTtcblxuICAgICAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQ29kZSBwb2ludCBcIicgKyBkZXAgKyAnXCI6XFxuJyArIEpTT04uc3RyaW5naWZ5KHNvdXJjZU1hcCwgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRhcmdldEZpZWxkTmFtZSA9IHNvdXJjZU1hcC50YXJnZXQ7IC8vZ2V0RmllbGROYW1lKHNvdXJjZU1hcC50YXJnZXQpO1xuXG4gICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19WQUxJREFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IFNuaXBwZXRzLl92YWxpZGF0ZUNoZWNrKHRhcmdldEZpZWxkTmFtZSwgYXN0QmxvY2spO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX1BST0NFU1NPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzb3VyY2VNYXAubmVlZERlY2xhcmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdFZhckRlY2xhcmUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gSnNMYW5nLmFzdEFzc2lnbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC5uZWVkRGVjbGFyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0QXNzaWduKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYEFjdGl2YXRpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3RCb2R5ID0gYXN0Qm9keS5jb25jYXQoXy5jYXN0QXJyYXkoYXN0QmxvY2spKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhc3QucHVzaChcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0TWVtYmVyTWV0aG9kKFxuICAgICAgICAgICAgICAgICAgICBhc3luY01ldGhvZE5hbWluZyhuYW1lKSxcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXMocGFyYW1NZXRhKSxcbiAgICAgICAgICAgICAgICAgICAgYXN0Qm9keSxcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlcGxhY2VBbGwoXy5rZWJhYkNhc2UobmFtZSksIFwiLVwiLCBcIiBcIilcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gYXN0O1xuICAgIH1cblxuICAgIF9wcm9jZXNzUGFyYW1zKGFjY2VwdFBhcmFtcywgY29tcGlsZUNvbnRleHQpIHtcbiAgICAgICAgbGV0IHBhcmFtTWV0YSA9IHt9O1xuXG4gICAgICAgIGFjY2VwdFBhcmFtcy5mb3JFYWNoKChwYXJhbSwgaSkgPT4ge1xuICAgICAgICAgICAgR2VtbFRvQXN0LmNvbXBpbGVQYXJhbShpLCBwYXJhbSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgcGFyYW1NZXRhW3BhcmFtLm5hbWVdID0gcGFyYW07XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcGFyYW0ubmFtZV0gPSB7IHNvdXJjZTogXCJhcmd1bWVudFwiIH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBwYXJhbU1ldGE7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IERhb01vZGVsZXI7XG4iXX0=