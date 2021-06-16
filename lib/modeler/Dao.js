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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9tb2RlbGVyL0Rhby5qcyJdLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsIl8iLCJmcyIsInBhc2NhbENhc2UiLCJyZXBsYWNlQWxsIiwicHV0SW50b0J1Y2tldCIsInN3aWciLCJHZW1sVHlwZXMiLCJKc0xhbmciLCJHZW1sVG9Bc3QiLCJTbmlwcGV0cyIsIkNoYWluYWJsZVR5cGUiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCIsIkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwiLCJnZXRGaWVsZE5hbWUiLCJ0Iiwic3BsaXQiLCJwb3AiLCJpc0NoYWluYWJsZSIsImN1cnJlbnQiLCJuZXh0IiwiaW5kZXhPZiIsInR5cGUiLCJ0YXJnZXQiLCJjaGFpbkNhbGwiLCJsYXN0QmxvY2siLCJsYXN0VHlwZSIsImN1cnJlbnRCbG9jayIsImN1cnJlbnRUeXBlIiwiYXN0QmluRXhwIiwiYXJndW1lbnRzIiwiYXN5bmNNZXRob2ROYW1pbmciLCJuYW1lIiwiaW5kZW50TGluZXMiLCJsaW5lcyIsImluZGVudGF0aW9uIiwibWFwIiwibGluZSIsImkiLCJyZXBlYXQiLCJqb2luIiwiT09MX01PRElGSUVSX1JFVFVSTiIsIk1vZGlmaWVyIiwiVkFMSURBVE9SIiwiYXN0UmV0dXJuIiwiUFJPQ0VTU09SIiwiYXJncyIsImFzdElkIiwiQUNUSVZBVE9SIiwiRGFvTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImxpbmtlciIsImNvbm5lY3RvciIsIm91dHB1dFBhdGgiLCJtb2RlbFBhdGgiLCJtYW5pZmVzdFBhdGgiLCJtb2RlbGluZ18iLCJzY2hlbWEiLCJsb2ciLCJfZ2VuZXJhdGVTY2hlbWFNb2RlbCIsIl9nZW5lcmF0ZUVudGl0eU1vZGVsIiwiX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEiLCJfZ2VuZXJhdGVFbnRpdHlNYW5pZmVzdCIsImNhcGl0YWxpemVkIiwibG9jYWxzIiwiZHJpdmVyIiwiY2xhc3NOYW1lIiwic2NoZW1hTmFtZSIsImVudGl0aWVzIiwiSlNPTiIsInN0cmluZ2lmeSIsIk9iamVjdCIsImtleXMiLCJjbGFzc1RlbXBsYXRlIiwicmVzb2x2ZSIsIl9fZGlybmFtZSIsImNsYXNzQ29kZSIsInJlbmRlckZpbGUiLCJtb2RlbEZpbGVQYXRoIiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiX2dlbmVyYXRlRW51bVR5cGVzIiwiZm9yT3duIiwiZW50aXR5IiwiZW50aXR5SW5zdGFuY2VOYW1lIiwiZmllbGRzIiwiZmllbGQiLCJmaWVsZE5hbWUiLCJzaGFyZWRDb250ZXh0IiwibWFwT2ZGdW5jdG9yVG9GaWxlIiwibmV3RnVuY3RvckZpbGVzIiwiYXN0IiwiYXN0Q2xhc3NNYWluIiwiZmllbGRSZWZlcmVuY2VzIiwiX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyIsInVuaXF1ZUtleXMiLCJjYXN0QXJyYXkiLCJrZXkiLCJpbmRleGVzIiwiZm9yRWFjaCIsImluZGV4IiwidW5pcXVlIiwicHVzaCIsIm1vZGVsTWV0YSIsImtleUZpZWxkIiwibWFwVmFsdWVzIiwiZiIsIm9taXQiLCJ0b0pTT04iLCJmZWF0dXJlcyIsImJhc2VDbGFzc2VzIiwiaXNFbXB0eSIsImFzc29jaWF0aW9ucyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaW50ZXJmYWNlcyIsImFzdEludGVyZmFjZXMiLCJfYnVpbGRJbnRlcmZhY2VzIiwiY29uY2F0IiwiaW1wb3J0TGluZXMiLCJmaWxlTmFtZSIsImZ1bmN0aW9uTmFtZSIsImFzdFRvQ29kZSIsImFzdFJlcXVpcmUiLCJlYWNoIiwiZW50cnkiLCJfZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZSIsImltcG9ydHMiLCJlbnRpdHlNZXRhIiwiY2xhc3NCb2R5IiwiYmxvY2siLCJmdW5jdG9ycyIsImFzdFZhbHVlIiwicmVkdWNlIiwicmVzdWx0IiwiZnVuY3RvciIsImlucHV0cyIsImlucHV0U2V0TmFtZSIsInZhbGlkYXRpb25TY2hlbWEiLCJkZXBlbmRlbmNpZXMiLCJTZXQiLCJhc3RQcm9ncmFtIiwiaW5wdXQiLCJzdGFydHNXaXRoIiwiYXNzb2MiLCJzdWJzdHIiLCJhc3NvY01ldGEiLCJFcnJvciIsInNwZWMiLCJkZXAiLCJhZGQiLCJsaXN0IiwiZWxlbWVudFNjaGVtYSIsImFzdENhbGwiLCJjYW1lbENhc2UiLCJwaWNrIiwiZXhwb3J0Qm9keSIsIkFycmF5IiwiZnJvbSIsImFzdFB1c2hJbkJvZHkiLCJhc3RBc3NpZ24iLCJhc3RWYXJSZWYiLCJhc3RBbm9ueW1vdXNGdW5jdGlvbiIsImlucHV0U2NoZW1hRmlsZVBhdGgiLCJzb3J0IiwidiIsInJlYWRPbmx5IiwiZmllbGRTY2hlbWEiLCJ2YWx1ZXMiLCJvcHRpb25hbCIsImVudGl0eU91dHB1dEZpbGVQYXRoIiwiY29tcGlsZUNvbnRleHQiLCJjcmVhdGVDb21waWxlQ29udGV4dCIsImdlbWxNb2R1bGUiLCJ2YXJpYWJsZXMiLCJzb3VyY2UiLCJmaW5hbGl6ZWQiLCJhbGxGaW5pc2hlZCIsImNyZWF0ZVRvcG9JZCIsInRvcG9JZCIsImNvbXBpbGVGaWVsZCIsImRlcGVuZHNPbiIsIndyaXRlT25jZSIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsInJlZmVyZW5jZSIsIndyaXRlUHJvdGVjdCIsImRlcHMiLCJ0b3BvU29ydCIsImZpbHRlciIsIm1hcE9mVG9rZW5Ub01ldGEiLCJoYXMiLCJtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsIiwibGFzdEZpZWxkc0dyb3VwIiwibWV0aG9kQm9keUNhY2hlIiwibGFzdEFzdFR5cGUiLCJfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUiLCJyZWZlcmVuY2VzIiwiYXN0Q2FjaGUiLCJyZXF1aXJlVGFyZ2V0RmllbGQiLCJjaGVja2VyIiwiX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayIsInNvdXJjZU1hcCIsImdldCIsImFzdEJsb2NrIiwiYXN0TWFwIiwidGFyZ2V0RmllbGROYW1lIiwibGVuZ3RoIiwiZmllbGRSZWZlcmVuY2UiLCJyZWYiLCJ3aGVuTnVsbCIsInVuZGVmaW5lZCIsIm5leHRUeXBlIiwiX3ZhbGlkYXRlQ2hlY2siLCJfY2hlY2tBbmRBc3NpZ24iLCJhc3RNZW1iZXJNZXRob2QiLCJfYXBwbHlNb2RpZmllcnNIZWFkZXIiLCJmdW5jdG9yVHlwZSIsImZpbGVQYXRoIiwiZXhpc3RzU3luYyIsInVwcGVyRmlyc3QiLCJhc3RGdW5jdGlvbiIsIm1vZGVsTWV0YUluaXQiLCJtZXRob2QiLCJpbmZvIiwiYXN0Qm9keSIsImFzdFZhckRlY2xhcmUiLCJwYXJhbU1ldGEiLCJhY2NlcHQiLCJfcHJvY2Vzc1BhcmFtcyIsInBhcmFtcyIsImltcGxlbWVudGF0aW9uIiwib3BlcmF0aW9uIiwiY29tcGlsZURiT3BlcmF0aW9uIiwibWFpblN0YXJ0SWQiLCJyZXR1cm4iLCJjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4iLCJuZWVkRGVjbGFyZSIsImtlYmFiQ2FzZSIsImFjY2VwdFBhcmFtcyIsInBhcmFtIiwiY29tcGlsZVBhcmFtIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBLFVBQVQ7QUFBcUJDLEVBQUFBLFVBQXJCO0FBQWlDQyxFQUFBQTtBQUFqQyxJQUFtREwsT0FBTyxDQUFDLFVBQUQsQ0FBaEU7O0FBQ0EsTUFBTU0sSUFBSSxHQUFHTixPQUFPLENBQUMsZ0JBQUQsQ0FBcEI7O0FBRUEsTUFBTU8sU0FBUyxHQUFHUCxPQUFPLENBQUMsbUJBQUQsQ0FBekI7O0FBQ0EsTUFBTVEsTUFBTSxHQUFHUixPQUFPLENBQUMsZUFBRCxDQUF0Qjs7QUFDQSxNQUFNUyxTQUFTLEdBQUdULE9BQU8sQ0FBQyxxQkFBRCxDQUF6Qjs7QUFDQSxNQUFNVSxRQUFRLEdBQUdWLE9BQU8sQ0FBQyxnQkFBRCxDQUF4Qjs7QUFFQSxNQUFNVyxhQUFhLEdBQUcsQ0FDbEJG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aCA9IHJlcXVpcmUoXCJwYXRoXCIpO1xuY29uc3QgeyBfLCBmcywgcGFzY2FsQ2FzZSwgcmVwbGFjZUFsbCwgcHV0SW50b0J1Y2tldCB9ID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3Qgc3dpZyA9IHJlcXVpcmUoXCJzd2lnLXRlbXBsYXRlc1wiKTtcblxuY29uc3QgR2VtbFR5cGVzID0gcmVxdWlyZShcIi4uL2xhbmcvR2VtbFR5cGVzXCIpO1xuY29uc3QgSnNMYW5nID0gcmVxdWlyZShcIi4vdXRpbC9hc3QuanNcIik7XG5jb25zdCBHZW1sVG9Bc3QgPSByZXF1aXJlKFwiLi91dGlsL2dlbWxUb0FzdC5qc1wiKTtcbmNvbnN0IFNuaXBwZXRzID0gcmVxdWlyZShcIi4vZGFvL3NuaXBwZXRzXCIpO1xuXG5jb25zdCBDaGFpbmFibGVUeXBlID0gW1xuICAgIEdlbWxUb0FzdC5BU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIEdlbWxUb0FzdC5BU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIEdlbWxUb0FzdC5BU1RfQkxLX0FDVElWQVRPUl9DQUxMLFxuXTtcblxuY29uc3QgZ2V0RmllbGROYW1lID0gKHQpID0+IHQuc3BsaXQoXCIuXCIpLnBvcCgpO1xuY29uc3QgaXNDaGFpbmFibGUgPSAoY3VycmVudCwgbmV4dCkgPT5cbiAgICBDaGFpbmFibGVUeXBlLmluZGV4T2YoY3VycmVudC50eXBlKSA+IC0xICYmIGN1cnJlbnQudGFyZ2V0ID09PSBuZXh0LnRhcmdldCAmJiBuZXh0LnR5cGUgPT09IGN1cnJlbnQudHlwZTtcbmNvbnN0IGNoYWluQ2FsbCA9IChsYXN0QmxvY2ssIGxhc3RUeXBlLCBjdXJyZW50QmxvY2ssIGN1cnJlbnRUeXBlKSA9PiB7XG4gICAgaWYgKGxhc3RCbG9jaykge1xuICAgICAgICBpZiAobGFzdFR5cGUgPT09IFwiVmFsaWRhdG9yQ2FsbFwiKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IGN1cnJlbnRUeXBlID09PSBcIlZhbGlkYXRvckNhbGxcIiwgXCJVbmV4cGVjdGVkIGN1cnJlbnRUeXBlXCI7XG5cbiAgICAgICAgICAgIGN1cnJlbnRCbG9jayA9IEpzTGFuZy5hc3RCaW5FeHAobGFzdEJsb2NrLCBcIiYmXCIsIGN1cnJlbnRCbG9jayk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBhc3NlcnQ6IGN1cnJlbnRUeXBlID09PSBcIlByb2Nlc3NvckNhbGxcIiwgXCJVbmV4cGVjdGVkIGN1cnJlbnRUeXBlOiBcIiArIGN1cnJlbnRUeXBlICsgXCIgbGFzdDogXCIgKyBsYXN0VHlwZTtcblxuICAgICAgICAgICAgY3VycmVudEJsb2NrLmFyZ3VtZW50c1swXSA9IGxhc3RCbG9jaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjdXJyZW50QmxvY2s7XG59O1xuY29uc3QgYXN5bmNNZXRob2ROYW1pbmcgPSAobmFtZSkgPT4gbmFtZSArIFwiX1wiO1xuXG5jb25zdCBpbmRlbnRMaW5lcyA9IChsaW5lcywgaW5kZW50YXRpb24pID0+XG4gICAgbGluZXNcbiAgICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAgIC5tYXAoKGxpbmUsIGkpID0+IChpID09PSAwID8gbGluZSA6IF8ucmVwZWF0KFwiIFwiLCBpbmRlbnRhdGlvbikgKyBsaW5lKSlcbiAgICAgICAgLmpvaW4oXCJcXG5cIik7XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9SRVRVUk4gPSB7XG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAoKSA9PiBbSnNMYW5nLmFzdFJldHVybih0cnVlKV0sXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAoYXJncykgPT4gW0pzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKGFyZ3NbMF0pKV0sXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAoKSA9PiBbSnNMYW5nLmFzdFJldHVybihKc0xhbmcuYXN0SWQoXCJ1bmRlZmluZWRcIikpXSxcbn07XG5cbi8qKlxuICogT29sb25nIGRhdGFiYXNlIGFjY2VzcyBvYmplY3QgKERBTykgbW9kZWxlci5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBEYW9Nb2RlbGVyIHtcbiAgICAvKipcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7R2VtbExpbmtlcn0gY29udGV4dC5saW5rZXIgLSBHZW1sIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0Lm1vZGVsUGF0aCAtIEdlbmVyYXRlZCBtb2RlbCBvdXRwdXQgcGF0aFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0Lm1hbmlmZXN0UGF0aCAtIEVudGl0aWVzIG1hbmlmZXN0IG91dHB1dCBwYXRoXG4gICAgICogQHBhcmFtIHtDb25uZWN0b3J9IGNvbm5lY3RvclxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGxpbmtlciwgY29ubmVjdG9yKSB7XG4gICAgICAgIHRoaXMubGlua2VyID0gbGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0Lm1vZGVsUGF0aDtcbiAgICAgICAgdGhpcy5tYW5pZmVzdFBhdGggPSBjb250ZXh0Lm1hbmlmZXN0UGF0aDtcblxuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcbiAgICB9XG5cbiAgICBtb2RlbGluZ18oc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgJ0dlbmVyYXRpbmcgZW50aXR5IG1vZGVscyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgdGhpcy5fZ2VuZXJhdGVTY2hlbWFNb2RlbChzY2hlbWEpO1xuICAgICAgICB0aGlzLl9nZW5lcmF0ZUVudGl0eU1vZGVsKHNjaGVtYSk7XG4gICAgICAgIC8vdGhpcy5fZ2VuZXJhdGVFbnRpdHlFbnVtVHlwZXMoc2NoZW1hKTtcbiAgICAgICAgdGhpcy5fZ2VuZXJhdGVFbnRpdHlJbnB1dFNjaGVtYShzY2hlbWEpO1xuICAgICAgICAvL3RoaXMuX2dlbmVyYXRlRW51bVR5cGVzKHNjaGVtYSk7XG4gICAgICAgIC8vdGhpcy5fZ2VuZXJhdGVWaWV3TW9kZWwoKTtcblxuICAgICAgICBpZiAodGhpcy5tYW5pZmVzdFBhdGgpIHtcbiAgICAgICAgICAgIHRoaXMuX2dlbmVyYXRlRW50aXR5TWFuaWZlc3Qoc2NoZW1hKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9nZW5lcmF0ZVNjaGVtYU1vZGVsKHNjaGVtYSkge1xuICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBwYXNjYWxDYXNlKHNjaGVtYS5uYW1lKTtcblxuICAgICAgICBsZXQgbG9jYWxzID0ge1xuICAgICAgICAgICAgZHJpdmVyOiB0aGlzLmNvbm5lY3Rvci5kcml2ZXIsXG4gICAgICAgICAgICBjbGFzc05hbWU6IGNhcGl0YWxpemVkLFxuICAgICAgICAgICAgc2NoZW1hTmFtZTogc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICBlbnRpdGllczogSlNPTi5zdHJpbmdpZnkoT2JqZWN0LmtleXMoc2NoZW1hLmVudGl0aWVzKSksXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGNsYXNzVGVtcGxhdGUgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRhdGFiYXNlXCIsIHRoaXMuY29ubmVjdG9yLmRyaXZlciwgXCJEYXRhYmFzZS5qcy5zd2lnXCIpO1xuICAgICAgICBsZXQgY2xhc3NDb2RlID0gc3dpZy5yZW5kZXJGaWxlKGNsYXNzVGVtcGxhdGUsIGxvY2Fscyk7XG5cbiAgICAgICAgbGV0IG1vZGVsRmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBjYXBpdGFsaXplZCArIFwiLmpzXCIpO1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoLCBjbGFzc0NvZGUpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgXCJHZW5lcmF0ZWQgZGF0YWJhc2UgbW9kZWw6IFwiICsgbW9kZWxGaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW51bVR5cGVzKHNjaGVtYSkge1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZpZWxkcywgKGZpZWxkLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gXCJlbnVtXCIpIHtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5TW9kZWwoc2NoZW1hKSB7XG4gICAgICAgIF8uZm9yT3duKHNjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5SW5zdGFuY2VOYW1lKSA9PiB7XG4gICAgICAgICAgICBsZXQgY2FwaXRhbGl6ZWQgPSBwYXNjYWxDYXNlKGVudGl0eUluc3RhbmNlTmFtZSk7XG5cbiAgICAgICAgICAgIC8vc2hhcmVkIGluZm9ybWF0aW9uIHdpdGggbW9kZWwgQ1JVRCBhbmQgY3VzdG9taXplZCBpbnRlcmZhY2VzXG4gICAgICAgICAgICBsZXQgc2hhcmVkQ29udGV4dCA9IHtcbiAgICAgICAgICAgICAgICBtYXBPZkZ1bmN0b3JUb0ZpbGU6IHt9LFxuICAgICAgICAgICAgICAgIG5ld0Z1bmN0b3JGaWxlczogW10sXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICBsZXQgeyBhc3Q6IGFzdENsYXNzTWFpbiwgZmllbGRSZWZlcmVuY2VzIH0gPSB0aGlzLl9wcm9jZXNzRmllbGRNb2RpZmllcnMoZW50aXR5LCBzaGFyZWRDb250ZXh0KTtcbiAgICAgICAgICAgIGFzdENsYXNzTWFpbiA9IFthc3RDbGFzc01haW5dO1xuXG4gICAgICAgICAgICAvL3ByZXBhcmUgbWV0YSBkYXRhXG4gICAgICAgICAgICBsZXQgdW5pcXVlS2V5cyA9IFtfLmNhc3RBcnJheShlbnRpdHkua2V5KV07XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcykge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goKGluZGV4KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVuaXF1ZUtleXMucHVzaChpbmRleC5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBtb2RlbE1ldGEgPSB7XG4gICAgICAgICAgICAgICAgc2NoZW1hTmFtZTogc2NoZW1hLm5hbWUsXG4gICAgICAgICAgICAgICAgbmFtZTogZW50aXR5SW5zdGFuY2VOYW1lLFxuICAgICAgICAgICAgICAgIGtleUZpZWxkOiBlbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgIGZpZWxkczogXy5tYXBWYWx1ZXMoZW50aXR5LmZpZWxkcywgKGYpID0+IF8ub21pdChmLnRvSlNPTigpLCBcIm1vZGlmaWVyc1wiKSksXG4gICAgICAgICAgICAgICAgZmVhdHVyZXM6IGVudGl0eS5mZWF0dXJlcyB8fCB7fSxcbiAgICAgICAgICAgICAgICB1bmlxdWVLZXlzLFxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5iYXNlQ2xhc3Nlcykge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5iYXNlQ2xhc3NlcyA9IGVudGl0eS5iYXNlQ2xhc3NlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZGV4ZXMpKSB7XG4gICAgICAgICAgICAgICAgbW9kZWxNZXRhLmluZGV4ZXMgPSBlbnRpdHkuaW5kZXhlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmZlYXR1cmVzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5mZWF0dXJlcyA9IGVudGl0eS5mZWF0dXJlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBtb2RlbE1ldGEuYXNzb2NpYXRpb25zID0gZW50aXR5LmFzc29jaWF0aW9ucztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZmllbGRSZWZlcmVuY2VzKSkge1xuICAgICAgICAgICAgICAgIG1vZGVsTWV0YS5maWVsZERlcGVuZGVuY2llcyA9IGZpZWxkUmVmZXJlbmNlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9idWlsZCBjdXN0b21pemVkIGludGVyZmFjZXNcbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW50ZXJmYWNlcykge1xuICAgICAgICAgICAgICAgIGxldCBhc3RJbnRlcmZhY2VzID0gdGhpcy5fYnVpbGRJbnRlcmZhY2VzKGVudGl0eSwgbW9kZWxNZXRhLCBzaGFyZWRDb250ZXh0KTtcbiAgICAgICAgICAgICAgICAvL2NvbnNvbGUubG9nKGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgICAgIC8vbGV0IGFzdENsYXNzID0gYXN0Q2xhc3NNYWluW2FzdENsYXNzTWFpbi5sZW5ndGggLSAxXTtcbiAgICAgICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdENsYXNzLCBhc3RJbnRlcmZhY2VzKTtcbiAgICAgICAgICAgICAgICBhc3RDbGFzc01haW4gPSBhc3RDbGFzc01haW4uY29uY2F0KGFzdEludGVyZmFjZXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgaW1wb3J0TGluZXMgPSBbXTtcblxuICAgICAgICAgICAgLy9nZW5lcmF0ZSBmdW5jdG9ycyBpZiBhbnlcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSkge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlLCAoZmlsZU5hbWUsIGZ1bmN0aW9uTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpbXBvcnRMaW5lcy5wdXNoKEpzTGFuZy5hc3RUb0NvZGUoSnNMYW5nLmFzdFJlcXVpcmUoZnVuY3Rpb25OYW1lLCBcIi5cIiArIGZpbGVOYW1lKSkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykpIHtcbiAgICAgICAgICAgICAgICBfLmVhY2goc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMsIChlbnRyeSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9nZW5lcmF0ZUZ1bmN0aW9uVGVtcGxhdGVGaWxlKHNjaGVtYSwgZW50cnkpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgbGV0IG1peGlucyA9IFtdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5taXhpbnMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1peGluc0RpclBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBzY2hlbWEubmFtZSwgJ21peGlucycpO1xuICAgICAgICAgICAgICAgIGZzLmVuc3VyZURpclN5bmMobWl4aW5zRGlyUGF0aCk7XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5taXhpbnMuZm9yRWFjaChtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IG1peGluTmFtZSA9IHBhc2NhbENhc2UobSk7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IG1peGluRmlsZVBhdGggPSBwYXRoLmpvaW4obWl4aW5zRGlyUGF0aCwgbWl4aW5OYW1lICsgJy5qcycpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZzLnBhdGhFeGlzdHNTeW5jKG1peGluRmlsZVBhdGgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG1peGluRmlsZVBhdGgsIGBjb25zdCB7XG4gICAgRXJyb3JzOiB7IFZhbGlkYXRpb25FcnJvciwgRGF0YWJhc2VFcnJvciB9LFxuICAgIFByb2Nlc3NvcnMsXG4gICAgVmFsaWRhdG9yc1xufSA9IHJlcXVpcmUoXCJAZ2VueC9kYXRhXCIpO1xuY29uc3QgeyBfIH0gPSByZXF1aXJlKFwicmstdXRpbHNcIik7XG5cbm1vZHVsZS5leHBvcnRzID0gJHtjYXBpdGFsaXplZH0gPT4gY2xhc3MgZXh0ZW5kcyAke2NhcGl0YWxpemVkfSB7XG4gICAgLy90b2RvOiBhZGQgc3RhaWMgbWV0aG9kc1xufTtgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBtaXhpblZhck5hbWUgPSAnbWl4aW4nICsgbWl4aW5OYW1lO1xuICAgICAgICAgICAgICAgICAgICBpbXBvcnRMaW5lcy5wdXNoKEpzTGFuZy5hc3RUb0NvZGUoSnNMYW5nLmFzdFJlcXVpcmUobWl4aW5WYXJOYW1lLCAnLi9taXhpbnMvJyArIG1peGluTmFtZSkpKTtcbiAgICAgICAgICAgICAgICAgICAgbWl4aW5zLnB1c2gobWl4aW5WYXJOYW1lKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAvL2Fzc2VtYmxlIHRoZSBzb3VyY2UgY29kZSBmaWxlXG4gICAgICAgICAgICAvL0pzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgYXN0Q2xhc3NNYWluKTtcblxuICAgICAgICAgICAgLy9Kc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIGVudGl0eS5maWVsZHMubWFwKCh2LCBrKSA9PiBKc0xhbmcuYXN0QXNzaWduKGNhcGl0YWxpemVkICsgJy5GXycgKyBfLnNuYWtlQ2FzZShrKS50b1VwcGVyQ2FzZSgpLCBrKSkpO1xuXG4gICAgICAgICAgICBsZXQgbG9jYWxzID0ge1xuICAgICAgICAgICAgICAgIGltcG9ydHM6IGltcG9ydExpbmVzLmpvaW4oXCJcXG5cIiksXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lOiBjYXBpdGFsaXplZCxcbiAgICAgICAgICAgICAgICBlbnRpdHlNZXRhOiBpbmRlbnRMaW5lcyhKU09OLnN0cmluZ2lmeShtb2RlbE1ldGEsIG51bGwsIDQpLCA0KSxcbiAgICAgICAgICAgICAgICBjbGFzc0JvZHk6IGluZGVudExpbmVzKGFzdENsYXNzTWFpbi5tYXAoKGJsb2NrKSA9PiBKc0xhbmcuYXN0VG9Db2RlKGJsb2NrKSkuam9pbihcIlxcblxcblwiKSwgOCksXG4gICAgICAgICAgICAgICAgZnVuY3RvcnM6IGluZGVudExpbmVzKFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VG9Db2RlKFxuICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhbHVlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF8ucmVkdWNlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKHJlc3VsdCwgZnVuY3RvcikgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVzdWx0W1wiJFwiICsgZnVuY3Rvci5mdW5jdGlvbk5hbWVdID0gSnNMYW5nLmFzdElkKGZ1bmN0b3IuZnVuY3Rpb25OYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHt9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICA0XG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAvL21peGluc1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgbGV0IGNsYXNzVGVtcGxhdGUgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRhdGFiYXNlXCIsIHRoaXMuY29ubmVjdG9yLmRyaXZlciwgXCJFbnRpdHlNb2RlbC5qcy5zd2lnXCIpO1xuICAgICAgICAgICAgbGV0IGNsYXNzQ29kZSA9IHN3aWcucmVuZGVyRmlsZShjbGFzc1RlbXBsYXRlLCBsb2NhbHMpO1xuXG4gICAgICAgICAgICBsZXQgbW9kZWxGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm91dHB1dFBhdGgsIHNjaGVtYS5uYW1lLCBcImJhc2VcIiwgY2FwaXRhbGl6ZWQgKyBcIi5qc1wiKTtcbiAgICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGgpO1xuICAgICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhtb2RlbEZpbGVQYXRoLCBjbGFzc0NvZGUpO1xuXG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGVudGl0eSBtb2RlbDogXCIgKyBtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5SW5wdXRTY2hlbWEoc2NoZW1hKSB7XG4gICAgICAgIC8vZ2VuZXJhdGUgdmFsaWRhdG9yIGNvbmZpZ1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKGVudGl0eS5pbnB1dHMsIChpbnB1dHMsIGlucHV0U2V0TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHZhbGlkYXRpb25TY2hlbWEgPSB7fTtcbiAgICAgICAgICAgICAgICBjb25zdCBkZXBlbmRlbmNpZXMgPSBuZXcgU2V0KCk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oKTtcblxuICAgICAgICAgICAgICAgIGlucHV0cy5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAvLzphZGRyZXNzXG4gICAgICAgICAgICAgICAgICAgIGlmIChpbnB1dC5uYW1lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBhc3NvYyA9IGlucHV0Lm5hbWUuc3Vic3RyKDEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYXNzb2NNZXRhID0gZW50aXR5LmFzc29jaWF0aW9uc1thc3NvY107XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIgbm90IGZvdW5kIGluIGVudGl0eSBbJHtlbnRpdHlJbnN0YW5jZU5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpbnB1dC5zcGVjKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgSW5wdXQgXCJzcGVjXCIgaXMgcmVxdWlyZWQgZm9yIGVudGl0eSByZWZlcmVuY2UuIElucHV0IHNldDogJHtpbnB1dFNldE5hbWV9LCBlbnRpdHk6ICR7ZW50aXR5SW5zdGFuY2VOYW1lfSwgbG9jYWw6ICR7YXNzb2N9LCByZWZlcmVuY2VkRW50aXR5OiAke2Fzc29jTWV0YS5lbnRpdHl9YFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGRlcCA9IGAke2Fzc29jTWV0YS5lbnRpdHl9LSR7aW5wdXQuc3BlY31gO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVwZW5kZW5jaWVzLmFkZChkZXApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2lucHV0Lm5hbWVdID0gSnNMYW5nLmFzdFZhbHVlKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJhcnJheVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbGVtZW50U2NoZW1hOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2NoZW1hOiBKc0xhbmcuYXN0Q2FsbChfLmNhbWVsQ2FzZShkZXApLCBbXSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLl8ucGljayhpbnB1dCwgW1wib3B0aW9uYWxcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2lucHV0Lm5hbWVdID0gSnNMYW5nLmFzdFZhbHVlKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJvYmplY3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2NoZW1hOiBKc0xhbmcuYXN0Q2FsbChfLmNhbWVsQ2FzZShkZXApLCBbXSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLl8ucGljayhpbnB1dCwgW1wib3B0aW9uYWxcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmllbGQgPSBlbnRpdHkuZmllbGRzW2lucHV0Lm5hbWVdO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWVsZCBcIiR7aW5wdXQubmFtZX1cIiBub3QgZm91bmQgaW4gZW50aXR5IFske2VudGl0eUluc3RhbmNlTmFtZX1dLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uU2NoZW1hW2lucHV0Lm5hbWVdID0gSnNMYW5nLmFzdFZhbHVlKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5fLnBpY2soZmllbGQsIFtcInR5cGVcIiwgXCJ2YWx1ZXNcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLl8ucGljayhpbnB1dCwgW1wib3B0aW9uYWxcIl0pLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIC8vY29uc29sZS5kaXIoSnNMYW5nLmFzdFZhbHVlKHZhbGlkYXRpb25TY2hlbWEpLCB7ZGVwdGg6IDIwfSk7XG5cbiAgICAgICAgICAgICAgICBjb25zdCBleHBvcnRCb2R5ID0gQXJyYXkuZnJvbShkZXBlbmRlbmNpZXMpLm1hcCgoZGVwKSA9PlxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0UmVxdWlyZShfLmNhbWVsQ2FzZShkZXApLCBgLi8ke2RlcH1gKVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShcbiAgICAgICAgICAgICAgICAgICAgYXN0LFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QXNzaWduKFxuICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihcIm1vZHVsZS5leHBvcnRzXCIpLFxuICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdEFub255bW91c0Z1bmN0aW9uKFtdLCBleHBvcnRCb2R5LmNvbmNhdChKc0xhbmcuYXN0UmV0dXJuKHZhbGlkYXRpb25TY2hlbWEpKSlcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBsZXQgaW5wdXRTY2hlbWFGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZShcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5vdXRwdXRQYXRoLFxuICAgICAgICAgICAgICAgICAgICBzY2hlbWEubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJpbnB1dHNcIixcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5SW5zdGFuY2VOYW1lICsgXCItXCIgKyBpbnB1dFNldE5hbWUgKyBcIi5qc1wiXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhpbnB1dFNjaGVtYUZpbGVQYXRoKTtcbiAgICAgICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGlucHV0U2NoZW1hRmlsZVBhdGgsIEpzTGFuZy5hc3RUb0NvZGUoYXN0KSk7XG5cbiAgICAgICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIFwiR2VuZXJhdGVkIGVudGl0eSBpbnB1dCBzY2hlbWE6IFwiICsgaW5wdXRTY2hlbWFGaWxlUGF0aCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlRW50aXR5TWFuaWZlc3Qoc2NoZW1hKSB7XG4gICAgICAgIGxldCBlbnRpdGllcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5lbnRpdGllcylcbiAgICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgICAgIC5yZWR1Y2UoKHJlc3VsdCwgdikgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHt9O1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgIC8qXG4gICAgICAgIGxldCBtYW5pZmVzdCA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5yZXN0ZnVsKSB7XG4gICAgICAgICAgICAgICAgXy5lYWNoKGVudGl0eS5pbmZvLnJlc3RmdWwsICh7IHR5cGUsIG1ldGhvZHMgfSwgcmVsYXRpdmVVcmkpID0+IHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgYXBpSW5mbyA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBtZXRob2RzOiB7fSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdlbnRpdHknKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLmVudGl0eSA9IGVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLmRpc3BsYXlOYW1lID0gZW50aXR5LmRpc3BsYXlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZW50aXR5LmNvbW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcGlJbmZvLmRlc2NyaXB0aW9uID0gZW50aXR5LmNvbW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBfLmVhY2gobWV0aG9kcywgKG1ldGEsIG1ldGhvZE5hbWUpID0+IHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChtZXRob2ROYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnY3JlYXRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBpSW5mby5tZXRob2RzWydwb3N0OicgKyByZWxhdGl2ZVVyaV0gPSBtZXRhO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnZmluZE9uZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdmaW5lQWxsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZU9uZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICd1cGRhdGVNYW55JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ2RlbGV0ZU9uZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdkZWxldGVNYW55JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgICovXG4gICAgICAgIC8qXG4gICAgICAgIGxldCBvdXRwdXRGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZSh0aGlzLm1hbmlmZXN0UGF0aCwgc2NoZW1hLm5hbWUgKyAnLm1hbmlmZXN0Lmpzb24nKTtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMob3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG91dHB1dEZpbGVQYXRoLCBKU09OLnN0cmluZ2lmeShlbnRpdGllcywgbnVsbCwgNCkpO1xuXG4gICAgICAgIHRoaXMubGlua2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgc2NoZW1hIG1hbmlmZXN0OiAnICsgb3V0cHV0RmlsZVBhdGgpO1xuICAgICAgICAqL1xuXG4gICAgICAgIC8vZ2VuZXJhdGUgdmFsaWRhdG9yIGNvbmZpZ1xuICAgICAgICBfLmZvck93bihzY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eUluc3RhbmNlTmFtZSkgPT4ge1xuICAgICAgICAgICAgbGV0IHZhbGlkYXRpb25TY2hlbWEgPSB7fTtcblxuICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZpZWxkcywgKGZpZWxkLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGQucmVhZE9ubHkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBmaWVsZFNjaGVtYSA9IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogZmllbGQudHlwZSxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09IFwiZW51bVwiKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkU2NoZW1hLnZhbHVlcyA9IGZpZWxkLnZhbHVlcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGRTY2hlbWEub3B0aW9uYWwgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhbGlkYXRpb25TY2hlbWFbZmllbGROYW1lXSA9IGZpZWxkU2NoZW1hO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGxldCBlbnRpdHlPdXRwdXRGaWxlUGF0aCA9IHBhdGgucmVzb2x2ZShcbiAgICAgICAgICAgICAgICB0aGlzLm1hbmlmZXN0UGF0aCxcbiAgICAgICAgICAgICAgICBzY2hlbWEubmFtZSxcbiAgICAgICAgICAgICAgICBcInZhbGlkYXRpb25cIixcbiAgICAgICAgICAgICAgICBlbnRpdHlJbnN0YW5jZU5hbWUgKyBcIi5tYW5pZmVzdC5qc29uXCJcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhlbnRpdHlPdXRwdXRGaWxlUGF0aCk7XG4gICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGVudGl0eU91dHB1dEZpbGVQYXRoLCBKU09OLnN0cmluZ2lmeSh2YWxpZGF0aW9uU2NoZW1hLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIHRoaXMubGlua2VyLmxvZyhcImluZm9cIiwgXCJHZW5lcmF0ZWQgZW50aXR5IG1hbmlmZXN0OiBcIiArIGVudGl0eU91dHB1dEZpbGVQYXRoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLypcbiAgICBfZ2VuZXJhdGVWaWV3TW9kZWwoc2NoZW1hLCBkYlNlcnZpY2UpIHsgICAgICAgIFxuICAgICAgICBfLmZvck93bihzY2hlbWEudmlld3MsICh2aWV3SW5mbywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMubGlua2VyLmluZm8oJ0J1aWxkaW5nIHZpZXc6ICcgKyB2aWV3TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBjYXBpdGFsaXplZCA9IF8udXBwZXJGaXJzdCh2aWV3TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBhc3QgPSBKc0xhbmcuYXN0UHJvZ3JhbSgpO1xuXG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RSZXF1aXJlKCdNb3dhJywgJ21vd2EnKSk7XG4gICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RWYXJEZWNsYXJlKCdVdGlsJywgSnNMYW5nLmFzdFZhclJlZignTW93YS5VdGlsJyksIHRydWUpKTtcbiAgICAgICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdFZhckRlY2xhcmUoJ18nLCBKc0xhbmcuYXN0VmFyUmVmKCdVdGlsLl8nKSwgdHJ1ZSkpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0UmVxdWlyZSgnVmlldycsICdtb3dhL2xpYi9vb2xvbmcvcnVudGltZS92aWV3JykpO1xuXG4gICAgICAgICAgICBsZXQgY29tcGlsZUNvbnRleHQgPSBPb2xUb0FzdC5jcmVhdGVDb21waWxlQ29udGV4dCh2aWV3TmFtZSwgZGJTZXJ2aWNlLnNlcnZpY2VJZCwgdGhpcy5saW5rZXIpO1xuXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuYWRkKHZpZXdJbmZvLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGxldCBwYXJhbU1ldGE7XG5cbiAgICAgICAgICAgIGlmICh2aWV3SW5mby5wYXJhbXMpIHtcbiAgICAgICAgICAgICAgICBwYXJhbU1ldGEgPSB0aGlzLl9wcm9jZXNzUGFyYW1zKHZpZXdJbmZvLnBhcmFtcywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgdmlld01ldGEgPSB7XG4gICAgICAgICAgICAgICAgaXNMaXN0OiB2aWV3SW5mby5pc0xpc3QsXG4gICAgICAgICAgICAgICAgcGFyYW1zOiBwYXJhbU1ldGFcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGxldCB2aWV3Qm9keVRvcG9JZCA9IE9vbFRvQXN0LmNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyR2aWV3Jyk7XG4gICAgICAgICAgICBPb2xUb0FzdC5kZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkLCB2aWV3Qm9keVRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCB2aWV3TW9kZWxlciA9IHJlcXVpcmUocGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4vZGFvL3ZpZXcnLCBkYlNlcnZpY2UuZGJUeXBlICsgJy5qcycpKTtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2aWV3Qm9keVRvcG9JZF0gPSB2aWV3TW9kZWxlcihkYlNlcnZpY2UsIHZpZXdOYW1lLCB2aWV3SW5mbyk7XG4gICAgICAgICAgICBPb2xUb0FzdC5hZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHZpZXdCb2R5VG9wb0lkLCB7XG4gICAgICAgICAgICAgICAgdHlwZTogT29sVG9Bc3QuQVNUX0JMS19WSUVXX09QRVJBVElPTlxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGxldCByZXR1cm5Ub3BvSWQgPSBPb2xUb0FzdC5jcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuOnZhbHVlJyk7XG4gICAgICAgICAgICBPb2xUb0FzdC5kZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHZpZXdCb2R5VG9wb0lkLCByZXR1cm5Ub3BvSWQpO1xuICAgICAgICAgICAgT29sVG9Bc3QuY29tcGlsZVJldHVybihyZXR1cm5Ub3BvSWQsIHtcbiAgICAgICAgICAgICAgICBcIm9vbFR5cGVcIjogXCJPYmplY3RSZWZlcmVuY2VcIixcbiAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJ2aWV3RGF0YVwiXG4gICAgICAgICAgICB9LCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCBkZXBzID0gY29tcGlsZUNvbnRleHQudG9wb1NvcnQuc29ydCgpO1xuICAgICAgICAgICAgdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIGRlcGVuZGVuY2llczpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBkZXBzID0gZGVwcy5maWx0ZXIoZGVwID0+IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuaGFzKGRlcCkpO1xuICAgICAgICAgICAgdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIG5lY2Vzc2FyeSBzb3VyY2UgY29kZTpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBsZXQgYXN0RG9Mb2FkTWFpbiA9IFtcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZSgnJG1ldGEnLCBKc0xhbmcuYXN0VmFyUmVmKCd0aGlzLm1ldGEnKSwgdHJ1ZSwgZmFsc2UsICdSZXRyaWV2aW5nIHRoZSBtZXRhIGRhdGEnKVxuICAgICAgICAgICAgXTtcblxuICAgICAgICAgICAgXy5lYWNoKGRlcHMsIGRlcCA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGFzdE1ldGEgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldChkZXApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFzdEJsb2NrID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW2RlcF07XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiBhc3RCbG9jaywgJ0VtcHR5IGFzdCBibG9jayc7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXN0TWV0YS50eXBlID09PSAnTW9kaWZpZXJDYWxsJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGROYW1lID0gZ2V0RmllbGROYW1lKGFzdE1ldGEudGFyZ2V0KTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGFzdENhY2hlID0gSnNMYW5nLmFzdEFzc2lnbihKc0xhbmcuYXN0VmFyUmVmKGFzdE1ldGEudGFyZ2V0KSwgYXN0QmxvY2ssIGBNb2RpZnlpbmcgJHtmaWVsZE5hbWV9YCk7XG4gICAgICAgICAgICAgICAgICAgIGFzdERvTG9hZE1haW4ucHVzaChhc3RDYWNoZSk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3REb0xvYWRNYWluID0gYXN0RG9Mb2FkTWFpbi5jb25jYXQoXy5jYXN0QXJyYXkoY29tcGlsZUNvbnRleHQuYXN0TWFwW2RlcF0pKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlLCAoZmlsZU5hbWUsIGZ1bmN0aW9uTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RSZXF1aXJlKGZ1bmN0aW9uTmFtZSwgJy4nICsgZmlsZU5hbWUpKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoY29tcGlsZUNvbnRleHQubmV3RnVuY3RvckZpbGVzKSkge1xuICAgICAgICAgICAgICAgIF8uZWFjaChjb21waWxlQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMsIGVudHJ5ID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZShkYlNlcnZpY2UsIGVudHJ5KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0Q2xhc3NEZWNsYXJlKGNhcGl0YWxpemVkLCAnVmlldycsIFtcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0TWVtYmVyTWV0aG9kKCdfZG9Mb2FkJywgT2JqZWN0LmtleXMocGFyYW1NZXRhKSxcbiAgICAgICAgICAgICAgICAgICAgYXN0RG9Mb2FkTWFpbixcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsIHRydWUsIGZhbHNlLCAnUG9wdWxhdGUgdmlldyBkYXRhJ1xuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgIF0sIGAke2NhcGl0YWxpemVkfSB2aWV3YCkpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0QXNzaWduKGNhcGl0YWxpemVkICsgJy5tZXRhJywgSnNMYW5nLmFzdFZhbHVlKHZpZXdNZXRhKSkpO1xuICAgICAgICAgICAgSnNMYW5nLmFzdFB1c2hJbkJvZHkoYXN0LCBKc0xhbmcuYXN0QXNzaWduKCdtb2R1bGUuZXhwb3J0cycsIEpzTGFuZy5hc3RWYXJSZWYoY2FwaXRhbGl6ZWQpKSk7XG5cbiAgICAgICAgICAgIGxldCBtb2RlbEZpbGVQYXRoID0gcGF0aC5yZXNvbHZlKHRoaXMub3V0cHV0UGF0aCwgZGJTZXJ2aWNlLmRiVHlwZSwgZGJTZXJ2aWNlLm5hbWUsICd2aWV3cycsIHZpZXdOYW1lICsgJy5qcycpO1xuICAgICAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMobW9kZWxGaWxlUGF0aCk7XG4gICAgICAgICAgICBmcy53cml0ZUZpbGVTeW5jKG1vZGVsRmlsZVBhdGggKyAnLmpzb24nLCBKU09OLnN0cmluZ2lmeShhc3QsIG51bGwsIDIpKTtcblxuICAgICAgICAgICAgRGFvTW9kZWxlci5fZXhwb3J0U291cmNlQ29kZShhc3QsIG1vZGVsRmlsZVBhdGgpO1xuXG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIHZpZXcgbW9kZWw6ICcgKyBtb2RlbEZpbGVQYXRoKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICAqL1xuXG4gICAgX3Byb2Nlc3NGaWVsZE1vZGlmaWVycyhlbnRpdHksIHNoYXJlZENvbnRleHQpIHtcbiAgICAgICAgbGV0IGNvbXBpbGVDb250ZXh0ID0gR2VtbFRvQXN0LmNyZWF0ZUNvbXBpbGVDb250ZXh0KGVudGl0eS5nZW1sTW9kdWxlLm5hbWUsIHRoaXMubGlua2VyLCBzaGFyZWRDb250ZXh0KTtcbiAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW1wicmF3XCJdID0geyBzb3VyY2U6IFwiY29udGV4dFwiLCBmaW5hbGl6ZWQ6IHRydWUgfTtcbiAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW1wiaTE4blwiXSA9IHsgc291cmNlOiBcImNvbnRleHRcIiwgZmluYWxpemVkOiB0cnVlIH07XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tcImNvbm5lY3RvclwiXSA9IHsgc291cmNlOiBcImNvbnRleHRcIiwgZmluYWxpemVkOiB0cnVlIH07XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tcImxhdGVzdFwiXSA9IHsgc291cmNlOiBcImNvbnRleHRcIiB9O1xuXG4gICAgICAgIGNvbnN0IGFsbEZpbmlzaGVkID0gR2VtbFRvQXN0LmNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgXCJkb25lLlwiKTtcblxuICAgICAgICAvL21hcCBvZiBmaWVsZCBuYW1lIHRvIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZmllbGRSZWZlcmVuY2VzID0ge307XG5cbiAgICAgICAgXy5mb3JPd24oZW50aXR5LmZpZWxkcywgKGZpZWxkLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGxldCB0b3BvSWQgPSBHZW1sVG9Bc3QuY29tcGlsZUZpZWxkKGZpZWxkTmFtZSwgZmllbGQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIEdlbWxUb0FzdC5kZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHRvcG9JZCwgYWxsRmluaXNoZWQpO1xuXG4gICAgICAgICAgICBpZiAoZmllbGQud3JpdGVPbmNlIHx8IGZpZWxkLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgIHB1dEludG9CdWNrZXQoZmllbGRSZWZlcmVuY2VzLCBmaWVsZE5hbWUsIHsgcmVmZXJlbmNlOiBmaWVsZE5hbWUsIHdyaXRlUHJvdGVjdDogdHJ1ZSB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IGRlcHMgPSBjb21waWxlQ29udGV4dC50b3BvU29ydC5zb3J0KCk7XG4gICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIGRlcGVuZGVuY2llczpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgIGRlcHMgPSBkZXBzLmZpbHRlcigoZGVwKSA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgbmVjZXNzYXJ5IHNvdXJjZSBjb2RlOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgbGV0IG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwgPSBbXSxcbiAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cCxcbiAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSA9IFtdLFxuICAgICAgICAgICAgbGFzdEJsb2NrLFxuICAgICAgICAgICAgbGFzdEFzdFR5cGU7IC8vLCBoYXNWYWxpZGF0b3IgPSBmYWxzZTtcblxuICAgICAgICBjb25zdCBfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUgPSBmdW5jdGlvbiAoZmllbGROYW1lLCByZWZlcmVuY2VzLCBhc3RDYWNoZSwgcmVxdWlyZVRhcmdldEZpZWxkKSB7XG4gICAgICAgICAgICBsZXQgZmllbGRzID0gW2ZpZWxkTmFtZV0uY29uY2F0KHJlZmVyZW5jZXMpO1xuICAgICAgICAgICAgbGV0IGNoZWNrZXIgPSBmaWVsZHMuam9pbihcIixcIik7XG5cbiAgICAgICAgICAgIGlmIChsYXN0RmllbGRzR3JvdXAgJiYgbGFzdEZpZWxkc0dyb3VwLmNoZWNrZXIgIT09IGNoZWNrZXIpIHtcbiAgICAgICAgICAgICAgICBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsID0gbWV0aG9kQm9keVZhbGlkYXRlQW5kRmlsbC5jb25jYXQoXG4gICAgICAgICAgICAgICAgICAgIFNuaXBwZXRzLl9maWVsZFJlcXVpcmVtZW50Q2hlY2soXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAuZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgbGFzdEZpZWxkc0dyb3VwLnJlZmVyZW5jZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAucmVxdWlyZVRhcmdldEZpZWxkXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIG1ldGhvZEJvZHlDYWNoZSA9IFtdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBtZXRob2RCb2R5Q2FjaGUgPSBtZXRob2RCb2R5Q2FjaGUuY29uY2F0KGFzdENhY2hlKTtcbiAgICAgICAgICAgIGxhc3RGaWVsZHNHcm91cCA9IHtcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgcmVmZXJlbmNlcyxcbiAgICAgICAgICAgICAgICByZXF1aXJlVGFyZ2V0RmllbGQsXG4gICAgICAgICAgICAgICAgY2hlY2tlcixcbiAgICAgICAgICAgIH07XG4gICAgICAgIH07XG5cbiAgICAgICAgLy9jb25zb2xlLmRpcihjb21waWxlQ29udGV4dC5hc3RNYXBbJ21vYmlsZX5pc01vYmlsZVBob25lOmFyZ1sxXXw+c3RyaW5nRGFzaGVyaXplJ10sIHsgZGVwdGg6IDggfSk7XG5cbiAgICAgICAgXy5lYWNoKGRlcHMsIChkZXAsIGkpID0+IHtcbiAgICAgICAgICAgIC8vZ2V0IG1ldGFkYXRhIG9mIHNvdXJjZSBjb2RlIGJsb2NrXG4gICAgICAgICAgICBsZXQgc291cmNlTWFwID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQoZGVwKTtcblxuICAgICAgICAgICAgLy9nZXQgc291cmNlIGNvZGUgYmxvY2tcbiAgICAgICAgICAgIGxldCBhc3RCbG9jayA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdO1xuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0RmllbGROYW1lID0gZ2V0RmllbGROYW1lKHNvdXJjZU1hcC50YXJnZXQpO1xuXG4gICAgICAgICAgICBpZiAoc291cmNlTWFwLnJlZmVyZW5jZXMgJiYgc291cmNlTWFwLnJlZmVyZW5jZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGxldCBmaWVsZFJlZmVyZW5jZSA9IGZpZWxkUmVmZXJlbmNlc1t0YXJnZXRGaWVsZE5hbWVdO1xuICAgICAgICAgICAgICAgIGlmICghZmllbGRSZWZlcmVuY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGRSZWZlcmVuY2VzW3RhcmdldEZpZWxkTmFtZV0gPSBmaWVsZFJlZmVyZW5jZSA9IFtdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAgICAgc291cmNlTWFwLnJlZmVyZW5jZXMuZm9yRWFjaCgocmVmKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZFJlZmVyZW5jZS5wdXNoKHsgcmVmZXJlbmNlOiByZWYsIHdoZW5OdWxsOiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzb3VyY2VNYXAucmVmZXJlbmNlcy5mb3JFYWNoKChyZWYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZFJlZmVyZW5jZS5pbmRleE9mKHJlZikgPT09IC0xKSBmaWVsZFJlZmVyZW5jZS5wdXNoKHJlZik7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGxhc3RCbG9jaykge1xuICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gY2hhaW5DYWxsKGxhc3RCbG9jaywgbGFzdEFzdFR5cGUsIGFzdEJsb2NrLCBzb3VyY2VNYXAudHlwZSk7XG4gICAgICAgICAgICAgICAgbGFzdEJsb2NrID0gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaSA8IGRlcHMubGVuZ3RoIC0gMSkge1xuICAgICAgICAgICAgICAgIGxldCBuZXh0VHlwZSA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KGRlcHNbaSArIDFdKTtcblxuICAgICAgICAgICAgICAgIGlmIChpc0NoYWluYWJsZShzb3VyY2VNYXAsIG5leHRUeXBlKSkge1xuICAgICAgICAgICAgICAgICAgICBsYXN0QmxvY2sgPSBhc3RCbG9jaztcbiAgICAgICAgICAgICAgICAgICAgbGFzdEFzdFR5cGUgPSBzb3VyY2VNYXAudHlwZTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19WQUxJREFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgIC8vaGFzVmFsaWRhdG9yID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBTbmlwcGV0cy5fdmFsaWRhdGVDaGVjayh0YXJnZXRGaWVsZE5hbWUsIGFzdEJsb2NrKTtcblxuICAgICAgICAgICAgICAgIF9tZXJnZURvVmFsaWRhdGVBbmRGaWxsQ29kZSh0YXJnZXRGaWVsZE5hbWUsIHNvdXJjZU1hcC5yZWZlcmVuY2VzLCBhc3RDYWNoZSwgdHJ1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYWNoZSA9IEpzTGFuZy5hc3RBc3NpZ24oXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksXG4gICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICBgUHJvY2Vzc2luZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUodGFyZ2V0RmllbGROYW1lLCBzb3VyY2VNYXAucmVmZXJlbmNlcywgYXN0Q2FjaGUsIHRydWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FjaGUgPSBTbmlwcGV0cy5fY2hlY2tBbmRBc3NpZ24oXG4gICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQsIHRydWUpLFxuICAgICAgICAgICAgICAgICAgICBgQWN0aXZhdGluZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBfbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUodGFyZ2V0RmllbGROYW1lLCBzb3VyY2VNYXAucmVmZXJlbmNlcywgYXN0Q2FjaGUsIGZhbHNlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVG8gYmUgaW1wbGVtZW50ZWQuXCIpO1xuICAgICAgICAgICAgICAgIC8vYXN0QmxvY2sgPSBfLmNhc3RBcnJheShhc3RCbG9jayk7XG4gICAgICAgICAgICAgICAgLy9fbWVyZ2VEb1ZhbGlkYXRlQW5kRmlsbENvZGUodGFyZ2V0RmllbGROYW1lLCBbXSwgYXN0QmxvY2spO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvKiBDaGFuZ2VkIHRvIHRocm93IGVycm9yIGluc3RlYWQgb2YgcmV0dXJuaW5nIGEgZXJyb3Igb2JqZWN0XG4gICAgICAgIGlmIChoYXNWYWxpZGF0b3IpIHtcbiAgICAgICAgICAgIGxldCBkZWNsYXJlID0gSnNMYW5nLmFzdFZhckRlY2xhcmUodmFsaWRTdGF0ZU5hbWUsIGZhbHNlKTtcbiAgICAgICAgICAgIG1ldGhvZEJvZHlDcmVhdGUudW5zaGlmdChkZWNsYXJlKTtcbiAgICAgICAgICAgIG1ldGhvZEJvZHlVcGRhdGUudW5zaGlmdChkZWNsYXJlKTtcbiAgICAgICAgfVxuICAgICAgICAqL1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KG1ldGhvZEJvZHlDYWNoZSkpIHtcbiAgICAgICAgICAgIG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwgPSBtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsLmNvbmNhdChcbiAgICAgICAgICAgICAgICBTbmlwcGV0cy5fZmllbGRSZXF1aXJlbWVudENoZWNrKFxuICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAuZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAucmVmZXJlbmNlcyxcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kQm9keUNhY2hlLFxuICAgICAgICAgICAgICAgICAgICBsYXN0RmllbGRzR3JvdXAucmVxdWlyZVRhcmdldEZpZWxkXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qXG4gICAgICAgIGxldCBhc3QgPSBKc0xhbmcuYXN0UHJvZ3JhbShmYWxzZSk7XG4gICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdENsYXNzRGVjbGFyZSgnQWJjJywgJ01vZGVsJywgW1xuICAgICAgICAgICAgSnNMYW5nLmFzdE1lbWJlck1ldGhvZChhc3luY01ldGhvZE5hbWluZygncHJlcGFyZUVudGl0eURhdGFfJyksIFsgJ2NvbnRleHQnIF0sXG4gICAgICAgICAgICBTbmlwcGV0cy5fZG9WYWxpZGF0ZUFuZEZpbGxIZWFkZXIuY29uY2F0KG1ldGhvZEJvZHlWYWxpZGF0ZUFuZEZpbGwpLmNvbmNhdChbIEpzTGFuZy5hc3RSZXR1cm4oSnNMYW5nLmFzdElkKCdjb250ZXh0JykpIF0pLFxuICAgICAgICAgICAgZmFsc2UsIHRydWUsIHRydWVcbiAgICAgICAgKV0sICdjb21tZW50JykpO1xuICAgICAgICAqL1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBhc3Q6IEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoXG4gICAgICAgICAgICAgICAgYXN5bmNNZXRob2ROYW1pbmcoXCJhcHBseU1vZGlmaWVyc1wiKSxcbiAgICAgICAgICAgICAgICBbXCJjb250ZXh0XCIsIFwiaXNVcGRhdGluZ1wiXSxcbiAgICAgICAgICAgICAgICBTbmlwcGV0cy5fYXBwbHlNb2RpZmllcnNIZWFkZXJcbiAgICAgICAgICAgICAgICAgICAgLmNvbmNhdChtZXRob2RCb2R5VmFsaWRhdGVBbmRGaWxsKVxuICAgICAgICAgICAgICAgICAgICAuY29uY2F0KFtKc0xhbmcuYXN0UmV0dXJuKEpzTGFuZy5hc3RJZChcImNvbnRleHRcIikpXSksXG4gICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgICAgIFwiQXBwbHlpbmcgcHJlZGVmaW5lZCBtb2RpZmllcnMgdG8gZW50aXR5IGZpZWxkcy5cIlxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGZpZWxkUmVmZXJlbmNlcyxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVGdW5jdGlvblRlbXBsYXRlRmlsZShzY2hlbWEsIHsgZnVuY3Rpb25OYW1lLCBmdW5jdG9yVHlwZSwgZmlsZU5hbWUsIGFyZ3MgfSkge1xuICAgICAgICBsZXQgZmlsZVBhdGggPSBwYXRoLnJlc29sdmUodGhpcy5vdXRwdXRQYXRoLCBzY2hlbWEubmFtZSwgZmlsZU5hbWUpO1xuXG4gICAgICAgIGlmIChmcy5leGlzdHNTeW5jKGZpbGVQYXRoKSkge1xuICAgICAgICAgICAgLy90b2RvOiBhbmFseXNlIGNvZGUsIGNvbXBhcmUgYXJndW1lbnRzXG4gICAgICAgICAgICB0aGlzLmxpbmtlci5sb2coXCJpbmZvXCIsIGAke18udXBwZXJGaXJzdChmdW5jdG9yVHlwZSl9IFwiJHtmaWxlTmFtZX1cIiBleGlzdHMuIEZpbGUgZ2VuZXJhdGluZyBza2lwcGVkLmApO1xuXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXN0ID0gSnNMYW5nLmFzdFByb2dyYW0oKTtcblxuICAgICAgICBKc0xhbmcuYXN0UHVzaEluQm9keShhc3QsIEpzTGFuZy5hc3RGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFyZ3MsIE9PTF9NT0RJRklFUl9SRVRVUk5bZnVuY3RvclR5cGVdKGFyZ3MpKSk7XG4gICAgICAgIEpzTGFuZy5hc3RQdXNoSW5Cb2R5KGFzdCwgSnNMYW5nLmFzdEFzc2lnbihcIm1vZHVsZS5leHBvcnRzXCIsIEpzTGFuZy5hc3RWYXJSZWYoZnVuY3Rpb25OYW1lKSkpO1xuXG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgSnNMYW5nLmFzdFRvQ29kZShhc3QpKTtcbiAgICAgICAgdGhpcy5saW5rZXIubG9nKFwiaW5mb1wiLCBgR2VuZXJhdGVkICR7ZnVuY3RvclR5cGV9IGZpbGU6ICR7ZmlsZVBhdGh9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkSW50ZXJmYWNlcyhlbnRpdHksIG1vZGVsTWV0YUluaXQsIHNoYXJlZENvbnRleHQpIHtcbiAgICAgICAgbGV0IGFzdCA9IFtdO1xuXG4gICAgICAgIF8uZm9yT3duKGVudGl0eS5pbnRlcmZhY2VzLCAobWV0aG9kLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmxpbmtlci5pbmZvKFwiQnVpbGRpbmcgaW50ZXJmYWNlOiBcIiArIG5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgYXN0Qm9keSA9IFtcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShcbiAgICAgICAgICAgICAgICAgICAgXCIkbWV0YVwiLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKFwidGhpcy5tZXRhLmludGVyZmFjZXMuXCIgKyBuYW1lKSxcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIFwiUmV0cmlldmluZyB0aGUgbWV0YSBkYXRhXCJcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgXTtcblxuICAgICAgICAgICAgbGV0IGNvbXBpbGVDb250ZXh0ID0gR2VtbFRvQXN0LmNyZWF0ZUNvbXBpbGVDb250ZXh0KGVudGl0eS5nZW1sTW9kdWxlLm5hbWUsIHRoaXMubGlua2VyLCBzaGFyZWRDb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHBhcmFtTWV0YTtcblxuICAgICAgICAgICAgaWYgKG1ldGhvZC5hY2NlcHQpIHtcbiAgICAgICAgICAgICAgICBwYXJhbU1ldGEgPSB0aGlzLl9wcm9jZXNzUGFyYW1zKG1ldGhvZC5hY2NlcHQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9tZXRhZGF0YVxuICAgICAgICAgICAgbW9kZWxNZXRhSW5pdFtcImludGVyZmFjZXNcIl0gfHwgKG1vZGVsTWV0YUluaXRbXCJpbnRlcmZhY2VzXCJdID0ge30pO1xuICAgICAgICAgICAgbW9kZWxNZXRhSW5pdFtcImludGVyZmFjZXNcIl1bbmFtZV0gPSB7IHBhcmFtczogT2JqZWN0LnZhbHVlcyhwYXJhbU1ldGEpIH07XG5cbiAgICAgICAgICAgIF8uZWFjaChtZXRob2QuaW1wbGVtZW50YXRpb24sIChvcGVyYXRpb24sIGluZGV4KSA9PiB7XG4gICAgICAgICAgICAgICAgLy9sZXQgbGFzdFRvcG9JZCA9XG4gICAgICAgICAgICAgICAgR2VtbFRvQXN0LmNvbXBpbGVEYk9wZXJhdGlvbihpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChtZXRob2QucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgR2VtbFRvQXN0LmNvbXBpbGVFeGNlcHRpb25hbFJldHVybihtZXRob2QucmV0dXJuLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBkZXBzID0gY29tcGlsZUNvbnRleHQudG9wb1NvcnQuc29ydCgpO1xuICAgICAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdBbGwgZGVwZW5kZW5jaWVzOlxcbicgKyBKU09OLnN0cmluZ2lmeShkZXBzLCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgIGRlcHMgPSBkZXBzLmZpbHRlcigoZGVwKSA9PiBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmhhcyhkZXApKTtcbiAgICAgICAgICAgIC8vdGhpcy5saW5rZXIudmVyYm9zZSgnQWxsIG5lY2Vzc2FyeSBzb3VyY2UgY29kZTpcXG4nICsgSlNPTi5zdHJpbmdpZnkoZGVwcywgbnVsbCwgMikpO1xuXG4gICAgICAgICAgICBfLmVhY2goZGVwcywgKGRlcCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBzb3VyY2VNYXAgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldChkZXApO1xuICAgICAgICAgICAgICAgIGxldCBhc3RCbG9jayA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtkZXBdO1xuXG4gICAgICAgICAgICAgICAgLy90aGlzLmxpbmtlci52ZXJib3NlKCdDb2RlIHBvaW50IFwiJyArIGRlcCArICdcIjpcXG4nICsgSlNPTi5zdHJpbmdpZnkoc291cmNlTWFwLCBudWxsLCAyKSk7XG5cbiAgICAgICAgICAgICAgICBsZXQgdGFyZ2V0RmllbGROYW1lID0gc291cmNlTWFwLnRhcmdldDsgLy9nZXRGaWVsZE5hbWUoc291cmNlTWFwLnRhcmdldCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoc291cmNlTWFwLnR5cGUgPT09IEdlbWxUb0FzdC5BU1RfQkxLX1ZBTElEQVRPUl9DQUxMKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrID0gU25pcHBldHMuX3ZhbGlkYXRlQ2hlY2sodGFyZ2V0RmllbGROYW1lLCBhc3RCbG9jayk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzb3VyY2VNYXAudHlwZSA9PT0gR2VtbFRvQXN0LkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNvdXJjZU1hcC5uZWVkRGVjbGFyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0VmFyUmVmKHNvdXJjZU1hcC50YXJnZXQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzdEJsb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBQcm9jZXNzaW5nIFwiJHt0YXJnZXRGaWVsZE5hbWV9XCJgXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2sgPSBKc0xhbmcuYXN0QXNzaWduKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCwgdHJ1ZSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb2Nlc3NpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNvdXJjZU1hcC50eXBlID09PSBHZW1sVG9Bc3QuQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc291cmNlTWFwLm5lZWREZWNsYXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RWYXJSZWYoc291cmNlTWFwLnRhcmdldCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXN0QmxvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYFByb2Nlc3NpbmcgXCIke3RhcmdldEZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayA9IEpzTGFuZy5hc3RBc3NpZ24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdFZhclJlZihzb3VyY2VNYXAudGFyZ2V0LCB0cnVlKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3RCbG9jayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBgQWN0aXZhdGluZyBcIiR7dGFyZ2V0RmllbGROYW1lfVwiYFxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzdEJvZHkgPSBhc3RCb2R5LmNvbmNhdChfLmNhc3RBcnJheShhc3RCbG9jaykpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFzdC5wdXNoKFxuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RNZW1iZXJNZXRob2QoXG4gICAgICAgICAgICAgICAgICAgIGFzeW5jTWV0aG9kTmFtaW5nKG5hbWUpLFxuICAgICAgICAgICAgICAgICAgICBPYmplY3Qua2V5cyhwYXJhbU1ldGEpLFxuICAgICAgICAgICAgICAgICAgICBhc3RCb2R5LFxuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVwbGFjZUFsbChfLmtlYmFiQ2FzZShuYW1lKSwgXCItXCIsIFwiIFwiKVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhc3Q7XG4gICAgfVxuXG4gICAgX3Byb2Nlc3NQYXJhbXMoYWNjZXB0UGFyYW1zLCBjb21waWxlQ29udGV4dCkge1xuICAgICAgICBsZXQgcGFyYW1NZXRhID0ge307XG5cbiAgICAgICAgYWNjZXB0UGFyYW1zLmZvckVhY2goKHBhcmFtLCBpKSA9PiB7XG4gICAgICAgICAgICBHZW1sVG9Bc3QuY29tcGlsZVBhcmFtKGksIHBhcmFtLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBwYXJhbU1ldGFbcGFyYW0ubmFtZV0gPSBwYXJhbTtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1twYXJhbS5uYW1lXSA9IHsgc291cmNlOiBcImFyZ3VtZW50XCIgfTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHBhcmFtTWV0YTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRGFvTW9kZWxlcjtcbiJdfQ==