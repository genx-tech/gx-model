"use strict";

require("source-map-support/register");

const path = require("path");

const {
  _,
  naming,
  text,
  putIntoBucket
} = require("@genx/july");

const {
  fs
} = require("@genx/sys");

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
      assert: currentType === "ValidatorCall", "Unexpected currentType";

      currentBlock = JsLang.astBinExp(lastBlock, "&&", currentBlock);
    } else {
      assert: currentType === "ProcessorCall", "Unexpected currentType: " + currentType + " last: " + lastType;

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
    let capitalized = naming.pascalCase(schema.name);
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
      let capitalized = naming.pascalCase(entityInstanceName);
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
    const diagram = {};

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

      diagram[entityInstanceName] = entity.toJSON();
      let entityOutputFilePath = path.resolve(this.manifestPath, schema.name, "validation", entityInstanceName + ".manifest.json");
      fs.ensureFileSync(entityOutputFilePath);
      fs.writeFileSync(entityOutputFilePath, JSON.stringify(validationSchema, null, 4));
      this.linker.log("info", "Generated entity manifest: " + entityOutputFilePath);
    });

    let diagramOutputFilePath = path.resolve(this.manifestPath, schema.name, "diagram.json");
    fs.ensureFileSync(diagramOutputFilePath);
    fs.writeFileSync(diagramOutputFilePath, JSON.stringify(diagram, null, 4));
    this.linker.log("info", "Generated schema manifest: " + diagramOutputFilePath);
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

      ast.push(JsLang.astMemberMethod(asyncMethodNaming(name), Object.keys(paramMeta), astBody, false, true, true, text.replaceAll(_.kebabCase(name), "-", " ")));
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
//# sourceMappingURL=Dao.js.map