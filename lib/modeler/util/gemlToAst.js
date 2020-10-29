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
  let endTopoId = createTopoId(compileContext, 'op$' + index.toString());
  let conditionVarName = endTopoId + '$condition';
  let ast = [JsLang.astVarDeclare(conditionVarName)];
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

  compileContext.topoNodes.add(name);
  return name;
}

function dependsOn(compileContext, previousOp, currentOp) {
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
    return {
      oolType: 'ObjectReference',
      name: replaceVarRefScope(varRef.name, targetScope)
    };
  }

  let parts = varRef.split('.');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvZ2VtbFRvQXN0LmpzIl0sIm5hbWVzIjpbIl8iLCJyZXF1aXJlIiwiVG9wb1NvcnQiLCJKc0xhbmciLCJHZW1sVHlwZXMiLCJpc0RvdFNlcGFyYXRlTmFtZSIsImV4dHJhY3REb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUiLCJUeXBlcyIsIlZhbGlkYXRvcnMiLCJPb2xvbmdWYWxpZGF0b3JzIiwiUHJvY2Vzc29ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJBY3RpdmF0b3JzIiwiT29sb25nQWN0aXZhdG9ycyIsImRlZmF1bHRFcnJvciIsIkFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MiLCJBU1RfQkxLX1BBUkFNX1NBTklUSVpFIiwiQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCIsIkFTVF9CTEtfVkFMSURBVE9SX0NBTEwiLCJBU1RfQkxLX0FDVElWQVRPUl9DQUxMIiwiQVNUX0JMS19WSUVXX09QRVJBVElPTiIsIkFTVF9CTEtfVklFV19SRVRVUk4iLCJBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04iLCJBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4iLCJBU1RfQkxLX0VYQ0VQVElPTl9JVEVNIiwiT09MX01PRElGSUVSX0NPREVfRkxBRyIsIk1vZGlmaWVyIiwiVkFMSURBVE9SIiwiUFJPQ0VTU09SIiwiQUNUSVZBVE9SIiwiT09MX01PRElGSUVSX09QIiwiT09MX01PRElGSUVSX1BBVEgiLCJPT0xfTU9ESUZJRVJfQlVJTFRJTiIsIk9QRVJBVE9SX1RPS0VOIiwiY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbiIsInRlc3QiLCJjb21waWxlQ29udGV4dCIsInN0YXJ0VG9wb0lkIiwiaXNQbGFpbk9iamVjdCIsIm9vbFR5cGUiLCJlbmRUb3BvSWQiLCJjcmVhdGVUb3BvSWQiLCJvcGVyYW5kVG9wb0lkIiwiZGVwZW5kc09uIiwibGFzdE9wZXJhbmRUb3BvSWQiLCJjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24iLCJjYWxsZXIiLCJhc3RBcmd1bWVudCIsImdldENvZGVSZXByZXNlbnRhdGlvbk9mIiwicmV0VG9wb0lkIiwiY29tcGlsZUFkSG9jVmFsaWRhdG9yIiwiY2FsbGVlIiwib3AiLCJvcGVyYXRvciIsIkVycm9yIiwibGVmdFRvcG9JZCIsInJpZ2h0VG9wb0lkIiwibGFzdExlZnRJZCIsImxlZnQiLCJsYXN0UmlnaHRJZCIsInJpZ2h0IiwiYXN0TWFwIiwiYXN0QmluRXhwIiwiYXJndW1lbnQiLCJhc3ROb3QiLCJhc3RDYWxsIiwidmFsdWVTdGFydFRvcG9JZCIsImFzdFZhbHVlIiwidG9wb0lkIiwidmFsdWUiLCJmdW5jdG9yIiwiY2FsbEFyZ3MiLCJhcmdzIiwidHJhbnNsYXRlQXJncyIsImFyZzAiLCJuYW1lIiwiY29uY2F0IiwiY29tcGlsZU1vZGlmaWVyIiwiZGVjbGFyZVBhcmFtcyIsInRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zIiwibW9kdWxlTmFtZSIsImlzRW1wdHkiLCJmdW5jdG9ySWQiLCJ0cmFuc2xhdGVNb2RpZmllciIsInJlZmVyZW5jZXMiLCJleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyIsImZpbmQiLCJyZWYiLCJhc3RBd2FpdCIsImFzdFZhclJlZiIsImlzVG9wTGV2ZWxCbG9jayIsInN0YXJ0c1dpdGgiLCJhc3RDb25kaXRpb25hbCIsInJlcGxhY2VWYXJSZWZTY29wZSIsInRhcmdldFZhck5hbWUiLCJuZWVkRGVjbGFyZSIsInZhcmlhYmxlcyIsImNvdW50ZXIiLCJ0b1N0cmluZyIsImhhc093blByb3BlcnR5IiwidHlwZSIsInNvdXJjZSIsImFkZENvZGVCbG9jayIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJBcnJheSIsImlzQXJyYXkiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwibmV3RnVuY3RvckZpbGVzIiwiY29tcGlsZVBpcGVkVmFsdWUiLCJ2YXJPb2wiLCJsYXN0VG9wb0lkIiwibW9kaWZpZXJzIiwibW9kaWZpZXIiLCJtb2RpZmllclN0YXJ0VG9wb0lkIiwiY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlIiwiU2V0IiwidHJhbnNsYXRlRnVuY3Rpb25QYXJhbSIsImFyZyIsImkiLCJwb3AiLCJtYXAiLCJiYXNlTmFtZSIsImNvdW50IiwiaGFzIiwiYWRkIiwicmVmQmFzZSIsInJlc3QiLCJkZXBlbmRlbmN5Iiwib25nb2luZyIsInJlZkZpZWxkTmFtZSIsIm9vclR5cGUiLCJ0cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm1hcFZhbHVlcyIsInZhbHVlT2ZFbGVtZW50Iiwia2V5Iiwic2lkIiwiZWlkIiwiaW5kZXgiLCJlYWNoIiwiYXJnVG9wb0lkIiwiY29tcGlsZVBhcmFtIiwicGFyYW0iLCJ0eXBlT2JqZWN0Iiwic2FuaXRpemVyTmFtZSIsInRvVXBwZXJDYXNlIiwidmFyUmVmIiwiY2FsbEFzdCIsImFzdEFycmF5QWNjZXNzIiwicHJlcGFyZVRvcG9JZCIsImFzdEFzc2lnbiIsIm1haW5TdGFydElkIiwid3JhcFBhcmFtUmVmZXJlbmNlIiwicmVhZHlUb3BvSWQiLCJjb21waWxlRmllbGQiLCJwYXJhbU5hbWUiLCJjb250ZXh0TmFtZSIsIk9iamVjdCIsImFzc2lnbiIsImhhc01vZGVsRmllbGQiLCJvcGVyYW5kIiwiYmFzZVZhciIsInNwbGl0IiwidHJhbnNsYXRlUmV0dXJuVGhlbkFzdCIsInN0YXJ0SWQiLCJlbmRJZCIsInRoZW4iLCJhc3RUaHJvdyIsImVycm9yVHlwZSIsIm1lc3NhZ2UiLCJ0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdCIsInZhbHVlRW5kSWQiLCJhc3RSZXR1cm4iLCJ0cmFuc2xhdGVUaGVuQXN0IiwiYXNzaWduVG8iLCJjb25kaXRpb24iLCJzdGFydFJpZ2h0SWQiLCJ2YWx1ZVRvcG9JZCIsImNvbXBpbGVSZXR1cm4iLCJjb21waWxlRmluZE9uZSIsIm9wZXJhdGlvbiIsImNvbmRpdGlvblZhck5hbWUiLCJhc3QiLCJhc3RWYXJEZWNsYXJlIiwibW9kZWwiLCJ0b3BvSWRQcmVmaXgiLCJsYXN0U3RhdGVtZW50IiwiZWxzZSIsImVsc2VTdGFydCIsImVsc2VFbmQiLCJpdGVtcyIsInJldmVyc2UiLCJpdGVtIiwiY2FzZVByZWZpeCIsImNhc2VUb3BvSWQiLCJjYXNlUmVzdWx0VmFyTmFtZSIsImFzdENhc2VUdGVtIiwiaWZTdGFydCIsImlmRW5kIiwiYXN0SWYiLCJhc3RCbG9jayIsIm1vZGVsVG9wb0lkIiwiY29tcGlsZURiT3BlcmF0aW9uIiwiZG9CbG9jayIsImRvIiwiY29tcGlsZURvU3RhdGVtZW50IiwiY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuIiwib29sTm9kZSIsImxhc3RFeGNlcHRpb25JZCIsImV4Y2VwdGlvbnMiLCJleGNlcHRpb25TdGFydElkIiwiZXhjZXB0aW9uRW5kSWQiLCJ0aGVuU3RhcnRJZCIsInJldHVyblN0YXJ0VG9wb0lkIiwidG9wb05vZGVzIiwicHJldmlvdXNPcCIsImN1cnJlbnRPcCIsImxpbmtlciIsImxvZyIsInRvcG9Tb3J0IiwiYmxvY2tNZXRhIiwibWFwT2ZUb2tlblRvTWV0YSIsInNldCIsImxhc3RTb3VyY2VUeXBlIiwiZ2V0Iiwib2JqZWN0IiwicHJvcGVydHkiLCJjcmVhdGVDb21waWxlQ29udGV4dCIsInNoYXJlZENvbnRleHQiLCJNYXAiLCJtb2RlbFZhcnMiLCJpbmRleE9mIiwidGFyZ2V0U2NvcGUiLCJwYXJ0cyIsInNwbGljZSIsImpvaW4iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQU9BLE1BQU07QUFBRUEsRUFBQUE7QUFBRixJQUFRQyxPQUFPLENBQUMsVUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBZUQsT0FBTyxDQUFDLGlCQUFELENBQTVCOztBQUVBLE1BQU1FLE1BQU0sR0FBR0YsT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBQ0EsTUFBTUcsU0FBUyxHQUFHSCxPQUFPLENBQUMsc0JBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxpQkFBRjtBQUFxQkMsRUFBQUEsc0JBQXJCO0FBQTZDQyxFQUFBQTtBQUE3QyxJQUEwRU4sT0FBTyxDQUFDLHNCQUFELENBQXZGOztBQUNBLE1BQU07QUFBR08sRUFBQUEsS0FBSDtBQUFVQyxFQUFBQSxVQUFVLEVBQUVDLGdCQUF0QjtBQUF3Q0MsRUFBQUEsVUFBVSxFQUFFQyxnQkFBcEQ7QUFBc0VDLEVBQUFBLFVBQVUsRUFBRUM7QUFBbEYsSUFBdUdiLE9BQU8sQ0FBQyxZQUFELENBQXBIOztBQUVBLE1BQU1jLFlBQVksR0FBRyxnQkFBckI7QUFFQSxNQUFNQyx5QkFBeUIsR0FBRyxpQkFBbEM7QUFDQSxNQUFNQyxzQkFBc0IsR0FBRyxtQkFBL0I7QUFDQSxNQUFNQyxzQkFBc0IsR0FBRyxlQUEvQjtBQUNBLE1BQU1DLHNCQUFzQixHQUFHLGVBQS9CO0FBQ0EsTUFBTUMsc0JBQXNCLEdBQUcsZUFBL0I7QUFDQSxNQUFNQyxzQkFBc0IsR0FBRyxlQUEvQjtBQUNBLE1BQU1DLG1CQUFtQixHQUFHLFlBQTVCO0FBQ0EsTUFBTUMsMkJBQTJCLEdBQUcsb0JBQXBDO0FBQ0EsTUFBTUMsd0JBQXdCLEdBQUcsaUJBQWpDO0FBQ0EsTUFBTUMsc0JBQXNCLEdBQUcsZUFBL0I7QUFFQSxNQUFNQyxzQkFBc0IsR0FBRztBQUMzQixHQUFDdEIsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkMsU0FBcEIsR0FBZ0NULHNCQURMO0FBRTNCLEdBQUNmLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJFLFNBQXBCLEdBQWdDWCxzQkFGTDtBQUczQixHQUFDZCxTQUFTLENBQUN1QixRQUFWLENBQW1CRyxTQUFwQixHQUFnQ1Y7QUFITCxDQUEvQjtBQU1BLE1BQU1XLGVBQWUsR0FBRztBQUNwQixHQUFDM0IsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkMsU0FBcEIsR0FBZ0MsSUFEWjtBQUVwQixHQUFDeEIsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkUsU0FBcEIsR0FBZ0MsSUFGWjtBQUdwQixHQUFDekIsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkcsU0FBcEIsR0FBZ0M7QUFIWixDQUF4QjtBQU1BLE1BQU1FLGlCQUFpQixHQUFHO0FBQ3RCLEdBQUM1QixTQUFTLENBQUN1QixRQUFWLENBQW1CQyxTQUFwQixHQUFnQyxZQURWO0FBRXRCLEdBQUN4QixTQUFTLENBQUN1QixRQUFWLENBQW1CRSxTQUFwQixHQUFnQyxZQUZWO0FBR3RCLEdBQUN6QixTQUFTLENBQUN1QixRQUFWLENBQW1CRyxTQUFwQixHQUFnQztBQUhWLENBQTFCO0FBTUEsTUFBTUcsb0JBQW9CLEdBQUc7QUFDekIsR0FBQzdCLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJDLFNBQXBCLEdBQWdDbEIsZ0JBRFA7QUFFekIsR0FBQ04sU0FBUyxDQUFDdUIsUUFBVixDQUFtQkUsU0FBcEIsR0FBZ0NqQixnQkFGUDtBQUd6QixHQUFDUixTQUFTLENBQUN1QixRQUFWLENBQW1CRyxTQUFwQixHQUFnQ2hCO0FBSFAsQ0FBN0I7QUFNQSxNQUFNb0IsY0FBYyxHQUFHO0FBQ25CLE9BQUssS0FEYztBQUVuQixPQUFLLEtBRmM7QUFHbkIsUUFBTSxNQUhhO0FBSW5CLFFBQU0sTUFKYTtBQUtuQixRQUFNLEtBTGE7QUFNbkIsUUFBTSxLQU5hO0FBT25CLFFBQU0sS0FQYTtBQVFuQixXQUFTO0FBUlUsQ0FBdkI7O0FBcUJBLFNBQVNDLDRCQUFULENBQXNDQyxJQUF0QyxFQUE0Q0MsY0FBNUMsRUFBNERDLFdBQTVELEVBQXlFO0FBQ3JFLE1BQUl0QyxDQUFDLENBQUN1QyxhQUFGLENBQWdCSCxJQUFoQixDQUFKLEVBQTJCO0FBQ3ZCLFFBQUlBLElBQUksQ0FBQ0ksT0FBTCxLQUFpQixvQkFBckIsRUFBMkM7QUFDdkMsVUFBSUMsU0FBUyxHQUFHQyxZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxjQUEvQixDQUE1QjtBQUNBLFVBQUlLLGFBQWEsR0FBR0QsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsU0FBL0IsQ0FBaEM7QUFFQU0sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4QkssYUFBOUIsQ0FBVDtBQUVBLFVBQUlFLGlCQUFpQixHQUFHQyw4QkFBOEIsQ0FBQ0gsYUFBRCxFQUFnQlAsSUFBSSxDQUFDVyxNQUFyQixFQUE2QlYsY0FBN0IsQ0FBdEQ7QUFDQU8sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCUSxpQkFBakIsRUFBb0NKLFNBQXBDLENBQVQ7QUFFQSxVQUFJTyxXQUFXLEdBQUdDLHVCQUF1QixDQUFDSixpQkFBRCxFQUFvQlIsY0FBcEIsQ0FBekM7QUFFQSxVQUFJYSxTQUFTLEdBQUdDLHFCQUFxQixDQUFDVixTQUFELEVBQVlPLFdBQVosRUFBeUJaLElBQUksQ0FBQ2dCLE1BQTlCLEVBQXNDZixjQUF0QyxDQUFyQztBQWlDQSxhQUFPSSxTQUFQO0FBRUgsS0E5Q0QsTUE4Q08sSUFBSUwsSUFBSSxDQUFDSSxPQUFMLEtBQWlCLG1CQUFyQixFQUEwQztBQUM3QyxVQUFJQyxTQUFTLEdBQUdDLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLGFBQS9CLENBQTVCO0FBRUEsVUFBSWUsRUFBSjs7QUFFQSxjQUFRakIsSUFBSSxDQUFDa0IsUUFBYjtBQUNJLGFBQUssS0FBTDtBQUNJRCxVQUFBQSxFQUFFLEdBQUcsSUFBTDtBQUNBOztBQUVKLGFBQUssSUFBTDtBQUNJQSxVQUFBQSxFQUFFLEdBQUcsSUFBTDtBQUNBOztBQUVKO0FBQ0ksZ0JBQU0sSUFBSUUsS0FBSixDQUFVLGdDQUFnQ25CLElBQUksQ0FBQ2tCLFFBQS9DLENBQU47QUFWUjs7QUFhQSxVQUFJRSxVQUFVLEdBQUdkLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLGFBQS9CLENBQTdCO0FBQ0EsVUFBSW1CLFdBQVcsR0FBR2YsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsY0FBL0IsQ0FBOUI7QUFFQU0sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4QmtCLFVBQTlCLENBQVQ7QUFDQVosTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4Qm1CLFdBQTlCLENBQVQ7QUFFQSxVQUFJQyxVQUFVLEdBQUd2Qiw0QkFBNEIsQ0FBQ0MsSUFBSSxDQUFDdUIsSUFBTixFQUFZdEIsY0FBWixFQUE0Qm1CLFVBQTVCLENBQTdDO0FBQ0EsVUFBSUksV0FBVyxHQUFHekIsNEJBQTRCLENBQUNDLElBQUksQ0FBQ3lCLEtBQU4sRUFBYXhCLGNBQWIsRUFBNkJvQixXQUE3QixDQUE5QztBQUVBYixNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJxQixVQUFqQixFQUE2QmpCLFNBQTdCLENBQVQ7QUFDQUcsTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCdUIsV0FBakIsRUFBOEJuQixTQUE5QixDQUFUO0FBRUFKLE1BQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3RDLE1BQU0sQ0FBQzRELFNBQVAsQ0FDL0JkLHVCQUF1QixDQUFDUyxVQUFELEVBQWFyQixjQUFiLENBRFEsRUFFL0JnQixFQUYrQixFQUcvQkosdUJBQXVCLENBQUNXLFdBQUQsRUFBY3ZCLGNBQWQsQ0FIUSxDQUFuQztBQU1BLGFBQU9JLFNBQVA7QUFFSCxLQXRDTSxNQXNDQSxJQUFJTCxJQUFJLENBQUNJLE9BQUwsS0FBaUIsa0JBQXJCLEVBQXlDO0FBQzVDLFVBQUlDLFNBQVMsR0FBR0MsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsYUFBL0IsQ0FBNUI7QUFFQSxVQUFJZSxFQUFKOztBQUVBLGNBQVFqQixJQUFJLENBQUNrQixRQUFiO0FBQ0ksYUFBSyxHQUFMO0FBQ0EsYUFBSyxHQUFMO0FBQ0EsYUFBSyxJQUFMO0FBQ0EsYUFBSyxJQUFMO0FBQ0EsYUFBSyxJQUFMO0FBQ0lELFVBQUFBLEVBQUUsR0FBR2pCLElBQUksQ0FBQ2tCLFFBQVY7QUFDQTs7QUFFSixhQUFLLElBQUw7QUFDSUQsVUFBQUEsRUFBRSxHQUFHLEtBQUw7QUFDQTs7QUFFSixhQUFLLElBQUw7QUFDSUEsVUFBQUEsRUFBRSxHQUFHLEtBQUw7QUFDQTs7QUFFSjtBQUNJLGdCQUFNLElBQUlFLEtBQUosQ0FBVSxnQ0FBZ0NuQixJQUFJLENBQUNrQixRQUEvQyxDQUFOO0FBbEJSOztBQXFCQSxVQUFJRSxVQUFVLEdBQUdkLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLGFBQS9CLENBQTdCO0FBQ0EsVUFBSW1CLFdBQVcsR0FBR2YsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsY0FBL0IsQ0FBOUI7QUFFQU0sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4QmtCLFVBQTlCLENBQVQ7QUFDQVosTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4Qm1CLFdBQTlCLENBQVQ7QUFFQSxVQUFJQyxVQUFVLEdBQUdaLDhCQUE4QixDQUFDVSxVQUFELEVBQWFwQixJQUFJLENBQUN1QixJQUFsQixFQUF3QnRCLGNBQXhCLENBQS9DO0FBQ0EsVUFBSXVCLFdBQVcsR0FBR2QsOEJBQThCLENBQUNXLFdBQUQsRUFBY3JCLElBQUksQ0FBQ3lCLEtBQW5CLEVBQTBCeEIsY0FBMUIsQ0FBaEQ7QUFFQU8sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCcUIsVUFBakIsRUFBNkJqQixTQUE3QixDQUFUO0FBQ0FHLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQnVCLFdBQWpCLEVBQThCbkIsU0FBOUIsQ0FBVDtBQUVBSixNQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUN0QyxNQUFNLENBQUM0RCxTQUFQLENBQy9CZCx1QkFBdUIsQ0FBQ1MsVUFBRCxFQUFhckIsY0FBYixDQURRLEVBRS9CZ0IsRUFGK0IsRUFHL0JKLHVCQUF1QixDQUFDVyxXQUFELEVBQWN2QixjQUFkLENBSFEsQ0FBbkM7QUFNQSxhQUFPSSxTQUFQO0FBRUgsS0E5Q00sTUE4Q0EsSUFBSUwsSUFBSSxDQUFDSSxPQUFMLEtBQWlCLGlCQUFyQixFQUF3QztBQUMzQyxVQUFJQyxTQUFTLEdBQUdDLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLGFBQS9CLENBQTVCO0FBQ0EsVUFBSUssYUFBYSxHQUFHRCxZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxRQUEvQixDQUFoQztBQUVBTSxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJDLFdBQWpCLEVBQThCSyxhQUE5QixDQUFUO0FBRUEsVUFBSUUsaUJBQWlCLEdBQUdULElBQUksQ0FBQ2tCLFFBQUwsS0FBa0IsS0FBbEIsR0FBMEJSLDhCQUE4QixDQUFDSCxhQUFELEVBQWdCUCxJQUFJLENBQUM0QixRQUFyQixFQUErQjNCLGNBQS9CLENBQXhELEdBQXlHRiw0QkFBNEIsQ0FBQ0MsSUFBSSxDQUFDNEIsUUFBTixFQUFnQjNCLGNBQWhCLEVBQWdDTSxhQUFoQyxDQUE3SjtBQUNBQyxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJRLGlCQUFqQixFQUFvQ0osU0FBcEMsQ0FBVDtBQUVBLFVBQUlPLFdBQVcsR0FBR0MsdUJBQXVCLENBQUNKLGlCQUFELEVBQW9CUixjQUFwQixDQUF6Qzs7QUFFQSxjQUFRRCxJQUFJLENBQUNrQixRQUFiO0FBQ0ksYUFBSyxRQUFMO0FBQ0lqQixVQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUN0QyxNQUFNLENBQUM4RCxNQUFQLENBQWM5RCxNQUFNLENBQUMrRCxPQUFQLENBQWUsV0FBZixFQUE0QmxCLFdBQTVCLENBQWQsQ0FBbkM7QUFDQTs7QUFFSixhQUFLLGFBQUw7QUFDSVgsVUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnJCLFNBQXRCLElBQW1DdEMsTUFBTSxDQUFDOEQsTUFBUCxDQUFjOUQsTUFBTSxDQUFDK0QsT0FBUCxDQUFlLFNBQWYsRUFBMEJsQixXQUExQixDQUFkLENBQW5DO0FBQ0E7O0FBRUosYUFBSyxZQUFMO0FBQ0lYLFVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JyQixTQUF0QixJQUFtQ3RDLE1BQU0sQ0FBQytELE9BQVAsQ0FBZSxXQUFmLEVBQTRCbEIsV0FBNUIsQ0FBbkM7QUFDQTs7QUFFSixhQUFLLFNBQUw7QUFDSVgsVUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnJCLFNBQXRCLElBQW1DdEMsTUFBTSxDQUFDK0QsT0FBUCxDQUFlLFNBQWYsRUFBMEJsQixXQUExQixDQUFuQztBQUNBOztBQUVKLGFBQUssS0FBTDtBQUNJWCxVQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUN0QyxNQUFNLENBQUM4RCxNQUFQLENBQWNqQixXQUFkLENBQW5DO0FBQ0E7O0FBRUo7QUFDSSxnQkFBTSxJQUFJTyxLQUFKLENBQVUsZ0NBQWdDbkIsSUFBSSxDQUFDa0IsUUFBL0MsQ0FBTjtBQXRCUjs7QUF5QkEsYUFBT2IsU0FBUDtBQUVILEtBdENNLE1Bc0NBO0FBQ0gsVUFBSTBCLGdCQUFnQixHQUFHekIsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUcsUUFBL0IsQ0FBbkM7QUFDQU0sTUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4QjZCLGdCQUE5QixDQUFUO0FBQ0EsYUFBT3JCLDhCQUE4QixDQUFDcUIsZ0JBQUQsRUFBbUIvQixJQUFuQixFQUF5QkMsY0FBekIsQ0FBckM7QUFDSDtBQUNKOztBQUVEQSxFQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCeEIsV0FBdEIsSUFBcUNuQyxNQUFNLENBQUNpRSxRQUFQLENBQWdCaEMsSUFBaEIsQ0FBckM7QUFDQSxTQUFPRSxXQUFQO0FBQ0g7O0FBWUQsU0FBU2EscUJBQVQsQ0FBK0JrQixNQUEvQixFQUF1Q0MsS0FBdkMsRUFBOENDLE9BQTlDLEVBQXVEbEMsY0FBdkQsRUFBdUU7QUFHbkUsTUFBSW1DLFFBQUo7O0FBRUEsTUFBSUQsT0FBTyxDQUFDRSxJQUFaLEVBQWtCO0FBQ2RELElBQUFBLFFBQVEsR0FBR0UsYUFBYSxDQUFDTCxNQUFELEVBQVNFLE9BQU8sQ0FBQ0UsSUFBakIsRUFBdUJwQyxjQUF2QixDQUF4QjtBQUNILEdBRkQsTUFFTztBQUNIbUMsSUFBQUEsUUFBUSxHQUFHLEVBQVg7QUFDSDs7QUFFRCxNQUFJRyxJQUFJLEdBQUdMLEtBQVg7QUFFQWpDLEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JPLE1BQXRCLElBQWdDbEUsTUFBTSxDQUFDK0QsT0FBUCxDQUFlLGdCQUFnQkssT0FBTyxDQUFDSyxJQUF2QyxFQUE2QyxDQUFFRCxJQUFGLEVBQVNFLE1BQVQsQ0FBZ0JMLFFBQWhCLENBQTdDLENBQWhDO0FBRUEsU0FBT0gsTUFBUDtBQUNIOztBQWFELFNBQVNTLGVBQVQsQ0FBeUJULE1BQXpCLEVBQWlDQyxLQUFqQyxFQUF3Q0MsT0FBeEMsRUFBaURsQyxjQUFqRCxFQUFpRTtBQUM3RCxNQUFJMEMsYUFBSjs7QUFFQSxNQUFJUixPQUFPLENBQUMvQixPQUFSLEtBQW9CcEMsU0FBUyxDQUFDdUIsUUFBVixDQUFtQkcsU0FBM0MsRUFBc0Q7QUFDbERpRCxJQUFBQSxhQUFhLEdBQUdDLHVCQUF1QixDQUFDLENBQUM7QUFBQ0osTUFBQUEsSUFBSSxFQUFFdkMsY0FBYyxDQUFDNEM7QUFBdEIsS0FBRCxFQUFvQztBQUFDTCxNQUFBQSxJQUFJLEVBQUU7QUFBUCxLQUFwQyxFQUF1REMsTUFBdkQsQ0FBOEROLE9BQU8sQ0FBQ0UsSUFBdEUsQ0FBRCxDQUF2QztBQUNILEdBRkQsTUFFTztBQUNITSxJQUFBQSxhQUFhLEdBQUdDLHVCQUF1QixDQUFDaEYsQ0FBQyxDQUFDa0YsT0FBRixDQUFVWCxPQUFPLENBQUNFLElBQWxCLElBQTBCLENBQUNILEtBQUQsQ0FBMUIsR0FBb0MsQ0FBQ0EsS0FBRCxFQUFRTyxNQUFSLENBQWVOLE9BQU8sQ0FBQ0UsSUFBdkIsQ0FBckMsQ0FBdkM7QUFDSDs7QUFFRCxNQUFJVSxTQUFTLEdBQUdDLGlCQUFpQixDQUFDYixPQUFELEVBQVVsQyxjQUFWLEVBQTBCMEMsYUFBMUIsQ0FBakM7QUFFQSxNQUFJUCxRQUFKLEVBQWNhLFVBQWQ7O0FBRUEsTUFBSWQsT0FBTyxDQUFDRSxJQUFaLEVBQWtCO0FBQ2RELElBQUFBLFFBQVEsR0FBR0UsYUFBYSxDQUFDTCxNQUFELEVBQVNFLE9BQU8sQ0FBQ0UsSUFBakIsRUFBdUJwQyxjQUF2QixDQUF4QjtBQUNBZ0QsSUFBQUEsVUFBVSxHQUFHQyx1QkFBdUIsQ0FBQ2YsT0FBTyxDQUFDRSxJQUFULENBQXBDOztBQUVBLFFBQUl6RSxDQUFDLENBQUN1RixJQUFGLENBQU9GLFVBQVAsRUFBbUJHLEdBQUcsSUFBSUEsR0FBRyxLQUFLbEIsS0FBSyxDQUFDTSxJQUF4QyxDQUFKLEVBQW1EO0FBQy9DLFlBQU0sSUFBSXJCLEtBQUosQ0FBVSxrRUFBVixDQUFOO0FBQ0g7QUFDSixHQVBELE1BT087QUFDSGlCLElBQUFBLFFBQVEsR0FBRyxFQUFYO0FBQ0g7O0FBRUQsTUFBSUQsT0FBTyxDQUFDL0IsT0FBUixLQUFvQnBDLFNBQVMsQ0FBQ3VCLFFBQVYsQ0FBbUJHLFNBQTNDLEVBQXNEO0FBQ2xETyxJQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCTyxNQUF0QixJQUFnQ2xFLE1BQU0sQ0FBQ3NGLFFBQVAsQ0FBZ0JOLFNBQWhCLEVBQTJCLENBQUVoRixNQUFNLENBQUN1RixTQUFQLENBQWlCLE1BQWpCLENBQUYsRUFBNEJ2RixNQUFNLENBQUN1RixTQUFQLENBQWlCLFNBQWpCLENBQTVCLEVBQTBEYixNQUExRCxDQUFpRUwsUUFBakUsQ0FBM0IsQ0FBaEM7QUFDSCxHQUZELE1BRU87QUFDSCxRQUFJRyxJQUFJLEdBQUdMLEtBQVg7O0FBQ0EsUUFBSSxDQUFDcUIsZUFBZSxDQUFDdEIsTUFBRCxDQUFoQixJQUE0QnJFLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0IrQixLQUFoQixDQUE1QixJQUFzREEsS0FBSyxDQUFDOUIsT0FBTixLQUFrQixpQkFBeEUsSUFBNkY4QixLQUFLLENBQUNNLElBQU4sQ0FBV2dCLFVBQVgsQ0FBc0IsU0FBdEIsQ0FBakcsRUFBbUk7QUFFL0hqQixNQUFBQSxJQUFJLEdBQUd4RSxNQUFNLENBQUMwRixjQUFQLENBQ0gxRixNQUFNLENBQUMrRCxPQUFQLENBQWUsdUJBQWYsRUFBd0MsQ0FBRTNELHdCQUF3QixDQUFDK0QsS0FBSyxDQUFDTSxJQUFQLENBQTFCLENBQXhDLENBREcsRUFFSE4sS0FGRyxFQUdId0Isa0JBQWtCLENBQUN4QixLQUFELEVBQVEsVUFBUixDQUhmLENBQVA7QUFLSDs7QUFDRGpDLElBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JPLE1BQXRCLElBQWdDbEUsTUFBTSxDQUFDK0QsT0FBUCxDQUFlaUIsU0FBZixFQUEwQixDQUFFUixJQUFGLEVBQVNFLE1BQVQsQ0FBZ0JMLFFBQWhCLENBQTFCLENBQWhDO0FBQ0g7O0FBRUQsTUFBSW1CLGVBQWUsQ0FBQ3RCLE1BQUQsQ0FBbkIsRUFBNkI7QUFDekIsUUFBSTBCLGFBQWEsR0FBR3pCLEtBQUssQ0FBQ00sSUFBMUI7QUFDQSxRQUFJb0IsV0FBVyxHQUFHLEtBQWxCOztBQUVBLFFBQUksQ0FBQzNGLGlCQUFpQixDQUFDaUUsS0FBSyxDQUFDTSxJQUFQLENBQWxCLElBQWtDdkMsY0FBYyxDQUFDNEQsU0FBZixDQUF5QjNCLEtBQUssQ0FBQ00sSUFBL0IsQ0FBbEMsSUFBMEVMLE9BQU8sQ0FBQy9CLE9BQVIsS0FBb0JwQyxTQUFTLENBQUN1QixRQUFWLENBQW1CQyxTQUFySCxFQUFnSTtBQUU1SCxVQUFJc0UsT0FBTyxHQUFHLENBQWQ7O0FBQ0EsU0FBRztBQUNDQSxRQUFBQSxPQUFPO0FBQ1BILFFBQUFBLGFBQWEsR0FBR3pCLEtBQUssQ0FBQ00sSUFBTixHQUFhc0IsT0FBTyxDQUFDQyxRQUFSLEVBQTdCO0FBQ0gsT0FIRCxRQUdTOUQsY0FBYyxDQUFDNEQsU0FBZixDQUF5QkcsY0FBekIsQ0FBd0NMLGFBQXhDLENBSFQ7O0FBS0ExRCxNQUFBQSxjQUFjLENBQUM0RCxTQUFmLENBQXlCRixhQUF6QixJQUEwQztBQUFFTSxRQUFBQSxJQUFJLEVBQUUsZUFBUjtBQUF5QkMsUUFBQUEsTUFBTSxFQUFFO0FBQWpDLE9BQTFDO0FBQ0FOLE1BQUFBLFdBQVcsR0FBRyxJQUFkO0FBQ0g7O0FBSURPLElBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUJnQyxNQUFqQixFQUF5QjtBQUNqQ2dDLE1BQUFBLElBQUksRUFBRTNFLHNCQUFzQixDQUFDNkMsT0FBTyxDQUFDL0IsT0FBVCxDQURLO0FBRWpDZ0UsTUFBQUEsTUFBTSxFQUFFVCxhQUZ5QjtBQUdqQ1YsTUFBQUEsVUFIaUM7QUFJakNXLE1BQUFBO0FBSmlDLEtBQXpCLENBQVo7QUFNSDs7QUFFRCxTQUFPM0IsTUFBUDtBQUNIOztBQUVELFNBQVNpQix1QkFBVCxDQUFpQ21CLE9BQWpDLEVBQTBDO0FBQ3RDQSxFQUFBQSxPQUFPLEdBQUd6RyxDQUFDLENBQUMwRyxTQUFGLENBQVlELE9BQVosQ0FBVjtBQUVBLE1BQUlFLElBQUksR0FBRyxFQUFYO0FBRUFGLEVBQUFBLE9BQU8sQ0FBQ0csT0FBUixDQUFnQkMsQ0FBQyxJQUFJO0FBQ2pCLFFBQUlDLEtBQUssQ0FBQ0MsT0FBTixDQUFjRixDQUFkLENBQUosRUFBc0I7QUFDbEJGLE1BQUFBLElBQUksR0FBR0EsSUFBSSxDQUFDOUIsTUFBTCxDQUFZUyx1QkFBdUIsQ0FBQ3VCLENBQUQsQ0FBbkMsQ0FBUDtBQUNBO0FBQ0g7O0FBRUQsUUFBSUcsTUFBTSxHQUFHQyxxQkFBcUIsQ0FBQ0osQ0FBRCxDQUFsQzs7QUFDQSxRQUFJRyxNQUFKLEVBQVk7QUFDUkwsTUFBQUEsSUFBSSxDQUFDTyxJQUFMLENBQVVGLE1BQVY7QUFDSDtBQUNKLEdBVkQ7QUFZQSxTQUFPTCxJQUFQO0FBQ0g7O0FBRUQsU0FBU00scUJBQVQsQ0FBK0JFLEdBQS9CLEVBQW9DO0FBQ2hDLE1BQUluSCxDQUFDLENBQUN1QyxhQUFGLENBQWdCNEUsR0FBaEIsS0FBd0JBLEdBQUcsQ0FBQzNFLE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUkyRSxHQUFHLENBQUMzRSxPQUFKLEtBQWdCLFlBQXBCLEVBQWtDLE9BQU95RSxxQkFBcUIsQ0FBQ0UsR0FBRyxDQUFDN0MsS0FBTCxDQUE1Qjs7QUFDbEMsUUFBSTZDLEdBQUcsQ0FBQzNFLE9BQUosS0FBZ0IsaUJBQXBCLEVBQXVDO0FBQ25DLGFBQU8yRSxHQUFHLENBQUN2QyxJQUFYO0FBQ0g7QUFDSjs7QUFFRCxTQUFPd0MsU0FBUDtBQUNIOztBQUVELFNBQVNDLGdCQUFULENBQTBCbEMsU0FBMUIsRUFBcUNtQyxXQUFyQyxFQUFrREMsYUFBbEQsRUFBaUVDLGtCQUFqRSxFQUFxRjtBQUNqRixNQUFJQSxrQkFBa0IsQ0FBQ3JDLFNBQUQsQ0FBbEIsSUFBaUNxQyxrQkFBa0IsQ0FBQ3JDLFNBQUQsQ0FBbEIsS0FBa0NvQyxhQUF2RSxFQUFzRjtBQUNsRixVQUFNLElBQUloRSxLQUFKLENBQVcsYUFBWStELFdBQVksWUFBV25DLFNBQVUsY0FBeEQsQ0FBTjtBQUNIOztBQUNEcUMsRUFBQUEsa0JBQWtCLENBQUNyQyxTQUFELENBQWxCLEdBQWdDb0MsYUFBaEM7QUFDSDs7QUFTRCxTQUFTbkMsaUJBQVQsQ0FBMkJiLE9BQTNCLEVBQW9DbEMsY0FBcEMsRUFBb0RvQyxJQUFwRCxFQUEwRDtBQUN0RCxNQUFJZ0QsWUFBSixFQUFrQkMsUUFBbEIsRUFBNEJ2QyxTQUE1Qjs7QUFHQSxNQUFJOUUsaUJBQWlCLENBQUNrRSxPQUFPLENBQUNLLElBQVQsQ0FBckIsRUFBcUM7QUFDakMsUUFBSStDLEtBQUssR0FBR3JILHNCQUFzQixDQUFDaUUsT0FBTyxDQUFDSyxJQUFULENBQWxDOztBQUNBLFFBQUkrQyxLQUFLLENBQUNDLE1BQU4sR0FBZSxDQUFuQixFQUFzQjtBQUNsQixZQUFNLElBQUlyRSxLQUFKLENBQVUsbUNBQW1DZ0IsT0FBTyxDQUFDSyxJQUFyRCxDQUFOO0FBQ0g7O0FBR0QsUUFBSWlELGFBQWEsR0FBR0YsS0FBSyxDQUFDLENBQUQsQ0FBekI7QUFDQUYsSUFBQUEsWUFBWSxHQUFHRSxLQUFLLENBQUMsQ0FBRCxDQUFwQjtBQUNBRCxJQUFBQSxRQUFRLEdBQUcsT0FBTzFGLGlCQUFpQixDQUFDdUMsT0FBTyxDQUFDL0IsT0FBVCxDQUF4QixHQUE0QyxHQUE1QyxHQUFrRHFGLGFBQWxELEdBQWtFLEdBQWxFLEdBQXdFSixZQUF4RSxHQUF1RixLQUFsRztBQUNBdEMsSUFBQUEsU0FBUyxHQUFHMEMsYUFBYSxHQUFHN0gsQ0FBQyxDQUFDOEgsVUFBRixDQUFhTCxZQUFiLENBQTVCO0FBQ0FKLElBQUFBLGdCQUFnQixDQUFDbEMsU0FBRCxFQUFZWixPQUFPLENBQUMvQixPQUFwQixFQUE2QmtGLFFBQTdCLEVBQXVDckYsY0FBYyxDQUFDbUYsa0JBQXRELENBQWhCO0FBRUgsR0FiRCxNQWFPO0FBQ0hDLElBQUFBLFlBQVksR0FBR2xELE9BQU8sQ0FBQ0ssSUFBdkI7QUFFQSxRQUFJbUQsUUFBUSxHQUFHOUYsb0JBQW9CLENBQUNzQyxPQUFPLENBQUMvQixPQUFULENBQW5DOztBQUVBLFFBQUksRUFBRWlGLFlBQVksSUFBSU0sUUFBbEIsQ0FBSixFQUFpQztBQUM3QkwsTUFBQUEsUUFBUSxHQUFHLE9BQU8xRixpQkFBaUIsQ0FBQ3VDLE9BQU8sQ0FBQy9CLE9BQVQsQ0FBeEIsR0FBNEMsR0FBNUMsR0FBa0RILGNBQWMsQ0FBQzRDLFVBQWpFLEdBQThFLEdBQTlFLEdBQW9Gd0MsWUFBcEYsR0FBbUcsS0FBOUc7QUFDQXRDLE1BQUFBLFNBQVMsR0FBR3NDLFlBQVo7O0FBRUEsVUFBSSxDQUFDcEYsY0FBYyxDQUFDbUYsa0JBQWYsQ0FBa0NyQyxTQUFsQyxDQUFMLEVBQW1EO0FBQy9DOUMsUUFBQUEsY0FBYyxDQUFDMkYsZUFBZixDQUErQmQsSUFBL0IsQ0FBb0M7QUFDaENPLFVBQUFBLFlBRGdDO0FBRWhDSCxVQUFBQSxXQUFXLEVBQUUvQyxPQUFPLENBQUMvQixPQUZXO0FBR2hDa0YsVUFBQUEsUUFIZ0M7QUFJaENqRCxVQUFBQTtBQUpnQyxTQUFwQztBQU1IOztBQUVENEMsTUFBQUEsZ0JBQWdCLENBQUNsQyxTQUFELEVBQVlaLE9BQU8sQ0FBQy9CLE9BQXBCLEVBQTZCa0YsUUFBN0IsRUFBdUNyRixjQUFjLENBQUNtRixrQkFBdEQsQ0FBaEI7QUFDSCxLQWRELE1BY087QUFDSHJDLE1BQUFBLFNBQVMsR0FBR1osT0FBTyxDQUFDL0IsT0FBUixHQUFrQixJQUFsQixHQUF5QmlGLFlBQXJDO0FBQ0g7QUFDSjs7QUFFRCxTQUFPdEMsU0FBUDtBQUNIOztBQVlELFNBQVM4QyxpQkFBVCxDQUEyQjNGLFdBQTNCLEVBQXdDNEYsTUFBeEMsRUFBZ0Q3RixjQUFoRCxFQUFnRTtBQUM1RCxNQUFJOEYsVUFBVSxHQUFHckYsOEJBQThCLENBQUNSLFdBQUQsRUFBYzRGLE1BQU0sQ0FBQzVELEtBQXJCLEVBQTRCakMsY0FBNUIsQ0FBL0M7QUFFQTZGLEVBQUFBLE1BQU0sQ0FBQ0UsU0FBUCxDQUFpQnhCLE9BQWpCLENBQXlCeUIsUUFBUSxJQUFJO0FBQ2pDLFFBQUlDLG1CQUFtQixHQUFHNUYsWUFBWSxDQUFDTCxjQUFELEVBQWlCQyxXQUFXLEdBQUdQLGVBQWUsQ0FBQ3NHLFFBQVEsQ0FBQzdGLE9BQVYsQ0FBN0IsR0FBa0Q2RixRQUFRLENBQUN6RCxJQUE1RSxDQUF0QztBQUNBaEMsSUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCOEYsVUFBakIsRUFBNkJHLG1CQUE3QixDQUFUO0FBRUFILElBQUFBLFVBQVUsR0FBR3JELGVBQWUsQ0FDeEJ3RCxtQkFEd0IsRUFFeEJKLE1BQU0sQ0FBQzVELEtBRmlCLEVBR3hCK0QsUUFId0IsRUFJeEJoRyxjQUp3QixDQUE1QjtBQU1ILEdBVkQ7QUFZQSxTQUFPOEYsVUFBUDtBQUNIOztBQVlELFNBQVNJLHdCQUFULENBQWtDakcsV0FBbEMsRUFBK0M0RixNQUEvQyxFQUF1RDdGLGNBQXZELEVBQXVFO0FBVW5FQSxFQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCeEIsV0FBdEIsSUFBcUNuQyxNQUFNLENBQUNpRSxRQUFQLENBQWdCOEQsTUFBaEIsQ0FBckM7QUFDQSxTQUFPNUYsV0FBUDtBQUNIOztBQU9ELFNBQVMwQyx1QkFBVCxDQUFpQ1AsSUFBakMsRUFBdUM7QUFDbkMsTUFBSXpFLENBQUMsQ0FBQ2tGLE9BQUYsQ0FBVVQsSUFBVixDQUFKLEVBQXFCLE9BQU8sRUFBUDtBQUVyQixNQUFJa0QsS0FBSyxHQUFHLElBQUlhLEdBQUosRUFBWjs7QUFFQSxXQUFTQyxzQkFBVCxDQUFnQ0MsR0FBaEMsRUFBcUNDLENBQXJDLEVBQXdDO0FBQ3BDLFFBQUkzSSxDQUFDLENBQUN1QyxhQUFGLENBQWdCbUcsR0FBaEIsQ0FBSixFQUEwQjtBQUN0QixVQUFJQSxHQUFHLENBQUNsRyxPQUFKLEtBQWdCLFlBQXBCLEVBQWtDO0FBQzlCLGVBQU9pRyxzQkFBc0IsQ0FBQ0MsR0FBRyxDQUFDcEUsS0FBTCxDQUE3QjtBQUNIOztBQUVELFVBQUlvRSxHQUFHLENBQUNsRyxPQUFKLEtBQWdCLGlCQUFwQixFQUF1QztBQUNuQyxZQUFJbkMsaUJBQWlCLENBQUNxSSxHQUFHLENBQUM5RCxJQUFMLENBQXJCLEVBQWlDO0FBQzdCLGlCQUFPdEUsc0JBQXNCLENBQUNvSSxHQUFHLENBQUM5RCxJQUFMLENBQXRCLENBQWlDZ0UsR0FBakMsRUFBUDtBQUNIO0FBQ0o7O0FBRUQsYUFBT0YsR0FBRyxDQUFDOUQsSUFBWDtBQUNIOztBQUVELFdBQU8sVUFBVSxDQUFDK0QsQ0FBQyxHQUFHLENBQUwsRUFBUXhDLFFBQVIsRUFBakI7QUFDSDs7QUFFRCxTQUFPbkcsQ0FBQyxDQUFDNkksR0FBRixDQUFNcEUsSUFBTixFQUFZLENBQUNpRSxHQUFELEVBQU1DLENBQU4sS0FBWTtBQUMzQixRQUFJRyxRQUFRLEdBQUdMLHNCQUFzQixDQUFDQyxHQUFELEVBQU1DLENBQU4sQ0FBckM7QUFDQSxRQUFJL0QsSUFBSSxHQUFHa0UsUUFBWDtBQUNBLFFBQUlDLEtBQUssR0FBRyxDQUFaOztBQUVBLFdBQU9wQixLQUFLLENBQUNxQixHQUFOLENBQVVwRSxJQUFWLENBQVAsRUFBd0I7QUFDcEJBLE1BQUFBLElBQUksR0FBR2tFLFFBQVEsR0FBR0MsS0FBSyxDQUFDNUMsUUFBTixFQUFsQjtBQUNBNEMsTUFBQUEsS0FBSztBQUNSOztBQUVEcEIsSUFBQUEsS0FBSyxDQUFDc0IsR0FBTixDQUFVckUsSUFBVjtBQUNBLFdBQU9BLElBQVA7QUFDSCxHQVpNLENBQVA7QUFhSDs7QUFTRCxTQUFTOUIsOEJBQVQsQ0FBd0NSLFdBQXhDLEVBQXFEZ0MsS0FBckQsRUFBNERqQyxjQUE1RCxFQUE0RTtBQUN4RSxNQUFJckMsQ0FBQyxDQUFDdUMsYUFBRixDQUFnQitCLEtBQWhCLENBQUosRUFBNEI7QUFDeEIsUUFBSUEsS0FBSyxDQUFDOUIsT0FBTixLQUFrQixZQUF0QixFQUFvQztBQUNoQyxhQUFPeUYsaUJBQWlCLENBQUMzRixXQUFELEVBQWNnQyxLQUFkLEVBQXFCakMsY0FBckIsQ0FBeEI7QUFDSDs7QUFFRCxRQUFJaUMsS0FBSyxDQUFDOUIsT0FBTixLQUFrQixpQkFBdEIsRUFBeUM7QUFDckMsVUFBSSxDQUFFMEcsT0FBRixFQUFXLEdBQUdDLElBQWQsSUFBdUI3SSxzQkFBc0IsQ0FBQ2dFLEtBQUssQ0FBQ00sSUFBUCxDQUFqRDtBQUVBLFVBQUl3RSxVQUFKOztBQUVBLFVBQUksQ0FBQy9HLGNBQWMsQ0FBQzRELFNBQWYsQ0FBeUJpRCxPQUF6QixDQUFMLEVBQXdDO0FBQ3BDLGNBQU0sSUFBSTNGLEtBQUosQ0FBVyxrQ0FBaUNlLEtBQUssQ0FBQ00sSUFBSyxFQUF2RCxDQUFOO0FBQ0g7O0FBRUQsVUFBSXZDLGNBQWMsQ0FBQzRELFNBQWYsQ0FBeUJpRCxPQUF6QixFQUFrQzdDLElBQWxDLEtBQTJDLFFBQTNDLElBQXVELENBQUNoRSxjQUFjLENBQUM0RCxTQUFmLENBQXlCaUQsT0FBekIsRUFBa0NHLE9BQTlGLEVBQXVHO0FBQ25HRCxRQUFBQSxVQUFVLEdBQUdGLE9BQWI7QUFDSCxPQUZELE1BRU8sSUFBSUEsT0FBTyxLQUFLLFFBQVosSUFBd0JDLElBQUksQ0FBQ3ZCLE1BQUwsR0FBYyxDQUExQyxFQUE2QztBQUVoRCxZQUFJMEIsWUFBWSxHQUFHSCxJQUFJLENBQUNQLEdBQUwsRUFBbkI7O0FBQ0EsWUFBSVUsWUFBWSxLQUFLaEgsV0FBckIsRUFBa0M7QUFDOUI4RyxVQUFBQSxVQUFVLEdBQUdFLFlBQVksR0FBRyxRQUE1QjtBQUNIO0FBQ0osT0FOTSxNQU1BLElBQUl0SixDQUFDLENBQUNrRixPQUFGLENBQVVpRSxJQUFWLENBQUosRUFBcUI7QUFDeEJDLFFBQUFBLFVBQVUsR0FBR0YsT0FBTyxHQUFHLFFBQXZCO0FBQ0g7O0FBRUQsVUFBSUUsVUFBSixFQUFnQjtBQUNaeEcsUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCK0csVUFBakIsRUFBNkI5RyxXQUE3QixDQUFUO0FBQ0g7O0FBRUQsYUFBT2lHLHdCQUF3QixDQUFDakcsV0FBRCxFQUFjZ0MsS0FBZCxFQUFxQmpDLGNBQXJCLENBQS9CO0FBQ0g7O0FBRUQsUUFBSWlDLEtBQUssQ0FBQzlCLE9BQU4sS0FBa0IsUUFBdEIsRUFBZ0M7QUFDNUJILE1BQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0J4QixXQUF0QixJQUFxQ25DLE1BQU0sQ0FBQ2lFLFFBQVAsQ0FBZ0JFLEtBQWhCLENBQXJDO0FBQ0EsYUFBT2hDLFdBQVA7QUFDSDs7QUFFRCxRQUFJZ0MsS0FBSyxDQUFDaUYsT0FBTixLQUFrQixhQUF0QixFQUFxQztBQUNqQ2xILE1BQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0J4QixXQUF0QixJQUFxQ25DLE1BQU0sQ0FBQ2lFLFFBQVAsQ0FBZ0JvRixvQkFBb0IsQ0FBQ2xGLEtBQUssQ0FBQ00sSUFBUCxDQUFwQyxDQUFyQztBQUNBLGFBQU90QyxXQUFQO0FBQ0g7O0FBRURnQyxJQUFBQSxLQUFLLEdBQUd0RSxDQUFDLENBQUN5SixTQUFGLENBQVluRixLQUFaLEVBQW1CLENBQUNvRixjQUFELEVBQWlCQyxHQUFqQixLQUF5QjtBQUNoRCxVQUFJQyxHQUFHLEdBQUdsSCxZQUFZLENBQUNMLGNBQUQsRUFBaUJDLFdBQVcsR0FBRyxHQUFkLEdBQW9CcUgsR0FBckMsQ0FBdEI7QUFDQSxVQUFJRSxHQUFHLEdBQUcvRyw4QkFBOEIsQ0FBQzhHLEdBQUQsRUFBTUYsY0FBTixFQUFzQnJILGNBQXRCLENBQXhDOztBQUNBLFVBQUl1SCxHQUFHLEtBQUtDLEdBQVosRUFBaUI7QUFDYmpILFFBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQndILEdBQWpCLEVBQXNCdkgsV0FBdEIsQ0FBVDtBQUNIOztBQUNELGFBQU9ELGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0IrRixHQUF0QixDQUFQO0FBQ0gsS0FQTyxDQUFSO0FBUUgsR0FuREQsTUFtRE8sSUFBSS9DLEtBQUssQ0FBQ0MsT0FBTixDQUFjekMsS0FBZCxDQUFKLEVBQTBCO0FBQzdCQSxJQUFBQSxLQUFLLEdBQUd0RSxDQUFDLENBQUM2SSxHQUFGLENBQU12RSxLQUFOLEVBQWEsQ0FBQ29GLGNBQUQsRUFBaUJJLEtBQWpCLEtBQTJCO0FBQzVDLFVBQUlGLEdBQUcsR0FBR2xILFlBQVksQ0FBQ0wsY0FBRCxFQUFpQkMsV0FBVyxHQUFHLEdBQWQsR0FBb0J3SCxLQUFwQixHQUE0QixHQUE3QyxDQUF0QjtBQUNBLFVBQUlELEdBQUcsR0FBRy9HLDhCQUE4QixDQUFDOEcsR0FBRCxFQUFNRixjQUFOLEVBQXNCckgsY0FBdEIsQ0FBeEM7O0FBQ0EsVUFBSXVILEdBQUcsS0FBS0MsR0FBWixFQUFpQjtBQUNiakgsUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCd0gsR0FBakIsRUFBc0J2SCxXQUF0QixDQUFUO0FBQ0g7O0FBQ0QsYUFBT0QsY0FBYyxDQUFDeUIsTUFBZixDQUFzQitGLEdBQXRCLENBQVA7QUFDSCxLQVBPLENBQVI7QUFRSDs7QUFFRHhILEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0J4QixXQUF0QixJQUFxQ25DLE1BQU0sQ0FBQ2lFLFFBQVAsQ0FBZ0JFLEtBQWhCLENBQXJDO0FBQ0EsU0FBT2hDLFdBQVA7QUFDSDs7QUFFRCxTQUFTa0gsb0JBQVQsQ0FBOEI1RSxJQUE5QixFQUFvQztBQUNoQyxNQUFJQSxJQUFJLEtBQUssS0FBYixFQUFvQjtBQUNoQixXQUFPO0FBQ0gsY0FBUSxnQkFETDtBQUVILGdCQUFVO0FBQ04sZ0JBQVEsa0JBREY7QUFFTixvQkFBWSxLQUZOO0FBR04sa0JBQVU7QUFDTixrQkFBUSxrQkFERjtBQUVOLHNCQUFZLEtBRk47QUFHTixvQkFBVTtBQUNOLG9CQUFRLGtCQURGO0FBRU4sd0JBQVksS0FGTjtBQUdOLHNCQUFVO0FBQ04sc0JBQVEsWUFERjtBQUVOLHNCQUFRO0FBRkYsYUFISjtBQU9OLHdCQUFZO0FBQ1Isc0JBQVEsWUFEQTtBQUVSLHNCQUFRO0FBRkE7QUFQTixXQUhKO0FBZU4sc0JBQVk7QUFDUixvQkFBUSxZQURBO0FBRVIsb0JBQVE7QUFGQTtBQWZOLFNBSEo7QUF1Qk4sb0JBQVk7QUFDUixrQkFBUSxZQURBO0FBRVIsa0JBQVE7QUFGQTtBQXZCTixPQUZQO0FBOEJILG1CQUFhO0FBOUJWLEtBQVA7QUFnQ0g7O0FBRUQsUUFBTSxJQUFJckIsS0FBSixDQUFVLGtCQUFrQnFCLElBQTVCLENBQU47QUFDSDs7QUFTRCxTQUFTRixhQUFULENBQXVCTCxNQUF2QixFQUErQkksSUFBL0IsRUFBcUNwQyxjQUFyQyxFQUFxRDtBQUNqRG9DLEVBQUFBLElBQUksR0FBR3pFLENBQUMsQ0FBQzBHLFNBQUYsQ0FBWWpDLElBQVosQ0FBUDtBQUNBLE1BQUl6RSxDQUFDLENBQUNrRixPQUFGLENBQVVULElBQVYsQ0FBSixFQUFxQixPQUFPLEVBQVA7QUFFckIsTUFBSUQsUUFBUSxHQUFHLEVBQWY7O0FBRUF4RSxFQUFBQSxDQUFDLENBQUMrSixJQUFGLENBQU90RixJQUFQLEVBQWEsQ0FBQ2lFLEdBQUQsRUFBTUMsQ0FBTixLQUFZO0FBQ3JCLFFBQUlxQixTQUFTLEdBQUd0SCxZQUFZLENBQUNMLGNBQUQsRUFBaUJnQyxNQUFNLEdBQUcsT0FBVCxHQUFtQixDQUFDc0UsQ0FBQyxHQUFDLENBQUgsRUFBTXhDLFFBQU4sRUFBbkIsR0FBc0MsR0FBdkQsQ0FBNUI7QUFDQSxRQUFJZ0MsVUFBVSxHQUFHckYsOEJBQThCLENBQUNrSCxTQUFELEVBQVl0QixHQUFaLEVBQWlCckcsY0FBakIsQ0FBL0M7QUFFQU8sSUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCOEYsVUFBakIsRUFBNkI5RCxNQUE3QixDQUFUO0FBRUFHLElBQUFBLFFBQVEsR0FBR0EsUUFBUSxDQUFDSyxNQUFULENBQWdCN0UsQ0FBQyxDQUFDMEcsU0FBRixDQUFZekQsdUJBQXVCLENBQUNrRixVQUFELEVBQWE5RixjQUFiLENBQW5DLENBQWhCLENBQVg7QUFDSCxHQVBEOztBQVNBLFNBQU9tQyxRQUFQO0FBQ0g7O0FBU0QsU0FBU3lGLFlBQVQsQ0FBc0JILEtBQXRCLEVBQTZCSSxLQUE3QixFQUFvQzdILGNBQXBDLEVBQW9EO0FBQ2hELE1BQUlnRSxJQUFJLEdBQUc2RCxLQUFLLENBQUM3RCxJQUFqQjtBQUVBLE1BQUk4RCxVQUFVLEdBQUczSixLQUFLLENBQUM2RixJQUFELENBQXRCOztBQUVBLE1BQUksQ0FBQzhELFVBQUwsRUFBaUI7QUFDYixVQUFNLElBQUk1RyxLQUFKLENBQVUseUJBQXlCOEMsSUFBbkMsQ0FBTjtBQUNIOztBQUVELE1BQUkrRCxhQUFhLEdBQUksU0FBUS9ELElBQUksQ0FBQ2dFLFdBQUwsRUFBbUIsV0FBaEQ7QUFFQSxNQUFJQyxNQUFNLEdBQUduSyxNQUFNLENBQUN1RixTQUFQLENBQWlCd0UsS0FBSyxDQUFDdEYsSUFBdkIsQ0FBYjtBQUNBLE1BQUkyRixPQUFPLEdBQUdwSyxNQUFNLENBQUMrRCxPQUFQLENBQWVrRyxhQUFmLEVBQThCLENBQUNFLE1BQUQsRUFBU25LLE1BQU0sQ0FBQ3FLLGNBQVAsQ0FBc0IsY0FBdEIsRUFBc0NWLEtBQXRDLENBQVQsRUFBdUQzSixNQUFNLENBQUN1RixTQUFQLENBQWlCLGNBQWpCLENBQXZELENBQTlCLENBQWQ7QUFFQSxNQUFJK0UsYUFBYSxHQUFHL0gsWUFBWSxDQUFDTCxjQUFELEVBQWlCLHNCQUFzQnlILEtBQUssQ0FBQzNELFFBQU4sRUFBdEIsR0FBeUMsR0FBMUQsQ0FBaEM7QUFhQTlELEVBQUFBLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0IyRyxhQUF0QixJQUF1QyxDQUNuQ3RLLE1BQU0sQ0FBQ3VLLFNBQVAsQ0FBaUJKLE1BQWpCLEVBQXlCQyxPQUF6QixFQUFtQyxzQkFBcUJMLEtBQUssQ0FBQ3RGLElBQUssR0FBbkUsQ0FEbUMsQ0FBdkM7QUFJQTJCLEVBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUJvSSxhQUFqQixFQUFnQztBQUN4Q3BFLElBQUFBLElBQUksRUFBRXBGO0FBRGtDLEdBQWhDLENBQVo7QUFJQTJCLEVBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQm9JLGFBQWpCLEVBQWdDcEksY0FBYyxDQUFDc0ksV0FBL0MsQ0FBVDtBQUVBLE1BQUl0RyxNQUFNLEdBQUczQixZQUFZLENBQUNMLGNBQUQsRUFBaUI2SCxLQUFLLENBQUN0RixJQUF2QixDQUF6QjtBQUNBaEMsRUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQSxjQUFjLENBQUNzSSxXQUFoQyxFQUE2Q3RHLE1BQTdDLENBQVQ7QUFFQSxNQUFJQyxLQUFLLEdBQUdzRyxrQkFBa0IsQ0FBQ1YsS0FBSyxDQUFDdEYsSUFBUCxFQUFhc0YsS0FBYixDQUE5QjtBQUNBLE1BQUl6SCxTQUFTLEdBQUc4Rix3QkFBd0IsQ0FBQ2xFLE1BQUQsRUFBU0MsS0FBVCxFQUFnQmpDLGNBQWhCLENBQXhDO0FBRUEsTUFBSXdJLFdBQVcsR0FBR25JLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmdDLE1BQU0sR0FBRyxRQUExQixDQUE5QjtBQUNBekIsRUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCSSxTQUFqQixFQUE0Qm9JLFdBQTVCLENBQVQ7QUFFQSxTQUFPQSxXQUFQO0FBQ0g7O0FBUUQsU0FBU0MsWUFBVCxDQUFzQkMsU0FBdEIsRUFBaUNiLEtBQWpDLEVBQXdDN0gsY0FBeEMsRUFBd0Q7QUFLcEQsTUFBSWdDLE1BQU0sR0FBRzNCLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQjBJLFNBQWpCLENBQXpCO0FBQ0EsTUFBSUMsV0FBVyxHQUFHLFlBQVlELFNBQTlCO0FBR0EsTUFBSXpHLEtBQUssR0FBR3NHLGtCQUFrQixDQUFDSSxXQUFELEVBQWNkLEtBQWQsQ0FBOUI7QUFDQSxNQUFJekgsU0FBUyxHQUFHSyw4QkFBOEIsQ0FBQ3VCLE1BQUQsRUFBU0MsS0FBVCxFQUFnQmpDLGNBQWhCLENBQTlDO0FBRUEsTUFBSXdJLFdBQVcsR0FBR25JLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmdDLE1BQU0sR0FBRyxRQUExQixDQUE5QjtBQUNBekIsRUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCSSxTQUFqQixFQUE0Qm9JLFdBQTVCLENBQVQ7QUFFQSxTQUFPQSxXQUFQO0FBQ0g7O0FBRUQsU0FBU0Qsa0JBQVQsQ0FBNEJoRyxJQUE1QixFQUFrQ04sS0FBbEMsRUFBeUM7QUFDckMsTUFBSWtCLEdBQUcsR0FBR3lGLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjO0FBQUUxSSxJQUFBQSxPQUFPLEVBQUUsaUJBQVg7QUFBOEJvQyxJQUFBQSxJQUFJLEVBQUVBO0FBQXBDLEdBQWQsQ0FBVjs7QUFFQSxNQUFJLENBQUM1RSxDQUFDLENBQUNrRixPQUFGLENBQVVaLEtBQUssQ0FBQzhELFNBQWhCLENBQUwsRUFBaUM7QUFDN0IsV0FBTztBQUFFNUYsTUFBQUEsT0FBTyxFQUFFLFlBQVg7QUFBeUI4QixNQUFBQSxLQUFLLEVBQUVrQixHQUFoQztBQUFxQzRDLE1BQUFBLFNBQVMsRUFBRTlELEtBQUssQ0FBQzhEO0FBQXRELEtBQVA7QUFDSDs7QUFFRCxTQUFPNUMsR0FBUDtBQUNIOztBQUVELFNBQVMyRixhQUFULENBQXVCQyxPQUF2QixFQUFnQy9JLGNBQWhDLEVBQWdEO0FBQzVDLE1BQUlyQyxDQUFDLENBQUN1QyxhQUFGLENBQWdCNkksT0FBaEIsS0FBNEJBLE9BQU8sQ0FBQzVJLE9BQVIsS0FBb0IsaUJBQXBELEVBQXVFO0FBQ25FLFFBQUksQ0FBRTZJLE9BQUYsRUFBVyxHQUFHbEMsSUFBZCxJQUF1QmlDLE9BQU8sQ0FBQ3hHLElBQVIsQ0FBYTBHLEtBQWIsQ0FBbUIsR0FBbkIsQ0FBM0I7QUFFQSxXQUFPakosY0FBYyxDQUFDNEQsU0FBZixDQUF5Qm9GLE9BQXpCLEtBQXFDaEosY0FBYyxDQUFDNEQsU0FBZixDQUF5Qm9GLE9BQXpCLEVBQWtDaEMsT0FBdkUsSUFBa0ZGLElBQUksQ0FBQ3ZCLE1BQUwsR0FBYyxDQUF2RztBQUNIOztBQUVELFNBQU8sS0FBUDtBQUNIOztBQVVELFNBQVMyRCxzQkFBVCxDQUFnQ0MsT0FBaEMsRUFBeUNDLEtBQXpDLEVBQWdEQyxJQUFoRCxFQUFzRHJKLGNBQXRELEVBQXNFO0FBQ2xFLE1BQUlyQyxDQUFDLENBQUN1QyxhQUFGLENBQWdCbUosSUFBaEIsQ0FBSixFQUEyQjtBQUN2QixRQUFJQSxJQUFJLENBQUNsSixPQUFMLEtBQWlCLGlCQUFyQixFQUF3QztBQUNwQyxVQUFJaUMsSUFBSjs7QUFDQSxVQUFJaUgsSUFBSSxDQUFDakgsSUFBVCxFQUFlO0FBQ1hBLFFBQUFBLElBQUksR0FBR0MsYUFBYSxDQUFDOEcsT0FBRCxFQUFVRSxJQUFJLENBQUNqSCxJQUFmLEVBQXFCcEMsY0FBckIsQ0FBcEI7QUFDSCxPQUZELE1BRU87QUFDSG9DLFFBQUFBLElBQUksR0FBRyxFQUFQO0FBQ0g7O0FBQ0QsYUFBT3RFLE1BQU0sQ0FBQ3dMLFFBQVAsQ0FBZ0JELElBQUksQ0FBQ0UsU0FBTCxJQUFrQjdLLFlBQWxDLEVBQWdEMkssSUFBSSxDQUFDRyxPQUFMLElBQWdCcEgsSUFBaEUsQ0FBUDtBQUNIOztBQUVELFFBQUlpSCxJQUFJLENBQUNsSixPQUFMLEtBQWlCLGtCQUFyQixFQUF5QztBQUNyQyxhQUFPc0osdUJBQXVCLENBQUNOLE9BQUQsRUFBVUMsS0FBVixFQUFpQkMsSUFBSSxDQUFDcEgsS0FBdEIsRUFBNkJqQyxjQUE3QixDQUE5QjtBQUNIO0FBQ0o7O0FBR0QsTUFBSXJDLENBQUMsQ0FBQytHLE9BQUYsQ0FBVTJFLElBQVYsS0FBbUIxTCxDQUFDLENBQUN1QyxhQUFGLENBQWdCbUosSUFBaEIsQ0FBdkIsRUFBOEM7QUFDMUMsUUFBSUssVUFBVSxHQUFHakosOEJBQThCLENBQUMwSSxPQUFELEVBQVVFLElBQVYsRUFBZ0JySixjQUFoQixDQUEvQztBQUNBcUosSUFBQUEsSUFBSSxHQUFHckosY0FBYyxDQUFDeUIsTUFBZixDQUFzQmlJLFVBQXRCLENBQVA7QUFDSDs7QUFFRCxTQUFPNUwsTUFBTSxDQUFDNkwsU0FBUCxDQUFpQk4sSUFBakIsQ0FBUDtBQUNIOztBQVdELFNBQVNPLGdCQUFULENBQTBCVCxPQUExQixFQUFtQ0MsS0FBbkMsRUFBMENDLElBQTFDLEVBQWdEckosY0FBaEQsRUFBZ0U2SixRQUFoRSxFQUEwRTtBQUN0RSxNQUFJbE0sQ0FBQyxDQUFDdUMsYUFBRixDQUFnQm1KLElBQWhCLENBQUosRUFBMkI7QUFDdkIsUUFBSUEsSUFBSSxDQUFDbEosT0FBTCxLQUFpQixpQkFBckIsRUFBd0M7QUFDcEMsVUFBSWlDLElBQUo7O0FBQ0EsVUFBSWlILElBQUksQ0FBQ2pILElBQVQsRUFBZTtBQUNYQSxRQUFBQSxJQUFJLEdBQUdDLGFBQWEsQ0FBQzhHLE9BQUQsRUFBVUUsSUFBSSxDQUFDakgsSUFBZixFQUFxQnBDLGNBQXJCLENBQXBCO0FBQ0gsT0FGRCxNQUVPO0FBQ0hvQyxRQUFBQSxJQUFJLEdBQUcsRUFBUDtBQUNIOztBQUNELGFBQU90RSxNQUFNLENBQUN3TCxRQUFQLENBQWdCRCxJQUFJLENBQUNFLFNBQUwsSUFBa0I3SyxZQUFsQyxFQUFnRDJLLElBQUksQ0FBQ0csT0FBTCxJQUFnQnBILElBQWhFLENBQVA7QUFDSDs7QUFFRCxRQUFJaUgsSUFBSSxDQUFDbEosT0FBTCxLQUFpQixtQkFBckIsRUFBMEMsQ0FlekM7O0FBRUQsUUFBSWtKLElBQUksQ0FBQ2xKLE9BQUwsS0FBaUIsa0JBQXJCLEVBQXlDO0FBQ3JDLFVBQUksQ0FBQzJJLGFBQWEsQ0FBQ08sSUFBSSxDQUFDL0gsSUFBTixFQUFZdEIsY0FBWixDQUFsQixFQUErQztBQUMzQyxjQUFNLElBQUlrQixLQUFKLENBQVUsdUVBQVYsQ0FBTjtBQUNIOztBQUVELFVBQUk0SCxhQUFhLENBQUNPLElBQUksQ0FBQzdILEtBQU4sRUFBYXhCLGNBQWIsQ0FBakIsRUFBK0M7QUFDM0MsY0FBTSxJQUFJa0IsS0FBSixDQUFVLHVIQUFWLENBQU47QUFDSDs7QUFFRCxVQUFJNEksU0FBUyxHQUFHLEVBQWhCO0FBQ0EsVUFBSUMsWUFBWSxHQUFHMUosWUFBWSxDQUFDTCxjQUFELEVBQWlCbUosT0FBTyxHQUFHLGNBQTNCLENBQS9CO0FBQ0E1SSxNQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJtSixPQUFqQixFQUEwQlksWUFBMUIsQ0FBVDtBQUVBLFVBQUl4SSxXQUFXLEdBQUdkLDhCQUE4QixDQUFDc0osWUFBRCxFQUFlVixJQUFJLENBQUM3SCxLQUFwQixFQUEyQnhCLGNBQTNCLENBQWhEO0FBQ0FPLE1BQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQnVCLFdBQWpCLEVBQThCNkgsS0FBOUIsQ0FBVDs7QUFFQSxVQUFJQyxJQUFJLENBQUNwSSxRQUFMLEtBQWtCLElBQXRCLEVBQTRCO0FBQ3hCNkksUUFBQUEsU0FBUyxDQUFDVCxJQUFJLENBQUMvSCxJQUFMLENBQVVpQixJQUFWLENBQWUwRyxLQUFmLENBQXFCLEdBQXJCLEVBQTBCLENBQTFCLEVBQTZCLENBQTdCLENBQUQsQ0FBVCxHQUE2Q2pKLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JGLFdBQXRCLENBQTdDO0FBQ0gsT0FGRCxNQUVPO0FBQ0h1SSxRQUFBQSxTQUFTLENBQUNULElBQUksQ0FBQy9ILElBQUwsQ0FBVWlCLElBQVYsQ0FBZTBHLEtBQWYsQ0FBcUIsR0FBckIsRUFBMEIsQ0FBMUIsRUFBNkIsQ0FBN0IsQ0FBRCxDQUFULEdBQTZDO0FBQUUsV0FBQ3BKLGNBQWMsQ0FBQ21CLEVBQUQsQ0FBZixHQUFzQmhCLGNBQWMsQ0FBQ3lCLE1BQWYsQ0FBc0JGLFdBQXRCO0FBQXhCLFNBQTdDO0FBQ0g7O0FBRUQsYUFBT3pELE1BQU0sQ0FBQ3VLLFNBQVAsQ0FBaUJ3QixRQUFqQixFQUEyQi9MLE1BQU0sQ0FBQ2lFLFFBQVAsQ0FBZ0IrSCxTQUFoQixDQUEzQixDQUFQO0FBQ0g7O0FBRUQsUUFBSVQsSUFBSSxDQUFDbEosT0FBTCxLQUFpQixpQkFBckIsRUFBd0MsQ0FFdkM7QUFDSjs7QUFHRCxNQUFJeEMsQ0FBQyxDQUFDK0csT0FBRixDQUFVMkUsSUFBVixLQUFtQjFMLENBQUMsQ0FBQ3VDLGFBQUYsQ0FBZ0JtSixJQUFoQixDQUF2QixFQUE4QztBQUMxQyxRQUFJSyxVQUFVLEdBQUdqSiw4QkFBOEIsQ0FBQzBJLE9BQUQsRUFBVUUsSUFBVixFQUFnQnJKLGNBQWhCLENBQS9DO0FBQ0FxSixJQUFBQSxJQUFJLEdBQUdySixjQUFjLENBQUN5QixNQUFmLENBQXNCaUksVUFBdEIsQ0FBUDtBQUNIOztBQUVELFNBQU81TCxNQUFNLENBQUN1SyxTQUFQLENBQWlCd0IsUUFBakIsRUFBMkJSLElBQTNCLENBQVA7QUFDSDs7QUFVRCxTQUFTSSx1QkFBVCxDQUFpQ3hKLFdBQWpDLEVBQThDRyxTQUE5QyxFQUF5RDZCLEtBQXpELEVBQWdFakMsY0FBaEUsRUFBZ0Y7QUFDNUUsTUFBSWdLLFdBQVcsR0FBR3ZKLDhCQUE4QixDQUFDUixXQUFELEVBQWNnQyxLQUFkLEVBQXFCakMsY0FBckIsQ0FBaEQ7O0FBQ0EsTUFBSWdLLFdBQVcsS0FBSy9KLFdBQXBCLEVBQWlDO0FBQzdCTSxJQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJnSyxXQUFqQixFQUE4QjVKLFNBQTlCLENBQVQ7QUFDSDs7QUFFRCxTQUFPdEMsTUFBTSxDQUFDNkwsU0FBUCxDQUFpQi9JLHVCQUF1QixDQUFDb0osV0FBRCxFQUFjaEssY0FBZCxDQUF4QyxDQUFQO0FBQ0g7O0FBU0QsU0FBU2lLLGFBQVQsQ0FBdUJoSyxXQUF2QixFQUFvQ2dDLEtBQXBDLEVBQTJDakMsY0FBM0MsRUFBMkQ7QUFDdkQsTUFBSUksU0FBUyxHQUFHQyxZQUFZLENBQUNMLGNBQUQsRUFBaUIsU0FBakIsQ0FBNUI7QUFDQU8sRUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCQyxXQUFqQixFQUE4QkcsU0FBOUIsQ0FBVDtBQUVBSixFQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUNxSix1QkFBdUIsQ0FBQ3hKLFdBQUQsRUFBY0csU0FBZCxFQUF5QjZCLEtBQXpCLEVBQWdDakMsY0FBaEMsQ0FBMUQ7QUFFQWtFLEVBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUJJLFNBQWpCLEVBQTRCO0FBQ3BDNEQsSUFBQUEsSUFBSSxFQUFFL0U7QUFEOEIsR0FBNUIsQ0FBWjtBQUlBLFNBQU9tQixTQUFQO0FBQ0g7O0FBVUQsU0FBUzhKLGNBQVQsQ0FBd0J6QyxLQUF4QixFQUErQjBDLFNBQS9CLEVBQTBDbkssY0FBMUMsRUFBMEQrRyxVQUExRCxFQUFzRTtBQUdsRSxNQUFJM0csU0FBUyxHQUFHQyxZQUFZLENBQUNMLGNBQUQsRUFBaUIsUUFBUXlILEtBQUssQ0FBQzNELFFBQU4sRUFBekIsQ0FBNUI7QUFDQSxNQUFJc0csZ0JBQWdCLEdBQUdoSyxTQUFTLEdBQUcsWUFBbkM7QUFFQSxNQUFJaUssR0FBRyxHQUFHLENBQ052TSxNQUFNLENBQUN3TSxhQUFQLENBQXFCRixnQkFBckIsQ0FETSxDQUFWO0FBTUFwSyxFQUFBQSxjQUFjLENBQUM0RCxTQUFmLENBQXlCdUcsU0FBUyxDQUFDSSxLQUFuQyxJQUE0QztBQUFFdkcsSUFBQUEsSUFBSSxFQUFFLFFBQVI7QUFBa0JDLElBQUFBLE1BQU0sRUFBRSxTQUExQjtBQUFxQytDLElBQUFBLE9BQU8sRUFBRTtBQUE5QyxHQUE1Qzs7QUFFQSxNQUFJbUQsU0FBUyxDQUFDTCxTQUFWLENBQW9CM0osT0FBeEIsRUFBaUM7QUFHN0IsUUFBSWdLLFNBQVMsQ0FBQ0wsU0FBVixDQUFvQjNKLE9BQXBCLEtBQWdDLE9BQXBDLEVBQTZDO0FBQ3pDLFVBQUlxSyxZQUFZLEdBQUdwSyxTQUFTLEdBQUcsUUFBL0I7QUFDQSxVQUFJcUssYUFBSjs7QUFFQSxVQUFJTixTQUFTLENBQUNMLFNBQVYsQ0FBb0JZLElBQXhCLEVBQThCO0FBQzFCLFlBQUlDLFNBQVMsR0FBR3RLLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQndLLFlBQVksR0FBRyxPQUFoQyxDQUE1QjtBQUNBLFlBQUlJLE9BQU8sR0FBR3ZLLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQndLLFlBQVksR0FBRyxNQUFoQyxDQUExQjtBQUNBakssUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCMkssU0FBakIsRUFBNEJDLE9BQTVCLENBQVQ7QUFDQXJLLFFBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQjRLLE9BQWpCLEVBQTBCeEssU0FBMUIsQ0FBVDtBQUVBcUssUUFBQUEsYUFBYSxHQUFHYixnQkFBZ0IsQ0FBQ2UsU0FBRCxFQUFZQyxPQUFaLEVBQXFCVCxTQUFTLENBQUNMLFNBQVYsQ0FBb0JZLElBQXpDLEVBQStDMUssY0FBL0MsRUFBK0RvSyxnQkFBL0QsQ0FBaEM7QUFDSCxPQVBELE1BT087QUFDSEssUUFBQUEsYUFBYSxHQUFHM00sTUFBTSxDQUFDd0wsUUFBUCxDQUFnQixhQUFoQixFQUErQixtQkFBL0IsQ0FBaEI7QUFDSDs7QUFFRCxVQUFJM0wsQ0FBQyxDQUFDa0YsT0FBRixDQUFVc0gsU0FBUyxDQUFDTCxTQUFWLENBQW9CZSxLQUE5QixDQUFKLEVBQTBDO0FBQ3RDLGNBQU0sSUFBSTNKLEtBQUosQ0FBVSxvQkFBVixDQUFOO0FBQ0g7O0FBRUR2RCxNQUFBQSxDQUFDLENBQUNtTixPQUFGLENBQVVYLFNBQVMsQ0FBQ0wsU0FBVixDQUFvQmUsS0FBOUIsRUFBcUN0RyxPQUFyQyxDQUE2QyxDQUFDd0csSUFBRCxFQUFPekUsQ0FBUCxLQUFhO0FBQ3RELFlBQUl5RSxJQUFJLENBQUM1SyxPQUFMLEtBQWlCLHNCQUFyQixFQUE2QztBQUN6QyxnQkFBTSxJQUFJZSxLQUFKLENBQVUsb0JBQVYsQ0FBTjtBQUNIOztBQUVEb0YsUUFBQUEsQ0FBQyxHQUFHNkQsU0FBUyxDQUFDTCxTQUFWLENBQW9CZSxLQUFwQixDQUEwQnRGLE1BQTFCLEdBQW1DZSxDQUFuQyxHQUF1QyxDQUEzQztBQUVBLFlBQUkwRSxVQUFVLEdBQUdSLFlBQVksR0FBRyxHQUFmLEdBQXFCbEUsQ0FBQyxDQUFDeEMsUUFBRixFQUFyQixHQUFvQyxHQUFyRDtBQUNBLFlBQUltSCxVQUFVLEdBQUc1SyxZQUFZLENBQUNMLGNBQUQsRUFBaUJnTCxVQUFqQixDQUE3QjtBQUNBekssUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCK0csVUFBakIsRUFBNkJrRSxVQUE3QixDQUFUO0FBRUEsWUFBSUMsaUJBQWlCLEdBQUcsTUFBTVYsWUFBTixHQUFxQixHQUFyQixHQUEyQmxFLENBQUMsQ0FBQ3hDLFFBQUYsRUFBbkQ7QUFFQSxZQUFJZ0MsVUFBVSxHQUFHaEcsNEJBQTRCLENBQUNpTCxJQUFJLENBQUNoTCxJQUFOLEVBQVlDLGNBQVosRUFBNEJpTCxVQUE1QixDQUE3QztBQUNBLFlBQUlFLFdBQVcsR0FBR3ZLLHVCQUF1QixDQUFDa0YsVUFBRCxFQUFhOUYsY0FBYixDQUF6QztBQUlBbUwsUUFBQUEsV0FBVyxHQUFHck4sTUFBTSxDQUFDd00sYUFBUCxDQUFxQlksaUJBQXJCLEVBQXdDQyxXQUF4QyxFQUFxRCxJQUFyRCxFQUEyRCxLQUEzRCxFQUFtRSxhQUFZN0UsQ0FBRSxpQkFBZ0I2RCxTQUFTLENBQUNJLEtBQU0sRUFBakgsQ0FBZDtBQUVBLFlBQUlhLE9BQU8sR0FBRy9LLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmdMLFVBQVUsR0FBRyxPQUE5QixDQUExQjtBQUNBLFlBQUlLLEtBQUssR0FBR2hMLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmdMLFVBQVUsR0FBRyxNQUE5QixDQUF4QjtBQUNBekssUUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCOEYsVUFBakIsRUFBNkJzRixPQUE3QixDQUFUO0FBQ0E3SyxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJvTCxPQUFqQixFQUEwQkMsS0FBMUIsQ0FBVDtBQUVBWixRQUFBQSxhQUFhLEdBQUcsQ0FDWlUsV0FEWSxFQUVack4sTUFBTSxDQUFDd04sS0FBUCxDQUFheE4sTUFBTSxDQUFDdUYsU0FBUCxDQUFpQjZILGlCQUFqQixDQUFiLEVBQWtEcE4sTUFBTSxDQUFDeU4sUUFBUCxDQUFnQjNCLGdCQUFnQixDQUFDd0IsT0FBRCxFQUFVQyxLQUFWLEVBQWlCTixJQUFJLENBQUMxQixJQUF0QixFQUE0QnJKLGNBQTVCLEVBQTRDb0ssZ0JBQTVDLENBQWhDLENBQWxELEVBQWtKSyxhQUFsSixDQUZZLENBQWhCO0FBSUFsSyxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJxTCxLQUFqQixFQUF3QmpMLFNBQXhCLENBQVQ7QUFDSCxPQTlCRDs7QUFnQ0FpSyxNQUFBQSxHQUFHLEdBQUdBLEdBQUcsQ0FBQzdILE1BQUosQ0FBVzdFLENBQUMsQ0FBQzBHLFNBQUYsQ0FBWW9HLGFBQVosQ0FBWCxDQUFOO0FBQ0gsS0FwREQsTUFvRE87QUFDSCxZQUFNLElBQUl2SixLQUFKLENBQVUsTUFBVixDQUFOO0FBQ0g7QUFHSixHQTVERCxNQTRETztBQUNILFVBQU0sSUFBSUEsS0FBSixDQUFVLE1BQVYsQ0FBTjtBQUNIOztBQUVEbUosRUFBQUEsR0FBRyxDQUFDeEYsSUFBSixDQUNJL0csTUFBTSxDQUFDd00sYUFBUCxDQUFxQkgsU0FBUyxDQUFDSSxLQUEvQixFQUFzQ3pNLE1BQU0sQ0FBQ3NGLFFBQVAsQ0FBaUIsZUFBakIsRUFBaUN0RixNQUFNLENBQUN1RixTQUFQLENBQWlCK0csZ0JBQWpCLENBQWpDLENBQXRDLENBREo7QUFJQSxTQUFPcEssY0FBYyxDQUFDNEQsU0FBZixDQUF5QnVHLFNBQVMsQ0FBQ0ksS0FBbkMsRUFBMEN2RCxPQUFqRDtBQUVBLE1BQUl3RSxXQUFXLEdBQUduTCxZQUFZLENBQUNMLGNBQUQsRUFBaUJtSyxTQUFTLENBQUNJLEtBQTNCLENBQTlCO0FBQ0FoSyxFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUJJLFNBQWpCLEVBQTRCb0wsV0FBNUIsQ0FBVDtBQUNBeEwsRUFBQUEsY0FBYyxDQUFDeUIsTUFBZixDQUFzQnJCLFNBQXRCLElBQW1DaUssR0FBbkM7QUFDQSxTQUFPakssU0FBUDtBQUNIOztBQUVELFNBQVNxTCxrQkFBVCxDQUE0QmhFLEtBQTVCLEVBQW1DMEMsU0FBbkMsRUFBOENuSyxjQUE5QyxFQUE4RCtHLFVBQTlELEVBQTBFO0FBQ3RFLE1BQUlqQixVQUFKOztBQUVBLFVBQVFxRSxTQUFTLENBQUNoSyxPQUFsQjtBQUNJLFNBQUssa0JBQUw7QUFDSTJGLE1BQUFBLFVBQVUsR0FBR29FLGNBQWMsQ0FBQ3pDLEtBQUQsRUFBUTBDLFNBQVIsRUFBbUJuSyxjQUFuQixFQUFtQytHLFVBQW5DLENBQTNCO0FBQ0E7O0FBRUosU0FBSyxNQUFMO0FBRUksWUFBTSxJQUFJN0YsS0FBSixDQUFVLEtBQVYsQ0FBTjtBQUNBOztBQUVKLFNBQUssUUFBTDtBQUNJLFlBQU0sSUFBSUEsS0FBSixDQUFVLEtBQVYsQ0FBTjtBQUVBOztBQUVKLFNBQUssUUFBTDtBQUNJLFlBQU0sSUFBSUEsS0FBSixDQUFVLEtBQVYsQ0FBTjtBQUVBOztBQUVKLFNBQUssUUFBTDtBQUNJLFlBQU0sSUFBSUEsS0FBSixDQUFVLEtBQVYsQ0FBTjtBQUVBOztBQUVKLFNBQUssYUFBTDtBQUNJLFVBQUl3SyxPQUFPLEdBQUd2QixTQUFTLENBQUN3QixFQUF4QjtBQUNBN0YsTUFBQUEsVUFBVSxHQUFHOEYsa0JBQWtCLENBQUNuRSxLQUFELEVBQVFpRSxPQUFSLEVBQWlCMUwsY0FBakIsRUFBaUMrRyxVQUFqQyxDQUEvQjtBQUNBOztBQUVKLFNBQUssWUFBTDtBQUNJLFlBQU0sSUFBSTdGLEtBQUosQ0FBVSxLQUFWLENBQU47QUFDQTs7QUFFSjtBQUNJLFlBQU0sSUFBSUEsS0FBSixDQUFVLGlDQUFpQ2lKLFNBQVMsQ0FBQ25HLElBQXJELENBQU47QUFuQ1I7O0FBc0NBRSxFQUFBQSxZQUFZLENBQUNsRSxjQUFELEVBQWlCOEYsVUFBakIsRUFBNkI7QUFDckM5QixJQUFBQSxJQUFJLEVBQUU5RTtBQUQrQixHQUE3QixDQUFaO0FBSUEsU0FBTzRHLFVBQVA7QUFDSDs7QUFFRCxTQUFTOEYsa0JBQVQsQ0FBNEJuRSxLQUE1QixFQUFtQzBDLFNBQW5DLEVBQThDbkssY0FBOUMsRUFBOEQrRyxVQUE5RCxFQUEwRSxDQUV6RTs7QUFTRCxTQUFTOEUsd0JBQVQsQ0FBa0NDLE9BQWxDLEVBQTJDOUwsY0FBM0MsRUFBMkQrRyxVQUEzRCxFQUF1RTtBQUduRSxNQUFJM0csU0FBUyxHQUFHQyxZQUFZLENBQUNMLGNBQUQsRUFBaUIsU0FBakIsQ0FBNUI7QUFBQSxNQUF5RCtMLGVBQWUsR0FBR2hGLFVBQTNFOztBQUVBLE1BQUksQ0FBQ3BKLENBQUMsQ0FBQ2tGLE9BQUYsQ0FBVWlKLE9BQU8sQ0FBQ0UsVUFBbEIsQ0FBTCxFQUFvQztBQUNoQ0YsSUFBQUEsT0FBTyxDQUFDRSxVQUFSLENBQW1CekgsT0FBbkIsQ0FBMkIsQ0FBQ3dHLElBQUQsRUFBT3pFLENBQVAsS0FBYTtBQUNwQyxVQUFJM0ksQ0FBQyxDQUFDdUMsYUFBRixDQUFnQjZLLElBQWhCLENBQUosRUFBMkI7QUFDdkIsWUFBSUEsSUFBSSxDQUFDNUssT0FBTCxLQUFpQixzQkFBckIsRUFBNkM7QUFDekMsZ0JBQU0sSUFBSWUsS0FBSixDQUFVLG1DQUFtQzZKLElBQUksQ0FBQzVLLE9BQWxELENBQU47QUFDSDs7QUFFRCxZQUFJOEwsZ0JBQWdCLEdBQUc1TCxZQUFZLENBQUNMLGNBQUQsRUFBaUJJLFNBQVMsR0FBRyxVQUFaLEdBQXlCa0csQ0FBQyxDQUFDeEMsUUFBRixFQUF6QixHQUF3QyxHQUF6RCxDQUFuQztBQUNBLFlBQUlvSSxjQUFjLEdBQUc3TCxZQUFZLENBQUNMLGNBQUQsRUFBaUJJLFNBQVMsR0FBRyxVQUFaLEdBQXlCa0csQ0FBQyxDQUFDeEMsUUFBRixFQUF6QixHQUF3QyxRQUF6RCxDQUFqQzs7QUFDQSxZQUFJaUksZUFBSixFQUFxQjtBQUNqQnhMLFVBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQitMLGVBQWpCLEVBQWtDRSxnQkFBbEMsQ0FBVDtBQUNIOztBQUVELFlBQUluRyxVQUFVLEdBQUdoRyw0QkFBNEIsQ0FBQ2lMLElBQUksQ0FBQ2hMLElBQU4sRUFBWUMsY0FBWixFQUE0QmlNLGdCQUE1QixDQUE3QztBQUVBLFlBQUlFLFdBQVcsR0FBRzlMLFlBQVksQ0FBQ0wsY0FBRCxFQUFpQmlNLGdCQUFnQixHQUFHLE9BQXBDLENBQTlCO0FBQ0ExTCxRQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUI4RixVQUFqQixFQUE2QnFHLFdBQTdCLENBQVQ7QUFDQTVMLFFBQUFBLFNBQVMsQ0FBQ1AsY0FBRCxFQUFpQm1NLFdBQWpCLEVBQThCRCxjQUE5QixDQUFUO0FBRUFsTSxRQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCeUssY0FBdEIsSUFBd0NwTyxNQUFNLENBQUN3TixLQUFQLENBQ3BDMUssdUJBQXVCLENBQUNrRixVQUFELEVBQWE5RixjQUFiLENBRGEsRUFFcENsQyxNQUFNLENBQUN5TixRQUFQLENBQWdCckMsc0JBQXNCLENBQ2xDaUQsV0FEa0MsRUFFbENELGNBRmtDLEVBR2xDbkIsSUFBSSxDQUFDMUIsSUFINkIsRUFHdkJySixjQUh1QixDQUF0QyxDQUZvQyxFQU1wQyxJQU5vQyxFQU9uQyx3QkFBdUJzRyxDQUFFLEVBUFUsQ0FBeEM7QUFVQXBDLFFBQUFBLFlBQVksQ0FBQ2xFLGNBQUQsRUFBaUJrTSxjQUFqQixFQUFpQztBQUN6Q2xJLFVBQUFBLElBQUksRUFBRTVFO0FBRG1DLFNBQWpDLENBQVo7QUFJQTJNLFFBQUFBLGVBQWUsR0FBR0csY0FBbEI7QUFDSCxPQWhDRCxNQWdDTztBQUNILGNBQU0sSUFBSWhMLEtBQUosQ0FBVSxhQUFWLENBQU47QUFDSDtBQUNKLEtBcENEO0FBcUNIOztBQUVEWCxFQUFBQSxTQUFTLENBQUNQLGNBQUQsRUFBaUIrTCxlQUFqQixFQUFrQzNMLFNBQWxDLENBQVQ7QUFFQSxNQUFJZ00saUJBQWlCLEdBQUcvTCxZQUFZLENBQUNMLGNBQUQsRUFBaUIsZUFBakIsQ0FBcEM7QUFDQU8sRUFBQUEsU0FBUyxDQUFDUCxjQUFELEVBQWlCb00saUJBQWpCLEVBQW9DaE0sU0FBcEMsQ0FBVDtBQUVBSixFQUFBQSxjQUFjLENBQUN5QixNQUFmLENBQXNCckIsU0FBdEIsSUFBbUNxSix1QkFBdUIsQ0FBQzJDLGlCQUFELEVBQW9CaE0sU0FBcEIsRUFBK0IwTCxPQUFPLENBQUM3SixLQUF2QyxFQUE4Q2pDLGNBQTlDLENBQTFEO0FBRUFrRSxFQUFBQSxZQUFZLENBQUNsRSxjQUFELEVBQWlCSSxTQUFqQixFQUE0QjtBQUNwQzRELElBQUFBLElBQUksRUFBRTdFO0FBRDhCLEdBQTVCLENBQVo7QUFJQSxTQUFPaUIsU0FBUDtBQUNIOztBQUVELFNBQVNDLFlBQVQsQ0FBc0JMLGNBQXRCLEVBQXNDdUMsSUFBdEMsRUFBNEM7QUFDeEMsTUFBSXZDLGNBQWMsQ0FBQ3FNLFNBQWYsQ0FBeUIxRixHQUF6QixDQUE2QnBFLElBQTdCLENBQUosRUFBd0M7QUFDcEMsVUFBTSxJQUFJckIsS0FBSixDQUFXLFlBQVdxQixJQUFLLG9CQUEzQixDQUFOO0FBQ0g7O0FBSUR2QyxFQUFBQSxjQUFjLENBQUNxTSxTQUFmLENBQXlCekYsR0FBekIsQ0FBNkJyRSxJQUE3QjtBQUVBLFNBQU9BLElBQVA7QUFDSDs7QUFFRCxTQUFTaEMsU0FBVCxDQUFtQlAsY0FBbkIsRUFBbUNzTSxVQUFuQyxFQUErQ0MsU0FBL0MsRUFBMEQ7QUFHdER2TSxFQUFBQSxjQUFjLENBQUN3TSxNQUFmLENBQXNCQyxHQUF0QixDQUEwQixPQUExQixFQUFtQ0YsU0FBUyxHQUFHLDZCQUFaLEdBQTRDRCxVQUEvRTs7QUFFQSxNQUFJLENBQUN0TSxjQUFjLENBQUNxTSxTQUFmLENBQXlCMUYsR0FBekIsQ0FBNkI0RixTQUE3QixDQUFMLEVBQThDO0FBQzFDLFVBQU0sSUFBSXJMLEtBQUosQ0FBVyxZQUFXcUwsU0FBVSxnQkFBaEMsQ0FBTjtBQUNIOztBQUVEdk0sRUFBQUEsY0FBYyxDQUFDME0sUUFBZixDQUF3QjlGLEdBQXhCLENBQTRCMEYsVUFBNUIsRUFBd0NDLFNBQXhDO0FBQ0g7O0FBRUQsU0FBU3JJLFlBQVQsQ0FBc0JsRSxjQUF0QixFQUFzQ2dDLE1BQXRDLEVBQThDMkssU0FBOUMsRUFBeUQ7QUFDckQsTUFBSSxFQUFFM0ssTUFBTSxJQUFJaEMsY0FBYyxDQUFDeUIsTUFBM0IsQ0FBSixFQUF3QztBQUNwQyxVQUFNLElBQUlQLEtBQUosQ0FBVyx3Q0FBdUNjLE1BQU8sRUFBekQsQ0FBTjtBQUNIOztBQUVEaEMsRUFBQUEsY0FBYyxDQUFDNE0sZ0JBQWYsQ0FBZ0NDLEdBQWhDLENBQW9DN0ssTUFBcEMsRUFBNEMySyxTQUE1QztBQUVBM00sRUFBQUEsY0FBYyxDQUFDd00sTUFBZixDQUFzQkMsR0FBdEIsQ0FBMEIsU0FBMUIsRUFBc0MsVUFBU0UsU0FBUyxDQUFDM0ksSUFBSyxLQUFJaEMsTUFBTyxxQkFBekU7QUFDSDs7QUFFRCxTQUFTcEIsdUJBQVQsQ0FBaUNvQixNQUFqQyxFQUF5Q2hDLGNBQXpDLEVBQXlEO0FBQ3JELE1BQUk4TSxjQUFjLEdBQUc5TSxjQUFjLENBQUM0TSxnQkFBZixDQUFnQ0csR0FBaEMsQ0FBb0MvSyxNQUFwQyxDQUFyQjs7QUFFQSxNQUFJOEssY0FBYyxLQUFLQSxjQUFjLENBQUM5SSxJQUFmLEtBQXdCbkYsc0JBQXhCLElBQWtEaU8sY0FBYyxDQUFDOUksSUFBZixLQUF3QmpGLHNCQUEvRSxDQUFsQixFQUEwSDtBQUV0SCxXQUFPakIsTUFBTSxDQUFDdUYsU0FBUCxDQUFpQnlKLGNBQWMsQ0FBQzNJLE1BQWhDLEVBQXdDLElBQXhDLENBQVA7QUFDSDs7QUFFRCxNQUFJa0csR0FBRyxHQUFHckssY0FBYyxDQUFDeUIsTUFBZixDQUFzQk8sTUFBdEIsQ0FBVjs7QUFDQSxNQUFJcUksR0FBRyxDQUFDckcsSUFBSixLQUFhLGtCQUFiLElBQW1DcUcsR0FBRyxDQUFDMkMsTUFBSixDQUFXekssSUFBWCxLQUFvQixRQUEzRCxFQUFxRTtBQUNqRSxXQUFPekUsTUFBTSxDQUFDMEYsY0FBUCxDQUNIMUYsTUFBTSxDQUFDK0QsT0FBUCxDQUFlLHVCQUFmLEVBQXdDLENBQUV3SSxHQUFHLENBQUM0QyxRQUFKLENBQWFoTCxLQUFmLENBQXhDLENBREcsRUFFSG9JLEdBRkcsRUFHSCxFQUFFLEdBQUdBLEdBQUw7QUFBVTJDLE1BQUFBLE1BQU0sRUFBRSxFQUFFLEdBQUczQyxHQUFHLENBQUMyQyxNQUFUO0FBQWlCekssUUFBQUEsSUFBSSxFQUFFO0FBQXZCO0FBQWxCLEtBSEcsQ0FBUDtBQUtIOztBQUVELFNBQU92QyxjQUFjLENBQUN5QixNQUFmLENBQXNCTyxNQUF0QixDQUFQO0FBQ0g7O0FBRUQsU0FBU2tMLG9CQUFULENBQThCdEssVUFBOUIsRUFBMEM0SixNQUExQyxFQUFrRFcsYUFBbEQsRUFBaUU7QUFDN0QsTUFBSW5OLGNBQWMsR0FBRztBQUNqQjRDLElBQUFBLFVBRGlCO0FBRWpCNEosSUFBQUEsTUFGaUI7QUFHakI1SSxJQUFBQSxTQUFTLEVBQUUsRUFITTtBQUlqQnlJLElBQUFBLFNBQVMsRUFBRSxJQUFJbEcsR0FBSixFQUpNO0FBS2pCdUcsSUFBQUEsUUFBUSxFQUFFLElBQUk3TyxRQUFKLEVBTE87QUFNakI0RCxJQUFBQSxNQUFNLEVBQUUsRUFOUztBQU9qQm1MLElBQUFBLGdCQUFnQixFQUFFLElBQUlRLEdBQUosRUFQRDtBQVFqQkMsSUFBQUEsU0FBUyxFQUFFLElBQUlsSCxHQUFKLEVBUk07QUFTakJoQixJQUFBQSxrQkFBa0IsRUFBR2dJLGFBQWEsSUFBSUEsYUFBYSxDQUFDaEksa0JBQWhDLElBQXVELEVBVDFEO0FBVWpCUSxJQUFBQSxlQUFlLEVBQUd3SCxhQUFhLElBQUlBLGFBQWEsQ0FBQ3hILGVBQWhDLElBQW9EO0FBVnBELEdBQXJCO0FBYUEzRixFQUFBQSxjQUFjLENBQUNzSSxXQUFmLEdBQTZCakksWUFBWSxDQUFDTCxjQUFELEVBQWlCLE9BQWpCLENBQXpDO0FBRUF3TSxFQUFBQSxNQUFNLENBQUNDLEdBQVAsQ0FBVyxTQUFYLEVBQXVCLG9DQUFtQzdKLFVBQVcsSUFBckU7QUFFQSxTQUFPNUMsY0FBUDtBQUNIOztBQUVELFNBQVNzRCxlQUFULENBQXlCdEIsTUFBekIsRUFBaUM7QUFDN0IsU0FBT0EsTUFBTSxDQUFDc0wsT0FBUCxDQUFlLE9BQWYsTUFBNEIsQ0FBQyxDQUE3QixJQUFrQ3RMLE1BQU0sQ0FBQ3NMLE9BQVAsQ0FBZSxTQUFmLE1BQThCLENBQUMsQ0FBakUsSUFBc0V0TCxNQUFNLENBQUNzTCxPQUFQLENBQWUsY0FBZixNQUFtQyxDQUFDLENBQWpIO0FBQ0g7O0FBRUQsU0FBUzdKLGtCQUFULENBQTRCd0UsTUFBNUIsRUFBb0NzRixXQUFwQyxFQUFpRDtBQUM3QyxNQUFJNVAsQ0FBQyxDQUFDdUMsYUFBRixDQUFnQitILE1BQWhCLENBQUosRUFBNkI7QUFHekIsV0FBTztBQUFFOUgsTUFBQUEsT0FBTyxFQUFFLGlCQUFYO0FBQThCb0MsTUFBQUEsSUFBSSxFQUFFa0Isa0JBQWtCLENBQUN3RSxNQUFNLENBQUMxRixJQUFSLEVBQWNnTCxXQUFkO0FBQXRELEtBQVA7QUFDSDs7QUFJRCxNQUFJQyxLQUFLLEdBQUd2RixNQUFNLENBQUNnQixLQUFQLENBQWEsR0FBYixDQUFaO0FBR0F1RSxFQUFBQSxLQUFLLENBQUNDLE1BQU4sQ0FBYSxDQUFiLEVBQWdCLENBQWhCLEVBQW1CRixXQUFuQjtBQUNBLFNBQU9DLEtBQUssQ0FBQ0UsSUFBTixDQUFXLEdBQVgsQ0FBUDtBQUNIOztBQUVEQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYmhHLEVBQUFBLFlBRGE7QUFFYmEsRUFBQUEsWUFGYTtBQUdiZ0QsRUFBQUEsa0JBSGE7QUFJYkksRUFBQUEsd0JBSmE7QUFLYjVCLEVBQUFBLGFBTGE7QUFNYjVKLEVBQUFBLFlBTmE7QUFPYjZNLEVBQUFBLG9CQVBhO0FBUWIzTSxFQUFBQSxTQVJhO0FBU2IyRCxFQUFBQSxZQVRhO0FBV2J2RixFQUFBQSx5QkFYYTtBQVliRSxFQUFBQSxzQkFaYTtBQWFiQyxFQUFBQSxzQkFiYTtBQWNiQyxFQUFBQSxzQkFkYTtBQWViQyxFQUFBQSxzQkFmYTtBQWdCYkMsRUFBQUEsbUJBaEJhO0FBaUJiQyxFQUFBQSwyQkFqQmE7QUFrQmJDLEVBQUFBLHdCQWxCYTtBQW1CYkMsRUFBQUEsc0JBbkJhO0FBcUJiQyxFQUFBQTtBQXJCYSxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIEBtb2R1bGVcbiAqIEBpZ25vcmVcbiAqL1xuXG5jb25zdCB7IF8gfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IFRvcG9Tb3J0IH0gPSByZXF1aXJlKCdAZ2VueC9hbGdvcml0aG0nKTtcblxuY29uc3QgSnNMYW5nID0gcmVxdWlyZSgnLi9hc3QuanMnKTtcbmNvbnN0IEdlbWxUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvR2VtbFR5cGVzJyk7XG5jb25zdCB7IGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lLCBleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUgfSA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvR2VtbFV0aWxzJyk7XG5jb25zdCB7ICBUeXBlcywgVmFsaWRhdG9yczogT29sb25nVmFsaWRhdG9ycywgUHJvY2Vzc29yczogT29sb25nUHJvY2Vzc29ycywgQWN0aXZhdG9yczogT29sb25nQWN0aXZhdG9ycyB9ID0gcmVxdWlyZSgnQGdlbngvZGF0YScpO1xuXG5jb25zdCBkZWZhdWx0RXJyb3IgPSAnSW52YWxpZFJlcXVlc3QnO1xuXG5jb25zdCBBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTID0gJ0ZpZWxkUHJlUHJvY2Vzcyc7XG5jb25zdCBBU1RfQkxLX1BBUkFNX1NBTklUSVpFID0gJ1BhcmFtZXRlclNhbml0aXplJztcbmNvbnN0IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwgPSAnUHJvY2Vzc29yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMID0gJ1ZhbGlkYXRvckNhbGwnO1xuY29uc3QgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCA9ICdBY3RpdmF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfVklFV19PUEVSQVRJT04gPSAnVmlld09wZXJhdGlvbic7XG5jb25zdCBBU1RfQkxLX1ZJRVdfUkVUVVJOID0gJ1ZpZXdSZXR1cm4nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OID0gJ0ludGVyZmFjZU9wZXJhdGlvbic7XG5jb25zdCBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4gPSAnSW50ZXJmYWNlUmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfRVhDRVBUSU9OX0lURU0gPSAnRXhjZXB0aW9uSXRlbSc7XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUcgPSB7XG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06IEFTVF9CTEtfQUNUSVZBVE9SX0NBTExcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9PUCA9IHtcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd8ficsXG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAnfD4nLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogJ3w9JyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9QQVRIID0ge1xuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogJ3ZhbGlkYXRvcnMnLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3Byb2Nlc3NvcnMnLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogJ2FjdGl2YXRvcnMnIFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX0JVSUxUSU4gPSB7XG4gICAgW0dlbWxUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBPb2xvbmdWYWxpZGF0b3JzLFxuICAgIFtHZW1sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogT29sb25nUHJvY2Vzc29ycyxcbiAgICBbR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06IE9vbG9uZ0FjdGl2YXRvcnMgXG59O1xuXG5jb25zdCBPUEVSQVRPUl9UT0tFTiA9IHtcbiAgICBcIj5cIjogXCIkZ3RcIixcbiAgICBcIjxcIjogXCIkbHRcIixcbiAgICBcIj49XCI6IFwiJGd0ZVwiLFxuICAgIFwiPD1cIjogXCIkbHRlXCIsXG4gICAgXCI9PVwiOiBcIiRlcVwiLFxuICAgIFwiIT1cIjogXCIkbmVcIixcbiAgICBcImluXCI6IFwiJGluXCIsXG4gICAgXCJub3RJblwiOiBcIiRuaW5cIlxufTtcblxuLyoqXG4gKiBDb21waWxlIGEgY29uZGl0aW9uYWwgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHRlc3RcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IFRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LCBjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRlc3QpKSB7ICAgICAgICBcbiAgICAgICAgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1ZhbGlkYXRlRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3AnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgb3BlcmFuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0T3BlcmFuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmNhbGxlciwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0T3BlcmFuZFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGFzdEFyZ3VtZW50ID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdE9wZXJhbmRUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldFRvcG9JZCA9IGNvbXBpbGVBZEhvY1ZhbGlkYXRvcihlbmRUb3BvSWQsIGFzdEFyZ3VtZW50LCB0ZXN0LmNhbGxlZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6IHJldFRvcG9JZCA9PT0gZW5kVG9wb0lkO1xuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmxlZnQsIGNvbXBpbGVDb250ZXh0LCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5yaWdodCwgY29tcGlsZUNvbnRleHQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6ZG9uZScpO1xuXG4gICAgICAgICAgICBsZXQgb3A7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJz4nOlxuICAgICAgICAgICAgICAgIGNhc2UgJzwnOlxuICAgICAgICAgICAgICAgIGNhc2UgJz49JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnaW4nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9IHRlc3Qub3BlcmF0b3I7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnPT0nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICc9PT0nO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJyE9JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnIT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGxlZnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpsZWZ0Jyk7XG4gICAgICAgICAgICBsZXQgcmlnaHRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpyaWdodCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RMZWZ0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24obGVmdFRvcG9JZCwgdGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ocmlnaHRUb3BvSWQsIHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcDpkb25lJyk7XG4gICAgICAgICAgICBsZXQgb3BlcmFuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHVuYU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSB0ZXN0Lm9wZXJhdG9yID09PSAnbm90JyA/IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCkgOiBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QuYXJndW1lbnQsIGNvbXBpbGVDb250ZXh0LCBvcGVyYW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2V4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90LWV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgdmFsdWVTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHZhbHVlJyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCB2YWx1ZVN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odmFsdWVTdGFydFRvcG9JZCwgdGVzdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodGVzdCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YWxpZGF0b3IgY2FsbGVkIGluIGEgbG9naWNhbCBleHByZXNzaW9uLlxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gZnVuY3RvcnNcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHRvcG9JbmZvXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8udG9wb0lkUHJlZml4XG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8ubGFzdFRvcG9JZFxuICogQHJldHVybnMgeyp8c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlQWRIb2NWYWxpZGF0b3IodG9wb0lkLCB2YWx1ZSwgZnVuY3RvciwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhc3NlcnQ6IGZ1bmN0b3Iub29sVHlwZSA9PT0gR2VtbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUjsgICAgICAgIFxuXG4gICAgbGV0IGNhbGxBcmdzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgICAgICBcbiAgICBcbiAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgIFxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ1ZhbGlkYXRvcnMuJyArIGZ1bmN0b3IubmFtZSwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RpZmllciBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0gdG9wb0lkIC0gc3RhcnRUb3BvSWRcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZU1vZGlmaWVyKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGRlY2xhcmVQYXJhbXM7XG5cbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBHZW1sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7IFxuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoW3tuYW1lOiBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lfSwge25hbWU6ICdjb250ZXh0J31dLmNvbmNhdChmdW5jdG9yLmFyZ3MpKTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhfLmlzRW1wdHkoZnVuY3Rvci5hcmdzKSA/IFt2YWx1ZV0gOiBbdmFsdWVdLmNvbmNhdChmdW5jdG9yLmFyZ3MpKTsgICAgICAgIFxuICAgIH0gICAgICAgIFxuXG4gICAgbGV0IGZ1bmN0b3JJZCA9IHRyYW5zbGF0ZU1vZGlmaWVyKGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0LCBkZWNsYXJlUGFyYW1zKTtcblxuICAgIGxldCBjYWxsQXJncywgcmVmZXJlbmNlcztcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5hcmdzKSB7XG4gICAgICAgIGNhbGxBcmdzID0gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGZ1bmN0b3IuYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICByZWZlcmVuY2VzID0gZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMoZnVuY3Rvci5hcmdzKTtcblxuICAgICAgICBpZiAoXy5maW5kKHJlZmVyZW5jZXMsIHJlZiA9PiByZWYgPT09IHZhbHVlLm5hbWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHRhcmdldCBmaWVsZCBpdHNlbGYgYXMgYW4gYXJndW1lbnQgb2YgYSBtb2RpZmllci4nKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgXG4gICAgXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gR2VtbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUikgeyAgICAgICAgICAgIFxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RBd2FpdChmdW5jdG9ySWQsIFsgSnNMYW5nLmFzdFZhclJlZigndGhpcycpLCBKc0xhbmcuYXN0VmFyUmVmKCdjb250ZXh0JykgXS5jb25jYXQoY2FsbEFyZ3MpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgICAgICBpZiAoIWlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpICYmIF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScgJiYgdmFsdWUubmFtZS5zdGFydHNXaXRoKCdsYXRlc3QuJykpIHtcbiAgICAgICAgICAgIC8vbGV0IGV4aXN0aW5nUmVmID0gICAgICAgICAgICBcbiAgICAgICAgICAgIGFyZzAgPSBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdENhbGwoJ2xhdGVzdC5oYXNPd25Qcm9wZXJ0eScsIFsgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lKHZhbHVlLm5hbWUpIF0pLCAvKiogdGVzdCAqL1xuICAgICAgICAgICAgICAgIHZhbHVlLCAvKiogY29uc2VxdWVudCAqL1xuICAgICAgICAgICAgICAgIHJlcGxhY2VWYXJSZWZTY29wZSh2YWx1ZSwgJ2V4aXN0aW5nJylcbiAgICAgICAgICAgICk7ICBcbiAgICAgICAgfVxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKGZ1bmN0b3JJZCwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG4gICAgfSAgICBcblxuICAgIGlmIChpc1RvcExldmVsQmxvY2sodG9wb0lkKSkge1xuICAgICAgICBsZXQgdGFyZ2V0VmFyTmFtZSA9IHZhbHVlLm5hbWU7XG4gICAgICAgIGxldCBuZWVkRGVjbGFyZSA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghaXNEb3RTZXBhcmF0ZU5hbWUodmFsdWUubmFtZSkgJiYgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3ZhbHVlLm5hbWVdICYmIGZ1bmN0b3Iub29sVHlwZSAhPT0gR2VtbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUikge1xuICAgICAgICAgICAgLy9jb25mbGljdCB3aXRoIGV4aXN0aW5nIHZhcmlhYmxlcywgbmVlZCB0byByZW5hbWUgdG8gYW5vdGhlciB2YXJpYWJsZVxuICAgICAgICAgICAgbGV0IGNvdW50ZXIgPSAxO1xuICAgICAgICAgICAgZG8ge1xuICAgICAgICAgICAgICAgIGNvdW50ZXIrKzsgICAgICAgXG4gICAgICAgICAgICAgICAgdGFyZ2V0VmFyTmFtZSA9IHZhbHVlLm5hbWUgKyBjb3VudGVyLnRvU3RyaW5nKCk7ICAgICAgICAgXG4gICAgICAgICAgICB9IHdoaWxlIChjb21waWxlQ29udGV4dC52YXJpYWJsZXMuaGFzT3duUHJvcGVydHkodGFyZ2V0VmFyTmFtZSkpOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbdGFyZ2V0VmFyTmFtZV0gPSB7IHR5cGU6ICdsb2NhbFZhcmlhYmxlJywgc291cmNlOiAnbW9kaWZpZXInIH07XG4gICAgICAgICAgICBuZWVkRGVjbGFyZSA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICAvL2lmIChjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXSlcblxuICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHRvcG9JZCwge1xuICAgICAgICAgICAgdHlwZTogT09MX01PRElGSUVSX0NPREVfRkxBR1tmdW5jdG9yLm9vbFR5cGVdLFxuICAgICAgICAgICAgdGFyZ2V0OiB0YXJnZXRWYXJOYW1lLFxuICAgICAgICAgICAgcmVmZXJlbmNlcywgICAvLyBsYXRlc3QuLCBleHNpdGluZy4sIHJhdy5cbiAgICAgICAgICAgIG5lZWREZWNsYXJlXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0b3BvSWQ7XG59ICBcbiAgICAgIFxuZnVuY3Rpb24gZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMob29sQXJncykgeyAgIFxuICAgIG9vbEFyZ3MgPSBfLmNhc3RBcnJheShvb2xBcmdzKTsgICAgXG5cbiAgICBsZXQgcmVmcyA9IFtdO1xuXG4gICAgb29sQXJncy5mb3JFYWNoKGEgPT4ge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShhKSkge1xuICAgICAgICAgICAgcmVmcyA9IHJlZnMuY29uY2F0KGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKGEpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBcblxuICAgICAgICBsZXQgcmVzdWx0ID0gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKGEpO1xuICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICByZWZzLnB1c2gocmVzdWx0KTtcbiAgICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlZnM7XG59XG5cbmZ1bmN0aW9uIGNoZWNrUmVmZXJlbmNlVG9GaWVsZChvYmopIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9iaikgJiYgb2JqLm9vbFR5cGUpIHtcbiAgICAgICAgaWYgKG9iai5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHJldHVybiBjaGVja1JlZmVyZW5jZVRvRmllbGQob2JqLnZhbHVlKTtcbiAgICAgICAgaWYgKG9iai5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgcmV0dXJuIG9iai5uYW1lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3JUeXBlLCBmdW5jdG9ySnNGaWxlLCBtYXBPZkZ1bmN0b3JUb0ZpbGUpIHtcbiAgICBpZiAobWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gJiYgbWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gIT09IGZ1bmN0b3JKc0ZpbGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb25mbGljdDogJHtmdW5jdG9yVHlwZX0gbmFtaW5nIFwiJHtmdW5jdG9ySWR9XCIgY29uZmxpY3RzIWApO1xuICAgIH1cbiAgICBtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSA9IGZ1bmN0b3JKc0ZpbGU7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGZ1bmN0b3IgaXMgdXNlci1kZWZpbmVkIG9yIGJ1aWx0LWluXG4gKiBAcGFyYW0gZnVuY3RvclxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gYXJncyAtIFVzZWQgdG8gbWFrZSB1cCB0aGUgZnVuY3Rpb24gc2lnbmF0dXJlXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBmdW5jdG9yIGlkXG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZU1vZGlmaWVyKGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0LCBhcmdzKSB7XG4gICAgbGV0IGZ1bmN0aW9uTmFtZSwgZmlsZU5hbWUsIGZ1bmN0b3JJZDtcblxuICAgIC8vZXh0cmFjdCB2YWxpZGF0b3IgbmFtaW5nIGFuZCBpbXBvcnQgaW5mb3JtYXRpb25cbiAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoZnVuY3Rvci5uYW1lKSkge1xuICAgICAgICBsZXQgbmFtZXMgPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGZ1bmN0b3IubmFtZSk7XG4gICAgICAgIGlmIChuYW1lcy5sZW5ndGggPiAyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBzdXBwb3J0ZWQgcmVmZXJlbmNlIHR5cGU6ICcgKyBmdW5jdG9yLm5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9yZWZlcmVuY2UgdG8gb3RoZXIgZW50aXR5IGZpbGVcbiAgICAgICAgbGV0IHJlZkVudGl0eU5hbWUgPSBuYW1lc1swXTtcbiAgICAgICAgZnVuY3Rpb25OYW1lID0gbmFtZXNbMV07XG4gICAgICAgIGZpbGVOYW1lID0gJy4vJyArIE9PTF9NT0RJRklFUl9QQVRIW2Z1bmN0b3Iub29sVHlwZV0gKyAnLycgKyByZWZFbnRpdHlOYW1lICsgJy0nICsgZnVuY3Rpb25OYW1lICsgJy5qcyc7XG4gICAgICAgIGZ1bmN0b3JJZCA9IHJlZkVudGl0eU5hbWUgKyBfLnVwcGVyRmlyc3QoZnVuY3Rpb25OYW1lKTtcbiAgICAgICAgYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3Iub29sVHlwZSwgZmlsZU5hbWUsIGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSk7XG5cbiAgICB9IGVsc2Uge1xuICAgICAgICBmdW5jdGlvbk5hbWUgPSBmdW5jdG9yLm5hbWU7XG5cbiAgICAgICAgbGV0IGJ1aWx0aW5zID0gT09MX01PRElGSUVSX0JVSUxUSU5bZnVuY3Rvci5vb2xUeXBlXTtcblxuICAgICAgICBpZiAoIShmdW5jdGlvbk5hbWUgaW4gYnVpbHRpbnMpKSB7XG4gICAgICAgICAgICBmaWxlTmFtZSA9ICcuLycgKyBPT0xfTU9ESUZJRVJfUEFUSFtmdW5jdG9yLm9vbFR5cGVdICsgJy8nICsgY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZSArICctJyArIGZ1bmN0aW9uTmFtZSArICcuanMnO1xuICAgICAgICAgICAgZnVuY3RvcklkID0gZnVuY3Rpb25OYW1lO1xuXG4gICAgICAgICAgICBpZiAoIWNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdKSB7XG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQubmV3RnVuY3RvckZpbGVzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGZ1bmN0b3JUeXBlOiBmdW5jdG9yLm9vbFR5cGUsXG4gICAgICAgICAgICAgICAgICAgIGZpbGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICBhcmdzXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yLm9vbFR5cGUsIGZpbGVOYW1lLCBjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpOyAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgZnVuY3RvcklkID0gZnVuY3Rvci5vb2xUeXBlICsgJ3MuJyArIGZ1bmN0aW9uTmFtZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBmdW5jdG9ySWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHBpcGVkIHZhbHVlIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvbG9naWNhbCBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlLCBkZWZhdWx0IGFzIHRoZSBwYXJhbSBuYW1lXG4gKiBAcGFyYW0ge29iamVjdH0gdmFyT29sIC0gVGFyZ2V0IHZhbHVlIG9vbCBub2RlLlxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dC5cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVQaXBlZFZhbHVlKHN0YXJ0VG9wb0lkLCB2YXJPb2wsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhck9vbC52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgdmFyT29sLm1vZGlmaWVycy5mb3JFYWNoKG1vZGlmaWVyID0+IHtcbiAgICAgICAgbGV0IG1vZGlmaWVyU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgT09MX01PRElGSUVSX09QW21vZGlmaWVyLm9vbFR5cGVdICsgbW9kaWZpZXIubmFtZSk7XG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgbW9kaWZpZXJTdGFydFRvcG9JZCk7XG5cbiAgICAgICAgbGFzdFRvcG9JZCA9IGNvbXBpbGVNb2RpZmllcihcbiAgICAgICAgICAgIG1vZGlmaWVyU3RhcnRUb3BvSWQsXG4gICAgICAgICAgICB2YXJPb2wudmFsdWUsXG4gICAgICAgICAgICBtb2RpZmllcixcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0XG4gICAgICAgICk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGFzdFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFyaWFibGUgcmVmZXJlbmNlIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvbG9naWNhbCBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlLCBkZWZhdWx0IGFzIHRoZSBwYXJhbSBuYW1lXG4gKiBAcGFyYW0ge29iamVjdH0gdmFyT29sIC0gVGFyZ2V0IHZhbHVlIG9vbCBub2RlLlxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dC5cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZShzdGFydFRvcG9JZCwgdmFyT29sLCBjb21waWxlQ29udGV4dCkge1xuICAgIHByZTogXy5pc1BsYWluT2JqZWN0KHZhck9vbCkgJiYgdmFyT29sLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnO1xuXG4gICAgLy9sZXQgWyBiYXNlTmFtZSwgb3RoZXJzIF0gPSB2YXJPb2wubmFtZS5zcGxpdCgnLicsIDIpO1xuICAgIC8qXG4gICAgaWYgKGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycyAmJiBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuaGFzKGJhc2VOYW1lKSAmJiBvdGhlcnMpIHtcbiAgICAgICAgdmFyT29sLm5hbWUgPSBiYXNlTmFtZSArICcuZGF0YScgKyAnLicgKyBvdGhlcnM7XG4gICAgfSovICAgIFxuXG4gICAgLy9zaW1wbGUgdmFsdWVcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhck9vbCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIEdldCBhbiBhcnJheSBvZiBwYXJhbWV0ZXIgbmFtZXMuXG4gKiBAcGFyYW0ge2FycmF5fSBhcmdzIC0gQW4gYXJyYXkgb2YgYXJndW1lbnRzIGluIG9vbCBzeW50YXhcbiAqIEByZXR1cm5zIHthcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoYXJncykge1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBuYW1lcyA9IG5ldyBTZXQoKTtcblxuICAgIGZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXJnKSkge1xuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcudmFsdWUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkucG9wKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYXJnLm5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJ3BhcmFtJyArIChpICsgMSkudG9TdHJpbmcoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gXy5tYXAoYXJncywgKGFyZywgaSkgPT4ge1xuICAgICAgICBsZXQgYmFzZU5hbWUgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSk7XG4gICAgICAgIGxldCBuYW1lID0gYmFzZU5hbWU7XG4gICAgICAgIGxldCBjb3VudCA9IDI7XG4gICAgICAgIFxuICAgICAgICB3aGlsZSAobmFtZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgICBuYW1lID0gYmFzZU5hbWUgKyBjb3VudC50b1N0cmluZygpO1xuICAgICAgICAgICAgY291bnQrKztcbiAgICAgICAgfVxuXG4gICAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgICAgcmV0dXJuIG5hbWU7ICAgICAgICBcbiAgICB9KTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgY29uY3JldGUgdmFsdWUgZXhwcmVzc2lvbiBmcm9tIG9vbCB0byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHZhbHVlIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVQaXBlZFZhbHVlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICBsZXQgWyByZWZCYXNlLCAuLi5yZXN0IF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKHZhbHVlLm5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVwZW5kZW5jeTtcblxuICAgICAgICAgICAgaWYgKCFjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0pIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgdW5kZWZpbmVkIHZhcmlhYmxlOiAke3ZhbHVlLm5hbWV9YCk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgaWYgKGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXS50eXBlID09PSAnZW50aXR5JyAmJiAhY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdLm9uZ29pbmcpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRlbmN5ID0gcmVmQmFzZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVmQmFzZSA9PT0gJ2xhdGVzdCcgJiYgcmVzdC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgLy9sYXRlc3QucGFzc3dvcmRcbiAgICAgICAgICAgICAgICBsZXQgcmVmRmllbGROYW1lID0gcmVzdC5wb3AoKTtcbiAgICAgICAgICAgICAgICBpZiAocmVmRmllbGROYW1lICE9PSBzdGFydFRvcG9JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRlbmN5ID0gcmVmRmllbGROYW1lICsgJzpyZWFkeSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRW1wdHkocmVzdCkpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRlbmN5ID0gcmVmQmFzZSArICc6cmVhZHknO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgaWYgKGRlcGVuZGVuY3kpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3ksIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZShzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnUmVnRXhwJykge1xuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YWx1ZSk7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh0cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKSk7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHZhbHVlID0gXy5tYXBWYWx1ZXModmFsdWUsICh2YWx1ZU9mRWxlbWVudCwga2V5KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnLicgKyBrZXkpO1xuICAgICAgICAgICAgbGV0IGVpZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzaWQsIHZhbHVlT2ZFbGVtZW50LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBpZiAoc2lkICE9PSBlaWQpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVpZCwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlaWRdO1xuICAgICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHZhbHVlID0gXy5tYXAodmFsdWUsICh2YWx1ZU9mRWxlbWVudCwgaW5kZXgpID0+IHsgXG4gICAgICAgICAgICBsZXQgc2lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICdbJyArIGluZGV4ICsgJ10nKTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YWx1ZSk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG5mdW5jdGlvbiB0cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgaWYgKG5hbWUgPT09ICdOT1cnKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgXCJjYWxsZWVcIjoge1xuICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICBcImNvbXB1dGVkXCI6IGZhbHNlLFxuICAgICAgICAgICAgICAgIFwib2JqZWN0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICBcImNvbXB1dGVkXCI6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBcIm9iamVjdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcImNvbXB1dGVkXCI6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJvYmplY3RcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJUeXBlc1wiXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJwcm9wZXJ0eVwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcIkRBVEVUSU1FXCJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXCJwcm9wZXJ0eVwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJ0eXBlT2JqZWN0XCJcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXCJwcm9wZXJ0eVwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwibG9jYWxcIlxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBcImFyZ3VtZW50c1wiOiBbXVxuICAgICAgICB9O1xuICAgIH0gXG4gICAgXG4gICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydDogJyArIG5hbWUpO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhbiBhcnJheSBvZiBmdW5jdGlvbiBhcmd1bWVudHMgZnJvbSBvb2wgaW50byBhc3QuXG4gKiBAcGFyYW0gdG9wb0lkIC0gVGhlIG1vZGlmaWVyIGZ1bmN0aW9uIHRvcG8gXG4gKiBAcGFyYW0gYXJncyAtIFxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0IC0gXG4gKiBAcmV0dXJucyB7QXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBhcmdzLCBjb21waWxlQ29udGV4dCkge1xuICAgIGFyZ3MgPSBfLmNhc3RBcnJheShhcmdzKTtcbiAgICBpZiAoXy5pc0VtcHR5KGFyZ3MpKSByZXR1cm4gW107XG5cbiAgICBsZXQgY2FsbEFyZ3MgPSBbXTtcblxuICAgIF8uZWFjaChhcmdzLCAoYXJnLCBpKSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICBsZXQgYXJnVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOmFyZ1snICsgKGkrMSkudG9TdHJpbmcoKSArICddJyk7XG4gICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGFyZ1RvcG9JZCwgYXJnLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0b3BvSWQpO1xuXG4gICAgICAgIGNhbGxBcmdzID0gY2FsbEFyZ3MuY29uY2F0KF8uY2FzdEFycmF5KGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSkpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNhbGxBcmdzO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwYXJhbSBvZiBpbnRlcmZhY2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSBpbmRleFxuICogQHBhcmFtIHBhcmFtXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVQYXJhbShpbmRleCwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IHR5cGUgPSBwYXJhbS50eXBlOyAgICBcblxuICAgIGxldCB0eXBlT2JqZWN0ID0gVHlwZXNbdHlwZV07XG5cbiAgICBpZiAoIXR5cGVPYmplY3QpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIGZpZWxkIHR5cGU6ICcgKyB0eXBlKTtcbiAgICB9XG5cbiAgICBsZXQgc2FuaXRpemVyTmFtZSA9IGBUeXBlcy4ke3R5cGUudG9VcHBlckNhc2UoKX0uc2FuaXRpemVgO1xuXG4gICAgbGV0IHZhclJlZiA9IEpzTGFuZy5hc3RWYXJSZWYocGFyYW0ubmFtZSk7XG4gICAgbGV0IGNhbGxBc3QgPSBKc0xhbmcuYXN0Q2FsbChzYW5pdGl6ZXJOYW1lLCBbdmFyUmVmLCBKc0xhbmcuYXN0QXJyYXlBY2Nlc3MoJyRtZXRhLnBhcmFtcycsIGluZGV4KSwgSnNMYW5nLmFzdFZhclJlZigndGhpcy5kYi5pMThuJyldKTtcblxuICAgIGxldCBwcmVwYXJlVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHBhcmFtczpzYW5pdGl6ZVsnICsgaW5kZXgudG9TdHJpbmcoKSArICddJyk7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZztcblxuICAgIC8vaWYgKGluZGV4ID09PSAwKSB7XG4gICAgICAgIC8vZGVjbGFyZSAkc2FuaXRpemVTdGF0ZSB2YXJpYWJsZSBmb3IgdGhlIGZpcnN0IHRpbWVcbiAgICAvLyAgICBzYW5pdGl6ZVN0YXJ0aW5nID0gSnNMYW5nLmFzdFZhckRlY2xhcmUodmFyUmVmLCBjYWxsQXN0LCBmYWxzZSwgZmFsc2UsIGBTYW5pdGl6ZSBwYXJhbSBcIiR7cGFyYW0ubmFtZX1cImApO1xuICAgIC8vfSBlbHNlIHtcbiAgICAvL2xldCBzYW5pdGl6ZVN0YXJ0aW5nID0gO1xuXG4gICAgICAgIC8vbGV0IGxhc3RQcmVwYXJlVG9wb0lkID0gJyRwYXJhbXM6c2FuaXRpemVbJyArIChpbmRleCAtIDEpLnRvU3RyaW5nKCkgKyAnXSc7XG4gICAgICAgIC8vZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UHJlcGFyZVRvcG9JZCwgcHJlcGFyZVRvcG9JZCk7XG4gICAgLy99XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbcHJlcGFyZVRvcG9JZF0gPSBbXG4gICAgICAgIEpzTGFuZy5hc3RBc3NpZ24odmFyUmVmLCBjYWxsQXN0LCBgU2FuaXRpemUgYXJndW1lbnQgXCIke3BhcmFtLm5hbWV9XCJgKVxuICAgIF07XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHByZXBhcmVUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19QQVJBTV9TQU5JVElaRVxuICAgIH0pO1xuXG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCk7XG5cbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbS5uYW1lKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkLCB0b3BvSWQpO1xuXG4gICAgbGV0IHZhbHVlID0gd3JhcFBhcmFtUmVmZXJlbmNlKHBhcmFtLm5hbWUsIHBhcmFtKTtcbiAgICBsZXQgZW5kVG9wb0lkID0gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGxldCByZWFkeVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzpyZWFkeScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCByZWFkeVRvcG9JZCk7XG5cbiAgICByZXR1cm4gcmVhZHlUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIG1vZGVsIGZpZWxkIHByZXByb2Nlc3MgaW5mb3JtYXRpb24gaW50byBhc3QuXG4gKiBAcGFyYW0ge29iamVjdH0gcGFyYW0gLSBGaWVsZCBpbmZvcm1hdGlvblxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dFxuICogQHJldHVybnMge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUZpZWxkKHBhcmFtTmFtZSwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgLy8gMS4gcmVmZXJlbmNlIHRvIHRoZSBsYXRlc3Qgb2JqZWN0IHRoYXQgaXMgcGFzc2VkIHF1YWxpZmllciBjaGVja3NcbiAgICAvLyAyLiBpZiBtb2RpZmllcnMgZXhpc3QsIHdyYXAgdGhlIHJlZiBpbnRvIGEgcGlwZWQgdmFsdWVcbiAgICAvLyAzLiBwcm9jZXNzIHRoZSByZWYgKG9yIHBpcGVkIHJlZikgYW5kIG1hcmsgYXMgZW5kXG4gICAgLy8gNC4gYnVpbGQgZGVwZW5kZW5jaWVzOiBsYXRlc3QuZmllbGQgLT4gLi4uIC0+IGZpZWxkOnJlYWR5IFxuICAgIGxldCB0b3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHBhcmFtTmFtZSk7XG4gICAgbGV0IGNvbnRleHROYW1lID0gJ2xhdGVzdC4nICsgcGFyYW1OYW1lO1xuICAgIC8vY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0VmFyUmVmKGNvbnRleHROYW1lLCB0cnVlKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShjb250ZXh0TmFtZSwgcGFyYW0pOyAgICBcbiAgICBsZXQgZW5kVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGxldCByZWFkeVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzpyZWFkeScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCByZWFkeVRvcG9JZCk7XG5cbiAgICByZXR1cm4gcmVhZHlUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIHdyYXBQYXJhbVJlZmVyZW5jZShuYW1lLCB2YWx1ZSkge1xuICAgIGxldCByZWYgPSBPYmplY3QuYXNzaWduKHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG5hbWUgfSk7XG4gICAgXG4gICAgaWYgKCFfLmlzRW1wdHkodmFsdWUubW9kaWZpZXJzKSkge1xuICAgICAgICByZXR1cm4geyBvb2xUeXBlOiAnUGlwZWRWYWx1ZScsIHZhbHVlOiByZWYsIG1vZGlmaWVyczogdmFsdWUubW9kaWZpZXJzIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiByZWY7XG59XG5cbmZ1bmN0aW9uIGhhc01vZGVsRmllbGQob3BlcmFuZCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9wZXJhbmQpICYmIG9wZXJhbmQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgbGV0IFsgYmFzZVZhciwgLi4ucmVzdCBdID0gb3BlcmFuZC5uYW1lLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tiYXNlVmFyXSAmJiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbYmFzZVZhcl0ub25nb2luZyAmJiByZXN0Lmxlbmd0aCA+IDA7ICAgICAgICBcbiAgICB9XG5cbiAgICByZXR1cm4gZmFsc2U7ICAgIFxufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHRoZW4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0IGluIHJldHVybiBibG9jay5cbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydElkXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kSWRcbiAqIEBwYXJhbSB0aGVuXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlUmV0dXJuVGhlbkFzdChzdGFydElkLCBlbmRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdUaHJvd0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJncztcbiAgICAgICAgICAgIGlmICh0aGVuLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gdHJhbnNsYXRlQXJncyhzdGFydElkLCB0aGVuLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBhcmdzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdSZXR1cm5FeHByZXNzaW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH0gICAgICAgIFxuICAgIH1cblxuICAgIC8vdGhlbiBleHByZXNzaW9uIGlzIGFuIG9vbG9uZyBjb25jcmV0ZSB2YWx1ZSAgICBcbiAgICBpZiAoXy5pc0FycmF5KHRoZW4pIHx8IF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBsZXQgdmFsdWVFbmRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydElkLCB0aGVuLCBjb21waWxlQ29udGV4dCk7ICAgIFxuICAgICAgICB0aGVuID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZhbHVlRW5kSWRdOyBcbiAgICB9ICAgXG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdFJldHVybih0aGVuKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSB0aGVuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0SWRcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRJZFxuICogQHBhcmFtIHRoZW5cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFzc2lnblRvXG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVRoZW5Bc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0LCBhc3NpZ25Ubykge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1Rocm93RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmdzO1xuICAgICAgICAgICAgaWYgKHRoZW4uYXJncykge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSB0cmFuc2xhdGVBcmdzKHN0YXJ0SWQsIHRoZW4uYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFRocm93KHRoZW4uZXJyb3JUeXBlIHx8IGRlZmF1bHRFcnJvciwgdGhlbi5tZXNzYWdlIHx8IGFyZ3MpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIHN3aXRjaCAodGhlbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyYmJztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJ3x8JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmICghaGFzTW9kZWxGaWVsZCh0aGVuLmxlZnQsIGNvbXBpbGVDb250ZXh0KSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgcXVlcnkgY29uZGl0aW9uOiB0aGUgbGVmdCBvcGVyYW5kIG5lZWQgdG8gYmUgYW4gZW50aXR5IGZpZWxkLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaGFzTW9kZWxGaWVsZCh0aGVuLnJpZ2h0LCBjb21waWxlQ29udGV4dCkpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHF1ZXJ5IGNvbmRpdGlvbjogdGhlIHJpZ2h0IG9wZXJhbmQgc2hvdWxkIG5vdCBiZSBhbiBlbnRpdHkgZmllbGQuIFVzZSBkYXRhc2V0IGluc3RlYWQgaWYgam9pbmluZyBpcyByZXF1aXJlZC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHt9O1xuICAgICAgICAgICAgbGV0IHN0YXJ0UmlnaHRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRJZCArICckYmluT3A6cmlnaHQnKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRJZCwgc3RhcnRSaWdodElkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0UmlnaHRJZCwgdGhlbi5yaWdodCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kSWQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodGhlbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvblt0aGVuLmxlZnQubmFtZS5zcGxpdCgnLicsIDIpWzFdXSA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtsYXN0UmlnaHRJZF07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvblt0aGVuLmxlZnQubmFtZS5zcGxpdCgnLicsIDIpWzFdXSA9IHsgW09QRVJBVE9SX1RPS0VOW29wXV06IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtsYXN0UmlnaHRJZF0gfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RBc3NpZ24oYXNzaWduVG8sIEpzTGFuZy5hc3RWYWx1ZShjb25kaXRpb24pKTsgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy90aGVuIGV4cHJlc3Npb24gaXMgYW4gb29sb25nIGNvbmNyZXRlIHZhbHVlICAgIFxuICAgIGlmIChfLmlzQXJyYXkodGhlbikgfHwgXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGxldCB2YWx1ZUVuZElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0SWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KTsgICAgXG4gICAgICAgIHRoZW4gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdmFsdWVFbmRJZF07IFxuICAgIH0gICBcblxuICAgIHJldHVybiBKc0xhbmcuYXN0QXNzaWduKGFzc2lnblRvLCB0aGVuKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSByZXR1cm4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgc3RhdGUgb2YgcmV0dXJuIGNsYXVzZVxuICogQHBhcmFtIHtzdHJpbmd9IGVuZFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBlbmRpbmcgc3RhdGUgb2YgcmV0dXJuIGNsYXVzZVxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IHZhbHVlVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgIGlmICh2YWx1ZVRvcG9JZCAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB2YWx1ZVRvcG9JZCwgZW5kVG9wb0lkKTtcbiAgICB9XG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdFJldHVybihnZXRDb2RlUmVwcmVzZW50YXRpb25PZih2YWx1ZVRvcG9JZCwgY29tcGlsZUNvbnRleHQpKTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSBleHByZXNzaW9uXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiBjb21waWxlUmV0dXJuKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybicpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX1ZJRVdfUkVUVVJOXG4gICAgfSk7XG5cbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBmaW5kIG9uZSBvcGVyYXRpb24gZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7aW50fSBpbmRleFxuICogQHBhcmFtIHtvYmplY3R9IG9wZXJhdGlvbiAtIE9vbCBub2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLVxuICogQHBhcmFtIHtzdHJpbmd9IGRlcGVuZGVuY3lcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGxhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaW5kT25lKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiBkZXBlbmRlbmN5O1xuXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJ29wJCcgKyBpbmRleC50b1N0cmluZygpKTtcbiAgICBsZXQgY29uZGl0aW9uVmFyTmFtZSA9IGVuZFRvcG9JZCArICckY29uZGl0aW9uJztcblxuICAgIGxldCBhc3QgPSBbXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKGNvbmRpdGlvblZhck5hbWUpXG4gICAgXTtcblxuICAgIGFzc2VydDogb3BlcmF0aW9uLmNvbmRpdGlvbjtcblxuICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tvcGVyYXRpb24ubW9kZWxdID0geyB0eXBlOiAnZW50aXR5Jywgc291cmNlOiAnZmluZE9uZScsIG9uZ29pbmc6IHRydWUgfTtcblxuICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLm9vbFR5cGUpIHtcbiAgICAgICAgLy9zcGVjaWFsIGNvbmRpdGlvblxuXG4gICAgICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLm9vbFR5cGUgPT09ICdjYXNlcycpIHtcbiAgICAgICAgICAgIGxldCB0b3BvSWRQcmVmaXggPSBlbmRUb3BvSWQgKyAnJGNhc2VzJztcbiAgICAgICAgICAgIGxldCBsYXN0U3RhdGVtZW50O1xuXG4gICAgICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5lbHNlKSB7XG4gICAgICAgICAgICAgICAgbGV0IGVsc2VTdGFydCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkUHJlZml4ICsgJzplbHNlJyk7XG4gICAgICAgICAgICAgICAgbGV0IGVsc2VFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZW5kJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbHNlU3RhcnQsIGVsc2VFbmQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZUVuZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSB0cmFuc2xhdGVUaGVuQXN0KGVsc2VTdGFydCwgZWxzZUVuZCwgb3BlcmF0aW9uLmNvbmRpdGlvbi5lbHNlLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSBKc0xhbmcuYXN0VGhyb3coJ1NlcnZlckVycm9yJywgJ1VuZXhwZWN0ZWQgc3RhdGUuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkob3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ01pc3NpbmcgY2FzZSBpdGVtcycpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBfLnJldmVyc2Uob3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcykuZm9yRWFjaCgoaXRlbSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChpdGVtLm9vbFR5cGUgIT09ICdDb25kaXRpb25hbFN0YXRlbWVudCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGNhc2UgaXRlbS4nKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpID0gb3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcy5sZW5ndGggLSBpIC0gMTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUHJlZml4ID0gdG9wb0lkUHJlZml4ICsgJ1snICsgaS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAgICAgICAgIGxldCBjYXNlVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4KTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3ksIGNhc2VUb3BvSWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNhc2VSZXN1bHRWYXJOYW1lID0gJyQnICsgdG9wb0lkUHJlZml4ICsgJ18nICsgaS50b1N0cmluZygpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGNhc2VUb3BvSWQpO1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYXNlVHRlbSA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoYXN0Q2FzZVR0ZW0pLCAnSW52YWxpZCBjYXNlIGl0ZW0gYXN0Lic7XG5cbiAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKGNhc2VSZXN1bHRWYXJOYW1lLCBhc3RDYXNlVHRlbSwgdHJ1ZSwgZmFsc2UsIGBDb25kaXRpb24gJHtpfSBmb3IgZmluZCBvbmUgJHtvcGVyYXRpb24ubW9kZWx9YCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgaWZTdGFydCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCArICc6dGhlbicpO1xuICAgICAgICAgICAgICAgIGxldCBpZkVuZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCArICc6ZW5kJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBpZlN0YXJ0KTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGlmU3RhcnQsIGlmRW5kKTtcblxuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSBbXG4gICAgICAgICAgICAgICAgICAgIGFzdENhc2VUdGVtLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0SWYoSnNMYW5nLmFzdFZhclJlZihjYXNlUmVzdWx0VmFyTmFtZSksIEpzTGFuZy5hc3RCbG9jayh0cmFuc2xhdGVUaGVuQXN0KGlmU3RhcnQsIGlmRW5kLCBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0LCBjb25kaXRpb25WYXJOYW1lKSksIGxhc3RTdGF0ZW1lbnQpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGlmRW5kLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFzdCA9IGFzdC5jb25jYXQoXy5jYXN0QXJyYXkobGFzdFN0YXRlbWVudCkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgICAgIH1cblxuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgfVxuXG4gICAgYXN0LnB1c2goXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKG9wZXJhdGlvbi5tb2RlbCwgSnNMYW5nLmFzdEF3YWl0KGB0aGlzLmZpbmRPbmVfYCwgSnNMYW5nLmFzdFZhclJlZihjb25kaXRpb25WYXJOYW1lKSkpXG4gICAgKTtcblxuICAgIGRlbGV0ZSBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbb3BlcmF0aW9uLm1vZGVsXS5vbmdvaW5nO1xuXG4gICAgbGV0IG1vZGVsVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBvcGVyYXRpb24ubW9kZWwpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCBtb2RlbFRvcG9JZCk7XG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBhc3Q7XG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY29tcGlsZURiT3BlcmF0aW9uKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgbGV0IGxhc3RUb3BvSWQ7XG5cbiAgICBzd2l0Y2ggKG9wZXJhdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIGNhc2UgJ0ZpbmRPbmVTdGF0ZW1lbnQnOlxuICAgICAgICAgICAgbGFzdFRvcG9JZCA9IGNvbXBpbGVGaW5kT25lKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2ZpbmQnOlxuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICd1cGRhdGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdjcmVhdGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdkZWxldGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdEb1N0YXRlbWVudCc6XG4gICAgICAgICAgICBsZXQgZG9CbG9jayA9IG9wZXJhdGlvbi5kbztcbiAgICAgICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlRG9TdGF0ZW1lbnQoaW5kZXgsIGRvQmxvY2ssIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2Fzc2lnbm1lbnQnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIG9wZXJhdGlvbiB0eXBlOiAnICsgb3BlcmF0aW9uLnR5cGUpO1xuICAgIH1cblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT05cbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjb21waWxlRG9TdGF0ZW1lbnQoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICAgICAgXG59XG5cbi8qKlxuICogQ29tcGlsZSBleGNlcHRpb25hbCByZXR1cm4gXG4gKiBAcGFyYW0ge29iamVjdH0gb29sTm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0ge3N0cmluZ30gW2RlcGVuZGVuY3ldXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4ob29sTm9kZSwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBwcmU6IChfLmlzUGxhaW5PYmplY3Qob29sTm9kZSkgJiYgb29sTm9kZS5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpO1xuXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKSwgbGFzdEV4Y2VwdGlvbklkID0gZGVwZW5kZW5jeTtcblxuICAgIGlmICghXy5pc0VtcHR5KG9vbE5vZGUuZXhjZXB0aW9ucykpIHtcbiAgICAgICAgb29sTm9kZS5leGNlcHRpb25zLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZXhjZXB0aW9uYWwgdHlwZTogJyArIGl0ZW0ub29sVHlwZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2VwdGlvblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25FbmRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkICsgJzpleGNlcHRbJyArIGkudG9TdHJpbmcoKSArICddOmRvbmUnKTtcbiAgICAgICAgICAgICAgICBpZiAobGFzdEV4Y2VwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBleGNlcHRpb25TdGFydElkKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24oaXRlbS50ZXN0LCBjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uU3RhcnRJZCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgdGhlblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQgKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHRoZW5TdGFydElkKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHRoZW5TdGFydElkLCBleGNlcHRpb25FbmRJZCk7XG5cbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZXhjZXB0aW9uRW5kSWRdID0gSnNMYW5nLmFzdElmKFxuICAgICAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RCbG9jayh0cmFuc2xhdGVSZXR1cm5UaGVuQXN0KFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhlblN0YXJ0SWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBleGNlcHRpb25FbmRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGl0ZW0udGhlbiwgY29tcGlsZUNvbnRleHQpKSxcbiAgICAgICAgICAgICAgICAgICAgbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgYFJldHVybiBvbiBleGNlcHRpb24gIyR7aX1gXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uRW5kSWQsIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogQVNUX0JMS19FWENFUFRJT05fSVRFTVxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgbGFzdEV4Y2VwdGlvbklkID0gZXhjZXB0aW9uRW5kSWQ7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0RXhjZXB0aW9uSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBsZXQgcmV0dXJuU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuOnZhbHVlJyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCByZXR1cm5TdGFydFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3QocmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgb29sTm9kZS52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOXG4gICAgfSk7XG4gICAgXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBuYW1lKSB7XG4gICAgaWYgKGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMobmFtZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtuYW1lfVwiIGFscmVhZHkgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBhc3NlcnQ6ICFjb21waWxlQ29udGV4dC50b3BvU29ydC5oYXNEZXBlbmRlbmN5KG5hbWUpLCAnQWxyZWFkeSBpbiB0b3BvU29ydCEnO1xuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmFkZChuYW1lKTtcblxuICAgIHJldHVybiBuYW1lO1xufVxuXG5mdW5jdGlvbiBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHByZXZpb3VzT3AsIGN1cnJlbnRPcCkge1xuICAgIHByZTogcHJldmlvdXNPcCAhPT0gY3VycmVudE9wLCAnU2VsZiBkZXBlbmRpbmcnO1xuXG4gICAgY29tcGlsZUNvbnRleHQubGlua2VyLmxvZygnZGVidWcnLCBjdXJyZW50T3AgKyAnIFxceDFiWzMzbWRlcGVuZHMgb25cXHgxYlswbSAnICsgcHJldmlvdXNPcCk7XG5cbiAgICBpZiAoIWNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMoY3VycmVudE9wKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRvcG8gaWQgXCIke2N1cnJlbnRPcH1cIiBub3QgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC50b3BvU29ydC5hZGQocHJldmlvdXNPcCwgY3VycmVudE9wKTtcbn1cblxuZnVuY3Rpb24gYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIGJsb2NrTWV0YSkge1xuICAgIGlmICghKHRvcG9JZCBpbiBjb21waWxlQ29udGV4dC5hc3RNYXApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQVNUIG5vdCBmb3VuZCBmb3IgYmxvY2sgd2l0aCB0b3BvSWQ6ICR7dG9wb0lkfWApO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuc2V0KHRvcG9JZCwgYmxvY2tNZXRhKTtcblxuICAgIGNvbXBpbGVDb250ZXh0Lmxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgQWRkaW5nICR7YmxvY2tNZXRhLnR5cGV9IFwiJHt0b3BvSWR9XCIgaW50byBzb3VyY2UgY29kZS5gKTsgICAgXG59XG5cbmZ1bmN0aW9uIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHRvcG9JZCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFNvdXJjZVR5cGUgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldCh0b3BvSWQpO1xuXG4gICAgaWYgKGxhc3RTb3VyY2VUeXBlICYmIChsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX1BST0NFU1NPUl9DQUxMIHx8IGxhc3RTb3VyY2VUeXBlLnR5cGUgPT09IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpKSB7XG4gICAgICAgIC8vZm9yIG1vZGlmaWVyLCBqdXN0IHVzZSB0aGUgZmluYWwgcmVzdWx0XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0VmFyUmVmKGxhc3RTb3VyY2VUeXBlLnRhcmdldCwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgbGV0IGFzdCA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xuICAgIGlmIChhc3QudHlwZSA9PT0gJ01lbWJlckV4cHJlc3Npb24nICYmIGFzdC5vYmplY3QubmFtZSA9PT0gJ2xhdGVzdCcpIHtcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RDb25kaXRpb25hbChcbiAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGFzdC5wcm9wZXJ0eS52YWx1ZSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgIGFzdCwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgIHsgLi4uYXN0LCBvYmplY3Q6IHsgLi4uYXN0Lm9iamVjdCwgbmFtZTogJ2V4aXN0aW5nJyB9IH1cbiAgICAgICAgKTsgICBcbiAgICB9XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUNvbXBpbGVDb250ZXh0KG1vZHVsZU5hbWUsIGxpbmtlciwgc2hhcmVkQ29udGV4dCkge1xuICAgIGxldCBjb21waWxlQ29udGV4dCA9IHtcbiAgICAgICAgbW9kdWxlTmFtZSwgICAgICAgIFxuICAgICAgICBsaW5rZXIsXG4gICAgICAgIHZhcmlhYmxlczoge30sXG4gICAgICAgIHRvcG9Ob2RlczogbmV3IFNldCgpLFxuICAgICAgICB0b3BvU29ydDogbmV3IFRvcG9Tb3J0KCksXG4gICAgICAgIGFzdE1hcDoge30sIC8vIFN0b3JlIHRoZSBBU1QgZm9yIGEgbm9kZVxuICAgICAgICBtYXBPZlRva2VuVG9NZXRhOiBuZXcgTWFwKCksIC8vIFN0b3JlIHRoZSBzb3VyY2UgY29kZSBibG9jayBwb2ludFxuICAgICAgICBtb2RlbFZhcnM6IG5ldyBTZXQoKSxcbiAgICAgICAgbWFwT2ZGdW5jdG9yVG9GaWxlOiAoc2hhcmVkQ29udGV4dCAmJiBzaGFyZWRDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSkgfHwge30sIC8vIFVzZSB0byByZWNvcmQgaW1wb3J0IGxpbmVzXG4gICAgICAgIG5ld0Z1bmN0b3JGaWxlczogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMpIHx8IFtdXG4gICAgfTtcblxuICAgIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJG1haW4nKTtcblxuICAgIGxpbmtlci5sb2coJ3ZlcmJvc2UnLCBgQ3JlYXRlZCBjb21waWxhdGlvbiBjb250ZXh0IGZvciBcIiR7bW9kdWxlTmFtZX1cIi5gKTtcblxuICAgIHJldHVybiBjb21waWxlQ29udGV4dDtcbn1cblxuZnVuY3Rpb24gaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkge1xuICAgIHJldHVybiB0b3BvSWQuaW5kZXhPZignOmFyZ1snKSA9PT0gLTEgJiYgdG9wb0lkLmluZGV4T2YoJyRjYXNlc1snKSA9PT0gLTEgJiYgdG9wb0lkLmluZGV4T2YoJyRleGNlcHRpb25zWycpID09PSAtMTtcbn1cblxuZnVuY3Rpb24gcmVwbGFjZVZhclJlZlNjb3BlKHZhclJlZiwgdGFyZ2V0U2NvcGUpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhclJlZikpIHtcbiAgICAgICAgYXNzZXJ0OiB2YXJSZWYub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYubmFtZSwgdGFyZ2V0U2NvcGUpIH07ICAgICAgICBcbiAgICB9IFxuXG4gICAgYXNzZXJ0OiB0eXBlb2YgdmFyUmVmID09PSAnc3RyaW5nJztcblxuICAgIGxldCBwYXJ0cyA9IHZhclJlZi5zcGxpdCgnLicpO1xuICAgIGFzc2VydDogcGFydHMubGVuZ3RoID4gMTtcblxuICAgIHBhcnRzLnNwbGljZSgwLCAxLCB0YXJnZXRTY29wZSk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJy4nKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgY29tcGlsZVBhcmFtLFxuICAgIGNvbXBpbGVGaWVsZCxcbiAgICBjb21waWxlRGJPcGVyYXRpb24sXG4gICAgY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuLFxuICAgIGNvbXBpbGVSZXR1cm4sXG4gICAgY3JlYXRlVG9wb0lkLFxuICAgIGNyZWF0ZUNvbXBpbGVDb250ZXh0LFxuICAgIGRlcGVuZHNPbixcbiAgICBhZGRDb2RlQmxvY2ssXG5cbiAgICBBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTLFxuICAgIEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX0FDVElWQVRPUl9DQUxMLFxuICAgIEFTVF9CTEtfVklFV19PUEVSQVRJT04sXG4gICAgQVNUX0JMS19WSUVXX1JFVFVSTixcbiAgICBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOLCBcbiAgICBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNLFxuXG4gICAgT09MX01PRElGSUVSX0NPREVfRkxBR1xufTsiXX0=