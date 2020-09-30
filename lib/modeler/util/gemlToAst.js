"use strict";

require("source-map-support/register");

const {
  _
} = require('rk-utils');

const {
  TopoSort
} = require('@genx/algorithm');

const JsLang = require('./ast.js');

const GemlTypes = require('../../lang/GemlTypes');

const {
  isDotSeparateName,
  extractDotSeparateName,
  extractReferenceBaseName
} = require('../../lang/GemlUtils');

const {
  Types,
  Validators: OolongValidators,
  Processors: OolongProcessors,
  Activators: OolongActivators
} = require('@genx/data');

const defaultError = 'InvalidRequest';
const AST_BLK_FIELD_PRE_PROCESS = 'FieldPreProcess';
const AST_BLK_PARAM_SANITIZE = 'ParameterSanitize';
const AST_BLK_PROCESSOR_CALL = 'ProcessorCall';
const AST_BLK_VALIDATOR_CALL = 'ValidatorCall';
const AST_BLK_ACTIVATOR_CALL = 'ActivatorCall';
const AST_BLK_VIEW_OPERATION = 'ViewOperation';
const AST_BLK_VIEW_RETURN = 'ViewReturn';
const AST_BLK_INTERFACE_OPERATION = 'InterfaceOperation';
const AST_BLK_INTERFACE_RETURN = 'InterfaceReturn';
const AST_BLK_EXCEPTION_ITEM = 'ExceptionItem';
const OOL_MODIFIER_CODE_FLAG = {
  [GemlTypes.Modifier.VALIDATOR]: AST_BLK_VALIDATOR_CALL,
  [GemlTypes.Modifier.PROCESSOR]: AST_BLK_PROCESSOR_CALL,
  [GemlTypes.Modifier.ACTIVATOR]: AST_BLK_ACTIVATOR_CALL
};
const OOL_MODIFIER_OP = {
  [GemlTypes.Modifier.VALIDATOR]: '|~',
  [GemlTypes.Modifier.PROCESSOR]: '|>',
  [GemlTypes.Modifier.ACTIVATOR]: '|='
};
const OOL_MODIFIER_PATH = {
  [GemlTypes.Modifier.VALIDATOR]: 'validators',
  [GemlTypes.Modifier.PROCESSOR]: 'processors',
  [GemlTypes.Modifier.ACTIVATOR]: 'activators'
};
const OOL_MODIFIER_BUILTIN = {
  [GemlTypes.Modifier.VALIDATOR]: OolongValidators,
  [GemlTypes.Modifier.PROCESSOR]: OolongProcessors,
  [GemlTypes.Modifier.ACTIVATOR]: OolongActivators
};
const OPERATOR_TOKEN = {
  ">": "$gt",
  "<": "$lt",
  ">=": "$gte",
  "<=": "$lte",
  "==": "$eq",
  "!=": "$ne",
  "in": "$in",
  "notIn": "$nin"
};

function compileConditionalExpression(test, compileContext, startTopoId) {
  if (_.isPlainObject(test)) {
    if (test.oolType === 'ValidateExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$valiOp:done');
      let operandTopoId = createTopoId(compileContext, startTopoId + '$valiOp');
      dependsOn(compileContext, startTopoId, operandTopoId);
      let lastOperandTopoId = compileConcreteValueExpression(operandTopoId, test.caller, compileContext);
      dependsOn(compileContext, lastOperandTopoId, endTopoId);
      let astArgument = getCodeRepresentationOf(lastOperandTopoId, compileContext);
      let retTopoId = compileAdHocValidator(endTopoId, astArgument, test.callee, compileContext);

      if (!(retTopoId === endTopoId)) {
        throw new Error("Function \"compileConditionalExpression\" assertion failed: retTopoId === endTopoId");
      }

      return endTopoId;
    } else if (test.oolType === 'LogicalExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$lopOp:done');
      let op;

      switch (test.operator) {
        case 'and':
          op = '&&';
          break;

        case 'or':
          op = '||';
          break;

        default:
          throw new Error('Unsupported test operator: ' + test.operator);
      }

      let leftTopoId = createTopoId(compileContext, startTopoId + '$lopOp:left');
      let rightTopoId = createTopoId(compileContext, startTopoId + '$lopOp:right');
      dependsOn(compileContext, startTopoId, leftTopoId);
      dependsOn(compileContext, startTopoId, rightTopoId);
      let lastLeftId = compileConditionalExpression(test.left, compileContext, leftTopoId);
      let lastRightId = compileConditionalExpression(test.right, compileContext, rightTopoId);
      dependsOn(compileContext, lastLeftId, endTopoId);
      dependsOn(compileContext, lastRightId, endTopoId);
      compileContext.astMap[endTopoId] = JsLang.astBinExp(getCodeRepresentationOf(lastLeftId, compileContext), op, getCodeRepresentationOf(lastRightId, compileContext));
      return endTopoId;
    } else if (test.oolType === 'BinaryExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$binOp:done');
      let op;

      switch (test.operator) {
        case '>':
        case '<':
        case '>=':
        case '<=':
        case 'in':
          op = test.operator;
          break;

        case '==':
          op = '===';
          break;

        case '!=':
          op = '!==';
          break;

        default:
          throw new Error('Unsupported test operator: ' + test.operator);
      }

      let leftTopoId = createTopoId(compileContext, startTopoId + '$binOp:left');
      let rightTopoId = createTopoId(compileContext, startTopoId + '$binOp:right');
      dependsOn(compileContext, startTopoId, leftTopoId);
      dependsOn(compileContext, startTopoId, rightTopoId);
      let lastLeftId = compileConcreteValueExpression(leftTopoId, test.left, compileContext);
      let lastRightId = compileConcreteValueExpression(rightTopoId, test.right, compileContext);
      dependsOn(compileContext, lastLeftId, endTopoId);
      dependsOn(compileContext, lastRightId, endTopoId);
      compileContext.astMap[endTopoId] = JsLang.astBinExp(getCodeRepresentationOf(lastLeftId, compileContext), op, getCodeRepresentationOf(lastRightId, compileContext));
      return endTopoId;
    } else if (test.oolType === 'UnaryExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$unaOp:done');
      let operandTopoId = createTopoId(compileContext, startTopoId + '$unaOp');
      dependsOn(compileContext, startTopoId, operandTopoId);
      let lastOperandTopoId = test.operator === 'not' ? compileConcreteValueExpression(operandTopoId, test.argument, compileContext) : compileConditionalExpression(test.argument, compileContext, operandTopoId);
      dependsOn(compileContext, lastOperandTopoId, endTopoId);
      let astArgument = getCodeRepresentationOf(lastOperandTopoId, compileContext);

      switch (test.operator) {
        case 'exists':
          compileContext.astMap[endTopoId] = JsLang.astNot(JsLang.astCall('_.isEmpty', astArgument));
          break;

        case 'is-not-null':
          compileContext.astMap[endTopoId] = JsLang.astNot(JsLang.astCall('_.isNil', astArgument));
          break;

        case 'not-exists':
          compileContext.astMap[endTopoId] = JsLang.astCall('_.isEmpty', astArgument);
          break;

        case 'is-null':
          compileContext.astMap[endTopoId] = JsLang.astCall('_.isNil', astArgument);
          break;

        case 'not':
          compileContext.astMap[endTopoId] = JsLang.astNot(astArgument);
          break;

        default:
          throw new Error('Unsupported test operator: ' + test.operator);
      }

      return endTopoId;
    } else {
      let valueStartTopoId = createTopoId(compileContext, startTopoId + '$value');
      dependsOn(compileContext, startTopoId, valueStartTopoId);
      return compileConcreteValueExpression(valueStartTopoId, test, compileContext);
    }
  }

  compileContext.astMap[startTopoId] = JsLang.astValue(test);
  return startTopoId;
}

function compileAdHocValidator(topoId, value, functor, compileContext) {
  if (!(functor.oolType === GemlTypes.Modifier.VALIDATOR)) {
    throw new Error("Function \"compileAdHocValidator\" assertion failed: functor.oolType === GemlTypes.Modifier.VALIDATOR");
  }

  let callArgs;

  if (functor.args) {
    callArgs = translateArgs(topoId, functor.args, compileContext);
  } else {
    callArgs = [];
  }

  let arg0 = value;
  compileContext.astMap[topoId] = JsLang.astCall('Validators.' + functor.name, [arg0].concat(callArgs));
  return topoId;
}

function compileModifier(topoId, value, functor, compileContext) {
  let declareParams;

  if (functor.oolType === GemlTypes.Modifier.ACTIVATOR) {
    declareParams = translateFunctionParams([{
      name: compileContext.moduleName
    }, {
      name: 'context'
    }].concat(functor.args));
  } else {
    declareParams = translateFunctionParams(_.isEmpty(functor.args) ? [value] : [value].concat(functor.args));
  }

  let functorId = translateModifier(functor, compileContext, declareParams);
  let callArgs, references;

  if (functor.args) {
    callArgs = translateArgs(topoId, functor.args, compileContext);
    references = extractReferencedFields(functor.args);

    if (_.find(references, ref => ref === value.name)) {
      throw new Error('Cannot use the target field itself as an argument of a modifier.');
    }
  } else {
    callArgs = [];
  }

  if (functor.oolType === GemlTypes.Modifier.ACTIVATOR) {
    compileContext.astMap[topoId] = JsLang.astAwait(functorId, [JsLang.astVarRef('this'), JsLang.astVarRef('context')].concat(callArgs));
  } else {
    let arg0 = value;

    if (!isTopLevelBlock(topoId) && _.isPlainObject(value) && value.oolType === 'ObjectReference' && value.name.startsWith('latest.')) {
      arg0 = JsLang.astConditional(JsLang.astCall('latest.hasOwnProperty', [extractReferenceBaseName(value.name)]), value, replaceVarRefScope(value, 'existing'));
    }

    compileContext.astMap[topoId] = JsLang.astCall(functorId, [arg0].concat(callArgs));
  }

  if (isTopLevelBlock(topoId)) {
    let targetVarName = value.name;
    let needDeclare = false;

    if (!isDotSeparateName(value.name) && compileContext.variables[value.name] && functor.oolType !== GemlTypes.Modifier.VALIDATOR) {
      let counter = 1;

      do {
        counter++;
        targetVarName = value.name + counter.toString();
      } while (compileContext.variables.hasOwnProperty(targetVarName));

      compileContext.variables[targetVarName] = {
        type: 'localVariable',
        source: 'modifier'
      };
      needDeclare = true;
    }

    addCodeBlock(compileContext, topoId, {
      type: OOL_MODIFIER_CODE_FLAG[functor.oolType],
      target: targetVarName,
      references,
      needDeclare
    });
  }

  return topoId;
}

function extractReferencedFields(oolArgs) {
  oolArgs = _.castArray(oolArgs);
  let refs = [];
  oolArgs.forEach(a => {
    if (Array.isArray(a)) {
      refs = refs.concat(extractReferencedFields(a));
      return;
    }

    let result = checkReferenceToField(a);

    if (result) {
      refs.push(result);
    }
  });
  return refs;
}

function checkReferenceToField(obj) {
  if (_.isPlainObject(obj) && obj.oolType) {
    if (obj.oolType === 'PipedValue') return checkReferenceToField(obj.value);

    if (obj.oolType === 'ObjectReference') {
      return obj.name;
    }
  }

  return undefined;
}

function addModifierToMap(functorId, functorType, functorJsFile, mapOfFunctorToFile) {
  if (mapOfFunctorToFile[functorId] && mapOfFunctorToFile[functorId] !== functorJsFile) {
    throw new Error(`Conflict: ${functorType} naming "${functorId}" conflicts!`);
  }

  mapOfFunctorToFile[functorId] = functorJsFile;
}

function translateModifier(functor, compileContext, args) {
  let functionName, fileName, functorId;

  if (isDotSeparateName(functor.name)) {
    let names = extractDotSeparateName(functor.name);

    if (names.length > 2) {
      throw new Error('Not supported reference type: ' + functor.name);
    }

    let refEntityName = names[0];
    functionName = names[1];
    fileName = './' + OOL_MODIFIER_PATH[functor.oolType] + '/' + refEntityName + '-' + functionName + '.js';
    functorId = refEntityName + _.upperFirst(functionName);
    addModifierToMap(functorId, functor.oolType, fileName, compileContext.mapOfFunctorToFile);
  } else {
    functionName = functor.name;
    let builtins = OOL_MODIFIER_BUILTIN[functor.oolType];

    if (!(functionName in builtins)) {
      fileName = './' + OOL_MODIFIER_PATH[functor.oolType] + '/' + compileContext.moduleName + '-' + functionName + '.js';
      functorId = functionName;

      if (!compileContext.mapOfFunctorToFile[functorId]) {
        compileContext.newFunctorFiles.push({
          functionName,
          functorType: functor.oolType,
          fileName,
          args
        });
      }

      addModifierToMap(functorId, functor.oolType, fileName, compileContext.mapOfFunctorToFile);
    } else {
      functorId = functor.oolType + 's.' + functionName;
    }
  }

  return functorId;
}

function compilePipedValue(startTopoId, varOol, compileContext) {
  let lastTopoId = compileConcreteValueExpression(startTopoId, varOol.value, compileContext);
  varOol.modifiers.forEach(modifier => {
    let modifierStartTopoId = createTopoId(compileContext, startTopoId + OOL_MODIFIER_OP[modifier.oolType] + modifier.name);
    dependsOn(compileContext, lastTopoId, modifierStartTopoId);
    lastTopoId = compileModifier(modifierStartTopoId, varOol.value, modifier, compileContext);
  });
  return lastTopoId;
}

function compileVariableReference(startTopoId, varOol, compileContext) {
  if (!(_.isPlainObject(varOol) && varOol.oolType === 'ObjectReference')) {
    throw new Error("Function \"compileVariableReference\" precondition failed: _.isPlainObject(varOol) && varOol.oolType === 'ObjectReference'");
  }

  compileContext.astMap[startTopoId] = JsLang.astValue(varOol);
  return startTopoId;
}

function translateFunctionParams(args) {
  if (_.isEmpty(args)) return [];
  let names = new Set();

  function translateFunctionParam(arg, i) {
    if (_.isPlainObject(arg)) {
      if (arg.oolType === 'PipedValue') {
        return translateFunctionParam(arg.value);
      }

      if (arg.oolType === 'ObjectReference') {
        if (isDotSeparateName(arg.name)) {
          return extractDotSeparateName(arg.name).pop();
        }
      }

      return arg.name;
    }

    return 'param' + (i + 1).toString();
  }

  return _.map(args, (arg, i) => {
    let baseName = translateFunctionParam(arg, i);
    let name = baseName;
    let count = 2;

    while (names.has(name)) {
      name = baseName + count.toString();
      count++;
    }

    names.add(name);
    return name;
  });
}

function compileConcreteValueExpression(startTopoId, value, compileContext) {
  if (_.isPlainObject(value)) {
    if (value.oolType === 'PipedValue') {
      return compilePipedValue(startTopoId, value, compileContext);
    }

    if (value.oolType === 'ObjectReference') {
      let [refBase, ...rest] = extractDotSeparateName(value.name);
      let dependency;

      if (!compileContext.variables[refBase]) {
        throw new Error(`Referenced undefined variable: ${value.name}`);
      }

      if (compileContext.variables[refBase].type === 'entity' && !compileContext.variables[refBase].ongoing) {
        dependency = refBase;
      } else if (refBase === 'latest' && rest.length > 0) {
        let refFieldName = rest.pop();

        if (refFieldName !== startTopoId) {
          dependency = refFieldName + ':ready';
        }
      } else if (_.isEmpty(rest)) {
        dependency = refBase + ':ready';
      }

      if (dependency) {
        dependsOn(compileContext, dependency, startTopoId);
      }

      return compileVariableReference(startTopoId, value, compileContext);
    }

    if (value.oolType === 'RegExp') {
      compileContext.astMap[startTopoId] = JsLang.astValue(value);
      return startTopoId;
    }

    if (value.oorType === 'SymbolToken') {
      compileContext.astMap[startTopoId] = JsLang.astValue(translateSymbolToken(value.name));
      return startTopoId;
    }

    value = _.mapValues(value, (valueOfElement, key) => {
      let sid = createTopoId(compileContext, startTopoId + '.' + key);
      let eid = compileConcreteValueExpression(sid, valueOfElement, compileContext);

      if (sid !== eid) {
        dependsOn(compileContext, eid, startTopoId);
      }

      return compileContext.astMap[eid];
    });
  } else if (Array.isArray(value)) {
    value = _.map(value, (valueOfElement, index) => {
      let sid = createTopoId(compileContext, startTopoId + '[' + index + ']');
      let eid = compileConcreteValueExpression(sid, valueOfElement, compileContext);

      if (sid !== eid) {
        dependsOn(compileContext, eid, startTopoId);
      }

      return compileContext.astMap[eid];
    });
  }

  compileContext.astMap[startTopoId] = JsLang.astValue(value);
  return startTopoId;
}

function translateSymbolToken(name) {
  if (name === 'NOW') {
    return {
      "type": "CallExpression",
      "callee": {
        "type": "MemberExpression",
        "computed": false,
        "object": {
          "type": "MemberExpression",
          "computed": false,
          "object": {
            "type": "MemberExpression",
            "computed": false,
            "object": {
              "type": "Identifier",
              "name": "Types"
            },
            "property": {
              "type": "Identifier",
              "name": "DATETIME"
            }
          },
          "property": {
            "type": "Identifier",
            "name": "typeObject"
          }
        },
        "property": {
          "type": "Identifier",
          "name": "local"
        }
      },
      "arguments": []
    };
  }

  throw new Error('not support: ' + name);
}

function translateArgs(topoId, args, compileContext) {
  args = _.castArray(args);
  if (_.isEmpty(args)) return [];
  let callArgs = [];

  _.each(args, (arg, i) => {
    let argTopoId = createTopoId(compileContext, topoId + ':arg[' + (i + 1).toString() + ']');
    let lastTopoId = compileConcreteValueExpression(argTopoId, arg, compileContext);
    dependsOn(compileContext, lastTopoId, topoId);
    callArgs = callArgs.concat(_.castArray(getCodeRepresentationOf(lastTopoId, compileContext)));
  });

  return callArgs;
}

function compileParam(index, param, compileContext) {
  let type = param.type;
  let typeObject = Types[type];

  if (!typeObject) {
    throw new Error('Unknown field type: ' + type);
  }

  let sanitizerName = `Types.${type.toUpperCase()}.sanitize`;
  let varRef = JsLang.astVarRef(param.name);
  let callAst = JsLang.astCall(sanitizerName, [varRef, JsLang.astArrayAccess('$meta.params', index), JsLang.astVarRef('this.db.i18n')]);
  let prepareTopoId = createTopoId(compileContext, '$params:sanitize[' + index.toString() + ']');
  compileContext.astMap[prepareTopoId] = [JsLang.astAssign(varRef, callAst, `Sanitize argument "${param.name}"`)];
  addCodeBlock(compileContext, prepareTopoId, {
    type: AST_BLK_PARAM_SANITIZE
  });
  dependsOn(compileContext, prepareTopoId, compileContext.mainStartId);
  let topoId = createTopoId(compileContext, param.name);
  dependsOn(compileContext, compileContext.mainStartId, topoId);
  let value = wrapParamReference(param.name, param);
  let endTopoId = compileVariableReference(topoId, value, compileContext);
  let readyTopoId = createTopoId(compileContext, topoId + ':ready');
  dependsOn(compileContext, endTopoId, readyTopoId);
  return readyTopoId;
}

function compileField(paramName, param, compileContext) {
  let topoId = createTopoId(compileContext, paramName);
  let contextName = 'latest.' + paramName;
  let value = wrapParamReference(contextName, param);
  let endTopoId = compileConcreteValueExpression(topoId, value, compileContext);
  let readyTopoId = createTopoId(compileContext, topoId + ':ready');
  dependsOn(compileContext, endTopoId, readyTopoId);
  return readyTopoId;
}

function wrapParamReference(name, value) {
  let ref = Object.assign({
    oolType: 'ObjectReference',
    name: name
  });

  if (!_.isEmpty(value.modifiers)) {
    return {
      oolType: 'PipedValue',
      value: ref,
      modifiers: value.modifiers
    };
  }

  return ref;
}

function hasModelField(operand, compileContext) {
  if (_.isPlainObject(operand) && operand.oolType === 'ObjectReference') {
    let [baseVar, ...rest] = operand.name.split('.');
    return compileContext.variables[baseVar] && compileContext.variables[baseVar].ongoing && rest.length > 0;
  }

  return false;
}

function translateReturnThenAst(startId, endId, then, compileContext) {
  if (_.isPlainObject(then)) {
    if (then.oolType === 'ThrowExpression') {
      let args;

      if (then.args) {
        args = translateArgs(startId, then.args, compileContext);
      } else {
        args = [];
      }

      return JsLang.astThrow(then.errorType || defaultError, then.message || args);
    }

    if (then.oolType === 'ReturnExpression') {
      return translateReturnValueAst(startId, endId, then.value, compileContext);
    }
  }

  if (_.isArray(then) || _.isPlainObject(then)) {
    let valueEndId = compileConcreteValueExpression(startId, then, compileContext);
    then = compileContext.astMap[valueEndId];
  }

  return JsLang.astReturn(then);
}

function translateThenAst(startId, endId, then, compileContext, assignTo) {
  if (_.isPlainObject(then)) {
    if (then.oolType === 'ThrowExpression') {
      let args;

      if (then.args) {
        args = translateArgs(startId, then.args, compileContext);
      } else {
        args = [];
      }

      return JsLang.astThrow(then.errorType || defaultError, then.message || args);
    }

    if (then.oolType === 'LogicalExpression') {}

    if (then.oolType === 'BinaryExpression') {
      if (!hasModelField(then.left, compileContext)) {
        throw new Error('Invalid query condition: the left operand need to be an entity field.');
      }

      if (hasModelField(then.right, compileContext)) {
        throw new Error('Invalid query condition: the right operand should not be an entity field. Use dataset instead if joining is required.');
      }

      let condition = {};
      let startRightId = createTopoId(compileContext, startId + '$binOp:right');
      dependsOn(compileContext, startId, startRightId);
      let lastRightId = compileConcreteValueExpression(startRightId, then.right, compileContext);
      dependsOn(compileContext, lastRightId, endId);

      if (then.operator === '==') {
        condition[then.left.name.split('.', 2)[1]] = compileContext.astMap[lastRightId];
      } else {
        condition[then.left.name.split('.', 2)[1]] = {
          [OPERATOR_TOKEN[op]]: compileContext.astMap[lastRightId]
        };
      }

      return JsLang.astAssign(assignTo, JsLang.astValue(condition));
    }

    if (then.oolType === 'UnaryExpression') {}
  }

  if (_.isArray(then) || _.isPlainObject(then)) {
    let valueEndId = compileConcreteValueExpression(startId, then, compileContext);
    then = compileContext.astMap[valueEndId];
  }

  return JsLang.astAssign(assignTo, then);
}

function translateReturnValueAst(startTopoId, endTopoId, value, compileContext) {
  let valueTopoId = compileConcreteValueExpression(startTopoId, value, compileContext);

  if (valueTopoId !== startTopoId) {
    dependsOn(compileContext, valueTopoId, endTopoId);
  }

  return JsLang.astReturn(getCodeRepresentationOf(valueTopoId, compileContext));
}

function compileReturn(startTopoId, value, compileContext) {
  let endTopoId = createTopoId(compileContext, '$return');
  dependsOn(compileContext, startTopoId, endTopoId);
  compileContext.astMap[endTopoId] = translateReturnValueAst(startTopoId, endTopoId, value, compileContext);
  addCodeBlock(compileContext, endTopoId, {
    type: AST_BLK_VIEW_RETURN
  });
  return endTopoId;
}

