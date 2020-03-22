"use strict";

require("source-map-support/register");

const {
  _
} = require('rk-utils');

const {
  TopoSort
} = require('@genx/algorithm');

const JsLang = require('./ast.js');

const OolTypes = require('../../lang/OolTypes');

const {
  isDotSeparateName,
  extractDotSeparateName,
  extractReferenceBaseName
} = require('../../lang/OolUtils');

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
  [OolTypes.Modifier.VALIDATOR]: AST_BLK_VALIDATOR_CALL,
  [OolTypes.Modifier.PROCESSOR]: AST_BLK_PROCESSOR_CALL,
  [OolTypes.Modifier.ACTIVATOR]: AST_BLK_ACTIVATOR_CALL
};
const OOL_MODIFIER_OP = {
  [OolTypes.Modifier.VALIDATOR]: '|~',
  [OolTypes.Modifier.PROCESSOR]: '|>',
  [OolTypes.Modifier.ACTIVATOR]: '|='
};
const OOL_MODIFIER_PATH = {
  [OolTypes.Modifier.VALIDATOR]: 'validators',
  [OolTypes.Modifier.PROCESSOR]: 'processors',
  [OolTypes.Modifier.ACTIVATOR]: 'activators'
};
const OOL_MODIFIER_BUILTIN = {
  [OolTypes.Modifier.VALIDATOR]: OolongValidators,
  [OolTypes.Modifier.PROCESSOR]: OolongProcessors,
  [OolTypes.Modifier.ACTIVATOR]: OolongActivators
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
  if (!(functor.oolType === OolTypes.Modifier.VALIDATOR)) {
    throw new Error("Function \"compileAdHocValidator\" assertion failed: functor.oolType === OolTypes.Modifier.VALIDATOR");
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

  if (functor.oolType === OolTypes.Modifier.ACTIVATOR) {
    declareParams = translateFunctionParams(functor.args);
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

  if (functor.oolType === OolTypes.Modifier.ACTIVATOR) {
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

    if (!isDotSeparateName(value.name) && compileContext.variables[value.name] && functor.oolType !== OolTypes.Modifier.VALIDATOR) {
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
  if (name === 'now') {
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

  throw new Error('not support');
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

  compileContext.logger.debug(currentOp + ' \x1b[33mdepends on\x1b[0m ' + previousOp);

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
  compileContext.logger.verbose(`Adding ${blockMeta.type} "${topoId}" into source code.`);
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

function createCompileContext(moduleName, logger, sharedContext) {
  let compileContext = {
    moduleName,
    logger,
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
  logger.verbose(`Created compilation context for "${moduleName}".`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiVHlwZXMiLCJWYWxpZGF0b3JzIiwiT29sb25nVmFsaWRhdG9ycyIsIlByb2Nlc3NvcnMiLCJPb2xvbmdQcm9jZXNzb3JzIiwiQWN0aXZhdG9ycyIsIk9vbG9uZ0FjdGl2YXRvcnMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJPUEVSQVRPUl9UT0tFTiIsImNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24iLCJ0ZXN0IiwiY29tcGlsZUNvbnRleHQiLCJzdGFydFRvcG9JZCIsImlzUGxhaW5PYmplY3QiLCJvb2xUeXBlIiwiZW5kVG9wb0lkIiwiY3JlYXRlVG9wb0lkIiwib3BlcmFuZFRvcG9JZCIsImRlcGVuZHNPbiIsImxhc3RPcGVyYW5kVG9wb0lkIiwiY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uIiwiY2FsbGVyIiwiYXN0QXJndW1lbnQiLCJnZXRDb2RlUmVwcmVzZW50YXRpb25PZiIsInJldFRvcG9JZCIsImNvbXBpbGVBZEhvY1ZhbGlkYXRvciIsImNhbGxlZSIsIm9wIiwib3BlcmF0b3IiLCJFcnJvciIsImxlZnRUb3BvSWQiLCJyaWdodFRvcG9JZCIsImxhc3RMZWZ0SWQiLCJsZWZ0IiwibGFzdFJpZ2h0SWQiLCJyaWdodCIsImFzdE1hcCIsImFzdEJpbkV4cCIsImFyZ3VtZW50IiwiYXN0Tm90IiwiYXN0Q2FsbCIsInZhbHVlU3RhcnRUb3BvSWQiLCJhc3RWYWx1ZSIsInRvcG9JZCIsInZhbHVlIiwiZnVuY3RvciIsImNhbGxBcmdzIiwiYXJncyIsInRyYW5zbGF0ZUFyZ3MiLCJhcmcwIiwibmFtZSIsImNvbmNhdCIsImNvbXBpbGVNb2RpZmllciIsImRlY2xhcmVQYXJhbXMiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyIsImlzRW1wdHkiLCJmdW5jdG9ySWQiLCJ0cmFuc2xhdGVNb2RpZmllciIsInJlZmVyZW5jZXMiLCJleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyIsImZpbmQiLCJyZWYiLCJhc3RBd2FpdCIsImFzdFZhclJlZiIsImlzVG9wTGV2ZWxCbG9jayIsInN0YXJ0c1dpdGgiLCJhc3RDb25kaXRpb25hbCIsInJlcGxhY2VWYXJSZWZTY29wZSIsInRhcmdldFZhck5hbWUiLCJuZWVkRGVjbGFyZSIsInZhcmlhYmxlcyIsImNvdW50ZXIiLCJ0b1N0cmluZyIsImhhc093blByb3BlcnR5IiwidHlwZSIsInNvdXJjZSIsImFkZENvZGVCbG9jayIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJBcnJheSIsImlzQXJyYXkiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwibW9kdWxlTmFtZSIsIm5ld0Z1bmN0b3JGaWxlcyIsImNvbXBpbGVQaXBlZFZhbHVlIiwidmFyT29sIiwibGFzdFRvcG9JZCIsIm1vZGlmaWVycyIsIm1vZGlmaWVyIiwibW9kaWZpZXJTdGFydFRvcG9JZCIsImNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSIsIlNldCIsInRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0iLCJhcmciLCJpIiwicG9wIiwibWFwIiwiYmFzZU5hbWUiLCJjb3VudCIsImhhcyIsImFkZCIsInJlZkJhc2UiLCJyZXN0IiwiZGVwZW5kZW5jeSIsIm9uZ29pbmciLCJyZWZGaWVsZE5hbWUiLCJvb3JUeXBlIiwidHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJtYXBWYWx1ZXMiLCJ2YWx1ZU9mRWxlbWVudCIsImtleSIsInNpZCIsImVpZCIsImluZGV4IiwiZWFjaCIsImFyZ1RvcG9JZCIsImNvbXBpbGVQYXJhbSIsInBhcmFtIiwidHlwZU9iamVjdCIsInNhbml0aXplck5hbWUiLCJ0b1VwcGVyQ2FzZSIsInZhclJlZiIsImNhbGxBc3QiLCJhc3RBcnJheUFjY2VzcyIsInByZXBhcmVUb3BvSWQiLCJhc3RBc3NpZ24iLCJtYWluU3RhcnRJZCIsIndyYXBQYXJhbVJlZmVyZW5jZSIsInJlYWR5VG9wb0lkIiwiY29tcGlsZUZpZWxkIiwicGFyYW1OYW1lIiwiY29udGV4dE5hbWUiLCJPYmplY3QiLCJhc3NpZ24iLCJoYXNNb2RlbEZpZWxkIiwib3BlcmFuZCIsImJhc2VWYXIiLCJzcGxpdCIsInRyYW5zbGF0ZVJldHVyblRoZW5Bc3QiLCJzdGFydElkIiwiZW5kSWQiLCJ0aGVuIiwiYXN0VGhyb3ciLCJlcnJvclR5cGUiLCJtZXNzYWdlIiwidHJhbnNsYXRlUmV0dXJuVmFsdWVBc3QiLCJ2YWx1ZUVuZElkIiwiYXN0UmV0dXJuIiwidHJhbnNsYXRlVGhlbkFzdCIsImFzc2lnblRvIiwiY29uZGl0aW9uIiwic3RhcnRSaWdodElkIiwidmFsdWVUb3BvSWQiLCJjb21waWxlUmV0dXJuIiwiY29tcGlsZUZpbmRPbmUiLCJvcGVyYXRpb24iLCJjb25kaXRpb25WYXJOYW1lIiwiYXN0IiwiYXN0VmFyRGVjbGFyZSIsIm1vZGVsIiwidG9wb0lkUHJlZml4IiwibGFzdFN0YXRlbWVudCIsImVsc2UiLCJlbHNlU3RhcnQiLCJlbHNlRW5kIiwiaXRlbXMiLCJyZXZlcnNlIiwiaXRlbSIsImNhc2VQcmVmaXgiLCJjYXNlVG9wb0lkIiwiY2FzZVJlc3VsdFZhck5hbWUiLCJhc3RDYXNlVHRlbSIsImlmU3RhcnQiLCJpZkVuZCIsImFzdElmIiwiYXN0QmxvY2siLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImRvQmxvY2siLCJkbyIsImNvbXBpbGVEb1N0YXRlbWVudCIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsIm1vZGVsVmFycyIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtB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QUUsaUJBQVg7QUFBOEJvQyxNQUFBQSxJQUFJLEVBQUVpQixrQkFBa0IsQ0FBQ3lFLE1BQU0sQ0FBQzFGLElBQVIsRUFBY2tMLFdBQWQ7QUFBdEQsS0FBUDtBQUNIOztBQUw0QyxRQU9yQyxPQUFPeEYsTUFBUCxLQUFrQixRQVBtQjtBQUFBO0FBQUE7O0FBUzdDLE1BQUl5RixLQUFLLEdBQUd6RixNQUFNLENBQUNnQixLQUFQLENBQWEsR0FBYixDQUFaOztBQVQ2QyxRQVVyQ3lFLEtBQUssQ0FBQ3BJLE1BQU4sR0FBZSxDQVZzQjtBQUFBO0FBQUE7O0FBWTdDb0ksRUFBQUEsS0FBSyxDQUFDQyxNQUFOLENBQWEsQ0FBYixFQUFnQixDQUFoQixFQUFtQkYsV0FBbkI7QUFDQSxTQUFPQyxLQUFLLENBQUNFLElBQU4sQ0FBVyxHQUFYLENBQVA7QUFDSDs7QUFFREMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2JsRyxFQUFBQSxZQURhO0FBRWJhLEVBQUFBLFlBRmE7QUFHYmdELEVBQUFBLGtCQUhhO0FBSWJJLEVBQUFBLHdCQUphO0FBS2I1QixFQUFBQSxhQUxhO0FBTWI1SixFQUFBQSxZQU5hO0FBT2IrTSxFQUFBQSxvQkFQYTtBQVFiN00sRUFBQUEsU0FSYTtBQVNiMEQsRUFBQUEsWUFUYTtBQVdidEYsRUFBQUEseUJBWGE7QUFZYkUsRUFBQUEsc0JBWmE7QUFhYkMsRUFBQUEsc0JBYmE7QUFjYkMsRUFBQUEsc0JBZGE7QUFlYkMsRUFBQUEsc0JBZmE7QUFnQmJDLEVBQUFBLG1CQWhCYTtBQWlCYkMsRUFBQUEsMkJBakJhO0FBa0JiQyxFQUFBQSx3QkFsQmE7QUFtQmJDLEVBQUFBLHNCQW5CYTtBQXFCYkMsRUFBQUE7QUFyQmEsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuLyoqXG4gKiBAbW9kdWxlXG4gKiBAaWdub3JlXG4gKi9cblxuY29uc3QgeyBfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBUb3BvU29ydCB9ID0gcmVxdWlyZSgnQGdlbngvYWxnb3JpdGhtJyk7XG5cbmNvbnN0IEpzTGFuZyA9IHJlcXVpcmUoJy4vYXN0LmpzJyk7XG5jb25zdCBPb2xUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvT29sVHlwZXMnKTtcbmNvbnN0IHsgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSB9ID0gcmVxdWlyZSgnLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyAgVHlwZXMsIFZhbGlkYXRvcnM6IE9vbG9uZ1ZhbGlkYXRvcnMsIFByb2Nlc3NvcnM6IE9vbG9uZ1Byb2Nlc3NvcnMsIEFjdGl2YXRvcnM6IE9vbG9uZ0FjdGl2YXRvcnMgfSA9IHJlcXVpcmUoJ0BnZW54L2RhdGEnKTtcblxuY29uc3QgZGVmYXVsdEVycm9yID0gJ0ludmFsaWRSZXF1ZXN0JztcblxuY29uc3QgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyA9ICdGaWVsZFByZVByb2Nlc3MnO1xuY29uc3QgQVNUX0JMS19QQVJBTV9TQU5JVElaRSA9ICdQYXJhbWV0ZXJTYW5pdGl6ZSc7XG5jb25zdCBBU1RfQkxLX1BST0NFU1NPUl9DQUxMID0gJ1Byb2Nlc3NvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCA9ICdWYWxpZGF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwgPSAnQWN0aXZhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OID0gJ1ZpZXdPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19WSUVXX1JFVFVSTiA9ICdWaWV3UmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTiA9ICdJbnRlcmZhY2VPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOID0gJ0ludGVyZmFjZVJldHVybic7XG5jb25zdCBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNID0gJ0V4Y2VwdGlvbkl0ZW0nO1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBBU1RfQkxLX0FDVElWQVRPUl9DQUxMXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfT1AgPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd8ficsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06ICd8PicsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICd8PScgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfUEFUSCA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogJ3ZhbGlkYXRvcnMnLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAncHJvY2Vzc29ycycsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICdhY3RpdmF0b3JzJyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9CVUlMVElOID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBPb2xvbmdWYWxpZGF0b3JzLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiBPb2xvbmdQcm9jZXNzb3JzLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBPb2xvbmdBY3RpdmF0b3JzIFxufTtcblxuY29uc3QgT1BFUkFUT1JfVE9LRU4gPSB7XG4gICAgXCI+XCI6IFwiJGd0XCIsXG4gICAgXCI8XCI6IFwiJGx0XCIsXG4gICAgXCI+PVwiOiBcIiRndGVcIixcbiAgICBcIjw9XCI6IFwiJGx0ZVwiLFxuICAgIFwiPT1cIjogXCIkZXFcIixcbiAgICBcIiE9XCI6IFwiJG5lXCIsXG4gICAgXCJpblwiOiBcIiRpblwiLFxuICAgIFwibm90SW5cIjogXCIkbmluXCJcbn07XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmRpdGlvbmFsIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB0ZXN0XG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBUb3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdCwgY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0ZXN0KSkgeyAgICAgICAgXG4gICAgICAgIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdWYWxpZGF0ZUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wOmRvbmUnKTtcbiAgICAgICAgICAgIGxldCBvcGVyYW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5jYWxsZXIsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRUb3BvSWQgPSBjb21waWxlQWRIb2NWYWxpZGF0b3IoZW5kVG9wb0lkLCBhc3RBcmd1bWVudCwgdGVzdC5jYWxsZWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiByZXRUb3BvSWQgPT09IGVuZFRvcG9JZDtcblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QtZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpkb25lJyk7XG5cbiAgICAgICAgICAgIGxldCBvcDtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbGVmdFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmxlZnQnKTtcbiAgICAgICAgICAgIGxldCByaWdodFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOnJpZ2h0Jyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdExlZnRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0LCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICc+JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8JzpcbiAgICAgICAgICAgICAgICBjYXNlICc+PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnPD0nOlxuICAgICAgICAgICAgICAgIGNhc2UgJ2luJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSB0ZXN0Lm9wZXJhdG9yO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJz09JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnPT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICchPSc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyE9PSc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGxlZnRUb3BvSWQsIHRlc3QubGVmdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHJpZ2h0VG9wb0lkLCB0ZXN0LnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdW5hT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBvcGVyYW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RPcGVyYW5kVG9wb0lkID0gdGVzdC5vcGVyYXRvciA9PT0gJ25vdCcgPyBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5hcmd1bWVudCwgY29tcGlsZUNvbnRleHQpIDogY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCwgb3BlcmFuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RPcGVyYW5kVG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgYXN0QXJndW1lbnQgPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0T3BlcmFuZFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IHZhbHVlU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWx1ZScpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgdmFsdWVTdGFydFRvcG9JZCk7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHZhbHVlU3RhcnRUb3BvSWQsIHRlc3QsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHRlc3QpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFsaWRhdG9yIGNhbGxlZCBpbiBhIGxvZ2ljYWwgZXhwcmVzc2lvbi5cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUFkSG9jVmFsaWRhdG9yKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXNzZXJ0OiBmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUjsgICAgICAgIFxuXG4gICAgbGV0IGNhbGxBcmdzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgICAgICBcbiAgICBcbiAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgIFxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ1ZhbGlkYXRvcnMuJyArIGZ1bmN0b3IubmFtZSwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RpZmllciBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0gdG9wb0lkIC0gc3RhcnRUb3BvSWRcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZU1vZGlmaWVyKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGRlY2xhcmVQYXJhbXM7XG5cbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgXG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhmdW5jdG9yLmFyZ3MpOyAgICAgICAgXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZGVjbGFyZVBhcmFtcyA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKF8uaXNFbXB0eShmdW5jdG9yLmFyZ3MpID8gW3ZhbHVlXSA6IFt2YWx1ZV0uY29uY2F0KGZ1bmN0b3IuYXJncykpOyAgICAgICAgXG4gICAgfSAgICAgICAgXG5cbiAgICBsZXQgZnVuY3RvcklkID0gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGRlY2xhcmVQYXJhbXMpO1xuXG4gICAgbGV0IGNhbGxBcmdzLCByZWZlcmVuY2VzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIHJlZmVyZW5jZXMgPSBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhmdW5jdG9yLmFyZ3MpO1xuXG4gICAgICAgIGlmIChfLmZpbmQocmVmZXJlbmNlcywgcmVmID0+IHJlZiA9PT0gdmFsdWUubmFtZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgdGFyZ2V0IGZpZWxkIGl0c2VsZiBhcyBhbiBhcmd1bWVudCBvZiBhIG1vZGlmaWVyLicpO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY2FsbEFyZ3MgPSBbXTtcbiAgICB9ICAgICAgICBcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgICAgICAgICAgICBcbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0QXdhaXQoZnVuY3RvcklkLCBbIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMnKSwgSnNMYW5nLmFzdFZhclJlZignY29udGV4dCcpIF0uY29uY2F0KGNhbGxBcmdzKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbGV0IGFyZzAgPSB2YWx1ZTtcbiAgICAgICAgaWYgKCFpc1RvcExldmVsQmxvY2sodG9wb0lkKSAmJiBfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnICYmIHZhbHVlLm5hbWUuc3RhcnRzV2l0aCgnbGF0ZXN0LicpKSB7XG4gICAgICAgICAgICAvL2xldCBleGlzdGluZ1JlZiA9ICAgICAgICAgICAgXG4gICAgICAgICAgICBhcmcwID0gSnNMYW5nLmFzdENvbmRpdGlvbmFsKFxuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSh2YWx1ZS5uYW1lKSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgICAgICB2YWx1ZSwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgICAgICByZXBsYWNlVmFyUmVmU2NvcGUodmFsdWUsICdleGlzdGluZycpXG4gICAgICAgICAgICApOyAgXG4gICAgICAgIH1cbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbChmdW5jdG9ySWQsIFsgYXJnMCBdLmNvbmNhdChjYWxsQXJncykpO1xuICAgIH0gICAgXG5cbiAgICBpZiAoaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkpIHtcbiAgICAgICAgbGV0IHRhcmdldFZhck5hbWUgPSB2YWx1ZS5uYW1lO1xuICAgICAgICBsZXQgbmVlZERlY2xhcmUgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIWlzRG90U2VwYXJhdGVOYW1lKHZhbHVlLm5hbWUpICYmIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1t2YWx1ZS5uYW1lXSAmJiBmdW5jdG9yLm9vbFR5cGUgIT09IE9vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUikge1xuICAgICAgICAgICAgLy9jb25mbGljdCB3aXRoIGV4aXN0aW5nIHZhcmlhYmxlcywgbmVlZCB0byByZW5hbWUgdG8gYW5vdGhlciB2YXJpYWJsZVxuICAgICAgICAgICAgbGV0IGNvdW50ZXIgPSAxO1xuICAgICAgICAgICAgZG8ge1xuICAgICAgICAgICAgICAgIGNvdW50ZXIrKzsgICAgICAgXG4gICAgICAgICAgICAgICAgdGFyZ2V0VmFyTmFtZSA9IHZhbHVlLm5hbWUgKyBjb3VudGVyLnRvU3RyaW5nKCk7ICAgICAgICAgXG4gICAgICAgICAgICB9IHdoaWxlIChjb21waWxlQ29udGV4dC52YXJpYWJsZXMuaGFzT3duUHJvcGVydHkodGFyZ2V0VmFyTmFtZSkpOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbdGFyZ2V0VmFyTmFtZV0gPSB7IHR5cGU6ICdsb2NhbFZhcmlhYmxlJywgc291cmNlOiAnbW9kaWZpZXInIH07XG4gICAgICAgICAgICBuZWVkRGVjbGFyZSA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICAvL2lmIChjb21waWxlQ29udGV4dC52YXJpYWJsZXNbXSlcblxuICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHRvcG9JZCwge1xuICAgICAgICAgICAgdHlwZTogT09MX01PRElGSUVSX0NPREVfRkxBR1tmdW5jdG9yLm9vbFR5cGVdLFxuICAgICAgICAgICAgdGFyZ2V0OiB0YXJnZXRWYXJOYW1lLFxuICAgICAgICAgICAgcmVmZXJlbmNlcywgICAvLyBsYXRlc3QuLCBleHNpdGluZy4sIHJhdy5cbiAgICAgICAgICAgIG5lZWREZWNsYXJlXG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0b3BvSWQ7XG59ICBcbiAgICAgIFxuZnVuY3Rpb24gZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMob29sQXJncykgeyAgIFxuICAgIG9vbEFyZ3MgPSBfLmNhc3RBcnJheShvb2xBcmdzKTsgICAgXG5cbiAgICBsZXQgcmVmcyA9IFtdO1xuXG4gICAgb29sQXJncy5mb3JFYWNoKGEgPT4ge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShhKSkge1xuICAgICAgICAgICAgcmVmcyA9IHJlZnMuY29uY2F0KGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKGEpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBcblxuICAgICAgICBsZXQgcmVzdWx0ID0gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKGEpO1xuICAgICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgICAgICByZWZzLnB1c2gocmVzdWx0KTtcbiAgICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlZnM7XG59XG5cbmZ1bmN0aW9uIGNoZWNrUmVmZXJlbmNlVG9GaWVsZChvYmopIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9iaikgJiYgb2JqLm9vbFR5cGUpIHtcbiAgICAgICAgaWYgKG9iai5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHJldHVybiBjaGVja1JlZmVyZW5jZVRvRmllbGQob2JqLnZhbHVlKTtcbiAgICAgICAgaWYgKG9iai5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgcmV0dXJuIG9iai5uYW1lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3JUeXBlLCBmdW5jdG9ySnNGaWxlLCBtYXBPZkZ1bmN0b3JUb0ZpbGUpIHtcbiAgICBpZiAobWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gJiYgbWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gIT09IGZ1bmN0b3JKc0ZpbGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb25mbGljdDogJHtmdW5jdG9yVHlwZX0gbmFtaW5nIFwiJHtmdW5jdG9ySWR9XCIgY29uZmxpY3RzIWApO1xuICAgIH1cbiAgICBtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSA9IGZ1bmN0b3JKc0ZpbGU7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGZ1bmN0b3IgaXMgdXNlci1kZWZpbmVkIG9yIGJ1aWx0LWluXG4gKiBAcGFyYW0gZnVuY3RvclxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gYXJncyAtIFVzZWQgdG8gbWFrZSB1cCB0aGUgZnVuY3Rpb24gc2lnbmF0dXJlXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBmdW5jdG9yIGlkXG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZU1vZGlmaWVyKGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0LCBhcmdzKSB7XG4gICAgbGV0IGZ1bmN0aW9uTmFtZSwgZmlsZU5hbWUsIGZ1bmN0b3JJZDtcblxuICAgIC8vZXh0cmFjdCB2YWxpZGF0b3IgbmFtaW5nIGFuZCBpbXBvcnQgaW5mb3JtYXRpb25cbiAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoZnVuY3Rvci5uYW1lKSkge1xuICAgICAgICBsZXQgbmFtZXMgPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGZ1bmN0b3IubmFtZSk7XG4gICAgICAgIGlmIChuYW1lcy5sZW5ndGggPiAyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBzdXBwb3J0ZWQgcmVmZXJlbmNlIHR5cGU6ICcgKyBmdW5jdG9yLm5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9yZWZlcmVuY2UgdG8gb3RoZXIgZW50aXR5IGZpbGVcbiAgICAgICAgbGV0IHJlZkVudGl0eU5hbWUgPSBuYW1lc1swXTtcbiAgICAgICAgZnVuY3Rpb25OYW1lID0gbmFtZXNbMV07XG4gICAgICAgIGZpbGVOYW1lID0gJy4vJyArIE9PTF9NT0RJRklFUl9QQVRIW2Z1bmN0b3Iub29sVHlwZV0gKyAnLycgKyByZWZFbnRpdHlOYW1lICsgJy0nICsgZnVuY3Rpb25OYW1lICsgJy5qcyc7XG4gICAgICAgIGZ1bmN0b3JJZCA9IHJlZkVudGl0eU5hbWUgKyBfLnVwcGVyRmlyc3QoZnVuY3Rpb25OYW1lKTtcbiAgICAgICAgYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3Iub29sVHlwZSwgZmlsZU5hbWUsIGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSk7XG5cbiAgICB9IGVsc2Uge1xuICAgICAgICBmdW5jdGlvbk5hbWUgPSBmdW5jdG9yLm5hbWU7XG5cbiAgICAgICAgbGV0IGJ1aWx0aW5zID0gT09MX01PRElGSUVSX0JVSUxUSU5bZnVuY3Rvci5vb2xUeXBlXTtcblxuICAgICAgICBpZiAoIShmdW5jdGlvbk5hbWUgaW4gYnVpbHRpbnMpKSB7XG4gICAgICAgICAgICBmaWxlTmFtZSA9ICcuLycgKyBPT0xfTU9ESUZJRVJfUEFUSFtmdW5jdG9yLm9vbFR5cGVdICsgJy8nICsgY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZSArICctJyArIGZ1bmN0aW9uTmFtZSArICcuanMnO1xuICAgICAgICAgICAgZnVuY3RvcklkID0gZnVuY3Rpb25OYW1lO1xuXG4gICAgICAgICAgICBpZiAoIWNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdKSB7XG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQubmV3RnVuY3RvckZpbGVzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGZ1bmN0b3JUeXBlOiBmdW5jdG9yLm9vbFR5cGUsXG4gICAgICAgICAgICAgICAgICAgIGZpbGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICBhcmdzXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yLm9vbFR5cGUsIGZpbGVOYW1lLCBjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpOyAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgZnVuY3RvcklkID0gZnVuY3Rvci5vb2xUeXBlICsgJ3MuJyArIGZ1bmN0aW9uTmFtZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBmdW5jdG9ySWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHBpcGVkIHZhbHVlIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvbG9naWNhbCBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlLCBkZWZhdWx0IGFzIHRoZSBwYXJhbSBuYW1lXG4gKiBAcGFyYW0ge29iamVjdH0gdmFyT29sIC0gVGFyZ2V0IHZhbHVlIG9vbCBub2RlLlxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dC5cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVQaXBlZFZhbHVlKHN0YXJ0VG9wb0lkLCB2YXJPb2wsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhck9vbC52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgdmFyT29sLm1vZGlmaWVycy5mb3JFYWNoKG1vZGlmaWVyID0+IHtcbiAgICAgICAgbGV0IG1vZGlmaWVyU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgT09MX01PRElGSUVSX09QW21vZGlmaWVyLm9vbFR5cGVdICsgbW9kaWZpZXIubmFtZSk7XG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgbW9kaWZpZXJTdGFydFRvcG9JZCk7XG5cbiAgICAgICAgbGFzdFRvcG9JZCA9IGNvbXBpbGVNb2RpZmllcihcbiAgICAgICAgICAgIG1vZGlmaWVyU3RhcnRUb3BvSWQsXG4gICAgICAgICAgICB2YXJPb2wudmFsdWUsXG4gICAgICAgICAgICBtb2RpZmllcixcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0XG4gICAgICAgICk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGFzdFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFyaWFibGUgcmVmZXJlbmNlIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvbG9naWNhbCBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlLCBkZWZhdWx0IGFzIHRoZSBwYXJhbSBuYW1lXG4gKiBAcGFyYW0ge29iamVjdH0gdmFyT29sIC0gVGFyZ2V0IHZhbHVlIG9vbCBub2RlLlxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dC5cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZShzdGFydFRvcG9JZCwgdmFyT29sLCBjb21waWxlQ29udGV4dCkge1xuICAgIHByZTogXy5pc1BsYWluT2JqZWN0KHZhck9vbCkgJiYgdmFyT29sLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnO1xuXG4gICAgLy9sZXQgWyBiYXNlTmFtZSwgb3RoZXJzIF0gPSB2YXJPb2wubmFtZS5zcGxpdCgnLicsIDIpO1xuICAgIC8qXG4gICAgaWYgKGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycyAmJiBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuaGFzKGJhc2VOYW1lKSAmJiBvdGhlcnMpIHtcbiAgICAgICAgdmFyT29sLm5hbWUgPSBiYXNlTmFtZSArICcuZGF0YScgKyAnLicgKyBvdGhlcnM7XG4gICAgfSovICAgIFxuXG4gICAgLy9zaW1wbGUgdmFsdWVcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhck9vbCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIEdldCBhbiBhcnJheSBvZiBwYXJhbWV0ZXIgbmFtZXMuXG4gKiBAcGFyYW0ge2FycmF5fSBhcmdzIC0gQW4gYXJyYXkgb2YgYXJndW1lbnRzIGluIG9vbCBzeW50YXhcbiAqIEByZXR1cm5zIHthcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoYXJncykge1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBuYW1lcyA9IG5ldyBTZXQoKTtcblxuICAgIGZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXJnKSkge1xuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcudmFsdWUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkucG9wKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYXJnLm5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJ3BhcmFtJyArIChpICsgMSkudG9TdHJpbmcoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gXy5tYXAoYXJncywgKGFyZywgaSkgPT4ge1xuICAgICAgICBsZXQgYmFzZU5hbWUgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSk7XG4gICAgICAgIGxldCBuYW1lID0gYmFzZU5hbWU7XG4gICAgICAgIGxldCBjb3VudCA9IDI7XG4gICAgICAgIFxuICAgICAgICB3aGlsZSAobmFtZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgICBuYW1lID0gYmFzZU5hbWUgKyBjb3VudC50b1N0cmluZygpO1xuICAgICAgICAgICAgY291bnQrKztcbiAgICAgICAgfVxuXG4gICAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgICAgcmV0dXJuIG5hbWU7ICAgICAgICBcbiAgICB9KTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgY29uY3JldGUgdmFsdWUgZXhwcmVzc2lvbiBmcm9tIG9vbCB0byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHZhbHVlIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVQaXBlZFZhbHVlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICBsZXQgWyByZWZCYXNlLCAuLi5yZXN0IF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKHZhbHVlLm5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVwZW5kZW5jeTtcblxuICAgICAgICAgICAgaWYgKCFjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0pIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgdW5kZWZpbmVkIHZhcmlhYmxlOiAke3ZhbHVlLm5hbWV9YCk7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgaWYgKGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXS50eXBlID09PSAnZW50aXR5JyAmJiAhY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdLm9uZ29pbmcpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRlbmN5ID0gcmVmQmFzZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVmQmFzZSA9PT0gJ2xhdGVzdCcgJiYgcmVzdC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgLy9sYXRlc3QucGFzc3dvcmRcbiAgICAgICAgICAgICAgICBsZXQgcmVmRmllbGROYW1lID0gcmVzdC5wb3AoKTtcbiAgICAgICAgICAgICAgICBpZiAocmVmRmllbGROYW1lICE9PSBzdGFydFRvcG9JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRlbmN5ID0gcmVmRmllbGROYW1lICsgJzpyZWFkeSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRW1wdHkocmVzdCkpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRlbmN5ID0gcmVmQmFzZSArICc6cmVhZHknO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgaWYgKGRlcGVuZGVuY3kpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3ksIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZShzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnUmVnRXhwJykge1xuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YWx1ZSk7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh0cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKSk7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHZhbHVlID0gXy5tYXBWYWx1ZXModmFsdWUsICh2YWx1ZU9mRWxlbWVudCwga2V5KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnLicgKyBrZXkpO1xuICAgICAgICAgICAgbGV0IGVpZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzaWQsIHZhbHVlT2ZFbGVtZW50LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBpZiAoc2lkICE9PSBlaWQpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVpZCwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlaWRdO1xuICAgICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHZhbHVlID0gXy5tYXAodmFsdWUsICh2YWx1ZU9mRWxlbWVudCwgaW5kZXgpID0+IHsgXG4gICAgICAgICAgICBsZXQgc2lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICdbJyArIGluZGV4ICsgJ10nKTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YWx1ZSk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG5mdW5jdGlvbiB0cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgaWYgKG5hbWUgPT09ICdub3cnKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgXCJjYWxsZWVcIjoge1xuICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICBcImNvbXB1dGVkXCI6IGZhbHNlLFxuICAgICAgICAgICAgICAgIFwib2JqZWN0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICBcImNvbXB1dGVkXCI6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBcIm9iamVjdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcImNvbXB1dGVkXCI6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJvYmplY3RcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJUeXBlc1wiXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJwcm9wZXJ0eVwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcIkRBVEVUSU1FXCJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXCJwcm9wZXJ0eVwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJ0eXBlT2JqZWN0XCJcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXCJwcm9wZXJ0eVwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwibG9jYWxcIlxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBcImFyZ3VtZW50c1wiOiBbXVxuICAgICAgICB9O1xuICAgIH0gXG4gICAgXG4gICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydCcpO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhbiBhcnJheSBvZiBmdW5jdGlvbiBhcmd1bWVudHMgZnJvbSBvb2wgaW50byBhc3QuXG4gKiBAcGFyYW0gdG9wb0lkIC0gVGhlIG1vZGlmaWVyIGZ1bmN0aW9uIHRvcG8gXG4gKiBAcGFyYW0gYXJncyAtIFxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0IC0gXG4gKiBAcmV0dXJucyB7QXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBhcmdzLCBjb21waWxlQ29udGV4dCkge1xuICAgIGFyZ3MgPSBfLmNhc3RBcnJheShhcmdzKTtcbiAgICBpZiAoXy5pc0VtcHR5KGFyZ3MpKSByZXR1cm4gW107XG5cbiAgICBsZXQgY2FsbEFyZ3MgPSBbXTtcblxuICAgIF8uZWFjaChhcmdzLCAoYXJnLCBpKSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICBsZXQgYXJnVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOmFyZ1snICsgKGkrMSkudG9TdHJpbmcoKSArICddJyk7XG4gICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGFyZ1RvcG9JZCwgYXJnLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0b3BvSWQpO1xuXG4gICAgICAgIGNhbGxBcmdzID0gY2FsbEFyZ3MuY29uY2F0KF8uY2FzdEFycmF5KGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSkpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNhbGxBcmdzO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwYXJhbSBvZiBpbnRlcmZhY2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSBpbmRleFxuICogQHBhcmFtIHBhcmFtXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVQYXJhbShpbmRleCwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IHR5cGUgPSBwYXJhbS50eXBlOyAgICBcblxuICAgIGxldCB0eXBlT2JqZWN0ID0gVHlwZXNbdHlwZV07XG5cbiAgICBpZiAoIXR5cGVPYmplY3QpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIGZpZWxkIHR5cGU6ICcgKyB0eXBlKTtcbiAgICB9XG5cbiAgICBsZXQgc2FuaXRpemVyTmFtZSA9IGBUeXBlcy4ke3R5cGUudG9VcHBlckNhc2UoKX0uc2FuaXRpemVgO1xuXG4gICAgbGV0IHZhclJlZiA9IEpzTGFuZy5hc3RWYXJSZWYocGFyYW0ubmFtZSk7XG4gICAgbGV0IGNhbGxBc3QgPSBKc0xhbmcuYXN0Q2FsbChzYW5pdGl6ZXJOYW1lLCBbdmFyUmVmLCBKc0xhbmcuYXN0QXJyYXlBY2Nlc3MoJyRtZXRhLnBhcmFtcycsIGluZGV4KSwgSnNMYW5nLmFzdFZhclJlZigndGhpcy5kYi5pMThuJyldKTtcblxuICAgIGxldCBwcmVwYXJlVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHBhcmFtczpzYW5pdGl6ZVsnICsgaW5kZXgudG9TdHJpbmcoKSArICddJyk7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZztcblxuICAgIC8vaWYgKGluZGV4ID09PSAwKSB7XG4gICAgICAgIC8vZGVjbGFyZSAkc2FuaXRpemVTdGF0ZSB2YXJpYWJsZSBmb3IgdGhlIGZpcnN0IHRpbWVcbiAgICAvLyAgICBzYW5pdGl6ZVN0YXJ0aW5nID0gSnNMYW5nLmFzdFZhckRlY2xhcmUodmFyUmVmLCBjYWxsQXN0LCBmYWxzZSwgZmFsc2UsIGBTYW5pdGl6ZSBwYXJhbSBcIiR7cGFyYW0ubmFtZX1cImApO1xuICAgIC8vfSBlbHNlIHtcbiAgICAvL2xldCBzYW5pdGl6ZVN0YXJ0aW5nID0gO1xuXG4gICAgICAgIC8vbGV0IGxhc3RQcmVwYXJlVG9wb0lkID0gJyRwYXJhbXM6c2FuaXRpemVbJyArIChpbmRleCAtIDEpLnRvU3RyaW5nKCkgKyAnXSc7XG4gICAgICAgIC8vZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UHJlcGFyZVRvcG9JZCwgcHJlcGFyZVRvcG9JZCk7XG4gICAgLy99XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbcHJlcGFyZVRvcG9JZF0gPSBbXG4gICAgICAgIEpzTGFuZy5hc3RBc3NpZ24odmFyUmVmLCBjYWxsQXN0LCBgU2FuaXRpemUgYXJndW1lbnQgXCIke3BhcmFtLm5hbWV9XCJgKVxuICAgIF07XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHByZXBhcmVUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19QQVJBTV9TQU5JVElaRVxuICAgIH0pO1xuXG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCk7XG5cbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbS5uYW1lKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkLCB0b3BvSWQpO1xuXG4gICAgbGV0IHZhbHVlID0gd3JhcFBhcmFtUmVmZXJlbmNlKHBhcmFtLm5hbWUsIHBhcmFtKTtcbiAgICBsZXQgZW5kVG9wb0lkID0gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGxldCByZWFkeVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzpyZWFkeScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCByZWFkeVRvcG9JZCk7XG5cbiAgICByZXR1cm4gcmVhZHlUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIG1vZGVsIGZpZWxkIHByZXByb2Nlc3MgaW5mb3JtYXRpb24gaW50byBhc3QuXG4gKiBAcGFyYW0ge29iamVjdH0gcGFyYW0gLSBGaWVsZCBpbmZvcm1hdGlvblxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dFxuICogQHJldHVybnMge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUZpZWxkKHBhcmFtTmFtZSwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgLy8gMS4gcmVmZXJlbmNlIHRvIHRoZSBsYXRlc3Qgb2JqZWN0IHRoYXQgaXMgcGFzc2VkIHF1YWxpZmllciBjaGVja3NcbiAgICAvLyAyLiBpZiBtb2RpZmllcnMgZXhpc3QsIHdyYXAgdGhlIHJlZiBpbnRvIGEgcGlwZWQgdmFsdWVcbiAgICAvLyAzLiBwcm9jZXNzIHRoZSByZWYgKG9yIHBpcGVkIHJlZikgYW5kIG1hcmsgYXMgZW5kXG4gICAgLy8gNC4gYnVpbGQgZGVwZW5kZW5jaWVzOiBsYXRlc3QuZmllbGQgLT4gLi4uIC0+IGZpZWxkOnJlYWR5IFxuICAgIGxldCB0b3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHBhcmFtTmFtZSk7XG4gICAgbGV0IGNvbnRleHROYW1lID0gJ2xhdGVzdC4nICsgcGFyYW1OYW1lO1xuICAgIC8vY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0VmFyUmVmKGNvbnRleHROYW1lLCB0cnVlKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShjb250ZXh0TmFtZSwgcGFyYW0pOyAgICBcbiAgICBsZXQgZW5kVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGxldCByZWFkeVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzpyZWFkeScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCByZWFkeVRvcG9JZCk7XG5cbiAgICByZXR1cm4gcmVhZHlUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIHdyYXBQYXJhbVJlZmVyZW5jZShuYW1lLCB2YWx1ZSkge1xuICAgIGxldCByZWYgPSBPYmplY3QuYXNzaWduKHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG5hbWUgfSk7XG4gICAgXG4gICAgaWYgKCFfLmlzRW1wdHkodmFsdWUubW9kaWZpZXJzKSkge1xuICAgICAgICByZXR1cm4geyBvb2xUeXBlOiAnUGlwZWRWYWx1ZScsIHZhbHVlOiByZWYsIG1vZGlmaWVyczogdmFsdWUubW9kaWZpZXJzIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiByZWY7XG59XG5cbmZ1bmN0aW9uIGhhc01vZGVsRmllbGQob3BlcmFuZCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9wZXJhbmQpICYmIG9wZXJhbmQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgbGV0IFsgYmFzZVZhciwgLi4ucmVzdCBdID0gb3BlcmFuZC5uYW1lLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tiYXNlVmFyXSAmJiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbYmFzZVZhcl0ub25nb2luZyAmJiByZXN0Lmxlbmd0aCA+IDA7ICAgICAgICBcbiAgICB9XG5cbiAgICByZXR1cm4gZmFsc2U7ICAgIFxufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHRoZW4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0IGluIHJldHVybiBibG9jay5cbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydElkXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kSWRcbiAqIEBwYXJhbSB0aGVuXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlUmV0dXJuVGhlbkFzdChzdGFydElkLCBlbmRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdUaHJvd0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJncztcbiAgICAgICAgICAgIGlmICh0aGVuLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gdHJhbnNsYXRlQXJncyhzdGFydElkLCB0aGVuLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBhcmdzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdSZXR1cm5FeHByZXNzaW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH0gICAgICAgIFxuICAgIH1cblxuICAgIC8vdGhlbiBleHByZXNzaW9uIGlzIGFuIG9vbG9uZyBjb25jcmV0ZSB2YWx1ZSAgICBcbiAgICBpZiAoXy5pc0FycmF5KHRoZW4pIHx8IF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBsZXQgdmFsdWVFbmRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydElkLCB0aGVuLCBjb21waWxlQ29udGV4dCk7ICAgIFxuICAgICAgICB0aGVuID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZhbHVlRW5kSWRdOyBcbiAgICB9ICAgXG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdFJldHVybih0aGVuKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSB0aGVuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0SWRcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRJZFxuICogQHBhcmFtIHRoZW5cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFzc2lnblRvXG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVRoZW5Bc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0LCBhc3NpZ25Ubykge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1Rocm93RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmdzO1xuICAgICAgICAgICAgaWYgKHRoZW4uYXJncykge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSB0cmFuc2xhdGVBcmdzKHN0YXJ0SWQsIHRoZW4uYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFRocm93KHRoZW4uZXJyb3JUeXBlIHx8IGRlZmF1bHRFcnJvciwgdGhlbi5tZXNzYWdlIHx8IGFyZ3MpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIHN3aXRjaCAodGhlbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyYmJztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJ3x8JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmICghaGFzTW9kZWxGaWVsZCh0aGVuLmxlZnQsIGNvbXBpbGVDb250ZXh0KSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgcXVlcnkgY29uZGl0aW9uOiB0aGUgbGVmdCBvcGVyYW5kIG5lZWQgdG8gYmUgYW4gZW50aXR5IGZpZWxkLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaGFzTW9kZWxGaWVsZCh0aGVuLnJpZ2h0LCBjb21waWxlQ29udGV4dCkpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHF1ZXJ5IGNvbmRpdGlvbjogdGhlIHJpZ2h0IG9wZXJhbmQgc2hvdWxkIG5vdCBiZSBhbiBlbnRpdHkgZmllbGQuIFVzZSBkYXRhc2V0IGluc3RlYWQgaWYgam9pbmluZyBpcyByZXF1aXJlZC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHt9O1xuICAgICAgICAgICAgbGV0IHN0YXJ0UmlnaHRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRJZCArICckYmluT3A6cmlnaHQnKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRJZCwgc3RhcnRSaWdodElkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0UmlnaHRJZCwgdGhlbi5yaWdodCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kSWQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodGhlbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvblt0aGVuLmxlZnQubmFtZS5zcGxpdCgnLicsIDIpWzFdXSA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtsYXN0UmlnaHRJZF07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvblt0aGVuLmxlZnQubmFtZS5zcGxpdCgnLicsIDIpWzFdXSA9IHsgW09QRVJBVE9SX1RPS0VOW29wXV06IGNvbXBpbGVDb250ZXh0LmFzdE1hcFtsYXN0UmlnaHRJZF0gfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RBc3NpZ24oYXNzaWduVG8sIEpzTGFuZy5hc3RWYWx1ZShjb25kaXRpb24pKTsgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy90aGVuIGV4cHJlc3Npb24gaXMgYW4gb29sb25nIGNvbmNyZXRlIHZhbHVlICAgIFxuICAgIGlmIChfLmlzQXJyYXkodGhlbikgfHwgXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGxldCB2YWx1ZUVuZElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0SWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KTsgICAgXG4gICAgICAgIHRoZW4gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdmFsdWVFbmRJZF07IFxuICAgIH0gICBcblxuICAgIHJldHVybiBKc0xhbmcuYXN0QXNzaWduKGFzc2lnblRvLCB0aGVuKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSByZXR1cm4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgc3RhdGUgb2YgcmV0dXJuIGNsYXVzZVxuICogQHBhcmFtIHtzdHJpbmd9IGVuZFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBlbmRpbmcgc3RhdGUgb2YgcmV0dXJuIGNsYXVzZVxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IHZhbHVlVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgIGlmICh2YWx1ZVRvcG9JZCAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB2YWx1ZVRvcG9JZCwgZW5kVG9wb0lkKTtcbiAgICB9XG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdFJldHVybihnZXRDb2RlUmVwcmVzZW50YXRpb25PZih2YWx1ZVRvcG9JZCwgY29tcGlsZUNvbnRleHQpKTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSBleHByZXNzaW9uXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiBjb21waWxlUmV0dXJuKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybicpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX1ZJRVdfUkVUVVJOXG4gICAgfSk7XG5cbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBmaW5kIG9uZSBvcGVyYXRpb24gZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7aW50fSBpbmRleFxuICogQHBhcmFtIHtvYmplY3R9IG9wZXJhdGlvbiAtIE9vbCBub2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLVxuICogQHBhcmFtIHtzdHJpbmd9IGRlcGVuZGVuY3lcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGxhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaW5kT25lKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiBkZXBlbmRlbmN5O1xuXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJ29wJCcgKyBpbmRleC50b1N0cmluZygpKTtcbiAgICBsZXQgY29uZGl0aW9uVmFyTmFtZSA9IGVuZFRvcG9JZCArICckY29uZGl0aW9uJztcblxuICAgIGxldCBhc3QgPSBbXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKGNvbmRpdGlvblZhck5hbWUpXG4gICAgXTtcblxuICAgIGFzc2VydDogb3BlcmF0aW9uLmNvbmRpdGlvbjtcblxuICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tvcGVyYXRpb24ubW9kZWxdID0geyB0eXBlOiAnZW50aXR5Jywgc291cmNlOiAnZmluZE9uZScsIG9uZ29pbmc6IHRydWUgfTtcblxuICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLm9vbFR5cGUpIHtcbiAgICAgICAgLy9zcGVjaWFsIGNvbmRpdGlvblxuXG4gICAgICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLm9vbFR5cGUgPT09ICdjYXNlcycpIHtcbiAgICAgICAgICAgIGxldCB0b3BvSWRQcmVmaXggPSBlbmRUb3BvSWQgKyAnJGNhc2VzJztcbiAgICAgICAgICAgIGxldCBsYXN0U3RhdGVtZW50O1xuXG4gICAgICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5lbHNlKSB7XG4gICAgICAgICAgICAgICAgbGV0IGVsc2VTdGFydCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkUHJlZml4ICsgJzplbHNlJyk7XG4gICAgICAgICAgICAgICAgbGV0IGVsc2VFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZW5kJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbHNlU3RhcnQsIGVsc2VFbmQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZUVuZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSB0cmFuc2xhdGVUaGVuQXN0KGVsc2VTdGFydCwgZWxzZUVuZCwgb3BlcmF0aW9uLmNvbmRpdGlvbi5lbHNlLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSBKc0xhbmcuYXN0VGhyb3coJ1NlcnZlckVycm9yJywgJ1VuZXhwZWN0ZWQgc3RhdGUuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkob3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ01pc3NpbmcgY2FzZSBpdGVtcycpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBfLnJldmVyc2Uob3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcykuZm9yRWFjaCgoaXRlbSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChpdGVtLm9vbFR5cGUgIT09ICdDb25kaXRpb25hbFN0YXRlbWVudCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGNhc2UgaXRlbS4nKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpID0gb3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcy5sZW5ndGggLSBpIC0gMTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUHJlZml4ID0gdG9wb0lkUHJlZml4ICsgJ1snICsgaS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAgICAgICAgIGxldCBjYXNlVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4KTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3ksIGNhc2VUb3BvSWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNhc2VSZXN1bHRWYXJOYW1lID0gJyQnICsgdG9wb0lkUHJlZml4ICsgJ18nICsgaS50b1N0cmluZygpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGNhc2VUb3BvSWQpO1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYXNlVHRlbSA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoYXN0Q2FzZVR0ZW0pLCAnSW52YWxpZCBjYXNlIGl0ZW0gYXN0Lic7XG5cbiAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKGNhc2VSZXN1bHRWYXJOYW1lLCBhc3RDYXNlVHRlbSwgdHJ1ZSwgZmFsc2UsIGBDb25kaXRpb24gJHtpfSBmb3IgZmluZCBvbmUgJHtvcGVyYXRpb24ubW9kZWx9YCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgaWZTdGFydCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCArICc6dGhlbicpO1xuICAgICAgICAgICAgICAgIGxldCBpZkVuZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCArICc6ZW5kJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBpZlN0YXJ0KTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGlmU3RhcnQsIGlmRW5kKTtcblxuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSBbXG4gICAgICAgICAgICAgICAgICAgIGFzdENhc2VUdGVtLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0SWYoSnNMYW5nLmFzdFZhclJlZihjYXNlUmVzdWx0VmFyTmFtZSksIEpzTGFuZy5hc3RCbG9jayh0cmFuc2xhdGVUaGVuQXN0KGlmU3RhcnQsIGlmRW5kLCBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0LCBjb25kaXRpb25WYXJOYW1lKSksIGxhc3RTdGF0ZW1lbnQpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGlmRW5kLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFzdCA9IGFzdC5jb25jYXQoXy5jYXN0QXJyYXkobGFzdFN0YXRlbWVudCkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgICAgIH1cblxuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgfVxuXG4gICAgYXN0LnB1c2goXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKG9wZXJhdGlvbi5tb2RlbCwgSnNMYW5nLmFzdEF3YWl0KGB0aGlzLmZpbmRPbmVfYCwgSnNMYW5nLmFzdFZhclJlZihjb25kaXRpb25WYXJOYW1lKSkpXG4gICAgKTtcblxuICAgIGRlbGV0ZSBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbb3BlcmF0aW9uLm1vZGVsXS5vbmdvaW5nO1xuXG4gICAgbGV0IG1vZGVsVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBvcGVyYXRpb24ubW9kZWwpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCBtb2RlbFRvcG9JZCk7XG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBhc3Q7XG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY29tcGlsZURiT3BlcmF0aW9uKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgbGV0IGxhc3RUb3BvSWQ7XG5cbiAgICBzd2l0Y2ggKG9wZXJhdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIGNhc2UgJ0ZpbmRPbmVTdGF0ZW1lbnQnOlxuICAgICAgICAgICAgbGFzdFRvcG9JZCA9IGNvbXBpbGVGaW5kT25lKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2ZpbmQnOlxuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICd1cGRhdGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdjcmVhdGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdkZWxldGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdEb1N0YXRlbWVudCc6XG4gICAgICAgICAgICBsZXQgZG9CbG9jayA9IG9wZXJhdGlvbi5kbztcbiAgICAgICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlRG9TdGF0ZW1lbnQoaW5kZXgsIGRvQmxvY2ssIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2Fzc2lnbm1lbnQnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIG9wZXJhdGlvbiB0eXBlOiAnICsgb3BlcmF0aW9uLnR5cGUpO1xuICAgIH1cblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT05cbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjb21waWxlRG9TdGF0ZW1lbnQoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICAgICAgXG59XG5cbi8qKlxuICogQ29tcGlsZSBleGNlcHRpb25hbCByZXR1cm4gXG4gKiBAcGFyYW0ge29iamVjdH0gb29sTm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0ge3N0cmluZ30gW2RlcGVuZGVuY3ldXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4ob29sTm9kZSwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBwcmU6IChfLmlzUGxhaW5PYmplY3Qob29sTm9kZSkgJiYgb29sTm9kZS5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpO1xuXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKSwgbGFzdEV4Y2VwdGlvbklkID0gZGVwZW5kZW5jeTtcblxuICAgIGlmICghXy5pc0VtcHR5KG9vbE5vZGUuZXhjZXB0aW9ucykpIHtcbiAgICAgICAgb29sTm9kZS5leGNlcHRpb25zLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZXhjZXB0aW9uYWwgdHlwZTogJyArIGl0ZW0ub29sVHlwZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2VwdGlvblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25FbmRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkICsgJzpleGNlcHRbJyArIGkudG9TdHJpbmcoKSArICddOmRvbmUnKTtcbiAgICAgICAgICAgICAgICBpZiAobGFzdEV4Y2VwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBleGNlcHRpb25TdGFydElkKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24oaXRlbS50ZXN0LCBjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uU3RhcnRJZCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgdGhlblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQgKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHRoZW5TdGFydElkKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHRoZW5TdGFydElkLCBleGNlcHRpb25FbmRJZCk7XG5cbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZXhjZXB0aW9uRW5kSWRdID0gSnNMYW5nLmFzdElmKFxuICAgICAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RCbG9jayh0cmFuc2xhdGVSZXR1cm5UaGVuQXN0KFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhlblN0YXJ0SWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBleGNlcHRpb25FbmRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGl0ZW0udGhlbiwgY29tcGlsZUNvbnRleHQpKSxcbiAgICAgICAgICAgICAgICAgICAgbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgYFJldHVybiBvbiBleGNlcHRpb24gIyR7aX1gXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uRW5kSWQsIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogQVNUX0JMS19FWENFUFRJT05fSVRFTVxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgbGFzdEV4Y2VwdGlvbklkID0gZXhjZXB0aW9uRW5kSWQ7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0RXhjZXB0aW9uSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBsZXQgcmV0dXJuU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuOnZhbHVlJyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCByZXR1cm5TdGFydFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3QocmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgb29sTm9kZS52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOXG4gICAgfSk7XG4gICAgXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBuYW1lKSB7XG4gICAgaWYgKGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMobmFtZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtuYW1lfVwiIGFscmVhZHkgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBhc3NlcnQ6ICFjb21waWxlQ29udGV4dC50b3BvU29ydC5oYXNEZXBlbmRlbmN5KG5hbWUpLCAnQWxyZWFkeSBpbiB0b3BvU29ydCEnO1xuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmFkZChuYW1lKTtcblxuICAgIHJldHVybiBuYW1lO1xufVxuXG5mdW5jdGlvbiBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHByZXZpb3VzT3AsIGN1cnJlbnRPcCkge1xuICAgIHByZTogcHJldmlvdXNPcCAhPT0gY3VycmVudE9wLCAnU2VsZiBkZXBlbmRpbmcnO1xuXG4gICAgY29tcGlsZUNvbnRleHQubG9nZ2VyLmRlYnVnKGN1cnJlbnRPcCArICcgXFx4MWJbMzNtZGVwZW5kcyBvblxceDFiWzBtICcgKyBwcmV2aW91c09wKTtcblxuICAgIGlmICghY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmhhcyhjdXJyZW50T3ApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7Y3VycmVudE9wfVwiIG5vdCBjcmVhdGVkLmApO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LmFkZChwcmV2aW91c09wLCBjdXJyZW50T3ApO1xufVxuXG5mdW5jdGlvbiBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHRvcG9JZCwgYmxvY2tNZXRhKSB7XG4gICAgaWYgKCEodG9wb0lkIGluIGNvbXBpbGVDb250ZXh0LmFzdE1hcCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBU1Qgbm90IGZvdW5kIGZvciBibG9jayB3aXRoIHRvcG9JZDogJHt0b3BvSWR9YCk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5zZXQodG9wb0lkLCBibG9ja01ldGEpO1xuXG4gICAgY29tcGlsZUNvbnRleHQubG9nZ2VyLnZlcmJvc2UoYEFkZGluZyAke2Jsb2NrTWV0YS50eXBlfSBcIiR7dG9wb0lkfVwiIGludG8gc291cmNlIGNvZGUuYCk7XG4gICAgLy9jb21waWxlQ29udGV4dC5sb2dnZXIuZGVidWcoJ0FTVDpcXG4nICsgSlNPTi5zdHJpbmdpZnkoY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0sIG51bGwsIDIpKTtcbn1cblxuZnVuY3Rpb24gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YodG9wb0lkLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBsYXN0U291cmNlVHlwZSA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KHRvcG9JZCk7XG5cbiAgICBpZiAobGFzdFNvdXJjZVR5cGUgJiYgKGxhc3RTb3VyY2VUeXBlLnR5cGUgPT09IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwgfHwgbGFzdFNvdXJjZVR5cGUudHlwZSA9PT0gQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCkpIHtcbiAgICAgICAgLy9mb3IgbW9kaWZpZXIsIGp1c3QgdXNlIHRoZSBmaW5hbCByZXN1bHRcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RWYXJSZWYobGFzdFNvdXJjZVR5cGUudGFyZ2V0LCB0cnVlKTtcbiAgICB9XG5cbiAgICBsZXQgYXN0ID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF07XG4gICAgaWYgKGFzdC50eXBlID09PSAnTWVtYmVyRXhwcmVzc2lvbicgJiYgYXN0Lm9iamVjdC5uYW1lID09PSAnbGF0ZXN0Jykge1xuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdENvbmRpdGlvbmFsKFxuICAgICAgICAgICAgSnNMYW5nLmFzdENhbGwoJ2xhdGVzdC5oYXNPd25Qcm9wZXJ0eScsIFsgYXN0LnByb3BlcnR5LnZhbHVlIF0pLCAvKiogdGVzdCAqL1xuICAgICAgICAgICAgYXN0LCAvKiogY29uc2VxdWVudCAqL1xuICAgICAgICAgICAgeyAuLi5hc3QsIG9iamVjdDogeyAuLi5hc3Qub2JqZWN0LCBuYW1lOiAnZXhpc3RpbmcnIH0gfVxuICAgICAgICApOyAgIFxuICAgIH1cblxuICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlQ29tcGlsZUNvbnRleHQobW9kdWxlTmFtZSwgbG9nZ2VyLCBzaGFyZWRDb250ZXh0KSB7XG4gICAgbGV0IGNvbXBpbGVDb250ZXh0ID0ge1xuICAgICAgICBtb2R1bGVOYW1lLCAgICAgICAgXG4gICAgICAgIGxvZ2dlcixcbiAgICAgICAgdmFyaWFibGVzOiB7fSxcbiAgICAgICAgdG9wb05vZGVzOiBuZXcgU2V0KCksXG4gICAgICAgIHRvcG9Tb3J0OiBuZXcgVG9wb1NvcnQoKSxcbiAgICAgICAgYXN0TWFwOiB7fSwgLy8gU3RvcmUgdGhlIEFTVCBmb3IgYSBub2RlXG4gICAgICAgIG1hcE9mVG9rZW5Ub01ldGE6IG5ldyBNYXAoKSwgLy8gU3RvcmUgdGhlIHNvdXJjZSBjb2RlIGJsb2NrIHBvaW50XG4gICAgICAgIG1vZGVsVmFyczogbmV3IFNldCgpLFxuICAgICAgICBtYXBPZkZ1bmN0b3JUb0ZpbGU6IChzaGFyZWRDb250ZXh0ICYmIHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSB8fCB7fSwgLy8gVXNlIHRvIHJlY29yZCBpbXBvcnQgbGluZXNcbiAgICAgICAgbmV3RnVuY3RvckZpbGVzOiAoc2hhcmVkQ29udGV4dCAmJiBzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykgfHwgW11cbiAgICB9O1xuXG4gICAgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckbWFpbicpO1xuXG4gICAgbG9nZ2VyLnZlcmJvc2UoYENyZWF0ZWQgY29tcGlsYXRpb24gY29udGV4dCBmb3IgXCIke21vZHVsZU5hbWV9XCIuYCk7XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQ7XG59XG5cbmZ1bmN0aW9uIGlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpIHtcbiAgICByZXR1cm4gdG9wb0lkLmluZGV4T2YoJzphcmdbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckY2FzZXNbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckZXhjZXB0aW9uc1snKSA9PT0gLTE7XG59XG5cbmZ1bmN0aW9uIHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYsIHRhcmdldFNjb3BlKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YXJSZWYpKSB7XG4gICAgICAgIGFzc2VydDogdmFyUmVmLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnO1xuXG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLm5hbWUsIHRhcmdldFNjb3BlKSB9OyAgICAgICAgXG4gICAgfSBcblxuICAgIGFzc2VydDogdHlwZW9mIHZhclJlZiA9PT0gJ3N0cmluZyc7XG5cbiAgICBsZXQgcGFydHMgPSB2YXJSZWYuc3BsaXQoJy4nKTtcbiAgICBhc3NlcnQ6IHBhcnRzLmxlbmd0aCA+IDE7XG5cbiAgICBwYXJ0cy5zcGxpY2UoMCwgMSwgdGFyZ2V0U2NvcGUpO1xuICAgIHJldHVybiBwYXJ0cy5qb2luKCcuJyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIGNvbXBpbGVQYXJhbSxcbiAgICBjb21waWxlRmllbGQsXG4gICAgY29tcGlsZURiT3BlcmF0aW9uLFxuICAgIGNvbXBpbGVFeGNlcHRpb25hbFJldHVybixcbiAgICBjb21waWxlUmV0dXJuLFxuICAgIGNyZWF0ZVRvcG9JZCxcbiAgICBjcmVhdGVDb21waWxlQ29udGV4dCxcbiAgICBkZXBlbmRzT24sXG4gICAgYWRkQ29kZUJsb2NrLFxuXG4gICAgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyxcbiAgICBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIEFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfVklFV19SRVRVUk4sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiwgXG4gICAgQVNUX0JMS19FWENFUFRJT05fSVRFTSxcblxuICAgIE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdcbn07Il19