function compileFindOne(index, operation, compileContext, dependency) {
  if (!dependency) {
    throw new Error("Function \"compileFindOne\" precondition failed: dependency");
  }

  let endTopoId = createTopoId(compileContext, 'op$' + index.toString());
  let conditionVarName = endTopoId + '$condition';
  let ast = [JsLang.astVarDeclare(conditionVarName)];

  if (!operation.condition) {
    throw new Error("Function \"compileFindOne\" assertion failed: operation.condition");
  }

  compileContext.variables[operation.model] = {
    type: 'entity',
    source: 'findOne',
    ongoing: true
  };

  if (operation.condition.oolType) {
    if (operation.condition.oolType === 'cases') {
      let topoIdPrefix = endTopoId + '$cases';
      let lastStatement;

      if (operation.condition.else) {
        let elseStart = createTopoId(compileContext, topoIdPrefix + ':else');
        let elseEnd = createTopoId(compileContext, topoIdPrefix + ':end');
        dependsOn(compileContext, elseStart, elseEnd);
        dependsOn(compileContext, elseEnd, endTopoId);
        lastStatement = translateThenAst(elseStart, elseEnd, operation.condition.else, compileContext, conditionVarName);
      } else {
        lastStatement = JsLang.astThrow('ServerError', 'Unexpected state.');
      }

      if (_.isEmpty(operation.condition.items)) {
        throw new Error('Missing case items');
      }

      _.reverse(operation.condition.items).forEach((item, i) => {
        if (item.oolType !== 'ConditionalStatement') {
          throw new Error('Invalid case item.');
        }

        i = operation.condition.items.length - i - 1;
        let casePrefix = topoIdPrefix + '[' + i.toString() + ']';
        let caseTopoId = createTopoId(compileContext, casePrefix);
        dependsOn(compileContext, dependency, caseTopoId);
        let caseResultVarName = '$' + topoIdPrefix + '_' + i.toString();
        let lastTopoId = compileConditionalExpression(item.test, compileContext, caseTopoId);
        let astCaseTtem = getCodeRepresentationOf(lastTopoId, compileContext);

        if (!!Array.isArray(astCaseTtem)) {
          throw new Error('Invalid case item ast.');
        }

        astCaseTtem = JsLang.astVarDeclare(caseResultVarName, astCaseTtem, true, false, `Condition ${i} for find one ${operation.model}`);
        let ifStart = createTopoId(compileContext, casePrefix + ':then');
        let ifEnd = createTopoId(compileContext, casePrefix + ':end');
        dependsOn(compileContext, lastTopoId, ifStart);
        dependsOn(compileContext, ifStart, ifEnd);
        lastStatement = [astCaseTtem, JsLang.astIf(JsLang.astVarRef(caseResultVarName), JsLang.astBlock(translateThenAst(ifStart, ifEnd, item.then, compileContext, conditionVarName)), lastStatement)];
        dependsOn(compileContext, ifEnd, endTopoId);
      });

      ast = ast.concat(_.castArray(lastStatement));
    } else {
      throw new Error('todo');
    }
  } else {
    throw new Error('todo');
  }

  ast.push(JsLang.astVarDeclare(operation.model, JsLang.astAwait(`this.findOne_`, JsLang.astVarRef(conditionVarName))));
  delete compileContext.variables[operation.model].ongoing;
  let modelTopoId = createTopoId(compileContext, operation.model);
  dependsOn(compileContext, endTopoId, modelTopoId);
  compileContext.astMap[endTopoId] = ast;
  return endTopoId;
}

function compileDbOperation(index, operation, compileContext, dependency) {
  let lastTopoId;

  switch (operation.oolType) {
    case 'FindOneStatement':
      lastTopoId = compileFindOne(index, operation, compileContext, dependency);
      break;

    case 'find':
      throw new Error('tbi');
      break;

    case 'update':
      throw new Error('tbi');
      break;

    case 'create':
      throw new Error('tbi');
      break;

    case 'delete':
      throw new Error('tbi');
      break;

    case 'DoStatement':
      let doBlock = operation.do;
      lastTopoId = compileDoStatement(index, doBlock, compileContext, dependency);
      break;

    case 'assignment':
      throw new Error('tbi');
      break;

    default:
      throw new Error('Unsupported operation type: ' + operation.type);
  }

  addCodeBlock(compileContext, lastTopoId, {
    type: AST_BLK_INTERFACE_OPERATION
  });
  return lastTopoId;
}

function compileDoStatement(index, operation, compileContext, dependency) {}

function compileExceptionalReturn(oolNode, compileContext, dependency) {
  if (!(_.isPlainObject(oolNode) && oolNode.oolType === 'ReturnExpression')) {
    throw new Error("Function \"compileExceptionalReturn\" precondition failed: _.isPlainObject(oolNode) && oolNode.oolType === 'ReturnExpression'");
  }

  let endTopoId = createTopoId(compileContext, '$return'),
      lastExceptionId = dependency;

  if (!_.isEmpty(oolNode.exceptions)) {
    oolNode.exceptions.forEach((item, i) => {
      if (_.isPlainObject(item)) {
        if (item.oolType !== 'ConditionalStatement') {
          throw new Error('Unsupported exceptional type: ' + item.oolType);
        }

        let exceptionStartId = createTopoId(compileContext, endTopoId + ':except[' + i.toString() + ']');
        let exceptionEndId = createTopoId(compileContext, endTopoId + ':except[' + i.toString() + ']:done');

        if (lastExceptionId) {
          dependsOn(compileContext, lastExceptionId, exceptionStartId);
        }

        let lastTopoId = compileConditionalExpression(item.test, compileContext, exceptionStartId);
        let thenStartId = createTopoId(compileContext, exceptionStartId + ':then');
        dependsOn(compileContext, lastTopoId, thenStartId);
        dependsOn(compileContext, thenStartId, exceptionEndId);
        compileContext.astMap[exceptionEndId] = JsLang.astIf(getCodeRepresentationOf(lastTopoId, compileContext), JsLang.astBlock(translateReturnThenAst(thenStartId, exceptionEndId, item.then, compileContext)), null, `Return on exception #${i}`);
        addCodeBlock(compileContext, exceptionEndId, {
          type: AST_BLK_EXCEPTION_ITEM
        });
        lastExceptionId = exceptionEndId;
      } else {
        throw new Error('Unexpected.');
      }
    });
  }

  dependsOn(compileContext, lastExceptionId, endTopoId);
  let returnStartTopoId = createTopoId(compileContext, '$return:value');
  dependsOn(compileContext, returnStartTopoId, endTopoId);
  compileContext.astMap[endTopoId] = translateReturnValueAst(returnStartTopoId, endTopoId, oolNode.value, compileContext);
  addCodeBlock(compileContext, endTopoId, {
    type: AST_BLK_INTERFACE_RETURN
  });
  return endTopoId;
}

function createTopoId(compileContext, name) {
  if (compileContext.topoNodes.has(name)) {
    throw new Error(`Topo id "${name}" already created.`);
  }

  if (!!compileContext.topoSort.hasDependency(name)) {
    throw new Error('Already in topoSort!');
  }

  compileContext.topoNodes.add(name);
  return name;
}

function dependsOn(compileContext, previousOp, currentOp) {
  if (!(previousOp !== currentOp)) {
    throw new Error('Self depending');
  }

  compileContext.linker.log('debug', currentOp + ' \x1b[33mdepends on\x1b[0m ' + previousOp);

  if (!compileContext.topoNodes.has(currentOp)) {
    throw new Error(`Topo id "${currentOp}" not created.`);
  }

  compileContext.topoSort.add(previousOp, currentOp);
}

function addCodeBlock(compileContext, topoId, blockMeta) {
  if (!(topoId in compileContext.astMap)) {
    throw new Error(`AST not found for block with topoId: ${topoId}`);
  }

  compileContext.mapOfTokenToMeta.set(topoId, blockMeta);
  compileContext.linker.log('verbose', `Adding ${blockMeta.type} "${topoId}" into source code.`);
}

function getCodeRepresentationOf(topoId, compileContext) {
  let lastSourceType = compileContext.mapOfTokenToMeta.get(topoId);

  if (lastSourceType && (lastSourceType.type === AST_BLK_PROCESSOR_CALL || lastSourceType.type === AST_BLK_ACTIVATOR_CALL)) {
    return JsLang.astVarRef(lastSourceType.target, true);
  }

  let ast = compileContext.astMap[topoId];

  if (ast.type === 'MemberExpression' && ast.object.name === 'latest') {
    return JsLang.astConditional(JsLang.astCall('latest.hasOwnProperty', [ast.property.value]), ast, { ...ast,
      object: { ...ast.object,
        name: 'existing'
      }
    });
  }

  return compileContext.astMap[topoId];
}

function createCompileContext(moduleName, linker, sharedContext) {
  let compileContext = {
    moduleName,
    linker,
    variables: {},
    topoNodes: new Set(),
    topoSort: new TopoSort(),
    astMap: {},
    mapOfTokenToMeta: new Map(),
    modelVars: new Set(),
    mapOfFunctorToFile: sharedContext && sharedContext.mapOfFunctorToFile || {},
    newFunctorFiles: sharedContext && sharedContext.newFunctorFiles || []
  };
  compileContext.mainStartId = createTopoId(compileContext, '$main');
  linker.log('verbose', `Created compilation context for "${moduleName}".`);
  return compileContext;
}

function isTopLevelBlock(topoId) {
  return topoId.indexOf(':arg[') === -1 && topoId.indexOf('$cases[') === -1 && topoId.indexOf('$exceptions[') === -1;
}

function replaceVarRefScope(varRef, targetScope) {
  if (_.isPlainObject(varRef)) {
    if (!(varRef.oolType === 'ObjectReference')) {
      throw new Error("Function \"replaceVarRefScope\" assertion failed: varRef.oolType === 'ObjectReference'");
    }

    return {
      oolType: 'ObjectReference',
      name: replaceVarRefScope(varRef.name, targetScope)
    };
  }

  if (!(typeof varRef === 'string')) {
    throw new Error("Function \"replaceVarRefScope\" assertion failed: typeof varRef === 'string'");
  }

  let parts = varRef.split('.');

  if (!(parts.length > 1)) {
    throw new Error("Function \"replaceVarRefScope\" assertion failed: parts.length > 1");
  }

  parts.splice(0, 1, targetScope);
  return parts.join('.');
}

module.exports = {
  compileParam,
  compileField,
  compileDbOperation,
  compileExceptionalReturn,
  compileReturn,
  createTopoId,
  createCompileContext,
  dependsOn,
  addCodeBlock,
  AST_BLK_FIELD_PRE_PROCESS,
  AST_BLK_PROCESSOR_CALL,
  AST_BLK_VALIDATOR_CALL,
  AST_BLK_ACTIVATOR_CALL,
  AST_BLK_VIEW_OPERATION,
  AST_BLK_VIEW_RETURN,
  AST_BLK_INTERFACE_OPERATION,
  AST_BLK_INTERFACE_RETURN,
  AST_BLK_EXCEPTION_ITEM,
  OOL_MODIFIER_CODE_FLAG
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvZ2VtbFRvQXN0LmpzIl0sIm5hbWVzIjpbIl8iLCJyZXF1aXJlIiwiVG9wb1NvcnQiLCJKc0xhbmciLCJHZW1sVHlwZXMiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUiLCJUeXBlcyIsIlZhbGlkYXRvcnMiLCJPb2xvbmdWYWxpZGF0b3JzIiwiUHJvY2Vzc29ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJBY3RpdmF0b3JzIiwiT29sb25nQWN0aXZhdG9ycyIsImRlZmF1bHRFcnJvciIsIkFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MiLCJBU1RfQkxLX1BBUkFNX1NBTklUSVpFIiwiQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCIsIkFTVF9CTEtfVkFMSURBVE9SX0NBTEwiLCJBU1RfQkxLX0FDVElWQVRPUl9DQUxMIiwiQVNUX0JMS19WSUVXX09QRVJBVElPTiIsIkFTVF9CTEtfVklFV19SRVRVUk4iLCJBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04iLCJBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4iLCJBU1RfQkxLX0VYQ0VQVElPTl9JVEVNIiwiT09MX01PRElGSUVSX0NPREVfRkxBRyIsIk1vZGlmaWVyIiwiVkFMSURBVE9SIiwiUFJPQ0VTU09SIiwiQUNUSVZBVE9SIiwiT09MX01PRElGSUVSX09QIiwiT09MX01PRElGSUVSX1BBVEgiLCJPT0xfTU9ESUZJRVJfQlVJTFRJTiIsIk9QRVJBVE9SX1RPS0VOIiwiY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbiIsInRlc3QiLCJjb21waWxlQ29udGV4dCIsInN0YXJ0VG9wb0lkIiwiaXNQbGFpbk9iamVjdCIsIm9vbFR5cGUiLCJlbmRUb3BvSWQiLCJjcmVhdGVUb3BvSWQiLCJvcGVyYW5kVG9wb0lkIiwiZGVwZW5kc09uIiwibGFzdE9wZXJhbmRUb3BvSWQiLCJjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24iLCJjYWxsZXIiLCJhc3RBcmd1bWVudCIsImdldENvZGVSZXByZXNlbnRhdGlvbk9mIiwicmV0VG9wb0lkIiwiY29tcGlsZUFkSG9jVmFsaWRhdG9yIiwiY2FsbGVlIiwib3AiLCJvcGVyYXRvciIsIkVycm9yIiwibGVmdFRvcG9JZCIsInJpZ2h0VG9wb0lkIiwibGFzdExlZnRJZCIsImxlZnQiLCJsYXN0UmlnaHRJZCIsInJpZ2h0IiwiYXN0TWFwIiwiYXN0QmluRXhwIiwiYXJndW1lbnQiLCJhc3ROb3QiLCJhc3RDYWxsIiwidmFsdWVTdGFydFRvcG9JZCIsImFzdFZhbHVlIiwidG9wb0lkIiwidmFsdWUiLCJmdW5jdG9yIiwiY2FsbEFyZ3MiLCJhcmdzIiwidHJhbnNsYXRlQXJncyIsImFyZzAiLCJuYW1lIiwiY29uY2F0IiwiY29tcGlsZU1vZGlmaWVyIiwiZGVjbGFyZVBhcmFtcyIsInRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zIiwibW9kdWxlTmFtZSIsImlzRW1wdHkiLCJmdW5jdG9ySWQiLCJ0cmFuc2xhdGVNb2RpZmllciIsInJlZmVyZW5jZXMiLCJleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyIsImZpbmQiLCJyZWYiLCJhc3RBd2FpdCIsImFzdFZhclJlZiIsImlzVG9wTGV2ZWxCbG9jayIsInN0YXJ0c1dpdGgiLCJhc3RDb25kaXRpb25hbCIsInJlcGxhY2VWYXJSZWZTY29wZSIsInRhcmdldFZhck5hbWUiLCJuZWVkRGVjbGFyZSIsInZhcmlhYmxlcyIsImNvdW50ZXIiLCJ0b1N0cmluZyIsImhhc093blByb3BlcnR5IiwidHlwZSIsInNvdXJjZSIsImFkZENvZGVCbG9jayIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJBcnJheSIsImlzQXJyYXkiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwibmV3RnVuY3RvckZpbGVzIiwiY29tcGlsZVBpcGVkVmFsdWUiLCJ2YXJPb2wiLCJsYXN0VG9wb0lkIiwibW9kaWZpZXJzIiwibW9kaWZpZXIiLCJtb2RpZmllclN0YXJ0VG9wb0lkIiwiY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlIiwiU2V0IiwidHJhbnNsYXRlRnVuY3Rpb25QYXJhbSIsImFyZyIsImkiLCJwb3AiLCJtYXAiLCJiYXNlTmFtZSIsImNvdW50IiwiaGFzIiwiYWRkIiwicmVmQmFzZSIsInJlc3QiLCJkZXBlbmRlbmN5Iiwib25nb2luZyIsInJlZkZpZWxkTmFtZSIsIm9vclR5cGUiLCJ0cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm1hcFZhbHVlcyIsInZhbHVlT2ZFbGVtZW50Iiwia2V5Iiwic2lkIiwiZWlkIiwiaW5kZXgiLCJlYWNoIiwiYXJnVG9wb0lkIiwiY29tcGlsZVBhcmFtIiwicGFyYW0iLCJ0eXBlT2JqZWN0Iiwic2FuaXRpemVyTmFtZSIsInRvVXBwZXJDYXNlIiwidmFyUmVmIiwiY2FsbEFzdCIsImFzdEFycmF5QWNjZXNzIiwicHJlcGFyZVRvcG9JZCIsImFzdEFzc2lnbiIsIm1haW5TdGFydElkIiwid3JhcFBhcmFtUmVmZXJlbmNlIiwicmVhZHlUb3BvSWQiLCJjb21waWxlRmllbGQiLCJwYXJhbU5hbWUiLCJjb250ZXh0TmFtZSIsIk9iamVjdCIsImFzc2lnbiIsImhhc01vZGVsRmllbGQiLCJvcGVyYW5kIiwiYmFzZVZhciIsInNwbGl0IiwidHJhbnNsYXRlUmV0dXJuVGhlbkFzdCIsInN0YXJ0SWQiLCJlbmRJZCIsInRoZW4iLCJhc3RUaHJvdyIsImVycm9yVHlwZSIsIm1lc3NhZ2UiLCJ0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdCIsInZhbHVlRW5kSWQiLCJhc3RSZXR1cm4iLCJ0cmFuc2xhdGVUaGVuQXN0IiwiYXNzaWduVG8iLCJjb25kaXRpb24iLCJzdGFydFJpZ2h0SWQiLCJ2YWx1ZVRvcG9JZCIsImNvbXBpbGVSZXR1cm4iLCJjb21waWxlRmluZE9uZSIsIm9wZXJhdGlvbiIsImNvbmRpdGlvblZhck5hbWUiLCJhc3QiLCJhc3RWYXJEZWNsYXJlIiwibW9kZWwiLCJ0b3BvSWRQcmVmaXgiLCJsYXN0U3RhdGVtZW50IiwiZWxzZSIsImVsc2VTdGFydCIsImVsc2VFbmQiLCJpdGVtcyIsInJldmVyc2UiLCJpdGVtIiwiY2FzZVByZWZpeCIsImNhc2VUb3BvSWQiLCJjYXNlUmVzdWx0VmFyTmFtZSIsImFzdENhc2VUdGVtIiwiaWZTdGFydCIsImlmRW5kIiwiYXN0SWYiLCJhc3RCbG9jayIsIm1vZGVsVG9wb0lkIiwiY29tcGlsZURiT3BlcmF0aW9uIiwiZG9CbG9jayIsImRvIiwiY29tcGlsZURvU3RhdGVtZW50IiwiY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuIiwib29sTm9kZSIsImxhc3RFeGNlcHRpb25JZCIsImV4Y2VwdGlvbnMiLCJleGNlcHRpb25TdGFydElkIiwiZXhjZXB0aW9uRW5kSWQiLCJ0aGVuU3RhcnRJZCIsInJldHVyblN0YXJ0VG9wb0lkIiwidG9wb05vZGVzIiwidG9wb1NvcnQiLCJoYXNEZXBlbmRlbmN5IiwicHJldmlvdXNPcCIsImN1cnJlbnRPcCIsImxpbmtlciIsImxvZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJsYXN0U291cmNlVHlwZSIsImdldCIsIm9iamVjdCIsInByb3BlcnR5IiwiY3JlYXRlQ29tcGlsZUNvbnRleHQiLCJzaGFyZWRDb250ZXh0IiwiTWFwIiwibW9kZWxWYXJzIiwiaW5kZXhPZiIsInRhcmdldFNjb3BlIiwicGFydHMiLCJzcGxpY2UiLCJqb2luIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFPQSxNQUFNO0FBQUVBLEVBQUFBO0FBQUYsSUFBUUMsT0FBTyxDQUFDLFVBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWVELE9BQU8sQ0FBQyxpQkFBRCxDQUE1Qjs7QUFFQSxNQUFNRSxNQUFNLEdBQUdGLE9BQU8sQ0FBQyxVQUFELENBQXRCOztBQUNBLE1BQU1HLFNBQVMsR0FBR0gsT0FBTyxDQUFDLHNCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsaUJBQUY7QUFBcUJDLEVBQUFBLHNCQUFyQjtBQUE2Q0MsRUFBQUE7QUFBN0MsSUFBMEVOLE9BQU8sQ0FBQyxzQkFBRCxDQUF2Rjs7QUFDQSxNQUFNO0FBQUdPLEVBQUFBLEtBQUg7QUFBVUMsRUFBQUEsVUFBVSxFQUFFQyxnQkFBdEI7QUFBd0NDLEVBQUFBLFVBQVUsRUFBRUMsZ0JBQXBEO0FBQXNFQyxFQUFBQSxVQUFVLEVBQUVDO0FBQWxGLElBQXVHYixPQUFPLENBQUMsWUFBRCxDQUFwSDs7QUFFQSxNQUFNYyxZQUFZLEdBQUcsZ0JBQXJCO0FBRUEsTUFBTUMseUJBQXlCLEdBQUcsaUJBQWxDO0FBQ0EsTUFBTUMsc0JBQXNCLEdBQUcsbUJBQS9CO0FBQ0EsTUFBTUMsc0JBQXNCLEdBQUcsZUFBL0I7QUFDQSxNQUFNQyxzQkFBc0IsR0FBRyxlQUEvQjtBQUNBLE1BQU1DLHNCQUFzQixHQUFHLGVBQS9CO0FBQ0EsTUFBTUMsc0JBQXNCLEdBQUcsZUFBL0I7QUFDQSxNQUFNQyxtQkFBbUIsR0FBRyxZQUE1QjtBQUNBLE1BQU1DLDJCQUEyQixHQUFHLG9CQUFwQztBQUNBLE1BQU1DLHdCQUF3QixHQUFHLGlCQUFqQztBQUNBLE1BQU1DLHNCQUFzQixHQUFHLGVBQS9CO0FBRUEsTUFBTUMsc0JBQXNCLEdBQUc7QUFDM0IsR0FBQ3RCLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJDLFNBQXBCLEdBQWdDVCxzQkFETDtBQUUzQixHQUFDZixTQUFTLENBQUN1QixRQUFWLENBQW1CRSxTQUFwQixHQUFnQ1gsc0JBRkw7QUFHM0IsR0FBQ2QsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkcsU0FBcEIsR0FBZ0NWO0FBSEwsQ0FBL0I7QUFNQSxNQUFNVyxlQUFlLEdBQUc7QUFDcEIsR0FBQzNCLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJDLFNBQXBCLEdBQWdDLElBRFo7QUFFcEIsR0FBQ3hCLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJFLFNBQXBCLEdBQWdDLElBRlo7QUFHcEIsR0FBQ3pCLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJHLFNBQXBCLEdBQWdDO0FBSFosQ0FBeEI7QUFNQSxNQUFNRSxpQkFBaUIsR0FBRztBQUN0QixHQUFDNUIsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkMsU0FBcEIsR0FBZ0MsWUFEVjtBQUV0QixHQUFDeEIsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkUsU0FBcEIsR0FBZ0MsWUFGVjtBQUd0QixHQUFDekIsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkcsU0FBcEIsR0FBZ0M7QUFIVixDQUExQjtBQU1BLE1BQU1HLG9CQUFvQixHQUFHO0FBQ3pCLEdBQUM3QixTQUFTLENBQUN1QixRQUFWLENBQW1CQyxTQUFwQixHQUFnQ2xCLGdCQURQO0FBRXpCLEdBQUNOLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJFLFNBQXBCLEdBQWdDakIsZ0JBRlA7QUFHekIsR0FBQ1IsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkcsU0FBcEIsR0FBZ0NoQjtBQUhQLENBQTdCO0FBTUEsTUFBTW9CLGNBQWMsR0FBRztBQUNuQixPQUFLLEtBRGM7QUFFbkIsT0FBSyxLQUZjO0FBR25CLFFBQU0sTUFIYTtBQUluQixRQUFNLE1BSmE7QUFLbkIsUUFBTSxLQUxhO0FBTW5CLFFBQU0sS0FOYTtBQU9uQixRQUFNLEtBUGE7QUFRbkIsV0FBUztBQVJVLENBQXZCOztBQXFCQSxTQUFTQyw0QkFBVCxDQUFzQ0MsSUFBdEMsRUFBNENDLGNBQTVDLEVBQTREQyxXQUE1RCxFQUF5RTtBQUNyRSxNQUFJdEMsQ0FBQyxDQUFDdUMsYUFBRixDQUFnQkgsSUFBaEIsQ0FBSixFQUEyQjtBQUN2QixRQUFJQSxJQUFJLENBQUNJLE9BQUwsS0FBaUIsb0JBQXJCLEVBQTJDO0FBQ3ZDLFVBQUlDLFNBQVMsR0FBR0MsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsY0FBL0IsQ0FBNUI7QUFDQSxVQUFJSyxhQUFhLEdBQUdELFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLFNBQS9CLENBQWhDO0FBRUFNLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQkMsV0FBakIsRUFBOEJLLGFBQTlCLENBQVQ7QUFFQSxVQUFJRSxpQkFBaUIsR0FBR0MsOEJBQThCLENBQUNILGFBQUQsRUFBZ0JQLElBQUksQ0FBQ1csTUFBckIsRUFBNkJWLGNBQTdCLENBQXREO0FBQ0FPLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQlEsaUJBQWpCLEVBQW9DSixTQUFwQyxDQUFUO0FBRUEsVUFBSU8sV0FBVyxHQUFHQyx1QkFBdUIsQ0FBQ0osaUJBQUQsRUFBb0JSLGNBQXBCLENBQXpDO0FBRUEsVUFBSWEsU0FBUyxHQUFHQyxxQkFBcUIsQ0FBQ1YsU0FBRCxFQUFZTyxXQUFaLEVBQXlCWixJQUFJLENBQUNnQixNQUE5QixFQUFzQ2YsY0FBdEMsQ0FBckM7O0FBWHVDLFlBYS9CYSxTQUFTLEtBQUtULFNBYmlCO0FBQUE7QUFBQTs7QUE0Q3ZDLGFBQU9BLFNBQVA7QUFFSCxLQTlDRCxNQThDTyxJQUFJTCxJQUFJLENBQUNJLE9BQUwsS0FBaUIsbUJBQXJCLEVBQTBDO0FBQzdDLFVBQUlDLFNBQVMsR0FBR0MsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsYUFBL0IsQ0FBNUI7QUFFQSxVQUFJZSxFQUFKOztBQUVBLGNBQVFqQixJQUFJLENBQUNrQixRQUFiO0FBQ0ksYUFBSyxLQUFMO0FBQ0lELFVBQUFBLEVBQUUsR0FBRyxJQUFMO0FBQ0E7O0FBRUosYUFBSyxJQUFMO0FBQ0lBLFVBQUFBLEVBQUUsR0FBRyxJQUFMO0FBQ0E7O0FBRUo7QUFDSSxnQkFBTSxJQUFJRSxLQUFKLENBQVUsZ0NBQWdDbkIsSUFBSSxDQUFDa0IsUUFBL0MsQ0FBTjtBQVZSOztBQWFBLFVBQUlFLFVBQVUsR0FBR2QsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsYUFBL0IsQ0FBN0I7QUFDQSxVQUFJbUIsV0FBVyxHQUFHZixZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxjQUEvQixDQUE5QjtBQUVBTSxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCa0IsVUFBOUIsQ0FBVDtBQUNBWixNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCbUIsV0FBOUIsQ0FBVDtBQUVBLFVBQUlDLFVBQVUsR0FBR3ZCLDRCQUE0QixDQUFDQyxJQUFJLENBQUN1QixJQUFOLEVBQVl0QixjQUFaLEVBQTRCbUIsVUFBNUIsQ0FBN0M7QUFDQSxVQUFJSSxXQUFXLEdBQUd6Qiw0QkFBNEIsQ0FBQ0MsSUFBSSxDQUFDeUIsS0FBTixFQUFheEIsY0FBYixFQUE2Qm9CLFdBQTdCLENBQTlDO0FBRUFiLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQnFCLFVBQWpCLEVBQTZCakIsU0FBN0IsQ0FBVDtBQUNBRyxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJ1QixXQUFqQixFQUE4Qm5CLFNBQTlCLENBQVQ7QUFFQUosTUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnJCLFNBQXRCLElBQW1DdEMsTUFBTSxDQUFDNEQsU0FBUCxDQUMvQmQsdUJBQXVCLENBQUNTLFVBQUQsRUFBYXJCLGNBQWIsQ0FEUSxFQUUvQmdCLEVBRitCLEVBRy9CSix1QkFBdUIsQ0FBQ1csV0FBRCxFQUFjdkIsY0FBZCxDQUhRLENBQW5DO0FBTUEsYUFBT0ksU0FBUDtBQUVILEtBdENNLE1Bc0NBLElBQUlMLElBQUksQ0FBQ0ksT0FBTCxLQUFpQixrQkFBckIsRUFBeUM7QUFDNUMsVUFBSUMsU0FBUyxHQUFHQyxZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxhQUEvQixDQUE1QjtBQUVBLFVBQUllLEVBQUo7O0FBRUEsY0FBUWpCLElBQUksQ0FBQ2tCLFFBQWI7QUFDSSxhQUFLLEdBQUw7QUFDQSxhQUFLLEdBQUw7QUFDQSxhQUFLLElBQUw7QUFDQSxhQUFLLElBQUw7QUFDQSxhQUFLLElBQUw7QUFDSUQsVUFBQUEsRUFBRSxHQUFHakIsSUFBSSxDQUFDa0IsUUFBVjtBQUNBOztBQUVKLGFBQUssSUFBTDtBQUNJRCxVQUFBQSxFQUFFLEdBQUcsS0FBTDtBQUNBOztBQUVKLGFBQUssSUFBTDtBQUNJQSxVQUFBQSxFQUFFLEdBQUcsS0FBTDtBQUNBOztBQUVKO0FBQ0ksZ0JBQU0sSUFBSUUsS0FBSixDQUFVLGdDQUFnQ25CLElBQUksQ0FBQ2tCLFFBQS9DLENBQU47QUFsQlI7O0FBcUJBLFVBQUlFLFVBQVUsR0FBR2QsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsYUFBL0IsQ0FBN0I7QUFDQSxVQUFJbUIsV0FBVyxHQUFHZixZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxjQUEvQixDQUE5QjtBQUVBTSxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCa0IsVUFBOUIsQ0FBVDtBQUNBWixNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCbUIsV0FBOUIsQ0FBVDtBQUVBLFVBQUlDLFVBQVUsR0FBR1osOEJBQThCLENBQUNVLFVBQUQsRUFBYXBCLElBQUksQ0FBQ3VCLElBQWxCLEVBQXdCdEIsY0FBeEIsQ0FBL0M7QUFDQSxVQUFJdUIsV0FBVyxHQUFHZCw4QkFBOEIsQ0FBQ1csV0FBRCxFQUFjckIsSUFBSSxDQUFDeUIsS0FBbkIsRUFBMEJ4QixjQUExQixDQUFoRDtBQUVBTyxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJxQixVQUFqQixFQUE2QmpCLFNBQTdCLENBQVQ7QUFDQUcsTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCdUIsV0FBakIsRUFBOEJuQixTQUE5QixDQUFUO0FBRUFKLE1BQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3RDLE1BQU0sQ0FBQzRELFNBQVAsQ0FDL0JkLHVCQUF1QixDQUFDUyxVQUFELEVBQWFyQixjQUFiLENBRFEsRUFFL0JnQixFQUYrQixFQUcvQkosdUJBQXVCLENBQUNXLFdBQUQsRUFBY3ZCLGNBQWQsQ0FIUSxDQUFuQztBQU1BLGFBQU9JLFNBQVA7QUFFSCxLQTlDTSxNQThDQSxJQUFJTCxJQUFJLENBQUNJLE9BQUwsS0FBaUIsaUJBQXJCLEVBQXdDO0FBQzNDLFVBQUlDLFNBQVMsR0FBR0MsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsYUFBL0IsQ0FBNUI7QUFDQSxVQUFJSyxhQUFhLEdBQUdELFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLFFBQS9CLENBQWhDO0FBRUFNLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQkMsV0FBakIsRUFBOEJLLGFBQTlCLENBQVQ7QUFFQSxVQUFJRSxpQkFBaUIsR0FBR1QsSUFBSSxDQUFDa0IsUUFBTCxLQUFrQixLQUFsQixHQUEwQlIsOEJBQThCLENBQUNILGFBQUQsRUFBZ0JQLElBQUksQ0FBQzRCLFFBQXJCLEVBQStCM0IsY0FBL0IsQ0FBeEQsR0FBeUdGLDRCQUE0QixDQUFDQyxJQUFJLENBQUM0QixRQUFOLEVBQWdCM0IsY0FBaEIsRUFBZ0NNLGFBQWhDLENBQTdKO0FBQ0FDLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQlEsaUJBQWpCLEVBQW9DSixTQUFwQyxDQUFUO0FBRUEsVUFBSU8sV0FBVyxHQUFHQyx1QkFBdUIsQ0FBQ0osaUJBQUQsRUFBb0JSLGNBQXBCLENBQXpDOztBQUVBLGNBQVFELElBQUksQ0FBQ2tCLFFBQWI7QUFDSSxhQUFLLFFBQUw7QUFDSWpCLFVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3RDLE1BQU0sQ0FBQzhELE1BQVAsQ0FBYzlELE1BQU0sQ0FBQytELE9BQVAsQ0FBZSxXQUFmLEVBQTRCbEIsV0FBNUIsQ0FBZCxDQUFuQztBQUNBOztBQUVKLGFBQUssYUFBTDtBQUNJWCxVQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUN0QyxNQUFNLENBQUM4RCxNQUFQLENBQWM5RCxNQUFNLENBQUMrRCxPQUFQLENBQWUsU0FBZixFQUEwQmxCLFdBQTFCLENBQWQsQ0FBbkM7QUFDQTs7QUFFSixhQUFLLFlBQUw7QUFDSVgsVUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnJCLFNBQXRCLElBQW1DdEMsTUFBTSxDQUFDK0QsT0FBUCxDQUFlLFdBQWYsRUFBNEJsQixXQUE1QixDQUFuQztBQUNBOztBQUVKLGFBQUssU0FBTDtBQUNJWCxVQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUN0QyxNQUFNLENBQUMrRCxPQUFQLENBQWUsU0FBZixFQUEwQmxCLFdBQTFCLENBQW5DO0FBQ0E7O0FBRUosYUFBSyxLQUFMO0FBQ0lYLFVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3RDLE1BQU0sQ0FBQzhELE1BQVAsQ0FBY2pCLFdBQWQsQ0FBbkM7QUFDQTs7QUFFSjtBQUNJLGdCQUFNLElBQUlPLEtBQUosQ0FBVSxnQ0FBZ0NuQixJQUFJLENBQUNrQixRQUEvQyxDQUFOO0FBdEJSOztBQXlCQSxhQUFPYixTQUFQO0FBRUgsS0F0Q00sTUFzQ0E7QUFDSCxVQUFJMEIsZ0JBQWdCLEdBQUd6QixZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxRQUEvQixDQUFuQztBQUNBTSxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCNkIsZ0JBQTlCLENBQVQ7QUFDQSxhQUFPckIsOEJBQThCLENBQUNxQixnQkFBRCxFQUFtQi9CLElBQW5CLEVBQXlCQyxjQUF6QixDQUFyQztBQUNIO0FBQ0o7O0FBRURBLEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0J4QixXQUF0QixJQUFxQ25DLE1BQU0sQ0FBQ2lFLFFBQVAsQ0FBZ0JoQyxJQUFoQixDQUFyQztBQUNBLFNBQU9FLFdBQVA7QUFDSDs7QUFZRCxTQUFTYSxxQkFBVCxDQUErQmtCLE1BQS9CLEVBQXVDQyxLQUF2QyxFQUE4Q0MsT0FBOUMsRUFBdURsQyxjQUF2RCxFQUF1RTtBQUFBLFFBQzNEa0MsT0FBTyxDQUFDL0IsT0FBUixLQUFvQnBDLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJDLFNBRG9CO0FBQUE7QUFBQTs7QUFHbkUsTUFBSTRDLFFBQUo7O0FBRUEsTUFBSUQsT0FBTyxDQUFDRSxJQUFaLEVBQWtCO0FBQ2RELElBQUFBLFFBQVEsR0FBR0UsYUFBYSxDQUFDTCxNQUFELEVBQVNFLE9BQU8sQ0FBQ0UsSUFBakIsRUFBdUJwQyxjQUF2QixDQUF4QjtBQUNILEdBRkQsTUFFTztBQUNIbUMsSUFBQUEsUUFBUSxHQUFHLEVBQVg7QUFDSDs7QUFFRCxNQUFJRyxJQUFJLEdBQUdMLEtBQVg7QUFFQWpDLEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JPLE1BQXRCLElBQWdDbEUsTUFBTSxDQUFDK0QsT0FBUCxDQUFlLGdCQUFnQkssT0FBTyxDQUFDSyxJQUF2QyxFQUE2QyxDQUFFRCxJQUFGLEVBQVNFLE1BQVQsQ0FBZ0JMLFFBQWhCLENBQTdDLENBQWhDO0FBRUEsU0FBT0gsTUFBUDtBQUNIOztBQWFELFNBQVNTLGVBQVQsQ0FBeUJULE1BQXpCLEVBQWlDQyxLQUFqQyxFQUF3Q0MsT0FBeEMsRUFBaURsQyxjQUFqRCxFQUFpRTtBQUM3RCxNQUFJMEMsYUFBSjs7QUFFQSxNQUFJUixPQUFPLENBQUMvQixPQUFSLEtBQW9CcEMsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkcsU0FBM0MsRUFBc0Q7QUFDbERpRCxJQUFBQSxhQUFhLEdBQUdDLHVCQUF1QixDQUFDLENBQUM7QUFBQ0osTUFBQUEsSUFBSSxFQUFFdkMsY0FBYyxDQUFDNEM7QUFBdEIsS0FBRCxFQUFvQztBQUFDTCxNQUFBQSxJQUFJLEVBQUU7QUFBUCxLQUFwQyxFQUF1REMsTUFBdkQsQ0FBOEROLE9BQU8sQ0FBQ0UsSUFBdEUsQ0FBRCxDQUF2QztBQUNILEdBRkQsTUFFTztBQUNITSxJQUFBQSxhQUFhLEdBQUdDLHVCQUF1QixDQUFDaEYsQ0FBQyxDQUFDa0YsT0FBRixDQUFVWCxPQUFPLENBQUNFLElBQWxCLElBQTBCLENBQUNILEtBQUQsQ0FBMUIsR0FBb0MsQ0FBQ0EsS0FBRCxFQUFRTyxNQUFSLENBQWVOLE9BQU8sQ0FBQ0UsSUFBdkIsQ0FBckMsQ0FBdkM7QUFDSDs7QUFFRCxNQUFJVSxTQUFTLEdBQUdDLGlCQUFpQixDQUFDYixPQUFELEVBQVVsQyxjQUFWLEVBQTBCMEMsYUFBMUIsQ0FBakM7QUFFQSxNQUFJUCxRQUFKLEVBQWNhLFVBQWQ7O0FBRUEsTUFBSWQsT0FBTyxDQUFDRSxJQUFaLEVBQWtCO0FBQ2RELElBQUFBLFFBQVEsR0FBR0UsYUFBYSxDQUFDTCxNQUFELEVBQVNFLE9BQU8sQ0FBQ0UsSUFBakIsRUFBdUJwQyxjQUF2QixDQUF4QjtBQUNBZ0QsSUFBQUEsVUFBVSxHQUFHQyx1QkFBdUIsQ0FBQ2YsT0FBTyxDQUFDRSxJQUFULENBQXBDOztBQUVBLFFBQUl6RSxDQUFDLENBQUN1RixJQUFGLENBQU9GLFVBQVAsRUFBbUJHLEdBQUcsSUFBSUEsR0FBRyxLQUFLbEIsS0FBSyxDQUFDTSxJQUF4QyxDQUFKLEVBQW1EO0FBQy9DLFlBQU0sSUFBSXJCLEtBQUosQ0FBVSxrRUFBVixDQUFOO0FBQ0g7QUFDSixHQVBELE1BT087QUFDSGlCLElBQUFBLFFBQVEsR0FBRyxFQUFYO0FBQ0g7O0FBRUQsTUFBSUQsT0FBTyxDQUFDL0IsT0FBUixLQUFvQnBDLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJHLFNBQTNDLEVBQXNEO0FBQ2xETyxJQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCTyxNQUF0QixJQUFnQ2xFLE1BQU0sQ0FBQ3NGLFFBQVAsQ0FBZ0JOLFNBQWhCLEVBQTJCLENBQUVoRixNQUFNLENBQUN1RixTQUFQLENBQWlCLE1BQWpCLENBQUYsRUFBNEJ2RixNQUFNLENBQUN1RixTQUFQLENBQWlCLFNBQWpCLENBQTVCLEVBQTBEYixNQUExRCxDQUFpRUwsUUFBakUsQ0FBM0IsQ0FBaEM7QUFDSCxHQUZELE1BRU87QUFDSCxRQUFJRyxJQUFJLEdBQUdMLEtBQVg7O0FBQ0EsUUFBSSxDQUFDcUIsZUFBZSxDQUFDdEIsTUFBRCxDQUFoQixJQUE0QnJFLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0IrQixLQUFoQixDQUE1QixJQUFzREEsS0FBSyxDQUFDOUIsT0FBTixLQUFrQixpQkFBeEUsSUFBNkY4QixLQUFLLENBQUNNLElBQU4sQ0FBV2dCLFVBQVgsQ0FBc0IsU0FBdEIsQ0FBakcsRUFBbUk7QUFFL0hqQixNQUFBQSxJQUFJLEdBQUd4RSxNQUFNLENBQUMwRixjQUFQLENBQ0gxRixNQUFNLENBQUMrRCxPQUFQLENBQWUsdUJBQWYsRUFBd0MsQ0FBRTNELHdCQUF3QixDQUFDK0QsS0FBSyxDQUFDTSxJQUFQLENBQTFCLENBQXhDLENBREcsRUFFSE4sS0FGRyxFQUdId0Isa0JBQWtCLENBQUN4QixLQUFELEVBQVEsVUFBUixDQUhmLENBQVA7QUFLSDs7QUFDRGpDLElBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JPLE1BQXRCLElBQWdDbEUsTUFBTSxDQUFDK0QsT0FBUCxDQUFlaUIsU0FBZixFQUEwQixDQUFFUixJQUFGLEVBQVNFLE1BQVQsQ0FBZ0JMLFFBQWhCLENBQTFCLENBQWhDO0FBQ0g7O0FBRUQsTUFBSW1CLGVBQWUsQ0FBQ3RCLE1BQUQsQ0FBbkIsRUFBNkI7QUFDekIsUUFBSTBCLGFBQWEsR0FBR3pCLEtBQUssQ0FBQ00sSUFBMUI7QUFDQSxRQUFJb0IsV0FBVyxHQUFHLEtBQWxCOztBQUVBLFFBQUksQ0FBQzNGLGlCQUFpQixDQUFDaUUsS0FBSyxDQUFDTSxJQUFQLENBQWxCLElBQWtDdkMsY0FBYyxDQUFDNEQsU0FBZixDQUF5QjNCLEtBQUssQ0FBQ00sSUFBL0IsQ0FBbEMsSUFBMEVMLE9BQU8sQ0FBQy9CLE9BQVIsS0FBb0JwQyxTQUFTLENBQUN1QixRQUFWLENBQW1CQyxTQUFySCxFQUFnSTtBQUU1SCxVQUFJc0UsT0FBTyxHQUFHLENBQWQ7O0FBQ0EsU0FBRztBQUNDQSxRQUFBQSxPQUFPO0FBQ1BILFFBQUFBLGFBQWEsR0FBR3pCLEtBQUssQ0FBQ00sSUFBTixHQUFhc0IsT0FBTyxDQUFDQyxRQUFSLEVBQTdCO0FBQ0gsT0FIRCxRQUdTOUQsY0FBYyxDQUFDNEQsU0FBZixDQUF5QkcsY0FBekIsQ0FBd0NMLGFBQXhDLENBSFQ7O0FBS0ExRCxNQUFBQSxjQUFjLENBQUM0RCxTQUFmLENBQXlCRixhQUF6QixJQUEwQztBQUFFTSxRQUFBQSxJQUFJLEVBQUUsZUFBUjtBQUF5QkMsUUFBQUEsTUFBTSxFQUFFO0FBQWpDLE9BQTFDO0FBQ0FOLE1BQUFBLFdBQVcsR0FBRyxJQUFkO0FBQ0g7O0FBSURPLElBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUJnQyxNQUFqQixFQUF5QjtBQUNqQ2dDLE1BQUFBLElBQUksRUFBRTNFLHNCQUFzQixDQUFDNkMsT0FBTyxDQUFDL0IsT0FBVCxDQURLO0FBRWpDZ0UsTUFBQUEsTUFBTSxFQUFFVCxhQUZ5QjtBQUdqQ1YsTUFBQUEsVUFIaUM7QUFJakNXLE1BQUFBO0FBSmlDLEtBQXpCLENBQVo7QUFNSDs7QUFFRCxTQUFPM0IsTUFBUDtBQUNIOztBQUVELFNBQVNpQix1QkFBVCxDQUFpQ21CLE9BQWpDLEVBQTBDO0FBQ3RDQSxFQUFBQSxPQUFPLEdBQUd6RyxDQUFDLENBQUMwRyxTQUFGLENBQVlELE9BQVosQ0FBVjtBQUVBLE1BQUlFLElBQUksR0FBRyxFQUFYO0FBRUFGLEVBQUFBLE9BQU8sQ0FBQ0csT0FBUixDQUFnQkMsQ0FBQyxJQUFJO0FBQ2pCLFFBQUlDLEtBQUssQ0FBQ0MsT0FBTixDQUFjRixDQUFkLENBQUosRUFBc0I7QUFDbEJGLE1BQUFBLElBQUksR0FBR0EsSUFBSSxDQUFDOUIsTUFBTCxDQUFZUyx1QkFBdUIsQ0FBQ3VCLENBQUQsQ0FBbkMsQ0FBUDtBQUNBO0FBQ0g7O0FBRUQsUUFBSUcsTUFBTSxHQUFHQyxxQkFBcUIsQ0FBQ0osQ0FBRCxDQUFsQzs7QUFDQSxRQUFJRyxNQUFKLEVBQVk7QUFDUkwsTUFBQUEsSUFBSSxDQUFDTyxJQUFMLENBQVVGLE1BQVY7QUFDSDtBQUNKLEdBVkQ7QUFZQSxTQUFPTCxJQUFQO0FBQ0g7O0FBRUQsU0FBU00scUJBQVQsQ0FBK0JFLEdBQS9CLEVBQW9DO0FBQ2hDLE1BQUluSCxDQUFDLENBQUN1QyxhQUFGLENBQWdCNEUsR0FBaEIsS0FBd0JBLEdBQUcsQ0FBQzNFLE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUkyRSxHQUFHLENBQUMzRSxPQUFKLEtBQWdCLFlBQXBCLEVBQWtDLE9BQU95RSxxQkFBcUIsQ0FBQ0UsR0FBRyxDQUFDN0MsS0FBTCxDQUE1Qjs7QUFDbEMsUUFBSTZDLEdBQUcsQ0FBQzNFLE9BQUosS0FBZ0IsaUJBQXBCLEVBQXVDO0FBQ25DLGFBQU8yRSxHQUFHLENBQUN2QyxJQUFYO0FBQ0g7QUFDSjs7QUFFRCxTQUFPd0MsU0FBUDtBQUNIOztBQUVELFNBQVNDLGdCQUFULENBQTBCbEMsU0FBMUIsRUFBcUNtQyxXQUFyQyxFQUFrREMsYUFBbEQsRUFBaUVDLGtCQUFqRSxFQUFxRjtBQUNqRixNQUFJQSxrQkFBa0IsQ0FBQ3JDLFNBQUQsQ0FBbEIsSUFBaUNxQyxrQkFBa0IsQ0FBQ3JDLFNBQUQsQ0FBbEIsS0FBa0NvQyxhQUF2RSxFQUFzRjtBQUNsRixVQUFNLElBQUloRSxLQUFKLENBQVcsYUFBWStELFdBQVksWUFBV25DLFNBQVUsY0FBeEQsQ0FBTjtBQUNIOztBQUNEcUMsRUFBQUEsa0JBQWtCLENBQUNyQyxTQUFELENBQWxCLEdBQWdDb0MsYUFBaEM7QUFDSDs7QUFTRCxTQUFTbkMsaUJBQVQsQ0FBMkJiLE9BQTNCLEVBQW9DbEMsY0FBcEMsRUFBb0RvQyxJQUFwRCxFQUEwRDtBQUN0RCxNQUFJZ0QsWUFBSixFQUFrQkMsUUFBbEIsRUFBNEJ2QyxTQUE1Qjs7QUFHQSxNQUFJOUUsaUJBQWlCLENBQUNrRSxPQUFPLENBQUNLLElBQVQsQ0FBckIsRUFBcUM7QUFDakMsUUFBSStDLEtBQUssR0FBR3JILHNCQUFzQixDQUFDaUUsT0FBTyxDQUFDSyxJQUFULENBQWxDOztBQUNBLFFBQUkrQyxLQUFLLENBQUNDLE1BQU4sR0FBZSxDQUFuQixFQUFzQjtBQUNsQixZQUFNLElBQUlyRSxLQUFKLENBQVUsbUNBQW1DZ0IsT0FBTyxDQUFDSyxJQUFyRCxDQUFOO0FBQ0g7O0FBR0QsUUFBSWlELGFBQWEsR0FBR0YsS0FBSyxDQUFDLENBQUQsQ0FBekI7QUFDQUYsSUFBQUEsWUFBWSxHQUFHRSxLQUFLLENBQUMsQ0FBRCxDQUFwQjtBQUNBRCxJQUFBQSxRQUFRLEdBQUcsT0FBTzFGLGlCQUFpQixDQUFDdUMsT0FBTyxDQUFDL0IsT0FBVCxDQUF4QixHQUE0QyxHQUE1QyxHQUFrRHFGLGFBQWxELEdBQWtFLEdBQWxFLEdBQXdFSixZQUF4RSxHQUF1RixLQUFsRztBQUNBdEMsSUFBQUEsU0FBUyxHQUFHMEMsYUFBYSxHQUFHN0gsQ0FBQyxDQUFDOEgsVUFBRixDQUFhTCxZQUFiLENBQTVCO0FBQ0FKLElBQUFBLGdCQUFnQixDQUFDbEMsU0FBRCxFQUFZWixPQUFPLENBQUMvQixPQUFwQixFQUE2QmtGLFFBQTdCLEVBQXVDckYsY0FBYyxDQUFDbUYsa0JBQXRELENBQWhCO0FBRUgsR0FiRCxNQWFPO0FBQ0hDLElBQUFBLFlBQVksR0FBR2xELE9BQU8sQ0FBQ0ssSUFBdkI7QUFFQSxRQUFJbUQsUUFBUSxHQUFHOUYsb0JBQW9CLENBQUNzQyxPQUFPLENBQUMvQixPQUFULENBQW5DOztBQUVBLFFBQUksRUFBRWlGLFlBQVksSUFBSU0sUUFBbEIsQ0FBSixFQUFpQztBQUM3QkwsTUFBQUEsUUFBUSxHQUFHLE9BQU8xRixpQkFBaUIsQ0FBQ3VDLE9BQU8sQ0FBQy9CLE9BQVQsQ0FBeEIsR0FBNEMsR0FBNUMsR0FBa0RILGNBQWMsQ0FBQzRDLFVBQWpFLEdBQThFLEdBQTlFLEdBQW9Gd0MsWUFBcEYsR0FBbUcsS0FBOUc7QUFDQXRDLE1BQUFBLFNBQVMsR0FBR3NDLFlBQVo7O0FBRUEsVUFBSSxDQUFDcEYsY0FBYyxDQUFDbUYsa0JBQWYsQ0FBa0NyQyxTQUFsQyxDQUFMLEVBQW1EO0FBQy9DOUMsUUFBQUEsY0FBYyxDQUFDMkYsZUFBZixDQUErQmQsSUFBL0IsQ0FBb0M7QUFDaENPLFVBQUFBLFlBRGdDO0FBRWhDSCxVQUFBQSxXQUFXLEVBQUUvQyxPQUFPLENBQUMvQixPQUZXO0FBR2hDa0YsVUFBQUEsUUFIZ0M7QUFJaENqRCxVQUFBQTtBQUpnQyxTQUFwQztBQU1IOztBQUVENEMsTUFBQUEsZ0JBQWdCLENBQUNsQyxTQUFELEVBQVlaLE9BQU8sQ0FBQy9CLE9BQXBCLEVBQTZCa0YsUUFBN0IsRUFBdUNyRixjQUFjLENBQUNtRixrQkFBdEQsQ0FBaEI7QUFDSCxLQWRELE1BY087QUFDSHJDLE1BQUFBLFNBQVMsR0FBR1osT0FBTyxDQUFDL0IsT0FBUixHQUFrQixJQUFsQixHQUF5QmlGLFlBQXJDO0FBQ0g7QUFDSjs7QUFFRCxTQUFPdEMsU0FBUDtBQUNIOztBQVlELFNBQVM4QyxpQkFBVCxDQUEyQjNGLFdBQTNCLEVBQXdDNEYsTUFBeEMsRUFBZ0Q3RixjQUFoRCxFQUFnRTtBQUM1RCxNQUFJOEYsVUFBVSxHQUFHckYsOEJBQThCLENBQUNSLFdBQUQsRUFBYzRGLE1BQU0sQ0FBQzVELEtBQXJCLEVBQTRCakMsY0FBNUIsQ0FBL0M7QUFFQTZGLEVBQUFBLE1BQU0sQ0FBQ0UsU0FBUCxDQUFpQnhCLE9BQWpCLENBQXlCeUIsUUFBUSxJQUFJO0FBQ2pDLFFBQUlDLG1CQUFtQixHQUFHNUYsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUdQLGVBQWUsQ0FBQ3NHLFFBQVEsQ0FBQzdGLE9BQVYsQ0FBN0IsR0FBa0Q2RixRQUFRLENBQUN6RCxJQUE1RSxDQUF0QztBQUNBaEMsSUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCOEYsVUFBakIsRUFBNkJHLG1CQUE3QixDQUFUO0FBRUFILElBQUFBLFVBQVUsR0FBR3JELGVBQWUsQ0FDeEJ3RCxtQkFEd0IsRUFFeEJKLE1BQU0sQ0FBQzVELEtBRmlCLEVBR3hCK0QsUUFId0IsRUFJeEJoRyxjQUp3QixDQUE1QjtBQU1ILEdBVkQ7QUFZQSxTQUFPOEYsVUFBUDtBQUNIOztBQVlELFNBQVNJLHdCQUFULENBQWtDakcsV0FBbEMsRUFBK0M0RixNQUEvQyxFQUF1RDdGLGNBQXZELEVBQXVFO0FBQUEsUUFDOURyQyxDQUFDLENBQUN1QyxhQUFGLENBQWdCMkYsTUFBaEIsS0FBMkJBLE1BQU0sQ0FBQzFGLE9BQVAsS0FBbUIsaUJBRGdCO0FBQUE7QUFBQTs7QUFVbkVILEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0J4QixXQUF0QixJQUFxQ25DLE1BQU0sQ0FBQ2lFLFFBQVAsQ0FBZ0I4RCxNQUFoQixDQUFyQztBQUNBLFNBQU81RixXQUFQO0FBQ0g7O0FBT0QsU0FBUzBDLHVCQUFULENBQWlDUCxJQUFqQyxFQUF1QztBQUNuQyxNQUFJekUsQ0FBQyxDQUFDa0YsT0FBRixDQUFVVCxJQUFWLENBQUosRUFBcUIsT0FBTyxFQUFQO0FBRXJCLE1BQUlrRCxLQUFLLEdBQUcsSUFBSWEsR0FBSixFQUFaOztBQUVBLFdBQVNDLHNCQUFULENBQWdDQyxHQUFoQyxFQUFxQ0MsQ0FBckMsRUFBd0M7QUFDcEMsUUFBSTNJLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0JtRyxHQUFoQixDQUFKLEVBQTBCO0FBQ3RCLFVBQUlBLEdBQUcsQ0FBQ2xHLE9BQUosS0FBZ0IsWUFBcEIsRUFBa0M7QUFDOUIsZUFBT2lHLHNCQUFzQixDQUFDQyxHQUFHLENBQUNwRSxLQUFMLENBQTdCO0FBQ0g7O0FBRUQsVUFBSW9FLEdBQUcsQ0FBQ2xHLE9BQUosS0FBZ0IsaUJBQXBCLEVBQXVDO0FBQ25DLFlBQUluQyxpQkFBaUIsQ0FBQ3FJLEdBQUcsQ0FBQzlELElBQUwsQ0FBckIsRUFBaUM7QUFDN0IsaUJBQU90RSxzQkFBc0IsQ0FBQ29JLEdBQUcsQ0FBQzlELElBQUwsQ0FBdEIsQ0FBaUNnRSxHQUFqQyxFQUFQO0FBQ0g7QUFDSjs7QUFFRCxhQUFPRixHQUFHLENBQUM5RCxJQUFYO0FBQ0g7O0FBRUQsV0FBTyxVQUFVLENBQUMrRCxDQUFDLEdBQUcsQ0FBTCxFQUFReEMsUUFBUixFQUFqQjtBQUNIOztBQUVELFNBQU9uRyxDQUFDLENBQUM2SSxHQUFGLENBQU1wRSxJQUFOLEVBQVksQ0FBQ2lFLEdBQUQsRUFBTUMsQ0FBTixLQUFZO0FBQzNCLFFBQUlHLFFBQVEsR0FBR0wsc0JBQXNCLENBQUNDLEdBQUQsRUFBTUMsQ0FBTixDQUFyQztBQUNBLFFBQUkvRCxJQUFJLEdBQUdrRSxRQUFYO0FBQ0EsUUFBSUMsS0FBSyxHQUFHLENBQVo7O0FBRUEsV0FBT3BCLEtBQUssQ0FBQ3FCLEdBQU4sQ0FBVXBFLElBQVYsQ0FBUCxFQUF3QjtBQUNwQkEsTUFBQUEsSUFBSSxHQUFHa0UsUUFBUSxHQUFHQyxLQUFLLENBQUM1QyxRQUFOLEVBQWxCO0FBQ0E0QyxNQUFBQSxLQUFLO0FBQ1I7O0FBRURwQixJQUFBQSxLQUFLLENBQUNzQixHQUFOLENBQVVyRSxJQUFWO0FBQ0EsV0FBT0EsSUFBUDtBQUNILEdBWk0sQ0FBUDtBQWFIOztBQVNELFNBQVM5Qiw4QkFBVCxDQUF3Q1IsV0FBeEMsRUFBcURnQyxLQUFyRCxFQUE0RGpDLGNBQTVELEVBQTRFO0FBQ3hFLE1BQUlyQyxDQUFDLENBQUN1QyxhQUFGLENBQWdCK0IsS0FBaEIsQ0FBSixFQUE0QjtBQUN4QixRQUFJQSxLQUFLLENBQUM5QixPQUFOLEtBQWtCLFlBQXRCLEVBQW9DO0FBQ2hDLGFBQU95RixpQkFBaUIsQ0FBQzNGLFdBQUQsRUFBY2dDLEtBQWQsRUFBcUJqQyxjQUFyQixDQUF4QjtBQUNIOztBQUVELFFBQUlpQyxLQUFLLENBQUM5QixPQUFOLEtBQWtCLGlCQUF0QixFQUF5QztBQUNyQyxVQUFJLENBQUUwRyxPQUFGLEVBQVcsR0FBR0MsSUFBZCxJQUF1QjdJLHNCQUFzQixDQUFDZ0UsS0FBSyxDQUFDTSxJQUFQLENBQWpEO0FBRUEsVUFBSXdFLFVBQUo7O0FBRUEsVUFBSSxDQUFDL0csY0FBYyxDQUFDNEQsU0FBZixDQUF5QmlELE9BQXpCLENBQUwsRUFBd0M7QUFDcEMsY0FBTSxJQUFJM0YsS0FBSixDQUFXLGtDQUFpQ2UsS0FBSyxDQUFDTSxJQUFLLEVBQXZELENBQU47QUFDSDs7QUFFRCxVQUFJdkMsY0FBYyxDQUFDNEQsU0FBZixDQUF5QmlELE9BQXpCLEVBQWtDN0MsSUFBbEMsS0FBMkMsUUFBM0MsSUFBdUQsQ0FBQ2hFLGNBQWMsQ0FBQzRELFNBQWYsQ0FBeUJpRCxPQUF6QixFQUFrQ0csT0FBOUYsRUFBdUc7QUFDbkdELFFBQUFBLFVBQVUsR0FBR0YsT0FBYjtBQUNILE9BRkQsTUFFTyxJQUFJQSxPQUFPLEtBQUssUUFBWixJQUF3QkMsSUFBSSxDQUFDdkIsTUFBTCxHQUFjLENBQTFDLEVBQTZDO0FBRWhELFlBQUkwQixZQUFZLEdBQUdILElBQUksQ0FBQ1AsR0FBTCxFQUFuQjs7QUFDQSxZQUFJVSxZQUFZLEtBQUtoSCxXQUFyQixFQUFrQztBQUM5QjhHLFVBQUFBLFVBQVUsR0FBR0UsWUFBWSxHQUFHLFFBQTVCO0FBQ0g7QUFDSixPQU5NLE1BTUEsSUFBSXRKLENBQUMsQ0FBQ2tGLE9BQUYsQ0FBVWlFLElBQVYsQ0FBSixFQUFxQjtBQUN4QkMsUUFBQUEsVUFBVSxHQUFHRixPQUFPLEdBQUcsUUFBdkI7QUFDSDs7QUFFRCxVQUFJRSxVQUFKLEVBQWdCO0FBQ1p4RyxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUIrRyxVQUFqQixFQUE2QjlHLFdBQTdCLENBQVQ7QUFDSDs7QUFFRCxhQUFPaUcsd0JBQXdCLENBQUNqRyxXQUFELEVBQWNnQyxLQUFkLEVBQXFCakMsY0FBckIsQ0FBL0I7QUFDSDs7QUFFRCxRQUFJaUMsS0FBSyxDQUFDOUIsT0FBTixLQUFrQixRQUF0QixFQUFnQztBQUM1QkgsTUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnhCLFdBQXRCLElBQXFDbkMsTUFBTSxDQUFDaUUsUUFBUCxDQUFnQkUsS0FBaEIsQ0FBckM7QUFDQSxhQUFPaEMsV0FBUDtBQUNIOztBQUVELFFBQUlnQyxLQUFLLENBQUNpRixPQUFOLEtBQWtCLGFBQXRCLEVBQXFDO0FBQ2pDbEgsTUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnhCLFdBQXRCLElBQXFDbkMsTUFBTSxDQUFDaUUsUUFBUCxDQUFnQm9GLG9CQUFvQixDQUFDbEYsS0FBSyxDQUFDTSxJQUFQLENBQXBDLENBQXJDO0FBQ0EsYUFBT3RDLFdBQVA7QUFDSDs7QUFFRGdDLElBQUFBLEtBQUssR0FBR3RFLENBQUMsQ0FBQ3lKLFNBQUYsQ0FBWW5GLEtBQVosRUFBbUIsQ0FBQ29GLGNBQUQsRUFBaUJDLEdBQWpCLEtBQXlCO0FBQ2hELFVBQUlDLEdBQUcsR0FBR2xILFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLEdBQWQsR0FBb0JxSCxHQUFyQyxDQUF0QjtBQUNBLFVBQUlFLEdBQUcsR0FBRy9HLDhCQUE4QixDQUFDOEcsR0FBRCxFQUFNRixjQUFOLEVBQXNCckgsY0FBdEIsQ0FBeEM7O0FBQ0EsVUFBSXVILEdBQUcsS0FBS0MsR0FBWixFQUFpQjtBQUNiakgsUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCd0gsR0FBakIsRUFBc0J2SCxXQUF0QixDQUFUO0FBQ0g7O0FBQ0QsYUFBT0QsY0FBYyxDQUFDeUIsTUFBZixDQUFzQitGLEdBQXRCLENBQVA7QUFDSCxLQVBPLENBQVI7QUFRSCxHQW5ERCxNQW1ETyxJQUFJL0MsS0FBSyxDQUFDQyxPQUFOLENBQWN6QyxLQUFkLENBQUosRUFBMEI7QUFDN0JBLElBQUFBLEtBQUssR0FBR3RFLENBQUMsQ0FBQzZJLEdBQUYsQ0FBTXZFLEtBQU4sRUFBYSxDQUFDb0YsY0FBRCxFQUFpQkksS0FBakIsS0FBMkI7QUFDNUMsVUFBSUYsR0FBRyxHQUFHbEgsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsR0FBZCxHQUFvQndILEtBQXBCLEdBQTRCLEdBQTdDLENBQXRCO0FBQ0EsVUFBSUQsR0FBRyxHQUFHL0csOEJBQThCLENBQUM4RyxHQUFELEVBQU1GLGNBQU4sRUFBc0JySCxjQUF0QixDQUF4Qzs7QUFDQSxVQUFJdUgsR0FBRyxLQUFLQyxHQUFaLEVBQWlCO0FBQ2JqSCxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJ3SCxHQUFqQixFQUFzQnZILFdBQXRCLENBQVQ7QUFDSDs7QUFDRCxhQUFPRCxjQUFjLENBQUN5QixNQUFmLENBQXNCK0YsR0FBdEIsQ0FBUDtBQUNILEtBUE8sQ0FBUjtBQVFIOztBQUVEeEgsRUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnhCLFdBQXRCLElBQXFDbkMsTUFBTSxDQUFDaUUsUUFBUCxDQUFnQkUsS0FBaEIsQ0FBckM7QUFDQSxTQUFPaEMsV0FBUDtBQUNIOztBQUVELFNBQVNrSCxvQkFBVCxDQUE4QjVFLElBQTlCLEVBQW9DO0FBQ2hDLE1BQUlBLElBQUksS0FBSyxLQUFiLEVBQW9CO0FBQ2hCLFdBQU87QUFDSCxjQUFRLGdCQURMO0FBRUgsZ0JBQVU7QUFDTixnQkFBUSxrQkFERjtBQUVOLG9CQUFZLEtBRk47QUFHTixrQkFBVTtBQUNOLGtCQUFRLGtCQURGO0FBRU4sc0JBQVksS0FGTjtBQUdOLG9CQUFVO0FBQ04sb0JBQVEsa0JBREY7QUFFTix3QkFBWSxLQUZOO0FBR04sc0JBQVU7QUFDTixzQkFBUSxZQURGO0FBRU4sc0JBQVE7QUFGRixhQUhKO0FBT04sd0JBQVk7QUFDUixzQkFBUSxZQURBO0FBRVIsc0JBQVE7QUFGQTtBQVBOLFdBSEo7QUFlTixzQkFBWTtBQUNSLG9CQUFRLFlBREE7QUFFUixvQkFBUTtBQUZBO0FBZk4sU0FISjtBQXVCTixvQkFBWTtBQUNSLGtCQUFRLFlBREE7QUFFUixrQkFBUTtBQUZBO0FBdkJOLE9BRlA7QUE4QkgsbUJBQWE7QUE5QlYsS0FBUDtBQWdDSDs7QUFFRCxRQUFNLElBQUlyQixLQUFKLENBQVUsa0JBQWtCcUIsSUFBNUIsQ0FBTjtBQUNIOztBQVNELFNBQVNGLGFBQVQsQ0FBdUJMLE1BQXZCLEVBQStCSSxJQUEvQixFQUFxQ3BDLGNBQXJDLEVBQXFEO0FBQ2pEb0MsRUFBQUEsSUFBSSxHQUFHekUsQ0FBQyxDQUFDMEcsU0FBRixDQUFZakMsSUFBWixDQUFQO0FBQ0EsTUFBSXpFLENBQUMsQ0FBQ2tGLE9BQUYsQ0FBVVQsSUFBVixDQUFKLEVBQXFCLE9BQU8sRUFBUDtBQUVyQixNQUFJRCxRQUFRLEdBQUcsRUFBZjs7QUFFQXhFLEVBQUFBLENBQUMsQ0FBQytKLElBQUYsQ0FBT3RGLElBQVAsRUFBYSxDQUFDaUUsR0FBRCxFQUFNQyxDQUFOLEtBQVk7QUFDckIsUUFBSXFCLFNBQVMsR0FBR3RILFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmdDLE1BQU0sR0FBRyxPQUFULEdBQW1CLENBQUNzRSxDQUFDLEdBQUMsQ0FBSCxFQUFNeEMsUUFBTixFQUFuQixHQUFzQyxHQUF2RCxDQUE1QjtBQUNBLFFBQUlnQyxVQUFVLEdBQUdyRiw4QkFBOEIsQ0FBQ2tILFNBQUQsRUFBWXRCLEdBQVosRUFBaUJyRyxjQUFqQixDQUEvQztBQUVBTyxJQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUI4RixVQUFqQixFQUE2QjlELE1BQTdCLENBQVQ7QUFFQUcsSUFBQUEsUUFBUSxHQUFHQSxRQUFRLENBQUNLLE1BQVQsQ0FBZ0I3RSxDQUFDLENBQUMwRyxTQUFGLENBQVl6RCx1QkFBdUIsQ0FBQ2tGLFVBQUQsRUFBYTlGLGNBQWIsQ0FBbkMsQ0FBaEIsQ0FBWDtBQUNILEdBUEQ7O0FBU0EsU0FBT21DLFFBQVA7QUFDSDs7QUFTRCxTQUFTeUYsWUFBVCxDQUFzQkgsS0FBdEIsRUFBNkJJLEtBQTdCLEVBQW9DN0gsY0FBcEMsRUFBb0Q7QUFDaEQsTUFBSWdFLElBQUksR0FBRzZELEtBQUssQ0FBQzdELElBQWpCO0FBRUEsTUFBSThELFVBQVUsR0FBRzNKLEtBQUssQ0FBQzZGLElBQUQsQ0FBdEI7O0FBRUEsTUFBSSxDQUFDOEQsVUFBTCxFQUFpQjtBQUNiLFVBQU0sSUFBSTVHLEtBQUosQ0FBVSx5QkFBeUI4QyxJQUFuQyxDQUFOO0FBQ0g7O0FBRUQsTUFBSStELGFBQWEsR0FBSSxTQUFRL0QsSUFBSSxDQUFDZ0UsV0FBTCxFQUFtQixXQUFoRDtBQUVBLE1BQUlDLE1BQU0sR0FBR25LLE1BQU0sQ0FBQ3VGLFNBQVAsQ0FBaUJ3RSxLQUFLLENBQUN0RixJQUF2QixDQUFiO0FBQ0EsTUFBSTJGLE9BQU8sR0FBR3BLLE1BQU0sQ0FBQytELE9BQVAsQ0FBZWtHLGFBQWYsRUFBOEIsQ0FBQ0UsTUFBRCxFQUFTbkssTUFBTSxDQUFDcUssY0FBUCxDQUFzQixjQUF0QixFQUFzQ1YsS0FBdEMsQ0FBVCxFQUF1RDNKLE1BQU0sQ0FBQ3VGLFNBQVAsQ0FBaUIsY0FBakIsQ0FBdkQsQ0FBOUIsQ0FBZDtBQUVBLE1BQUkrRSxhQUFhLEdBQUcvSCxZQUFZLENBQUNMLGNBQUQsRUFBaUIsc0JBQXNCeUgsS0FBSyxDQUFDM0QsUUFBTixFQUF0QixHQUF5QyxHQUExRCxDQUFoQztBQWFBOUQsRUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQjJHLGFBQXRCLElBQXVDLENBQ25DdEssTUFBTSxDQUFDdUssU0FBUCxDQUFpQkosTUFBakIsRUFBeUJDLE9BQXpCLEVBQW1DLHNCQUFxQkwsS0FBSyxDQUFDdEYsSUFBSyxHQUFuRSxDQURtQyxDQUF2QztBQUlBMkIsRUFBQUEsWUFBWSxDQUFDbEUsY0FBRCxFQUFpQm9JLGFBQWpCLEVBQWdDO0FBQ3hDcEUsSUFBQUEsSUFBSSxFQUFFcEY7QUFEa0MsR0FBaEMsQ0FBWjtBQUlBMkIsRUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCb0ksYUFBakIsRUFBZ0NwSSxjQUFjLENBQUNzSSxXQUEvQyxDQUFUO0FBRUEsTUFBSXRHLE1BQU0sR0FBRzNCLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQjZILEtBQUssQ0FBQ3RGLElBQXZCLENBQXpCO0FBQ0FoQyxFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJBLGNBQWMsQ0FBQ3NJLFdBQWhDLEVBQTZDdEcsTUFBN0MsQ0FBVDtBQUVBLE1BQUlDLEtBQUssR0FBR3NHLGtCQUFrQixDQUFDVixLQUFLLENBQUN0RixJQUFQLEVBQWFzRixLQUFiLENBQTlCO0FBQ0EsTUFBSXpILFNBQVMsR0FBRzhGLHdCQUF3QixDQUFDbEUsTUFBRCxFQUFTQyxLQUFULEVBQWdCakMsY0FBaEIsQ0FBeEM7QUFFQSxNQUFJd0ksV0FBVyxHQUFHbkksWUFBWSxDQUFDTCxjQUFELEVBQWlCZ0MsTUFBTSxHQUFHLFFBQTFCLENBQTlCO0FBQ0F6QixFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJJLFNBQWpCLEVBQTRCb0ksV0FBNUIsQ0FBVDtBQUVBLFNBQU9BLFdBQVA7QUFDSDs7QUFRRCxTQUFTQyxZQUFULENBQXNCQyxTQUF0QixFQUFpQ2IsS0FBakMsRUFBd0M3SCxjQUF4QyxFQUF3RDtBQUtwRCxNQUFJZ0MsTUFBTSxHQUFHM0IsWUFBWSxDQUFDTCxjQUFELEVBQWlCMEksU0FBakIsQ0FBekI7QUFDQSxNQUFJQyxXQUFXLEdBQUcsWUFBWUQsU0FBOUI7QUFHQSxNQUFJekcsS0FBSyxHQUFHc0csa0JBQWtCLENBQUNJLFdBQUQsRUFBY2QsS0FBZCxDQUE5QjtBQUNBLE1BQUl6SCxTQUFTLEdBQUdLLDhCQUE4QixDQUFDdUIsTUFBRCxFQUFTQyxLQUFULEVBQWdCakMsY0FBaEIsQ0FBOUM7QUFFQSxNQUFJd0ksV0FBVyxHQUFHbkksWUFBWSxDQUFDTCxjQUFELEVBQWlCZ0MsTUFBTSxHQUFHLFFBQTFCLENBQTlCO0FBQ0F6QixFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJJLFNBQWpCLEVBQTRCb0ksV0FBNUIsQ0FBVDtBQUVBLFNBQU9BLFdBQVA7QUFDSDs7QUFFRCxTQUFTRCxrQkFBVCxDQUE0QmhHLElBQTVCLEVBQWtDTixLQUFsQyxFQUF5QztBQUNyQyxNQUFJa0IsR0FBRyxHQUFHeUYsTUFBTSxDQUFDQyxNQUFQLENBQWM7QUFBRTFJLElBQUFBLE9BQU8sRUFBRSxpQkFBWDtBQUE4Qm9DLElBQUFBLElBQUksRUFBRUE7QUFBcEMsR0FBZCxDQUFWOztBQUVBLE1BQUksQ0FBQzVFLENBQUMsQ0FBQ2tGLE9BQUYsQ0FBVVosS0FBSyxDQUFDOEQsU0FBaEIsQ0FBTCxFQUFpQztBQUM3QixXQUFPO0FBQUU1RixNQUFBQSxPQUFPLEVBQUUsWUFBWDtBQUF5QjhCLE1BQUFBLEtBQUssRUFBRWtCLEdBQWhDO0FBQXFDNEMsTUFBQUEsU0FBUyxFQUFFOUQsS0FBSyxDQUFDOEQ7QUFBdEQsS0FBUDtBQUNIOztBQUVELFNBQU81QyxHQUFQO0FBQ0g7O0FBRUQsU0FBUzJGLGFBQVQsQ0FBdUJDLE9BQXZCLEVBQWdDL0ksY0FBaEMsRUFBZ0Q7QUFDNUMsTUFBSXJDLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0I2SSxPQUFoQixLQUE0QkEsT0FBTyxDQUFDNUksT0FBUixLQUFvQixpQkFBcEQsRUFBdUU7QUFDbkUsUUFBSSxDQUFFNkksT0FBRixFQUFXLEdBQUdsQyxJQUFkLElBQXVCaUMsT0FBTyxDQUFDeEcsSUFBUixDQUFhMEcsS0FBYixDQUFtQixHQUFuQixDQUEzQjtBQUVBLFdBQU9qSixjQUFjLENBQUM0RCxTQUFmLENBQXlCb0YsT0FBekIsS0FBcUNoSixjQUFjLENBQUM0RCxTQUFmLENBQXlCb0YsT0FBekIsRUFBa0NoQyxPQUF2RSxJQUFrRkYsSUFBSSxDQUFDdkIsTUFBTCxHQUFjLENBQXZHO0FBQ0g7O0FBRUQsU0FBTyxLQUFQO0FBQ0g7O0FBVUQsU0FBUzJELHNCQUFULENBQWdDQyxPQUFoQyxFQUF5Q0MsS0FBekMsRUFBZ0RDLElBQWhELEVBQXNEckosY0FBdEQsRUFBc0U7QUFDbEUsTUFBSXJDLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0JtSixJQUFoQixDQUFKLEVBQTJCO0FBQ3ZCLFFBQUlBLElBQUksQ0FBQ2xKLE9BQUwsS0FBaUIsaUJBQXJCLEVBQXdDO0FBQ3BDLFVBQUlpQyxJQUFKOztBQUNBLFVBQUlpSCxJQUFJLENBQUNqSCxJQUFULEVBQWU7QUFDWEEsUUFBQUEsSUFBSSxHQUFHQyxhQUFhLENBQUM4RyxPQUFELEVBQVVFLElBQUksQ0FBQ2pILElBQWYsRUFBcUJwQyxjQUFyQixDQUFwQjtBQUNILE9BRkQsTUFFTztBQUNIb0MsUUFBQUEsSUFBSSxHQUFHLEVBQVA7QUFDSDs7QUFDRCxhQUFPdEUsTUFBTSxDQUFDd0wsUUFBUCxDQUFnQkQsSUFBSSxDQUFDRSxTQUFMLElBQWtCN0ssWUFBbEMsRUFBZ0QySyxJQUFJLENBQUNHLE9BQUwsSUFBZ0JwSCxJQUFoRSxDQUFQO0FBQ0g7O0FBRUQsUUFBSWlILElBQUksQ0FBQ2xKLE9BQUwsS0FBaUIsa0JBQXJCLEVBQXlDO0FBQ3JDLGFBQU9zSix1QkFBdUIsQ0FBQ04sT0FBRCxFQUFVQyxLQUFWLEVBQWlCQyxJQUFJLENBQUNwSCxLQUF0QixFQUE2QmpDLGNBQTdCLENBQTlCO0FBQ0g7QUFDSjs7QUFHRCxNQUFJckMsQ0FBQyxDQUFDK0csT0FBRixDQUFVMkUsSUFBVixLQUFtQjFMLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0JtSixJQUFoQixDQUF2QixFQUE4QztBQUMxQyxRQUFJSyxVQUFVLEdBQUdqSiw4QkFBOEIsQ0FBQzBJLE9BQUQsRUFBVUUsSUFBVixFQUFnQnJKLGNBQWhCLENBQS9DO0FBQ0FxSixJQUFBQSxJQUFJLEdBQUdySixjQUFjLENBQUN5QixNQUFmLENBQXNCaUksVUFBdEIsQ0FBUDtBQUNIOztBQUVELFNBQU81TCxNQUFNLENBQUM2TCxTQUFQLENBQWlCTixJQUFqQixDQUFQO0FBQ0g7O0FBV0QsU0FBU08sZ0JBQVQsQ0FBMEJULE9BQTFCLEVBQW1DQyxLQUFuQyxFQUEwQ0MsSUFBMUMsRUFBZ0RySixjQUFoRCxFQUFnRTZKLFFBQWhFLEVBQTBFO0FBQ3RFLE1BQUlsTSxDQUFDLENBQUN1QyxhQUFGLENBQWdCbUosSUFBaEIsQ0FBSixFQUEyQjtBQUN2QixRQUFJQSxJQUFJLENBQUNsSixPQUFMLEtBQWlCLGlCQUFyQixFQUF3QztBQUNwQyxVQUFJaUMsSUFBSjs7QUFDQSxVQUFJaUgsSUFBSSxDQUFDakgsSUFBVCxFQUFlO0FBQ1hBLFFBQUFBLElBQUksR0FBR0MsYUFBYSxDQUFDOEcsT0FBRCxFQUFVRSxJQUFJLENBQUNqSCxJQUFmLEVBQXFCcEMsY0FBckIsQ0FBcEI7QUFDSCxPQUZELE1BRU87QUFDSG9DLFFBQUFBLElBQUksR0FBRyxFQUFQO0FBQ0g7O0FBQ0QsYUFBT3RFLE1BQU0sQ0FBQ3dMLFFBQVAsQ0FBZ0JELElBQUksQ0FBQ0UsU0FBTCxJQUFrQjdLLFlBQWxDLEVBQWdEMkssSUFBSSxDQUFDRyxPQUFMLElBQWdCcEgsSUFBaEUsQ0FBUDtBQUNIOztBQUVELFFBQUlpSCxJQUFJLENBQUNsSixPQUFMLEtBQWlCLG1CQUFyQixFQUEwQyxDQWV6Qzs7QUFFRCxRQUFJa0osSUFBSSxDQUFDbEosT0FBTCxLQUFpQixrQkFBckIsRUFBeUM7QUFDckMsVUFBSSxDQUFDMkksYUFBYSxDQUFDTyxJQUFJLENBQUMvSCxJQUFOLEVBQVl0QixjQUFaLENBQWxCLEVBQStDO0FBQzNDLGNBQU0sSUFBSWtCLEtBQUosQ0FBVSx1RUFBVixDQUFOO0FBQ0g7O0FBRUQsVUFBSTRILGFBQWEsQ0FBQ08sSUFBSSxDQUFDN0gsS0FBTixFQUFheEIsY0FBYixDQUFqQixFQUErQztBQUMzQyxjQUFNLElBQUlrQixLQUFKLENBQVUsdUhBQVYsQ0FBTjtBQUNIOztBQUVELFVBQUk0SSxTQUFTLEdBQUcsRUFBaEI7QUFDQSxVQUFJQyxZQUFZLEdBQUcxSixZQUFZLENBQUNMLGNBQUQsRUFBaUJtSixPQUFPLEdBQUcsY0FBM0IsQ0FBL0I7QUFDQTVJLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQm1KLE9BQWpCLEVBQTBCWSxZQUExQixDQUFUO0FBRUEsVUFBSXhJLFdBQVcsR0FBR2QsOEJBQThCLENBQUNzSixZQUFELEVBQWVWLElBQUksQ0FBQzdILEtBQXBCLEVBQTJCeEIsY0FBM0IsQ0FBaEQ7QUFDQU8sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCdUIsV0FBakIsRUFBOEI2SCxLQUE5QixDQUFUOztBQUVBLFVBQUlDLElBQUksQ0FBQ3BJLFFBQUwsS0FBa0IsSUFBdEIsRUFBNEI7QUFDeEI2SSxRQUFBQSxTQUFTLENBQUNULElBQUksQ0FBQy9ILElBQUwsQ0FBVWlCLElBQVYsQ0FBZTBHLEtBQWYsQ0FBcUIsR0FBckIsRUFBMEIsQ0FBMUIsRUFBNkIsQ0FBN0IsQ0FBRCxDQUFULEdBQTZDakosY0FBYyxDQUFDeUIsTUFBZixDQUFzQkYsV0FBdEIsQ0FBN0M7QUFDSCxPQUZELE1BRU87QUFDSHVJLFFBQUFBLFNBQVMsQ0FBQ1QsSUFBSSxDQUFDL0gsSUFBTCxDQUFVaUIsSUFBVixDQUFlMEcsS0FBZixDQUFxQixHQUFyQixFQUEwQixDQUExQixFQUE2QixDQUE3QixDQUFELENBQVQsR0FBNkM7QUFBRSxXQUFDcEosY0FBYyxDQUFDbUIsRUFBRCxDQUFmLEdBQXNCaEIsY0FBYyxDQUFDeUIsTUFBZixDQUFzQkYsV0FBdEI7QUFBeEIsU0FBN0M7QUFDSDs7QUFFRCxhQUFPekQsTUFBTSxDQUFDdUssU0FBUCxDQUFpQndCLFFBQWpCLEVBQTJCL0wsTUFBTSxDQUFDaUUsUUFBUCxDQUFnQitILFNBQWhCLENBQTNCLENBQVA7QUFDSDs7QUFFRCxRQUFJVCxJQUFJLENBQUNsSixPQUFMLEtBQWlCLGlCQUFyQixFQUF3QyxDQUV2QztBQUNKOztBQUdELE1BQUl4QyxDQUFDLENBQUMrRyxPQUFGLENBQVUyRSxJQUFWLEtBQW1CMUwsQ0FBQyxDQUFDdUMsYUFBRixDQUFnQm1KLElBQWhCLENBQXZCLEVBQThDO0FBQzFDLFFBQUlLLFVBQVUsR0FBR2pKLDhCQUE4QixDQUFDMEksT0FBRCxFQUFVRSxJQUFWLEVBQWdCckosY0FBaEIsQ0FBL0M7QUFDQXFKLElBQUFBLElBQUksR0FBR3JKLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JpSSxVQUF0QixDQUFQO0FBQ0g7O0FBRUQsU0FBTzVMLE1BQU0sQ0FBQ3VLLFNBQVAsQ0FBaUJ3QixRQUFqQixFQUEyQlIsSUFBM0IsQ0FBUDtBQUNIOztBQVVELFNBQVNJLHVCQUFULENBQWlDeEosV0FBakMsRUFBOENHLFNBQTlDLEVBQXlENkIsS0FBekQsRUFBZ0VqQyxjQUFoRSxFQUFnRjtBQUM1RSxNQUFJZ0ssV0FBVyxHQUFHdkosOEJBQThCLENBQUNSLFdBQUQsRUFBY2dDLEtBQWQsRUFBcUJqQyxjQUFyQixDQUFoRDs7QUFDQSxNQUFJZ0ssV0FBVyxLQUFLL0osV0FBcEIsRUFBaUM7QUFDN0JNLElBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQmdLLFdBQWpCLEVBQThCNUosU0FBOUIsQ0FBVDtBQUNIOztBQUVELFNBQU90QyxNQUFNLENBQUM2TCxTQUFQLENBQWlCL0ksdUJBQXVCLENBQUNvSixXQUFELEVBQWNoSyxjQUFkLENBQXhDLENBQVA7QUFDSDs7QUFTRCxTQUFTaUssYUFBVCxDQUF1QmhLLFdBQXZCLEVBQW9DZ0MsS0FBcEMsRUFBMkNqQyxjQUEzQyxFQUEyRDtBQUN2RCxNQUFJSSxTQUFTLEdBQUdDLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQixTQUFqQixDQUE1QjtBQUNBTyxFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCRyxTQUE5QixDQUFUO0FBRUFKLEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3FKLHVCQUF1QixDQUFDeEosV0FBRCxFQUFjRyxTQUFkLEVBQXlCNkIsS0FBekIsRUFBZ0NqQyxjQUFoQyxDQUExRDtBQUVBa0UsRUFBQUEsWUFBWSxDQUFDbEUsY0FBRCxFQUFpQkksU0FBakIsRUFBNEI7QUFDcEM0RCxJQUFBQSxJQUFJLEVBQUUvRTtBQUQ4QixHQUE1QixDQUFaO0FBSUEsU0FBT21CLFNBQVA7QUFDSDs7QUFVRCxTQUFTOEosY0FBVCxDQUF3QnpDLEtBQXhCLEVBQStCMEMsU0FBL0IsRUFBMENuSyxjQUExQyxFQUEwRCtHLFVBQTFELEVBQXNFO0FBQUEsT0FDN0RBLFVBRDZEO0FBQUE7QUFBQTs7QUFHbEUsTUFBSTNHLFNBQVMsR0FBR0MsWUFBWSxDQUFDTCxjQUFELEVBQWlCLFFBQVF5SCxLQUFLLENBQUMzRCxRQUFOLEVBQXpCLENBQTVCO0FBQ0EsTUFBSXNHLGdCQUFnQixHQUFHaEssU0FBUyxHQUFHLFlBQW5DO0FBRUEsTUFBSWlLLEdBQUcsR0FBRyxDQUNOdk0sTUFBTSxDQUFDd00sYUFBUCxDQUFxQkYsZ0JBQXJCLENBRE0sQ0FBVjs7QUFOa0UsT0FVMURELFNBQVMsQ0FBQ0wsU0FWZ0Q7QUFBQTtBQUFBOztBQVlsRTlKLEVBQUFBLGNBQWMsQ0FBQzRELFNBQWYsQ0FBeUJ1RyxTQUFTLENBQUNJLEtBQW5DLElBQTRDO0FBQUV2RyxJQUFBQSxJQUFJLEVBQUUsUUFBUjtBQUFrQkMsSUFBQUEsTUFBTSxFQUFFLFNBQTFCO0FBQXFDK0MsSUFBQUEsT0FBTyxFQUFFO0FBQTlDLEdBQTVDOztBQUVBLE1BQUltRCxTQUFTLENBQUNMLFNBQVYsQ0FBb0IzSixPQUF4QixFQUFpQztBQUc3QixRQUFJZ0ssU0FBUyxDQUFDTCxTQUFWLENBQW9CM0osT0FBcEIsS0FBZ0MsT0FBcEMsRUFBNkM7QUFDekMsVUFBSXFLLFlBQVksR0FBR3BLLFNBQVMsR0FBRyxRQUEvQjtBQUNBLFVBQUlxSyxhQUFKOztBQUVBLFVBQUlOLFNBQVMsQ0FBQ0wsU0FBVixDQUFvQlksSUFBeEIsRUFBOEI7QUFDMUIsWUFBSUMsU0FBUyxHQUFHdEssWUFBWSxDQUFDTCxjQUFELEVBQWlCd0ssWUFBWSxHQUFHLE9BQWhDLENBQTVCO0FBQ0EsWUFBSUksT0FBTyxHQUFHdkssWUFBWSxDQUFDTCxjQUFELEVBQWlCd0ssWUFBWSxHQUFHLE1BQWhDLENBQTFCO0FBQ0FqSyxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUIySyxTQUFqQixFQUE0QkMsT0FBNUIsQ0FBVDtBQUNBckssUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCNEssT0FBakIsRUFBMEJ4SyxTQUExQixDQUFUO0FBRUFxSyxRQUFBQSxhQUFhLEdBQUdiLGdCQUFnQixDQUFDZSxTQUFELEVBQVlDLE9BQVosRUFBcUJULFNBQVMsQ0FBQ0wsU0FBVixDQUFvQlksSUFBekMsRUFBK0MxSyxjQUEvQyxFQUErRG9LLGdCQUEvRCxDQUFoQztBQUNILE9BUEQsTUFPTztBQUNISyxRQUFBQSxhQUFhLEdBQUczTSxNQUFNLENBQUN3TCxRQUFQLENBQWdCLGFBQWhCLEVBQStCLG1CQUEvQixDQUFoQjtBQUNIOztBQUVELFVBQUkzTCxDQUFDLENBQUNrRixPQUFGLENBQVVzSCxTQUFTLENBQUNMLFNBQVYsQ0FBb0JlLEtBQTlCLENBQUosRUFBMEM7QUFDdEMsY0FBTSxJQUFJM0osS0FBSixDQUFVLG9CQUFWLENBQU47QUFDSDs7QUFFRHZELE1BQUFBLENBQUMsQ0FBQ21OLE9BQUYsQ0FBVVgsU0FBUyxDQUFDTCxTQUFWLENBQW9CZSxLQUE5QixFQUFxQ3RHLE9BQXJDLENBQTZDLENBQUN3RyxJQUFELEVBQU96RSxDQUFQLEtBQWE7QUFDdEQsWUFBSXlFLElBQUksQ0FBQzVLLE9BQUwsS0FBaUIsc0JBQXJCLEVBQTZDO0FBQ3pDLGdCQUFNLElBQUllLEtBQUosQ0FBVSxvQkFBVixDQUFOO0FBQ0g7O0FBRURvRixRQUFBQSxDQUFDLEdBQUc2RCxTQUFTLENBQUNMLFNBQVYsQ0FBb0JlLEtBQXBCLENBQTBCdEYsTUFBMUIsR0FBbUNlLENBQW5DLEdBQXVDLENBQTNDO0FBRUEsWUFBSTBFLFVBQVUsR0FBR1IsWUFBWSxHQUFHLEdBQWYsR0FBcUJsRSxDQUFDLENBQUN4QyxRQUFGLEVBQXJCLEdBQW9DLEdBQXJEO0FBQ0EsWUFBSW1ILFVBQVUsR0FBRzVLLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmdMLFVBQWpCLENBQTdCO0FBQ0F6SyxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUIrRyxVQUFqQixFQUE2QmtFLFVBQTdCLENBQVQ7QUFFQSxZQUFJQyxpQkFBaUIsR0FBRyxNQUFNVixZQUFOLEdBQXFCLEdBQXJCLEdBQTJCbEUsQ0FBQyxDQUFDeEMsUUFBRixFQUFuRDtBQUVBLFlBQUlnQyxVQUFVLEdBQUdoRyw0QkFBNEIsQ0FBQ2lMLElBQUksQ0FBQ2hMLElBQU4sRUFBWUMsY0FBWixFQUE0QmlMLFVBQTVCLENBQTdDO0FBQ0EsWUFBSUUsV0FBVyxHQUFHdkssdUJBQXVCLENBQUNrRixVQUFELEVBQWE5RixjQUFiLENBQXpDOztBQWRzRCxhQWdCOUMsQ0FBQ3lFLEtBQUssQ0FBQ0MsT0FBTixDQUFjeUcsV0FBZCxDQWhCNkM7QUFBQSwwQkFnQmpCLHdCQWhCaUI7QUFBQTs7QUFrQnREQSxRQUFBQSxXQUFXLEdBQUdyTixNQUFNLENBQUN3TSxhQUFQLENBQXFCWSxpQkFBckIsRUFBd0NDLFdBQXhDLEVBQXFELElBQXJELEVBQTJELEtBQTNELEVBQW1FLGFBQVk3RSxDQUFFLGlCQUFnQjZELFNBQVMsQ0FBQ0ksS0FBTSxFQUFqSCxDQUFkO0FBRUEsWUFBSWEsT0FBTyxHQUFHL0ssWUFBWSxDQUFDTCxjQUFELEVBQWlCZ0wsVUFBVSxHQUFHLE9BQTlCLENBQTFCO0FBQ0EsWUFBSUssS0FBSyxHQUFHaEwsWUFBWSxDQUFDTCxjQUFELEVBQWlCZ0wsVUFBVSxHQUFHLE1BQTlCLENBQXhCO0FBQ0F6SyxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUI4RixVQUFqQixFQUE2QnNGLE9BQTdCLENBQVQ7QUFDQTdLLFFBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQm9MLE9BQWpCLEVBQTBCQyxLQUExQixDQUFUO0FBRUFaLFFBQUFBLGFBQWEsR0FBRyxDQUNaVSxXQURZLEVBRVpyTixNQUFNLENBQUN3TixLQUFQLENBQWF4TixNQUFNLENBQUN1RixTQUFQLENBQWlCNkgsaUJBQWpCLENBQWIsRUFBa0RwTixNQUFNLENBQUN5TixRQUFQLENBQWdCM0IsZ0JBQWdCLENBQUN3QixPQUFELEVBQVVDLEtBQVYsRUFBaUJOLElBQUksQ0FBQzFCLElBQXRCLEVBQTRCckosY0FBNUIsRUFBNENvSyxnQkFBNUMsQ0FBaEMsQ0FBbEQsRUFBa0pLLGFBQWxKLENBRlksQ0FBaEI7QUFJQWxLLFFBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQnFMLEtBQWpCLEVBQXdCakwsU0FBeEIsQ0FBVDtBQUNILE9BOUJEOztBQWdDQWlLLE1BQUFBLEdBQUcsR0FBR0EsR0FBRyxDQUFDN0gsTUFBSixDQUFXN0UsQ0FBQyxDQUFDMEcsU0FBRixDQUFZb0csYUFBWixDQUFYLENBQU47QUFDSCxLQXBERCxNQW9ETztBQUNILFlBQU0sSUFBSXZKLEtBQUosQ0FBVSxNQUFWLENBQU47QUFDSDtBQUdKLEdBNURELE1BNERPO0FBQ0gsVUFBTSxJQUFJQSxLQUFKLENBQVUsTUFBVixDQUFOO0FBQ0g7O0FBRURtSixFQUFBQSxHQUFHLENBQUN4RixJQUFKLENBQ0kvRyxNQUFNLENBQUN3TSxhQUFQLENBQXFCSCxTQUFTLENBQUNJLEtBQS9CLEVBQXNDek0sTUFBTSxDQUFDc0YsUUFBUCxDQUFpQixlQUFqQixFQUFpQ3RGLE1BQU0sQ0FBQ3VGLFNBQVAsQ0FBaUIrRyxnQkFBakIsQ0FBakMsQ0FBdEMsQ0FESjtBQUlBLFNBQU9wSyxjQUFjLENBQUM0RCxTQUFmLENBQXlCdUcsU0FBUyxDQUFDSSxLQUFuQyxFQUEwQ3ZELE9BQWpEO0FBRUEsTUFBSXdFLFdBQVcsR0FBR25MLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQm1LLFNBQVMsQ0FBQ0ksS0FBM0IsQ0FBOUI7QUFDQWhLLEVBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQkksU0FBakIsRUFBNEJvTCxXQUE1QixDQUFUO0FBQ0F4TCxFQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUNpSyxHQUFuQztBQUNBLFNBQU9qSyxTQUFQO0FBQ0g7O0FBRUQsU0FBU3FMLGtCQUFULENBQTRCaEUsS0FBNUIsRUFBbUMwQyxTQUFuQyxFQUE4Q25LLGNBQTlDLEVBQThEK0csVUFBOUQsRUFBMEU7QUFDdEUsTUFBSWpCLFVBQUo7O0FBRUEsVUFBUXFFLFNBQVMsQ0FBQ2hLLE9BQWxCO0FBQ0ksU0FBSyxrQkFBTDtBQUNJMkYsTUFBQUEsVUFBVSxHQUFHb0UsY0FBYyxDQUFDekMsS0FBRCxFQUFRMEMsU0FBUixFQUFtQm5LLGNBQW5CLEVBQW1DK0csVUFBbkMsQ0FBM0I7QUFDQTs7QUFFSixTQUFLLE1BQUw7QUFFSSxZQUFNLElBQUk3RixLQUFKLENBQVUsS0FBVixDQUFOO0FBQ0E7O0FBRUosU0FBSyxRQUFMO0FBQ0ksWUFBTSxJQUFJQSxLQUFKLENBQVUsS0FBVixDQUFOO0FBRUE7O0FBRUosU0FBSyxRQUFMO0FBQ0ksWUFBTSxJQUFJQSxLQUFKLENBQVUsS0FBVixDQUFOO0FBRUE7O0FBRUosU0FBSyxRQUFMO0FBQ0ksWUFBTSxJQUFJQSxLQUFKLENBQVUsS0FBVixDQUFOO0FBRUE7O0FBRUosU0FBSyxhQUFMO0FBQ0ksVUFBSXdLLE9BQU8sR0FBR3ZCLFNBQVMsQ0FBQ3dCLEVBQXhCO0FBQ0E3RixNQUFBQSxVQUFVLEdBQUc4RixrQkFBa0IsQ0FBQ25FLEtBQUQsRUFBUWlFLE9BQVIsRUFBaUIxTCxjQUFqQixFQUFpQytHLFVBQWpDLENBQS9CO0FBQ0E7O0FBRUosU0FBSyxZQUFMO0FBQ0ksWUFBTSxJQUFJN0YsS0FBSixDQUFVLEtBQVYsQ0FBTjtBQUNBOztBQUVKO0FBQ0ksWUFBTSxJQUFJQSxLQUFKLENBQVUsaUNBQWlDaUosU0FBUyxDQUFDbkcsSUFBckQsQ0FBTjtBQW5DUjs7QUFzQ0FFLEVBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUI4RixVQUFqQixFQUE2QjtBQUNyQzlCLElBQUFBLElBQUksRUFBRTlFO0FBRCtCLEdBQTdCLENBQVo7QUFJQSxTQUFPNEcsVUFBUDtBQUNIOztBQUVELFNBQVM4RixrQkFBVCxDQUE0Qm5FLEtBQTVCLEVBQW1DMEMsU0FBbkMsRUFBOENuSyxjQUE5QyxFQUE4RCtHLFVBQTlELEVBQTBFLENBRXpFOztBQVNELFNBQVM4RSx3QkFBVCxDQUFrQ0MsT0FBbEMsRUFBMkM5TCxjQUEzQyxFQUEyRCtHLFVBQTNELEVBQXVFO0FBQUEsUUFDN0RwSixDQUFDLENBQUN1QyxhQUFGLENBQWdCNEwsT0FBaEIsS0FBNEJBLE9BQU8sQ0FBQzNMLE9BQVIsS0FBb0Isa0JBRGE7QUFBQTtBQUFBOztBQUduRSxNQUFJQyxTQUFTLEdBQUdDLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQixTQUFqQixDQUE1QjtBQUFBLE1BQXlEK0wsZUFBZSxHQUFHaEYsVUFBM0U7O0FBRUEsTUFBSSxDQUFDcEosQ0FBQyxDQUFDa0YsT0FBRixDQUFVaUosT0FBTyxDQUFDRSxVQUFsQixDQUFMLEVBQW9DO0FBQ2hDRixJQUFBQSxPQUFPLENBQUNFLFVBQVIsQ0FBbUJ6SCxPQUFuQixDQUEyQixDQUFDd0csSUFBRCxFQUFPekUsQ0FBUCxLQUFhO0FBQ3BDLFVBQUkzSSxDQUFDLENBQUN1QyxhQUFGLENBQWdCNkssSUFBaEIsQ0FBSixFQUEyQjtBQUN2QixZQUFJQSxJQUFJLENBQUM1SyxPQUFMLEtBQWlCLHNCQUFyQixFQUE2QztBQUN6QyxnQkFBTSxJQUFJZSxLQUFKLENBQVUsbUNBQW1DNkosSUFBSSxDQUFDNUssT0FBbEQsQ0FBTjtBQUNIOztBQUVELFlBQUk4TCxnQkFBZ0IsR0FBRzVMLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkksU0FBUyxHQUFHLFVBQVosR0FBeUJrRyxDQUFDLENBQUN4QyxRQUFGLEVBQXpCLEdBQXdDLEdBQXpELENBQW5DO0FBQ0EsWUFBSW9JLGNBQWMsR0FBRzdMLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkksU0FBUyxHQUFHLFVBQVosR0FBeUJrRyxDQUFDLENBQUN4QyxRQUFGLEVBQXpCLEdBQXdDLFFBQXpELENBQWpDOztBQUNBLFlBQUlpSSxlQUFKLEVBQXFCO0FBQ2pCeEwsVUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCK0wsZUFBakIsRUFBa0NFLGdCQUFsQyxDQUFUO0FBQ0g7O0FBRUQsWUFBSW5HLFVBQVUsR0FBR2hHLDRCQUE0QixDQUFDaUwsSUFBSSxDQUFDaEwsSUFBTixFQUFZQyxjQUFaLEVBQTRCaU0sZ0JBQTVCLENBQTdDO0FBRUEsWUFBSUUsV0FBVyxHQUFHOUwsWUFBWSxDQUFDTCxjQUFELEVBQWlCaU0sZ0JBQWdCLEdBQUcsT0FBcEMsQ0FBOUI7QUFDQTFMLFFBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQjhGLFVBQWpCLEVBQTZCcUcsV0FBN0IsQ0FBVDtBQUNBNUwsUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCbU0sV0FBakIsRUFBOEJELGNBQTlCLENBQVQ7QUFFQWxNLFFBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0J5SyxjQUF0QixJQUF3Q3BPLE1BQU0sQ0FBQ3dOLEtBQVAsQ0FDcEMxSyx1QkFBdUIsQ0FBQ2tGLFVBQUQsRUFBYTlGLGNBQWIsQ0FEYSxFQUVwQ2xDLE1BQU0sQ0FBQ3lOLFFBQVAsQ0FBZ0JyQyxzQkFBc0IsQ0FDbENpRCxXQURrQyxFQUVsQ0QsY0FGa0MsRUFHbENuQixJQUFJLENBQUMxQixJQUg2QixFQUd2QnJKLGNBSHVCLENBQXRDLENBRm9DLEVBTXBDLElBTm9DLEVBT25DLHdCQUF1QnNHLENBQUUsRUFQVSxDQUF4QztBQVVBcEMsUUFBQUEsWUFBWSxDQUFDbEUsY0FBRCxFQUFpQmtNLGNBQWpCLEVBQWlDO0FBQ3pDbEksVUFBQUEsSUFBSSxFQUFFNUU7QUFEbUMsU0FBakMsQ0FBWjtBQUlBMk0sUUFBQUEsZUFBZSxHQUFHRyxjQUFsQjtBQUNILE9BaENELE1BZ0NPO0FBQ0gsY0FBTSxJQUFJaEwsS0FBSixDQUFVLGFBQVYsQ0FBTjtBQUNIO0FBQ0osS0FwQ0Q7QUFxQ0g7O0FBRURYLEVBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQitMLGVBQWpCLEVBQWtDM0wsU0FBbEMsQ0FBVDtBQUVBLE1BQUlnTSxpQkFBaUIsR0FBRy9MLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQixlQUFqQixDQUFwQztBQUNBTyxFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJvTSxpQkFBakIsRUFBb0NoTSxTQUFwQyxDQUFUO0FBRUFKLEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3FKLHVCQUF1QixDQUFDMkMsaUJBQUQsRUFBb0JoTSxTQUFwQixFQUErQjBMLE9BQU8sQ0FBQzdKLEtBQXZDLEVBQThDakMsY0FBOUMsQ0FBMUQ7QUFFQWtFLEVBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUJJLFNBQWpCLEVBQTRCO0FBQ3BDNEQsSUFBQUEsSUFBSSxFQUFFN0U7QUFEOEIsR0FBNUIsQ0FBWjtBQUlBLFNBQU9pQixTQUFQO0FBQ0g7O0FBRUQsU0FBU0MsWUFBVCxDQUFzQkwsY0FBdEIsRUFBc0N1QyxJQUF0QyxFQUE0QztBQUN4QyxNQUFJdkMsY0FBYyxDQUFDcU0sU0FBZixDQUF5QjFGLEdBQXpCLENBQTZCcEUsSUFBN0IsQ0FBSixFQUF3QztBQUNwQyxVQUFNLElBQUlyQixLQUFKLENBQVcsWUFBV3FCLElBQUssb0JBQTNCLENBQU47QUFDSDs7QUFIdUMsT0FLaEMsQ0FBQ3ZDLGNBQWMsQ0FBQ3NNLFFBQWYsQ0FBd0JDLGFBQXhCLENBQXNDaEssSUFBdEMsQ0FMK0I7QUFBQSxvQkFLYyxzQkFMZDtBQUFBOztBQU94Q3ZDLEVBQUFBLGNBQWMsQ0FBQ3FNLFNBQWYsQ0FBeUJ6RixHQUF6QixDQUE2QnJFLElBQTdCO0FBRUEsU0FBT0EsSUFBUDtBQUNIOztBQUVELFNBQVNoQyxTQUFULENBQW1CUCxjQUFuQixFQUFtQ3dNLFVBQW5DLEVBQStDQyxTQUEvQyxFQUEwRDtBQUFBLFFBQ2pERCxVQUFVLEtBQUtDLFNBRGtDO0FBQUEsb0JBQ3ZCLGdCQUR1QjtBQUFBOztBQUd0RHpNLEVBQUFBLGNBQWMsQ0FBQzBNLE1BQWYsQ0FBc0JDLEdBQXRCLENBQTBCLE9BQTFCLEVBQW1DRixTQUFTLEdBQUcsNkJBQVosR0FBNENELFVBQS9FOztBQUVBLE1BQUksQ0FBQ3hNLGNBQWMsQ0FBQ3FNLFNBQWYsQ0FBeUIxRixHQUF6QixDQUE2QjhGLFNBQTdCLENBQUwsRUFBOEM7QUFDMUMsVUFBTSxJQUFJdkwsS0FBSixDQUFXLFlBQVd1TCxTQUFVLGdCQUFoQyxDQUFOO0FBQ0g7O0FBRUR6TSxFQUFBQSxjQUFjLENBQUNzTSxRQUFmLENBQXdCMUYsR0FBeEIsQ0FBNEI0RixVQUE1QixFQUF3Q0MsU0FBeEM7QUFDSDs7QUFFRCxTQUFTdkksWUFBVCxDQUFzQmxFLGNBQXRCLEVBQXNDZ0MsTUFBdEMsRUFBOEM0SyxTQUE5QyxFQUF5RDtBQUNyRCxNQUFJLEVBQUU1SyxNQUFNLElBQUloQyxjQUFjLENBQUN5QixNQUEzQixDQUFKLEVBQXdDO0FBQ3BDLFVBQU0sSUFBSVAsS0FBSixDQUFXLHdDQUF1Q2MsTUFBTyxFQUF6RCxDQUFOO0FBQ0g7O0FBRURoQyxFQUFBQSxjQUFjLENBQUM2TSxnQkFBZixDQUFnQ0MsR0FBaEMsQ0FBb0M5SyxNQUFwQyxFQUE0QzRLLFNBQTVDO0FBRUE1TSxFQUFBQSxjQUFjLENBQUMwTSxNQUFmLENBQXNCQyxHQUF0QixDQUEwQixTQUExQixFQUFzQyxVQUFTQyxTQUFTLENBQUM1SSxJQUFLLEtBQUloQyxNQUFPLHFCQUF6RTtBQUNIOztBQUVELFNBQVNwQix1QkFBVCxDQUFpQ29CLE1BQWpDLEVBQXlDaEMsY0FBekMsRUFBeUQ7QUFDckQsTUFBSStNLGNBQWMsR0FBRy9NLGNBQWMsQ0FBQzZNLGdCQUFmLENBQWdDRyxHQUFoQyxDQUFvQ2hMLE1BQXBDLENBQXJCOztBQUVBLE1BQUkrSyxjQUFjLEtBQUtBLGNBQWMsQ0FBQy9JLElBQWYsS0FBd0JuRixzQkFBeEIsSUFBa0RrTyxjQUFjLENBQUMvSSxJQUFmLEtBQXdCakYsc0JBQS9FLENBQWxCLEVBQTBIO0FBRXRILFdBQU9qQixNQUFNLENBQUN1RixTQUFQLENBQWlCMEosY0FBYyxDQUFDNUksTUFBaEMsRUFBd0MsSUFBeEMsQ0FBUDtBQUNIOztBQUVELE1BQUlrRyxHQUFHLEdBQUdySyxjQUFjLENBQUN5QixNQUFmLENBQXNCTyxNQUF0QixDQUFWOztBQUNBLE1BQUlxSSxHQUFHLENBQUNyRyxJQUFKLEtBQWEsa0JBQWIsSUFBbUNxRyxHQUFHLENBQUM0QyxNQUFKLENBQVcxSyxJQUFYLEtBQW9CLFFBQTNELEVBQXFFO0FBQ2pFLFdBQU96RSxNQUFNLENBQUMwRixjQUFQLENBQ0gxRixNQUFNLENBQUMrRCxPQUFQLENBQWUsdUJBQWYsRUFBd0MsQ0FBRXdJLEdBQUcsQ0FBQzZDLFFBQUosQ0FBYWpMLEtBQWYsQ0FBeEMsQ0FERyxFQUVIb0ksR0FGRyxFQUdILEVBQUUsR0FBR0EsR0FBTDtBQUFVNEMsTUFBQUEsTUFBTSxFQUFFLEVBQUUsR0FBRzVDLEdBQUcsQ0FBQzRDLE1BQVQ7QUFBaUIxSyxRQUFBQSxJQUFJLEVBQUU7QUFBdkI7QUFBbEIsS0FIRyxDQUFQO0FBS0g7O0FBRUQsU0FBT3ZDLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JPLE1BQXRCLENBQVA7QUFDSDs7QUFFRCxTQUFTbUwsb0JBQVQsQ0FBOEJ2SyxVQUE5QixFQUEwQzhKLE1BQTFDLEVBQWtEVSxhQUFsRCxFQUFpRTtBQUM3RCxNQUFJcE4sY0FBYyxHQUFHO0FBQ2pCNEMsSUFBQUEsVUFEaUI7QUFFakI4SixJQUFBQSxNQUZpQjtBQUdqQjlJLElBQUFBLFNBQVMsRUFBRSxFQUhNO0FBSWpCeUksSUFBQUEsU0FBUyxFQUFFLElBQUlsRyxHQUFKLEVBSk07QUFLakJtRyxJQUFBQSxRQUFRLEVBQUUsSUFBSXpPLFFBQUosRUFMTztBQU1qQjRELElBQUFBLE1BQU0sRUFBRSxFQU5TO0FBT2pCb0wsSUFBQUEsZ0JBQWdCLEVBQUUsSUFBSVEsR0FBSixFQVBEO0FBUWpCQyxJQUFBQSxTQUFTLEVBQUUsSUFBSW5ILEdBQUosRUFSTTtBQVNqQmhCLElBQUFBLGtCQUFrQixFQUFHaUksYUFBYSxJQUFJQSxhQUFhLENBQUNqSSxrQkFBaEMsSUFBdUQsRUFUMUQ7QUFVakJRLElBQUFBLGVBQWUsRUFBR3lILGFBQWEsSUFBSUEsYUFBYSxDQUFDekgsZUFBaEMsSUFBb0Q7QUFWcEQsR0FBckI7QUFhQTNGLEVBQUFBLGNBQWMsQ0FBQ3NJLFdBQWYsR0FBNkJqSSxZQUFZLENBQUNMLGNBQUQsRUFBaUIsT0FBakIsQ0FBekM7QUFFQTBNLEVBQUFBLE1BQU0sQ0FBQ0MsR0FBUCxDQUFXLFNBQVgsRUFBdUIsb0NBQW1DL0osVUFBVyxJQUFyRTtBQUVBLFNBQU81QyxjQUFQO0FBQ0g7O0FBRUQsU0FBU3NELGVBQVQsQ0FBeUJ0QixNQUF6QixFQUFpQztBQUM3QixTQUFPQSxNQUFNLENBQUN1TCxPQUFQLENBQWUsT0FBZixNQUE0QixDQUFDLENBQTdCLElBQWtDdkwsTUFBTSxDQUFDdUwsT0FBUCxDQUFlLFNBQWYsTUFBOEIsQ0FBQyxDQUFqRSxJQUFzRXZMLE1BQU0sQ0FBQ3VMLE9BQVAsQ0FBZSxjQUFmLE1BQW1DLENBQUMsQ0FBakg7QUFDSDs7QUFFRCxTQUFTOUosa0JBQVQsQ0FBNEJ3RSxNQUE1QixFQUFvQ3VGLFdBQXBDLEVBQWlEO0FBQzdDLE1BQUk3UCxDQUFDLENBQUN1QyxhQUFGLENBQWdCK0gsTUFBaEIsQ0FBSixFQUE2QjtBQUFBLFVBQ2pCQSxNQUFNLENBQUM5SCxPQUFQLEtBQW1CLGlCQURGO0FBQUE7QUFBQTs7QUFHekIsV0FBTztBQUFFQSxNQUFBQSxPQUFPLEVBQUUsaUJBQVg7QUFBOEJvQyxNQUFBQSxJQUFJLEVBQUVrQixrQkFBa0IsQ0FBQ3dFLE1BQU0sQ0FBQzFGLElBQVIsRUFBY2lMLFdBQWQ7QUFBdEQsS0FBUDtBQUNIOztBQUw0QyxRQU9yQyxPQUFPdkYsTUFBUCxLQUFrQixRQVBtQjtBQUFBO0FBQUE7O0FBUzdDLE1BQUl3RixLQUFLLEdBQUd4RixNQUFNLENBQUNnQixLQUFQLENBQWEsR0FBYixDQUFaOztBQVQ2QyxRQVVyQ3dFLEtBQUssQ0FBQ2xJLE1BQU4sR0FBZSxDQVZzQjtBQUFBO0FBQUE7O0FBWTdDa0ksRUFBQUEsS0FBSyxDQUFDQyxNQUFOLENBQWEsQ0FBYixFQUFnQixDQUFoQixFQUFtQkYsV0FBbkI7QUFDQSxTQUFPQyxLQUFLLENBQUNFLElBQU4sQ0FBVyxHQUFYLENBQVA7QUFDSDs7QUFFREMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2JqRyxFQUFBQSxZQURhO0FBRWJhLEVBQUFBLFlBRmE7QUFHYmdELEVBQUFBLGtCQUhhO0FBSWJJLEVBQUFBLHdCQUphO0FBS2I1QixFQUFBQSxhQUxhO0FBTWI1SixFQUFBQSxZQU5hO0FBT2I4TSxFQUFBQSxvQkFQYTtBQVFiNU0sRUFBQUEsU0FSYTtBQVNiMkQsRUFBQUEsWUFUYTtBQVdidkYsRUFBQUEseUJBWGE7QUFZYkUsRUFBQUEsc0JBWmE7QUFhYkMsRUFBQUEsc0JBYmE7QUFjYkMsRUFBQUEsc0JBZGE7QUFlYkMsRUFBQUEsc0JBZmE7QUFnQmJDLEVBQUFBLG1CQWhCYTtBQWlCYkMsRUFBQUEsMkJBakJhO0FBa0JiQyxFQUFBQSx3QkFsQmE7QUFtQmJDLEVBQUFBLHNCQW5CYTtBQXFCYkMsRUFBQUE7QUFyQmEsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuLyoqXG4gKiBAbW9kdWxlXG4gKiBAaWdub3JlXG4gKi9cblxuY29uc3QgeyBfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBUb3BvU29ydCB9ID0gcmVxdWlyZSgnQGdlbngvYWxnb3JpdGhtJyk7XG5cbmNvbnN0IEpzTGFuZyA9IHJlcXVpcmUoJy4vYXN0LmpzJyk7XG5jb25zdCBHZW1sVHlwZXMgPSByZXF1aXJlKCcuLi8uLi9sYW5nL0dlbWxUeXBlcycpO1xuY29uc3QgeyBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIH0gPSByZXF1aXJlKCcuLi8uLi9sYW5nL0dlbWxVdGlscycpO1xuY29uc3QgeyAgVHlwZXMsIFZhbGlkYXRvcnM6IE9vbG9uZ1ZhbGlkYXRvcnMsIFByb2Nlc3NvcnM6IE9vbG9uZ1Byb2Nlc3NvcnMsIEFjdGl2YXRvcnM6IE9vbG9uZ0FjdGl2YXRvcnMgfSA9IHJlcXVpcmUoJ0BnZW54L2RhdGEnKTtcblxuY29uc3QgZGVmYXVsdEVycm9yID0gJ0ludmFsaWRSZXF1ZXN0JztcblxuY29uc3QgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyA9ICdGaWVsZFByZVByb2Nlc3MnO1xuY29uc3QgQVNUX0JMS19QQVJBTV9TQU5JVElaRSA9ICdQYXJhbWV0ZXJTYW5pdGl6ZSc7XG5jb25zdCBBU1RfQkxLX1BST0NFU1NPUl9DQUxMID0gJ1Byb2Nlc3NvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCA9ICdWYWxpZGF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwgPSAnQWN0aXZhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OID0gJ1ZpZXdPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19WSUVXX1JFVFVSTiA9ICdWaWV3UmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTiA9ICdJbnRlcmZhY2VPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOID0gJ0ludGVyZmFjZVJldHVybic7XG5jb25zdCBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNID0gJ0V4Y2VwdGlvbkl0ZW0nO1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHID0ge1xuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBBU1RfQkxLX0FDVElWQVRPUl9DQUxMXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfT1AgPSB7XG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAnfH4nLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3w+JyxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICd8PScgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfUEFUSCA9IHtcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd2YWxpZGF0b3JzJyxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06ICdwcm9jZXNzb3JzJyxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICdhY3RpdmF0b3JzJyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9CVUlMVElOID0ge1xuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogT29sb25nVmFsaWRhdG9ycyxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IE9vbG9uZ1Byb2Nlc3NvcnMsXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBPb2xvbmdBY3RpdmF0b3JzIFxufTtcblxuY29uc3QgT1BFUkFUT1JfVE9LRU4gPSB7XG4gICAgXCI+XCI6IFwiJGd0XCIsXG4gICAgXCI8XCI6IFwiJGx0XCIsXG4gICAgXCI+PVwiOiBcIiRndGVcIixcbiAgICBcIjw9XCI6IFwiJGx0ZVwiLFxuICAgIFwiPT1cIjogXCIkZXFcIixcbiAgICBcIiE9XCI6IFwiJG5lXCIsXG4gICAgXCJpblwiOiBcIiRpblwiLFxuICAgIFwibm90SW5cIjogXCIkbmluXCJcbn07XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmRpdGlvbmFsIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB0ZXN0XG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBUb3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdCwgY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0ZXN0KSkgeyAgICAgICAgXG4gICAgICAgIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdWYWxpZGF0ZUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wOmRvbmUnKTtcbiAgICAgICAgICAgIGxldCBvcGVyYW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5jYWxsZXIsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRUb3BvSWQgPSBjb21waWxlQWRIb2NWYWxpZGF0b3IoZW5kVG9wb0lkLCBhc3RBcmd1bWVudCwgdGVzdC5jYWxsZWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiByZXRUb3BvSWQgPT09IGVuZFRvcG9JZDtcblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QtZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpkb25lJyk7XG5cbiAgICAgICAgICAgIGxldCBvcDtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbGVmdFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmxlZnQnKTtcbiAgICAgICAgICAgIGxldCByaWdodFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOnJpZ2h0Jyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdExlZnRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0LCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICc+JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8JzpcbiAgICAgICAgICAgICAgICBjYXNlICc+PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnPD0nOlxuICAgICAgICAgICAgICAgIGNhc2UgJ2luJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSB0ZXN0Lm9wZXJhdG9yO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJz09JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnPT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICchPSc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyE9PSc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGxlZnRUb3BvSWQsIHRlc3QubGVmdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHJpZ2h0VG9wb0lkLCB0ZXN0LnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdW5hT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBvcGVyYW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RPcGVyYW5kVG9wb0lkID0gdGVzdC5vcGVyYXRvciA9PT0gJ25vdCcgPyBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5hcmd1bWVudCwgY29tcGlsZUNvbnRleHQpIDogY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCwgb3BlcmFuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RPcGVyYW5kVG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgYXN0QXJndW1lbnQgPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0T3BlcmFuZFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IHZhbHVlU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWx1ZScpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgdmFsdWVTdGFydFRvcG9JZCk7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHZhbHVlU3RhcnRUb3BvSWQsIHRlc3QsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHRlc3QpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFsaWRhdG9yIGNhbGxlZCBpbiBhIGxvZ2ljYWwgZXhwcmVzc2lvbi5cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUFkSG9jVmFsaWRhdG9yKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXNzZXJ0OiBmdW5jdG9yLm9vbFR5cGUgPT09IEdlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1I7ICAgICAgICBcblxuICAgIGxldCBjYWxsQXJncztcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5hcmdzKSB7XG4gICAgICAgIGNhbGxBcmdzID0gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGZ1bmN0b3IuYXJncywgY29tcGlsZUNvbnRleHQpOyAgICAgICAgXG4gICAgfSBlbHNlIHtcbiAgICAgICAgY2FsbEFyZ3MgPSBbXTtcbiAgICB9ICAgICAgICAgICAgXG4gICAgXG4gICAgbGV0IGFyZzAgPSB2YWx1ZTtcbiAgICBcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdWYWxpZGF0b3JzLicgKyBmdW5jdG9yLm5hbWUsIFsgYXJnMCBdLmNvbmNhdChjYWxsQXJncykpO1xuXG4gICAgcmV0dXJuIHRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgbW9kaWZpZXIgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHRvcG9JZCAtIHN0YXJ0VG9wb0lkXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBmdW5jdG9yc1xuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gdG9wb0luZm9cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby50b3BvSWRQcmVmaXhcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby5sYXN0VG9wb0lkXG4gKiBAcmV0dXJucyB7KnxzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVNb2RpZmllcih0b3BvSWQsIHZhbHVlLCBmdW5jdG9yLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBkZWNsYXJlUGFyYW1zO1xuXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUikgeyBcbiAgICAgICAgZGVjbGFyZVBhcmFtcyA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKFt7bmFtZTogY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZX0sIHtuYW1lOiAnY29udGV4dCd9XS5jb25jYXQoZnVuY3Rvci5hcmdzKSk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoXy5pc0VtcHR5KGZ1bmN0b3IuYXJncykgPyBbdmFsdWVdIDogW3ZhbHVlXS5jb25jYXQoZnVuY3Rvci5hcmdzKSk7ICAgICAgICBcbiAgICB9ICAgICAgICBcblxuICAgIGxldCBmdW5jdG9ySWQgPSB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgZGVjbGFyZVBhcmFtcyk7XG5cbiAgICBsZXQgY2FsbEFyZ3MsIHJlZmVyZW5jZXM7XG4gICAgXG4gICAgaWYgKGZ1bmN0b3IuYXJncykge1xuICAgICAgICBjYWxsQXJncyA9IHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBmdW5jdG9yLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgcmVmZXJlbmNlcyA9IGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKGZ1bmN0b3IuYXJncyk7XG5cbiAgICAgICAgaWYgKF8uZmluZChyZWZlcmVuY2VzLCByZWYgPT4gcmVmID09PSB2YWx1ZS5uYW1lKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSB0YXJnZXQgZmllbGQgaXRzZWxmIGFzIGFuIGFyZ3VtZW50IG9mIGEgbW9kaWZpZXIuJyk7XG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgIFxuICAgIFxuICAgIGlmIChmdW5jdG9yLm9vbFR5cGUgPT09IEdlbWxUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgICAgICAgICAgICBcbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0QXdhaXQoZnVuY3RvcklkLCBbIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMnKSwgSnNMYW5nLmFzdFZhclJlZignY29udGV4dCcpIF0uY29uY2F0KGNhbGxBcmdzKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbGV0IGFyZzAgPSB2YWx1ZTtcbiAgICAgICAgaWYgKCFpc1RvcExldmVsQmxvY2sodG9wb0lkKSAmJiBfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnICYmIHZhbHVlLm5hbWUuc3RhcnRzV2l0aCgnbGF0ZXN0LicpKSB7XG4gICAgICAgICAgICAvL2xldCBleGlzdGluZ1JlZiA9ICAgICAgICAgICAgXG4gICAgICAgICAgICBhcmcwID0gSnNMYW5nLmFzdENvbmRpdGlvbmFsKFxuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSh2YWx1ZS5uYW1lKSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgICAgICB2YWx1ZSwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgICAgICByZXBsYWNlVmFyUmVmU2NvcGUodmFsdWUsICdleGlzdGluZycpXG4gICAgICAgICAgICApOyAgXG4gICAgICAgIH1cbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbChmdW5jdG9ySWQsIFsgYXJnMCBdLmNvbmNhdChjYWxsQXJncykpO1xuICAgIH0gICAgXG5cbiAgICBpZiAoaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkpIHtcbiAgICAgICAgbGV0IHRhcmdldFZhck5hbWUgPSB2YWx1ZS5uYW1lO1xuICAgICAgICBsZXQgbmVlZERlY2xhcmUgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIWlzRG90U2VwYXJhdGVOYW1lKHZhbHVlLm5hbWUpICYmIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1t2YWx1ZS5uYW1lXSAmJiBmdW5jdG9yLm9vbFR5cGUgIT09IEdlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1IpIHtcbiAgICAgICAgICAgIC8vY29uZmxpY3Qgd2l0aCBleGlzdGluZyB2YXJpYWJsZXMsIG5lZWQgdG8gcmVuYW1lIHRvIGFub3RoZXIgdmFyaWFibGVcbiAgICAgICAgICAgIGxldCBjb3VudGVyID0gMTtcbiAgICAgICAgICAgIGRvIHtcbiAgICAgICAgICAgICAgICBjb3VudGVyKys7ICAgICAgIFxuICAgICAgICAgICAgICAgIHRhcmdldFZhck5hbWUgPSB2YWx1ZS5uYW1lICsgY291bnRlci50b1N0cmluZygpOyAgICAgICAgIFxuICAgICAgICAgICAgfSB3aGlsZSAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzLmhhc093blByb3BlcnR5KHRhcmdldFZhck5hbWUpKTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3RhcmdldFZhck5hbWVdID0geyB0eXBlOiAnbG9jYWxWYXJpYWJsZScsIHNvdXJjZTogJ21vZGlmaWVyJyB9O1xuICAgICAgICAgICAgbmVlZERlY2xhcmUgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9pZiAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzW10pXG5cbiAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIHtcbiAgICAgICAgICAgIHR5cGU6IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdbZnVuY3Rvci5vb2xUeXBlXSxcbiAgICAgICAgICAgIHRhcmdldDogdGFyZ2V0VmFyTmFtZSxcbiAgICAgICAgICAgIHJlZmVyZW5jZXMsICAgLy8gbGF0ZXN0LiwgZXhzaXRpbmcuLCByYXcuXG4gICAgICAgICAgICBuZWVkRGVjbGFyZVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufSAgXG4gICAgICBcbmZ1bmN0aW9uIGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKG9vbEFyZ3MpIHsgICBcbiAgICBvb2xBcmdzID0gXy5jYXN0QXJyYXkob29sQXJncyk7ICAgIFxuXG4gICAgbGV0IHJlZnMgPSBbXTtcblxuICAgIG9vbEFyZ3MuZm9yRWFjaChhID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoYSkpIHtcbiAgICAgICAgICAgIHJlZnMgPSByZWZzLmNvbmNhdChleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhhKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gXG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IGNoZWNrUmVmZXJlbmNlVG9GaWVsZChhKTtcbiAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVmcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiByZWZzO1xufVxuXG5mdW5jdGlvbiBjaGVja1JlZmVyZW5jZVRvRmllbGQob2JqKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvYmopICYmIG9iai5vb2xUeXBlKSB7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSByZXR1cm4gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iai52YWx1ZSk7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmoubmFtZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yVHlwZSwgZnVuY3RvckpzRmlsZSwgbWFwT2ZGdW5jdG9yVG9GaWxlKSB7XG4gICAgaWYgKG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICYmIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICE9PSBmdW5jdG9ySnNGaWxlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3Q6ICR7ZnVuY3RvclR5cGV9IG5hbWluZyBcIiR7ZnVuY3RvcklkfVwiIGNvbmZsaWN0cyFgKTtcbiAgICB9XG4gICAgbWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gPSBmdW5jdG9ySnNGaWxlO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBmdW5jdG9yIGlzIHVzZXItZGVmaW5lZCBvciBidWlsdC1pblxuICogQHBhcmFtIGZ1bmN0b3JcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFyZ3MgLSBVc2VkIHRvIG1ha2UgdXAgdGhlIGZ1bmN0aW9uIHNpZ25hdHVyZVxuICogQHJldHVybnMge3N0cmluZ30gZnVuY3RvciBpZFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgYXJncykge1xuICAgIGxldCBmdW5jdGlvbk5hbWUsIGZpbGVOYW1lLCBmdW5jdG9ySWQ7XG5cbiAgICAvL2V4dHJhY3QgdmFsaWRhdG9yIG5hbWluZyBhbmQgaW1wb3J0IGluZm9ybWF0aW9uXG4gICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGZ1bmN0b3IubmFtZSkpIHtcbiAgICAgICAgbGV0IG5hbWVzID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpO1xuICAgICAgICBpZiAobmFtZXMubGVuZ3RoID4gMikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3Qgc3VwcG9ydGVkIHJlZmVyZW5jZSB0eXBlOiAnICsgZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vcmVmZXJlbmNlIHRvIG90aGVyIGVudGl0eSBmaWxlXG4gICAgICAgIGxldCByZWZFbnRpdHlOYW1lID0gbmFtZXNbMF07XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IG5hbWVzWzFdO1xuICAgICAgICBmaWxlTmFtZSA9ICcuLycgKyBPT0xfTU9ESUZJRVJfUEFUSFtmdW5jdG9yLm9vbFR5cGVdICsgJy8nICsgcmVmRW50aXR5TmFtZSArICctJyArIGZ1bmN0aW9uTmFtZSArICcuanMnO1xuICAgICAgICBmdW5jdG9ySWQgPSByZWZFbnRpdHlOYW1lICsgXy51cHBlckZpcnN0KGZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yLm9vbFR5cGUsIGZpbGVOYW1lLCBjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lID0gZnVuY3Rvci5uYW1lO1xuXG4gICAgICAgIGxldCBidWlsdGlucyA9IE9PTF9NT0RJRklFUl9CVUlMVElOW2Z1bmN0b3Iub29sVHlwZV07XG5cbiAgICAgICAgaWYgKCEoZnVuY3Rpb25OYW1lIGluIGJ1aWx0aW5zKSkge1xuICAgICAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0aW9uTmFtZTtcblxuICAgICAgICAgICAgaWYgKCFjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSkge1xuICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgICBmdW5jdG9yVHlwZTogZnVuY3Rvci5vb2xUeXBlLFxuICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgYXJnc1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0b3Iub29sVHlwZSArICdzLicgKyBmdW5jdGlvbk5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3RvcklkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwaXBlZCB2YWx1ZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFyT29sLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YXJPb2wudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIHZhck9vbC5tb2RpZmllcnMuZm9yRWFjaChtb2RpZmllciA9PiB7XG4gICAgICAgIGxldCBtb2RpZmllclN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArIE9PTF9NT0RJRklFUl9PUFttb2RpZmllci5vb2xUeXBlXSArIG1vZGlmaWVyLm5hbWUpO1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIG1vZGlmaWVyU3RhcnRUb3BvSWQpO1xuXG4gICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlTW9kaWZpZXIoXG4gICAgICAgICAgICBtb2RpZmllclN0YXJ0VG9wb0lkLFxuICAgICAgICAgICAgdmFyT29sLnZhbHVlLFxuICAgICAgICAgICAgbW9kaWZpZXIsXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dFxuICAgICAgICApO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxhc3RUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHZhcmlhYmxlIHJlZmVyZW5jZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBwcmU6IF8uaXNQbGFpbk9iamVjdCh2YXJPb2wpICYmIHZhck9vbC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgIC8vbGV0IFsgYmFzZU5hbWUsIG90aGVycyBdID0gdmFyT29sLm5hbWUuc3BsaXQoJy4nLCAyKTtcbiAgICAvKlxuICAgIGlmIChjb21waWxlQ29udGV4dC5tb2RlbFZhcnMgJiYgY29tcGlsZUNvbnRleHQubW9kZWxWYXJzLmhhcyhiYXNlTmFtZSkgJiYgb3RoZXJzKSB7XG4gICAgICAgIHZhck9vbC5uYW1lID0gYmFzZU5hbWUgKyAnLmRhdGEnICsgJy4nICsgb3RoZXJzO1xuICAgIH0qLyAgICBcblxuICAgIC8vc2ltcGxlIHZhbHVlXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YXJPb2wpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBHZXQgYW4gYXJyYXkgb2YgcGFyYW1ldGVyIG5hbWVzLlxuICogQHBhcmFtIHthcnJheX0gYXJncyAtIEFuIGFycmF5IG9mIGFyZ3VtZW50cyBpbiBvb2wgc3ludGF4XG4gKiBAcmV0dXJucyB7YXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKGFyZ3MpIHtcbiAgICBpZiAoXy5pc0VtcHR5KGFyZ3MpKSByZXR1cm4gW107XG5cbiAgICBsZXQgbmFtZXMgPSBuZXcgU2V0KCk7XG5cbiAgICBmdW5jdGlvbiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFyZykpIHtcbiAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLnZhbHVlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoYXJnLm5hbWUpLnBvcCgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFyZy5uYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICdwYXJhbScgKyAoaSArIDEpLnRvU3RyaW5nKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIF8ubWFwKGFyZ3MsIChhcmcsIGkpID0+IHtcbiAgICAgICAgbGV0IGJhc2VOYW1lID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcsIGkpO1xuICAgICAgICBsZXQgbmFtZSA9IGJhc2VOYW1lO1xuICAgICAgICBsZXQgY291bnQgPSAyO1xuICAgICAgICBcbiAgICAgICAgd2hpbGUgKG5hbWVzLmhhcyhuYW1lKSkge1xuICAgICAgICAgICAgbmFtZSA9IGJhc2VOYW1lICsgY291bnQudG9TdHJpbmcoKTtcbiAgICAgICAgICAgIGNvdW50Kys7XG4gICAgICAgIH1cblxuICAgICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICAgIHJldHVybiBuYW1lOyAgICAgICAgXG4gICAgfSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmNyZXRlIHZhbHVlIGV4cHJlc3Npb24gZnJvbSBvb2wgdG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB2YWx1ZSAtIE9vbCBub2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgbGV0IFsgcmVmQmFzZSwgLi4ucmVzdCBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZSh2YWx1ZS5uYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlcGVuZGVuY3k7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIHVuZGVmaW5lZCB2YXJpYWJsZTogJHt2YWx1ZS5uYW1lfWApOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGlmIChjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0udHlwZSA9PT0gJ2VudGl0eScgJiYgIWNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXS5vbmdvaW5nKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2U7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlZkJhc2UgPT09ICdsYXRlc3QnICYmIHJlc3QubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIC8vbGF0ZXN0LnBhc3N3b3JkXG4gICAgICAgICAgICAgICAgbGV0IHJlZkZpZWxkTmFtZSA9IHJlc3QucG9wKCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlZkZpZWxkTmFtZSAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkZpZWxkTmFtZSArICc6cmVhZHknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0VtcHR5KHJlc3QpKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2UgKyAnOnJlYWR5JztcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGlmIChkZXBlbmRlbmN5KSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1JlZ0V4cCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSkpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZSA9IF8ubWFwVmFsdWVzKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGtleSkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJy4nICsga2V5KTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICB2YWx1ZSA9IF8ubWFwKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGluZGV4KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnWycgKyBpbmRleCArICddJyk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgIGlmIChuYW1lID09PSAnTk9XJykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgIFwiY2FsbGVlXCI6IHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgXCJjb21wdXRlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBcIm9iamVjdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgXCJjb21wdXRlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgXCJvYmplY3RcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJjb21wdXRlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwib2JqZWN0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwiVHlwZXNcIlxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwicHJvcGVydHlcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJEQVRFVElNRVwiXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIFwicHJvcGVydHlcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwidHlwZU9iamVjdFwiXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIFwicHJvcGVydHlcIjoge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcImxvY2FsXCJcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgXCJhcmd1bWVudHNcIjogW11cbiAgICAgICAgfTtcbiAgICB9IFxuICAgIFxuICAgIHRocm93IG5ldyBFcnJvcignbm90IHN1cHBvcnQ6ICcgKyBuYW1lKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYW4gYXJyYXkgb2YgZnVuY3Rpb24gYXJndW1lbnRzIGZyb20gb29sIGludG8gYXN0LlxuICogQHBhcmFtIHRvcG9JZCAtIFRoZSBtb2RpZmllciBmdW5jdGlvbiB0b3BvIFxuICogQHBhcmFtIGFyZ3MgLSBcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dCAtIFxuICogQHJldHVybnMge0FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgYXJncywgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhcmdzID0gXy5jYXN0QXJyYXkoYXJncyk7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IGNhbGxBcmdzID0gW107XG5cbiAgICBfLmVhY2goYXJncywgKGFyZywgaSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgbGV0IGFyZ1RvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzphcmdbJyArIChpKzEpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihhcmdUb3BvSWQsIGFyZywgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgdG9wb0lkKTtcblxuICAgICAgICBjYWxsQXJncyA9IGNhbGxBcmdzLmNvbmNhdChfLmNhc3RBcnJheShnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCkpKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBjYWxsQXJncztcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGFyYW0gb2YgaW50ZXJmYWNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0gaW5kZXhcbiAqIEBwYXJhbSBwYXJhbVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlUGFyYW0oaW5kZXgsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB0eXBlID0gcGFyYW0udHlwZTsgICAgXG5cbiAgICBsZXQgdHlwZU9iamVjdCA9IFR5cGVzW3R5cGVdO1xuXG4gICAgaWYgKCF0eXBlT2JqZWN0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBmaWVsZCB0eXBlOiAnICsgdHlwZSk7XG4gICAgfVxuXG4gICAgbGV0IHNhbml0aXplck5hbWUgPSBgVHlwZXMuJHt0eXBlLnRvVXBwZXJDYXNlKCl9LnNhbml0aXplYDtcblxuICAgIGxldCB2YXJSZWYgPSBKc0xhbmcuYXN0VmFyUmVmKHBhcmFtLm5hbWUpO1xuICAgIGxldCBjYWxsQXN0ID0gSnNMYW5nLmFzdENhbGwoc2FuaXRpemVyTmFtZSwgW3ZhclJlZiwgSnNMYW5nLmFzdEFycmF5QWNjZXNzKCckbWV0YS5wYXJhbXMnLCBpbmRleCksIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMuZGIuaTE4bicpXSk7XG5cbiAgICBsZXQgcHJlcGFyZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRwYXJhbXM6c2FuaXRpemVbJyArIGluZGV4LnRvU3RyaW5nKCkgKyAnXScpO1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmc7XG5cbiAgICAvL2lmIChpbmRleCA9PT0gMCkge1xuICAgICAgICAvL2RlY2xhcmUgJHNhbml0aXplU3RhdGUgdmFyaWFibGUgZm9yIHRoZSBmaXJzdCB0aW1lXG4gICAgLy8gICAgc2FuaXRpemVTdGFydGluZyA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhclJlZiwgY2FsbEFzdCwgZmFsc2UsIGZhbHNlLCBgU2FuaXRpemUgcGFyYW0gXCIke3BhcmFtLm5hbWV9XCJgKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZyA9IDtcblxuICAgICAgICAvL2xldCBsYXN0UHJlcGFyZVRvcG9JZCA9ICckcGFyYW1zOnNhbml0aXplWycgKyAoaW5kZXggLSAxKS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAvL2RlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFByZXBhcmVUb3BvSWQsIHByZXBhcmVUb3BvSWQpO1xuICAgIC8vfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3ByZXBhcmVUb3BvSWRdID0gW1xuICAgICAgICBKc0xhbmcuYXN0QXNzaWduKHZhclJlZiwgY2FsbEFzdCwgYFNhbml0aXplIGFyZ3VtZW50IFwiJHtwYXJhbS5uYW1lfVwiYClcbiAgICBdO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkVcbiAgICB9KTtcblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQpO1xuXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW0ubmFtZSk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdG9wb0lkKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShwYXJhbS5uYW1lLCBwYXJhbSk7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSh0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RlbCBmaWVsZCBwcmVwcm9jZXNzIGluZm9ybWF0aW9uIGludG8gYXN0LlxuICogQHBhcmFtIHtvYmplY3R9IHBhcmFtIC0gRmllbGQgaW5mb3JtYXRpb25cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaWVsZChwYXJhbU5hbWUsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIC8vIDEuIHJlZmVyZW5jZSB0byB0aGUgbGF0ZXN0IG9iamVjdCB0aGF0IGlzIHBhc3NlZCBxdWFsaWZpZXIgY2hlY2tzXG4gICAgLy8gMi4gaWYgbW9kaWZpZXJzIGV4aXN0LCB3cmFwIHRoZSByZWYgaW50byBhIHBpcGVkIHZhbHVlXG4gICAgLy8gMy4gcHJvY2VzcyB0aGUgcmVmIChvciBwaXBlZCByZWYpIGFuZCBtYXJrIGFzIGVuZFxuICAgIC8vIDQuIGJ1aWxkIGRlcGVuZGVuY2llczogbGF0ZXN0LmZpZWxkIC0+IC4uLiAtPiBmaWVsZDpyZWFkeSBcbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbU5hbWUpO1xuICAgIGxldCBjb250ZXh0TmFtZSA9ICdsYXRlc3QuJyArIHBhcmFtTmFtZTtcbiAgICAvL2NvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdFZhclJlZihjb250ZXh0TmFtZSwgdHJ1ZSk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UoY29udGV4dE5hbWUsIHBhcmFtKTsgICAgXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbih0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG5mdW5jdGlvbiB3cmFwUGFyYW1SZWZlcmVuY2UobmFtZSwgdmFsdWUpIHtcbiAgICBsZXQgcmVmID0gT2JqZWN0LmFzc2lnbih7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBuYW1lIH0pO1xuICAgIFxuICAgIGlmICghXy5pc0VtcHR5KHZhbHVlLm1vZGlmaWVycykpIHtcbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ1BpcGVkVmFsdWUnLCB2YWx1ZTogcmVmLCBtb2RpZmllcnM6IHZhbHVlLm1vZGlmaWVycyB9O1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gcmVmO1xufVxuXG5mdW5jdGlvbiBoYXNNb2RlbEZpZWxkKG9wZXJhbmQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcGVyYW5kKSAmJiBvcGVyYW5kLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgIGxldCBbIGJhc2VWYXIsIC4uLnJlc3QgXSA9IG9wZXJhbmQubmFtZS5zcGxpdCgnLicpO1xuXG4gICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbYmFzZVZhcl0gJiYgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW2Jhc2VWYXJdLm9uZ29pbmcgJiYgcmVzdC5sZW5ndGggPiAwOyAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlOyAgICBcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSB0aGVuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdCBpbiByZXR1cm4gYmxvY2suXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRJZFxuICogQHBhcmFtIHtzdHJpbmd9IGVuZElkXG4gKiBAcGFyYW0gdGhlblxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblRoZW5Bc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVGhyb3dFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZ3M7XG4gICAgICAgICAgICBpZiAodGhlbi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IHRyYW5zbGF0ZUFyZ3Moc3RhcnRJZCwgdGhlbi5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0VGhyb3codGhlbi5lcnJvclR5cGUgfHwgZGVmYXVsdEVycm9yLCB0aGVuLm1lc3NhZ2UgfHwgYXJncyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydElkLCBlbmRJZCwgdGhlbi52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICAvL3RoZW4gZXhwcmVzc2lvbiBpcyBhbiBvb2xvbmcgY29uY3JldGUgdmFsdWUgICAgXG4gICAgaWYgKF8uaXNBcnJheSh0aGVuKSB8fCBfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgbGV0IHZhbHVlRW5kSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpOyAgICBcbiAgICAgICAgdGhlbiA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2YWx1ZUVuZElkXTsgXG4gICAgfSAgIFxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4odGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgdGhlbiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydElkXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kSWRcbiAqIEBwYXJhbSB0aGVuXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhc3NpZ25Ub1xuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVUaGVuQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLCBjb21waWxlQ29udGV4dCwgYXNzaWduVG8pIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdUaHJvd0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJncztcbiAgICAgICAgICAgIGlmICh0aGVuLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gdHJhbnNsYXRlQXJncyhzdGFydElkLCB0aGVuLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBhcmdzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICBzd2l0Y2ggKHRoZW4ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAoIWhhc01vZGVsRmllbGQodGhlbi5sZWZ0LCBjb21waWxlQ29udGV4dCkpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHF1ZXJ5IGNvbmRpdGlvbjogdGhlIGxlZnQgb3BlcmFuZCBuZWVkIHRvIGJlIGFuIGVudGl0eSBmaWVsZC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGhhc01vZGVsRmllbGQodGhlbi5yaWdodCwgY29tcGlsZUNvbnRleHQpKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBxdWVyeSBjb25kaXRpb246IHRoZSByaWdodCBvcGVyYW5kIHNob3VsZCBub3QgYmUgYW4gZW50aXR5IGZpZWxkLiBVc2UgZGF0YXNldCBpbnN0ZWFkIGlmIGpvaW5pbmcgaXMgcmVxdWlyZWQuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7fTtcbiAgICAgICAgICAgIGxldCBzdGFydFJpZ2h0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0SWQgKyAnJGJpbk9wOnJpZ2h0Jyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0SWQsIHN0YXJ0UmlnaHRJZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFJpZ2h0SWQsIHRoZW4ucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZElkKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHRoZW4ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb25bdGhlbi5sZWZ0Lm5hbWUuc3BsaXQoJy4nLCAyKVsxXV0gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbbGFzdFJpZ2h0SWRdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb25bdGhlbi5sZWZ0Lm5hbWUuc3BsaXQoJy4nLCAyKVsxXV0gPSB7IFtPUEVSQVRPUl9UT0tFTltvcF1dOiBjb21waWxlQ29udGV4dC5hc3RNYXBbbGFzdFJpZ2h0SWRdIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0QXNzaWduKGFzc2lnblRvLCBKc0xhbmcuYXN0VmFsdWUoY29uZGl0aW9uKSk7ICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vdGhlbiBleHByZXNzaW9uIGlzIGFuIG9vbG9uZyBjb25jcmV0ZSB2YWx1ZSAgICBcbiAgICBpZiAoXy5pc0FycmF5KHRoZW4pIHx8IF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBsZXQgdmFsdWVFbmRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydElkLCB0aGVuLCBjb21waWxlQ29udGV4dCk7ICAgIFxuICAgICAgICB0aGVuID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZhbHVlRW5kSWRdOyBcbiAgICB9ICAgXG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdEFzc2lnbihhc3NpZ25UbywgdGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgZW5kaW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB2YWx1ZVRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICBpZiAodmFsdWVUb3BvSWQgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdmFsdWVUb3BvSWQsIGVuZFRvcG9JZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4oZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YodmFsdWVUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVJldHVybihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19WSUVXX1JFVFVSTlxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgZmluZCBvbmUgb3BlcmF0aW9uIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge2ludH0gaW5kZXhcbiAqIEBwYXJhbSB7b2JqZWN0fSBvcGVyYXRpb24gLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC1cbiAqIEBwYXJhbSB7c3RyaW5nfSBkZXBlbmRlbmN5XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIHByZTogZGVwZW5kZW5jeTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICdvcCQnICsgaW5kZXgudG9TdHJpbmcoKSk7XG4gICAgbGV0IGNvbmRpdGlvblZhck5hbWUgPSBlbmRUb3BvSWQgKyAnJGNvbmRpdGlvbic7XG5cbiAgICBsZXQgYXN0ID0gW1xuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShjb25kaXRpb25WYXJOYW1lKVxuICAgIF07XG5cbiAgICBhc3NlcnQ6IG9wZXJhdGlvbi5jb25kaXRpb247XG5cbiAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbb3BlcmF0aW9uLm1vZGVsXSA9IHsgdHlwZTogJ2VudGl0eScsIHNvdXJjZTogJ2ZpbmRPbmUnLCBvbmdvaW5nOiB0cnVlIH07XG5cbiAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIC8vc3BlY2lhbCBjb25kaXRpb25cblxuICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlID09PSAnY2FzZXMnKSB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkUHJlZml4ID0gZW5kVG9wb0lkICsgJyRjYXNlcyc7XG4gICAgICAgICAgICBsZXQgbGFzdFN0YXRlbWVudDtcblxuICAgICAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSkge1xuICAgICAgICAgICAgICAgIGxldCBlbHNlU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZWxzZScpO1xuICAgICAgICAgICAgICAgIGxldCBlbHNlRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZVN0YXJ0LCBlbHNlRW5kKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VFbmQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gdHJhbnNsYXRlVGhlbkFzdChlbHNlU3RhcnQsIGVsc2VFbmQsIG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gSnNMYW5nLmFzdFRocm93KCdTZXJ2ZXJFcnJvcicsICdVbmV4cGVjdGVkIHN0YXRlLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdNaXNzaW5nIGNhc2UgaXRlbXMnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgXy5yZXZlcnNlKG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBjYXNlIGl0ZW0uJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaSA9IG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMubGVuZ3RoIC0gaSAtIDE7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVByZWZpeCA9IHRvcG9JZFByZWZpeCArICdbJyArIGkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgICAgICAgICBsZXQgY2FzZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBjYXNlVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUmVzdWx0VmFyTmFtZSA9ICckJyArIHRvcG9JZFByZWZpeCArICdfJyArIGkudG9TdHJpbmcoKTtcblxuICAgICAgICAgICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbihpdGVtLnRlc3QsIGNvbXBpbGVDb250ZXh0LCBjYXNlVG9wb0lkKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FzZVR0ZW0gPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGFzdENhc2VUdGVtKSwgJ0ludmFsaWQgY2FzZSBpdGVtIGFzdC4nO1xuXG4gICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0gPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShjYXNlUmVzdWx0VmFyTmFtZSwgYXN0Q2FzZVR0ZW0sIHRydWUsIGZhbHNlLCBgQ29uZGl0aW9uICR7aX0gZm9yIGZpbmQgb25lICR7b3BlcmF0aW9uLm1vZGVsfWApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGlmU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBsZXQgaWZFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgaWZTdGFydCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZlN0YXJ0LCBpZkVuZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gW1xuICAgICAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdElmKEpzTGFuZy5hc3RWYXJSZWYoY2FzZVJlc3VsdFZhck5hbWUpLCBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlVGhlbkFzdChpZlN0YXJ0LCBpZkVuZCwgaXRlbS50aGVuLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSkpLCBsYXN0U3RhdGVtZW50KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZkVuZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhc3QgPSBhc3QuY29uY2F0KF8uY2FzdEFycmF5KGxhc3RTdGF0ZW1lbnQpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbycpO1xuICAgICAgICB9XG5cblxuICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbycpO1xuICAgIH1cblxuICAgIGFzdC5wdXNoKFxuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShvcGVyYXRpb24ubW9kZWwsIEpzTGFuZy5hc3RBd2FpdChgdGhpcy5maW5kT25lX2AsIEpzTGFuZy5hc3RWYXJSZWYoY29uZGl0aW9uVmFyTmFtZSkpKVxuICAgICk7XG5cbiAgICBkZWxldGUgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW29wZXJhdGlvbi5tb2RlbF0ub25nb2luZztcblxuICAgIGxldCBtb2RlbFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgb3BlcmF0aW9uLm1vZGVsKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgbW9kZWxUb3BvSWQpO1xuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gYXN0O1xuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBpbGVEYk9wZXJhdGlvbihpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIGxldCBsYXN0VG9wb0lkO1xuXG4gICAgc3dpdGNoIChvcGVyYXRpb24ub29sVHlwZSkge1xuICAgICAgICBjYXNlICdGaW5kT25lU3RhdGVtZW50JzpcbiAgICAgICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdmaW5kJzpcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnY3JlYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZGVsZXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnRG9TdGF0ZW1lbnQnOlxuICAgICAgICAgICAgbGV0IGRvQmxvY2sgPSBvcGVyYXRpb24uZG87XG4gICAgICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZURvU3RhdGVtZW50KGluZGV4LCBkb0Jsb2NrLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdhc3NpZ25tZW50JzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBvcGVyYXRpb24gdHlwZTogJyArIG9wZXJhdGlvbi50eXBlKTtcbiAgICB9XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OXG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGFzdFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY29tcGlsZURvU3RhdGVtZW50KGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgICAgIFxufVxuXG4vKipcbiAqIENvbXBpbGUgZXhjZXB0aW9uYWwgcmV0dXJuIFxuICogQHBhcmFtIHtvYmplY3R9IG9vbE5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXBlbmRlbmN5XVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG9vbE5vZGUsIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiAoXy5pc1BsYWluT2JqZWN0KG9vbE5vZGUpICYmIG9vbE5vZGUub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyksIGxhc3RFeGNlcHRpb25JZCA9IGRlcGVuZGVuY3k7XG5cbiAgICBpZiAoIV8uaXNFbXB0eShvb2xOb2RlLmV4Y2VwdGlvbnMpKSB7XG4gICAgICAgIG9vbE5vZGUuZXhjZXB0aW9ucy5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGV4Y2VwdGlvbmFsIHR5cGU6ICcgKyBpdGVtLm9vbFR5cGUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uRW5kSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXTpkb25lJyk7XG4gICAgICAgICAgICAgICAgaWYgKGxhc3RFeGNlcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZXhjZXB0aW9uU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRoZW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0aGVuU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0aGVuU3RhcnRJZCwgZXhjZXB0aW9uRW5kSWQpO1xuXG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2V4Y2VwdGlvbkVuZElkXSA9IEpzTGFuZy5hc3RJZihcbiAgICAgICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlUmV0dXJuVGhlbkFzdChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoZW5TdGFydElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgZXhjZXB0aW9uRW5kSWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0KSksXG4gICAgICAgICAgICAgICAgICAgIG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGBSZXR1cm4gb24gZXhjZXB0aW9uICMke2l9YFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvbkVuZElkLCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IEFTVF9CTEtfRVhDRVBUSU9OX0lURU1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGxhc3RFeGNlcHRpb25JZCA9IGV4Y2VwdGlvbkVuZElkO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBlbmRUb3BvSWQpO1xuXG4gICAgbGV0IHJldHVyblN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIG9vbE5vZGUudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTlxuICAgIH0pO1xuICAgIFxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgbmFtZSkge1xuICAgIGlmIChjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7bmFtZX1cIiBhbHJlYWR5IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgYXNzZXJ0OiAhY29tcGlsZUNvbnRleHQudG9wb1NvcnQuaGFzRGVwZW5kZW5jeShuYW1lKSwgJ0FscmVhZHkgaW4gdG9wb1NvcnQhJztcblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5hZGQobmFtZSk7XG5cbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmV2aW91c09wLCBjdXJyZW50T3ApIHtcbiAgICBwcmU6IHByZXZpb3VzT3AgIT09IGN1cnJlbnRPcCwgJ1NlbGYgZGVwZW5kaW5nJztcblxuICAgIGNvbXBpbGVDb250ZXh0Lmxpbmtlci5sb2coJ2RlYnVnJywgY3VycmVudE9wICsgJyBcXHgxYlszM21kZXBlbmRzIG9uXFx4MWJbMG0gJyArIHByZXZpb3VzT3ApO1xuXG4gICAgaWYgKCFjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKGN1cnJlbnRPcCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtjdXJyZW50T3B9XCIgbm90IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb1NvcnQuYWRkKHByZXZpb3VzT3AsIGN1cnJlbnRPcCk7XG59XG5cbmZ1bmN0aW9uIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdG9wb0lkLCBibG9ja01ldGEpIHtcbiAgICBpZiAoISh0b3BvSWQgaW4gY29tcGlsZUNvbnRleHQuYXN0TWFwKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFTVCBub3QgZm91bmQgZm9yIGJsb2NrIHdpdGggdG9wb0lkOiAke3RvcG9JZH1gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLnNldCh0b3BvSWQsIGJsb2NrTWV0YSk7XG5cbiAgICBjb21waWxlQ29udGV4dC5saW5rZXIubG9nKCd2ZXJib3NlJywgYEFkZGluZyAke2Jsb2NrTWV0YS50eXBlfSBcIiR7dG9wb0lkfVwiIGludG8gc291cmNlIGNvZGUuYCk7ICAgIFxufVxuXG5mdW5jdGlvbiBnZXRDb2RlUmVwcmVzZW50YXRpb25PZih0b3BvSWQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGxhc3RTb3VyY2VUeXBlID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQodG9wb0lkKTtcblxuICAgIGlmIChsYXN0U291cmNlVHlwZSAmJiAobGFzdFNvdXJjZVR5cGUudHlwZSA9PT0gQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCB8fCBsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX0FDVElWQVRPUl9DQUxMKSkge1xuICAgICAgICAvL2ZvciBtb2RpZmllciwganVzdCB1c2UgdGhlIGZpbmFsIHJlc3VsdFxuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFZhclJlZihsYXN0U291cmNlVHlwZS50YXJnZXQsIHRydWUpO1xuICAgIH1cblxuICAgIGxldCBhc3QgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXTtcbiAgICBpZiAoYXN0LnR5cGUgPT09ICdNZW1iZXJFeHByZXNzaW9uJyAmJiBhc3Qub2JqZWN0Lm5hbWUgPT09ICdsYXRlc3QnKSB7XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICBKc0xhbmcuYXN0Q2FsbCgnbGF0ZXN0Lmhhc093blByb3BlcnR5JywgWyBhc3QucHJvcGVydHkudmFsdWUgXSksIC8qKiB0ZXN0ICovXG4gICAgICAgICAgICBhc3QsIC8qKiBjb25zZXF1ZW50ICovXG4gICAgICAgICAgICB7IC4uLmFzdCwgb2JqZWN0OiB7IC4uLmFzdC5vYmplY3QsIG5hbWU6ICdleGlzdGluZycgfSB9XG4gICAgICAgICk7ICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVDb21waWxlQ29udGV4dChtb2R1bGVOYW1lLCBsaW5rZXIsIHNoYXJlZENvbnRleHQpIHtcbiAgICBsZXQgY29tcGlsZUNvbnRleHQgPSB7XG4gICAgICAgIG1vZHVsZU5hbWUsICAgICAgICBcbiAgICAgICAgbGlua2VyLFxuICAgICAgICB2YXJpYWJsZXM6IHt9LFxuICAgICAgICB0b3BvTm9kZXM6IG5ldyBTZXQoKSxcbiAgICAgICAgdG9wb1NvcnQ6IG5ldyBUb3BvU29ydCgpLFxuICAgICAgICBhc3RNYXA6IHt9LCAvLyBTdG9yZSB0aGUgQVNUIGZvciBhIG5vZGVcbiAgICAgICAgbWFwT2ZUb2tlblRvTWV0YTogbmV3IE1hcCgpLCAvLyBTdG9yZSB0aGUgc291cmNlIGNvZGUgYmxvY2sgcG9pbnRcbiAgICAgICAgbW9kZWxWYXJzOiBuZXcgU2V0KCksXG4gICAgICAgIG1hcE9mRnVuY3RvclRvRmlsZTogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpIHx8IHt9LCAvLyBVc2UgdG8gcmVjb3JkIGltcG9ydCBsaW5lc1xuICAgICAgICBuZXdGdW5jdG9yRmlsZXM6IChzaGFyZWRDb250ZXh0ICYmIHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzKSB8fCBbXVxuICAgIH07XG5cbiAgICBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRtYWluJyk7XG5cbiAgICBsaW5rZXIubG9nKCd2ZXJib3NlJywgYENyZWF0ZWQgY29tcGlsYXRpb24gY29udGV4dCBmb3IgXCIke21vZHVsZU5hbWV9XCIuYCk7XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQ7XG59XG5cbmZ1bmN0aW9uIGlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpIHtcbiAgICByZXR1cm4gdG9wb0lkLmluZGV4T2YoJzphcmdbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckY2FzZXNbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckZXhjZXB0aW9uc1snKSA9PT0gLTE7XG59XG5cbmZ1bmN0aW9uIHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYsIHRhcmdldFNjb3BlKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YXJSZWYpKSB7XG4gICAgICAgIGFzc2VydDogdmFyUmVmLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnO1xuXG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLm5hbWUsIHRhcmdldFNjb3BlKSB9OyAgICAgICAgXG4gICAgfSBcblxuICAgIGFzc2VydDogdHlwZW9mIHZhclJlZiA9PT0gJ3N0cmluZyc7XG5cbiAgICBsZXQgcGFydHMgPSB2YXJSZWYuc3BsaXQoJy4nKTtcbiAgICBhc3NlcnQ6IHBhcnRzLmxlbmd0aCA+IDE7XG5cbiAgICBwYXJ0cy5zcGxpY2UoMCwgMSwgdGFyZ2V0U2NvcGUpO1xuICAgIHJldHVybiBwYXJ0cy5qb2luKCcuJyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIGNvbXBpbGVQYXJhbSxcbiAgICBjb21waWxlRmllbGQsXG4gICAgY29tcGlsZURiT3BlcmF0aW9uLFxuICAgIGNvbXBpbGVFeGNlcHRpb25hbFJldHVybixcbiAgICBjb21waWxlUmV0dXJuLFxuICAgIGNyZWF0ZVRvcG9JZCxcbiAgICBjcmVhdGVDb21waWxlQ29udGV4dCxcbiAgICBkZXBlbmRzT24sXG4gICAgYWRkQ29kZUJsb2NrLFxuXG4gICAgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyxcbiAgICBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIEFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfVklFV19SRVRVUk4sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiwgXG4gICAgQVNUX0JMS19FWENFUFRJT05fSVRFTSxcblxuICAgIE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdcbn07Il19