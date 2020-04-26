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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiVHlwZXMiLCJWYWxpZGF0b3JzIiwiT29sb25nVmFsaWRhdG9ycyIsIlByb2Nlc3NvcnMiLCJPb2xvbmdQcm9jZXNzb3JzIiwiQWN0aXZhdG9ycyIsIk9vbG9uZ0FjdGl2YXRvcnMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJPUEVSQVRPUl9UT0tFTiIsImNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24iLCJ0ZXN0IiwiY29tcGlsZUNvbnRleHQiLCJzdGFydFRvcG9JZCIsImlzUGxhaW5PYmplY3QiLCJvb2xUeXBlIiwiZW5kVG9wb0lkIiwiY3JlYXRlVG9wb0lkIiwib3BlcmFuZFRvcG9JZCIsImRlcGVuZHNPbiIsImxhc3RPcGVyYW5kVG9wb0lkIiwiY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uIiwiY2FsbGVyIiwiYXN0QXJndW1lbnQiLCJnZXRDb2RlUmVwcmVzZW50YXRpb25PZiIsInJldFRvcG9JZCIsImNvbXBpbGVBZEhvY1ZhbGlkYXRvciIsImNhbGxlZSIsIm9wIiwib3BlcmF0b3IiLCJFcnJvciIsImxlZnRUb3BvSWQiLCJyaWdodFRvcG9JZCIsImxhc3RMZWZ0SWQiLCJsZWZ0IiwibGFzdFJpZ2h0SWQiLCJyaWdodCIsImFzdE1hcCIsImFzdEJpbkV4cCIsImFyZ3VtZW50IiwiYXN0Tm90IiwiYXN0Q2FsbCIsInZhbHVlU3RhcnRUb3BvSWQiLCJhc3RWYWx1ZSIsInRvcG9JZCIsInZhbHVlIiwiZnVuY3RvciIsImNhbGxBcmdzIiwiYXJncyIsInRyYW5zbGF0ZUFyZ3MiLCJhcmcwIiwibmFtZSIsImNvbmNhdCIsImNvbXBpbGVNb2RpZmllciIsImRlY2xhcmVQYXJhbXMiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyIsIm1vZHVsZU5hbWUiLCJpc0VtcHR5IiwiZnVuY3RvcklkIiwidHJhbnNsYXRlTW9kaWZpZXIiLCJyZWZlcmVuY2VzIiwiZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMiLCJmaW5kIiwicmVmIiwiYXN0QXdhaXQiLCJhc3RWYXJSZWYiLCJpc1RvcExldmVsQmxvY2siLCJzdGFydHNXaXRoIiwiYXN0Q29uZGl0aW9uYWwiLCJyZXBsYWNlVmFyUmVmU2NvcGUiLCJ0YXJnZXRWYXJOYW1lIiwibmVlZERlY2xhcmUiLCJ2YXJpYWJsZXMiLCJjb3VudGVyIiwidG9TdHJpbmciLCJoYXNPd25Qcm9wZXJ0eSIsInR5cGUiLCJzb3VyY2UiLCJhZGRDb2RlQmxvY2siLCJ0YXJnZXQiLCJvb2xBcmdzIiwiY2FzdEFycmF5IiwicmVmcyIsImZvckVhY2giLCJhIiwiQXJyYXkiLCJpc0FycmF5IiwicmVzdWx0IiwiY2hlY2tSZWZlcmVuY2VUb0ZpZWxkIiwicHVzaCIsIm9iaiIsInVuZGVmaW5lZCIsImFkZE1vZGlmaWVyVG9NYXAiLCJmdW5jdG9yVHlwZSIsImZ1bmN0b3JKc0ZpbGUiLCJtYXBPZkZ1bmN0b3JUb0ZpbGUiLCJmdW5jdGlvbk5hbWUiLCJmaWxlTmFtZSIsIm5hbWVzIiwibGVuZ3RoIiwicmVmRW50aXR5TmFtZSIsInVwcGVyRmlyc3QiLCJidWlsdGlucyIsIm5ld0Z1bmN0b3JGaWxlcyIsImNvbXBpbGVQaXBlZFZhbHVlIiwidmFyT29sIiwibGFzdFRvcG9JZCIsIm1vZGlmaWVycyIsIm1vZGlmaWVyIiwibW9kaWZpZXJTdGFydFRvcG9JZCIsImNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSIsIlNldCIsInRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0iLCJhcmciLCJpIiwicG9wIiwibWFwIiwiYmFzZU5hbWUiLCJjb3VudCIsImhhcyIsImFkZCIsInJlZkJhc2UiLCJyZXN0IiwiZGVwZW5kZW5jeSIsIm9uZ29pbmciLCJyZWZGaWVsZE5hbWUiLCJvb3JUeXBlIiwidHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJtYXBWYWx1ZXMiLCJ2YWx1ZU9mRWxlbWVudCIsImtleSIsInNpZCIsImVpZCIsImluZGV4IiwiZWFjaCIsImFyZ1RvcG9JZCIsImNvbXBpbGVQYXJhbSIsInBhcmFtIiwidHlwZU9iamVjdCIsInNhbml0aXplck5hbWUiLCJ0b1VwcGVyQ2FzZSIsInZhclJlZiIsImNhbGxBc3QiLCJhc3RBcnJheUFjY2VzcyIsInByZXBhcmVUb3BvSWQiLCJhc3RBc3NpZ24iLCJtYWluU3RhcnRJZCIsIndyYXBQYXJhbVJlZmVyZW5jZSIsInJlYWR5VG9wb0lkIiwiY29tcGlsZUZpZWxkIiwicGFyYW1OYW1lIiwiY29udGV4dE5hbWUiLCJPYmplY3QiLCJhc3NpZ24iLCJoYXNNb2RlbEZpZWxkIiwib3BlcmFuZCIsImJhc2VWYXIiLCJzcGxpdCIsInRyYW5zbGF0ZVJldHVyblRoZW5Bc3QiLCJzdGFydElkIiwiZW5kSWQiLCJ0aGVuIiwiYXN0VGhyb3ciLCJlcnJvclR5cGUiLCJtZXNzYWdlIiwidHJhbnNsYXRlUmV0dXJuVmFsdWVBc3QiLCJ2YWx1ZUVuZElkIiwiYXN0UmV0dXJuIiwidHJhbnNsYXRlVGhlbkFzdCIsImFzc2lnblRvIiwiY29uZGl0aW9uIiwic3RhcnRSaWdodElkIiwidmFsdWVUb3BvSWQiLCJjb21waWxlUmV0dXJuIiwiY29tcGlsZUZpbmRPbmUiLCJvcGVyYXRpb24iLCJjb25kaXRpb25WYXJOYW1lIiwiYXN0IiwiYXN0VmFyRGVjbGFyZSIsIm1vZGVsIiwidG9wb0lkUHJlZml4IiwibGFzdFN0YXRlbWVudCIsImVsc2UiLCJlbHNlU3RhcnQiLCJlbHNlRW5kIiwiaXRlbXMiLCJyZXZlcnNlIiwiaXRlbSIsImNhc2VQcmVmaXgiLCJjYXNlVG9wb0lkIiwiY2FzZVJlc3VsdFZhck5hbWUiLCJhc3RDYXNlVHRlbSIsImlmU3RhcnQiLCJpZkVuZCIsImFzdElmIiwiYXN0QmxvY2siLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImRvQmxvY2siLCJkbyIsImNvbXBpbGVEb1N0YXRlbWVudCIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsaW5rZXIiLCJsb2ciLCJibG9ja01ldGEiLCJtYXBPZlRva2VuVG9NZXRhIiwic2V0IiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsIm1vZGVsVmFycyIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtB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Iiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8qKlxuICogQG1vZHVsZVxuICogQGlnbm9yZVxuICovXG5cbmNvbnN0IHsgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVG9wb1NvcnQgfSA9IHJlcXVpcmUoJ0BnZW54L2FsZ29yaXRobScpO1xuXG5jb25zdCBKc0xhbmcgPSByZXF1aXJlKCcuL2FzdC5qcycpO1xuY29uc3QgT29sVHlwZXMgPSByZXF1aXJlKCcuLi8uLi9sYW5nL09vbFR5cGVzJyk7XG5jb25zdCB7IGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lLCBleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUgfSA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IHsgIFR5cGVzLCBWYWxpZGF0b3JzOiBPb2xvbmdWYWxpZGF0b3JzLCBQcm9jZXNzb3JzOiBPb2xvbmdQcm9jZXNzb3JzLCBBY3RpdmF0b3JzOiBPb2xvbmdBY3RpdmF0b3JzIH0gPSByZXF1aXJlKCdAZ2VueC9kYXRhJyk7XG5cbmNvbnN0IGRlZmF1bHRFcnJvciA9ICdJbnZhbGlkUmVxdWVzdCc7XG5cbmNvbnN0IEFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MgPSAnRmllbGRQcmVQcm9jZXNzJztcbmNvbnN0IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkUgPSAnUGFyYW1ldGVyU2FuaXRpemUnO1xuY29uc3QgQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCA9ICdQcm9jZXNzb3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfVkFMSURBVE9SX0NBTEwgPSAnVmFsaWRhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX0FDVElWQVRPUl9DQUxMID0gJ0FjdGl2YXRvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WSUVXX09QRVJBVElPTiA9ICdWaWV3T3BlcmF0aW9uJztcbmNvbnN0IEFTVF9CTEtfVklFV19SRVRVUk4gPSAnVmlld1JldHVybic7XG5jb25zdCBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04gPSAnSW50ZXJmYWNlT3BlcmF0aW9uJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiA9ICdJbnRlcmZhY2VSZXR1cm4nO1xuY29uc3QgQVNUX0JMS19FWENFUFRJT05fSVRFTSA9ICdFeGNlcHRpb25JdGVtJztcblxuY29uc3QgT09MX01PRElGSUVSX0NPREVfRkxBRyA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX09QID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAnfH4nLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAnfD4nLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAnfD0nIFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX1BBVEggPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd2YWxpZGF0b3JzJyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3Byb2Nlc3NvcnMnLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAnYWN0aXZhdG9ycycgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQlVJTFRJTiA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogT29sb25nVmFsaWRhdG9ycyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogT29sb25nUHJvY2Vzc29ycyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogT29sb25nQWN0aXZhdG9ycyBcbn07XG5cbmNvbnN0IE9QRVJBVE9SX1RPS0VOID0ge1xuICAgIFwiPlwiOiBcIiRndFwiLFxuICAgIFwiPFwiOiBcIiRsdFwiLFxuICAgIFwiPj1cIjogXCIkZ3RlXCIsXG4gICAgXCI8PVwiOiBcIiRsdGVcIixcbiAgICBcIj09XCI6IFwiJGVxXCIsXG4gICAgXCIhPVwiOiBcIiRuZVwiLFxuICAgIFwiaW5cIjogXCIkaW5cIixcbiAgICBcIm5vdEluXCI6IFwiJG5pblwiXG59O1xuXG4vKipcbiAqIENvbXBpbGUgYSBjb25kaXRpb25hbCBleHByZXNzaW9uXG4gKiBAcGFyYW0ge29iamVjdH0gdGVzdFxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0XG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZFxuICogQHJldHVybnMge3N0cmluZ30gVG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QsIGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodGVzdCkpIHsgICAgICAgIFxuICAgICAgICBpZiAodGVzdC5vb2xUeXBlID09PSAnVmFsaWRhdGVFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHZhbGlPcDpkb25lJyk7XG4gICAgICAgICAgICBsZXQgb3BlcmFuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHZhbGlPcCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBvcGVyYW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RPcGVyYW5kVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKG9wZXJhbmRUb3BvSWQsIHRlc3QuY2FsbGVyLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RPcGVyYW5kVG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgYXN0QXJndW1lbnQgPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0T3BlcmFuZFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBsZXQgcmV0VG9wb0lkID0gY29tcGlsZUFkSG9jVmFsaWRhdG9yKGVuZFRvcG9JZCwgYXN0QXJndW1lbnQsIHRlc3QuY2FsbGVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGFzc2VydDogcmV0VG9wb0lkID09PSBlbmRUb3BvSWQ7XG5cbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCk7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2V4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90LWV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodGVzdC5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6ZG9uZScpO1xuXG4gICAgICAgICAgICBsZXQgb3A7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyYmJztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJ3x8JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGxlZnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpsZWZ0Jyk7XG4gICAgICAgICAgICBsZXQgcmlnaHRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpyaWdodCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RMZWZ0SWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QubGVmdCwgY29tcGlsZUNvbnRleHQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LnJpZ2h0LCBjb21waWxlQ29udGV4dCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RMZWZ0SWQsIGVuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RSaWdodElkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RCaW5FeHAoXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdExlZnRJZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgIG9wLFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RSaWdodElkLCBjb21waWxlQ29udGV4dClcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodGVzdC5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpkb25lJyk7XG5cbiAgICAgICAgICAgIGxldCBvcDtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnPic6XG4gICAgICAgICAgICAgICAgY2FzZSAnPCc6XG4gICAgICAgICAgICAgICAgY2FzZSAnPj0nOlxuICAgICAgICAgICAgICAgIGNhc2UgJzw9JzpcbiAgICAgICAgICAgICAgICBjYXNlICdpbic6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gdGVzdC5vcGVyYXRvcjtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICc9PSc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJz09PSc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnIT0nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICchPT0nO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbGVmdFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOmxlZnQnKTtcbiAgICAgICAgICAgIGxldCByaWdodFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOnJpZ2h0Jyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdExlZnRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihsZWZ0VG9wb0lkLCB0ZXN0LmxlZnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihyaWdodFRvcG9JZCwgdGVzdC5yaWdodCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RMZWZ0SWQsIGVuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RSaWdodElkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RCaW5FeHAoXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdExlZnRJZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgIG9wLFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RSaWdodElkLCBjb21waWxlQ29udGV4dClcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodGVzdC5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHVuYU9wOmRvbmUnKTtcbiAgICAgICAgICAgIGxldCBvcGVyYW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdW5hT3AnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgb3BlcmFuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0T3BlcmFuZFRvcG9JZCA9IHRlc3Qub3BlcmF0b3IgPT09ICdub3QnID8gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKG9wZXJhbmRUb3BvSWQsIHRlc3QuYXJndW1lbnQsIGNvbXBpbGVDb250ZXh0KSA6IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5hcmd1bWVudCwgY29tcGlsZUNvbnRleHQsIG9wZXJhbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0T3BlcmFuZFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGFzdEFyZ3VtZW50ID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdE9wZXJhbmRUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QtZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCB2YWx1ZVN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsdWUnKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIHZhbHVlU3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbih2YWx1ZVN0YXJ0VG9wb0lkLCB0ZXN0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh0ZXN0KTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHZhbGlkYXRvciBjYWxsZWQgaW4gYSBsb2dpY2FsIGV4cHJlc3Npb24uXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBmdW5jdG9yc1xuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gdG9wb0luZm9cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby50b3BvSWRQcmVmaXhcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby5sYXN0VG9wb0lkXG4gKiBAcmV0dXJucyB7KnxzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVBZEhvY1ZhbGlkYXRvcih0b3BvSWQsIHZhbHVlLCBmdW5jdG9yLCBjb21waWxlQ29udGV4dCkge1xuICAgIGFzc2VydDogZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1I7ICAgICAgICBcblxuICAgIGxldCBjYWxsQXJncztcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5hcmdzKSB7XG4gICAgICAgIGNhbGxBcmdzID0gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGZ1bmN0b3IuYXJncywgY29tcGlsZUNvbnRleHQpOyAgICAgICAgXG4gICAgfSBlbHNlIHtcbiAgICAgICAgY2FsbEFyZ3MgPSBbXTtcbiAgICB9ICAgICAgICAgICAgXG4gICAgXG4gICAgbGV0IGFyZzAgPSB2YWx1ZTtcbiAgICBcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdWYWxpZGF0b3JzLicgKyBmdW5jdG9yLm5hbWUsIFsgYXJnMCBdLmNvbmNhdChjYWxsQXJncykpO1xuXG4gICAgcmV0dXJuIHRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgbW9kaWZpZXIgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHRvcG9JZCAtIHN0YXJ0VG9wb0lkXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBmdW5jdG9yc1xuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gdG9wb0luZm9cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby50b3BvSWRQcmVmaXhcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby5sYXN0VG9wb0lkXG4gKiBAcmV0dXJucyB7KnxzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVNb2RpZmllcih0b3BvSWQsIHZhbHVlLCBmdW5jdG9yLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBkZWNsYXJlUGFyYW1zO1xuXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7IFxuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoW3tuYW1lOiBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lfSwge25hbWU6ICdjb250ZXh0J31dLmNvbmNhdChmdW5jdG9yLmFyZ3MpKTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhfLmlzRW1wdHkoZnVuY3Rvci5hcmdzKSA/IFt2YWx1ZV0gOiBbdmFsdWVdLmNvbmNhdChmdW5jdG9yLmFyZ3MpKTsgICAgICAgIFxuICAgIH0gICAgICAgIFxuXG4gICAgbGV0IGZ1bmN0b3JJZCA9IHRyYW5zbGF0ZU1vZGlmaWVyKGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0LCBkZWNsYXJlUGFyYW1zKTtcblxuICAgIGxldCBjYWxsQXJncywgcmVmZXJlbmNlcztcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5hcmdzKSB7XG4gICAgICAgIGNhbGxBcmdzID0gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGZ1bmN0b3IuYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICByZWZlcmVuY2VzID0gZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMoZnVuY3Rvci5hcmdzKTtcblxuICAgICAgICBpZiAoXy5maW5kKHJlZmVyZW5jZXMsIHJlZiA9PiByZWYgPT09IHZhbHVlLm5hbWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHRhcmdldCBmaWVsZCBpdHNlbGYgYXMgYW4gYXJndW1lbnQgb2YgYSBtb2RpZmllci4nKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgXG4gICAgXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7ICAgICAgICAgICAgXG4gICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdEF3YWl0KGZ1bmN0b3JJZCwgWyBKc0xhbmcuYXN0VmFyUmVmKCd0aGlzJyksIEpzTGFuZy5hc3RWYXJSZWYoJ2NvbnRleHQnKSBdLmNvbmNhdChjYWxsQXJncykpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGxldCBhcmcwID0gdmFsdWU7XG4gICAgICAgIGlmICghaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkgJiYgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJyAmJiB2YWx1ZS5uYW1lLnN0YXJ0c1dpdGgoJ2xhdGVzdC4nKSkge1xuICAgICAgICAgICAgLy9sZXQgZXhpc3RpbmdSZWYgPSAgICAgICAgICAgIFxuICAgICAgICAgICAgYXJnMCA9IEpzTGFuZy5hc3RDb25kaXRpb25hbChcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0Q2FsbCgnbGF0ZXN0Lmhhc093blByb3BlcnR5JywgWyBleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUodmFsdWUubmFtZSkgXSksIC8qKiB0ZXN0ICovXG4gICAgICAgICAgICAgICAgdmFsdWUsIC8qKiBjb25zZXF1ZW50ICovXG4gICAgICAgICAgICAgICAgcmVwbGFjZVZhclJlZlNjb3BlKHZhbHVlLCAnZXhpc3RpbmcnKVxuICAgICAgICAgICAgKTsgIFxuICAgICAgICB9XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoZnVuY3RvcklkLCBbIGFyZzAgXS5jb25jYXQoY2FsbEFyZ3MpKTtcbiAgICB9ICAgIFxuXG4gICAgaWYgKGlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpKSB7XG4gICAgICAgIGxldCB0YXJnZXRWYXJOYW1lID0gdmFsdWUubmFtZTtcbiAgICAgICAgbGV0IG5lZWREZWNsYXJlID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFpc0RvdFNlcGFyYXRlTmFtZSh2YWx1ZS5uYW1lKSAmJiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbdmFsdWUubmFtZV0gJiYgZnVuY3Rvci5vb2xUeXBlICE9PSBPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1IpIHtcbiAgICAgICAgICAgIC8vY29uZmxpY3Qgd2l0aCBleGlzdGluZyB2YXJpYWJsZXMsIG5lZWQgdG8gcmVuYW1lIHRvIGFub3RoZXIgdmFyaWFibGVcbiAgICAgICAgICAgIGxldCBjb3VudGVyID0gMTtcbiAgICAgICAgICAgIGRvIHtcbiAgICAgICAgICAgICAgICBjb3VudGVyKys7ICAgICAgIFxuICAgICAgICAgICAgICAgIHRhcmdldFZhck5hbWUgPSB2YWx1ZS5uYW1lICsgY291bnRlci50b1N0cmluZygpOyAgICAgICAgIFxuICAgICAgICAgICAgfSB3aGlsZSAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzLmhhc093blByb3BlcnR5KHRhcmdldFZhck5hbWUpKTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3RhcmdldFZhck5hbWVdID0geyB0eXBlOiAnbG9jYWxWYXJpYWJsZScsIHNvdXJjZTogJ21vZGlmaWVyJyB9O1xuICAgICAgICAgICAgbmVlZERlY2xhcmUgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9pZiAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzW10pXG5cbiAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIHtcbiAgICAgICAgICAgIHR5cGU6IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdbZnVuY3Rvci5vb2xUeXBlXSxcbiAgICAgICAgICAgIHRhcmdldDogdGFyZ2V0VmFyTmFtZSxcbiAgICAgICAgICAgIHJlZmVyZW5jZXMsICAgLy8gbGF0ZXN0LiwgZXhzaXRpbmcuLCByYXcuXG4gICAgICAgICAgICBuZWVkRGVjbGFyZVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufSAgXG4gICAgICBcbmZ1bmN0aW9uIGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKG9vbEFyZ3MpIHsgICBcbiAgICBvb2xBcmdzID0gXy5jYXN0QXJyYXkob29sQXJncyk7ICAgIFxuXG4gICAgbGV0IHJlZnMgPSBbXTtcblxuICAgIG9vbEFyZ3MuZm9yRWFjaChhID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoYSkpIHtcbiAgICAgICAgICAgIHJlZnMgPSByZWZzLmNvbmNhdChleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhhKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gXG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IGNoZWNrUmVmZXJlbmNlVG9GaWVsZChhKTtcbiAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVmcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiByZWZzO1xufVxuXG5mdW5jdGlvbiBjaGVja1JlZmVyZW5jZVRvRmllbGQob2JqKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvYmopICYmIG9iai5vb2xUeXBlKSB7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSByZXR1cm4gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iai52YWx1ZSk7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmoubmFtZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yVHlwZSwgZnVuY3RvckpzRmlsZSwgbWFwT2ZGdW5jdG9yVG9GaWxlKSB7XG4gICAgaWYgKG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICYmIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICE9PSBmdW5jdG9ySnNGaWxlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3Q6ICR7ZnVuY3RvclR5cGV9IG5hbWluZyBcIiR7ZnVuY3RvcklkfVwiIGNvbmZsaWN0cyFgKTtcbiAgICB9XG4gICAgbWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gPSBmdW5jdG9ySnNGaWxlO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBmdW5jdG9yIGlzIHVzZXItZGVmaW5lZCBvciBidWlsdC1pblxuICogQHBhcmFtIGZ1bmN0b3JcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFyZ3MgLSBVc2VkIHRvIG1ha2UgdXAgdGhlIGZ1bmN0aW9uIHNpZ25hdHVyZVxuICogQHJldHVybnMge3N0cmluZ30gZnVuY3RvciBpZFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgYXJncykge1xuICAgIGxldCBmdW5jdGlvbk5hbWUsIGZpbGVOYW1lLCBmdW5jdG9ySWQ7XG5cbiAgICAvL2V4dHJhY3QgdmFsaWRhdG9yIG5hbWluZyBhbmQgaW1wb3J0IGluZm9ybWF0aW9uXG4gICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGZ1bmN0b3IubmFtZSkpIHtcbiAgICAgICAgbGV0IG5hbWVzID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpO1xuICAgICAgICBpZiAobmFtZXMubGVuZ3RoID4gMikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3Qgc3VwcG9ydGVkIHJlZmVyZW5jZSB0eXBlOiAnICsgZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vcmVmZXJlbmNlIHRvIG90aGVyIGVudGl0eSBmaWxlXG4gICAgICAgIGxldCByZWZFbnRpdHlOYW1lID0gbmFtZXNbMF07XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IG5hbWVzWzFdO1xuICAgICAgICBmaWxlTmFtZSA9ICcuLycgKyBPT0xfTU9ESUZJRVJfUEFUSFtmdW5jdG9yLm9vbFR5cGVdICsgJy8nICsgcmVmRW50aXR5TmFtZSArICctJyArIGZ1bmN0aW9uTmFtZSArICcuanMnO1xuICAgICAgICBmdW5jdG9ySWQgPSByZWZFbnRpdHlOYW1lICsgXy51cHBlckZpcnN0KGZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yLm9vbFR5cGUsIGZpbGVOYW1lLCBjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lID0gZnVuY3Rvci5uYW1lO1xuXG4gICAgICAgIGxldCBidWlsdGlucyA9IE9PTF9NT0RJRklFUl9CVUlMVElOW2Z1bmN0b3Iub29sVHlwZV07XG5cbiAgICAgICAgaWYgKCEoZnVuY3Rpb25OYW1lIGluIGJ1aWx0aW5zKSkge1xuICAgICAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0aW9uTmFtZTtcblxuICAgICAgICAgICAgaWYgKCFjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSkge1xuICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgICBmdW5jdG9yVHlwZTogZnVuY3Rvci5vb2xUeXBlLFxuICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgYXJnc1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0b3Iub29sVHlwZSArICdzLicgKyBmdW5jdGlvbk5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3RvcklkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwaXBlZCB2YWx1ZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFyT29sLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YXJPb2wudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIHZhck9vbC5tb2RpZmllcnMuZm9yRWFjaChtb2RpZmllciA9PiB7XG4gICAgICAgIGxldCBtb2RpZmllclN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArIE9PTF9NT0RJRklFUl9PUFttb2RpZmllci5vb2xUeXBlXSArIG1vZGlmaWVyLm5hbWUpO1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIG1vZGlmaWVyU3RhcnRUb3BvSWQpO1xuXG4gICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlTW9kaWZpZXIoXG4gICAgICAgICAgICBtb2RpZmllclN0YXJ0VG9wb0lkLFxuICAgICAgICAgICAgdmFyT29sLnZhbHVlLFxuICAgICAgICAgICAgbW9kaWZpZXIsXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dFxuICAgICAgICApO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxhc3RUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHZhcmlhYmxlIHJlZmVyZW5jZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBwcmU6IF8uaXNQbGFpbk9iamVjdCh2YXJPb2wpICYmIHZhck9vbC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgIC8vbGV0IFsgYmFzZU5hbWUsIG90aGVycyBdID0gdmFyT29sLm5hbWUuc3BsaXQoJy4nLCAyKTtcbiAgICAvKlxuICAgIGlmIChjb21waWxlQ29udGV4dC5tb2RlbFZhcnMgJiYgY29tcGlsZUNvbnRleHQubW9kZWxWYXJzLmhhcyhiYXNlTmFtZSkgJiYgb3RoZXJzKSB7XG4gICAgICAgIHZhck9vbC5uYW1lID0gYmFzZU5hbWUgKyAnLmRhdGEnICsgJy4nICsgb3RoZXJzO1xuICAgIH0qLyAgICBcblxuICAgIC8vc2ltcGxlIHZhbHVlXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YXJPb2wpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBHZXQgYW4gYXJyYXkgb2YgcGFyYW1ldGVyIG5hbWVzLlxuICogQHBhcmFtIHthcnJheX0gYXJncyAtIEFuIGFycmF5IG9mIGFyZ3VtZW50cyBpbiBvb2wgc3ludGF4XG4gKiBAcmV0dXJucyB7YXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKGFyZ3MpIHtcbiAgICBpZiAoXy5pc0VtcHR5KGFyZ3MpKSByZXR1cm4gW107XG5cbiAgICBsZXQgbmFtZXMgPSBuZXcgU2V0KCk7XG5cbiAgICBmdW5jdGlvbiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFyZykpIHtcbiAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLnZhbHVlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoYXJnLm5hbWUpLnBvcCgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFyZy5uYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICdwYXJhbScgKyAoaSArIDEpLnRvU3RyaW5nKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIF8ubWFwKGFyZ3MsIChhcmcsIGkpID0+IHtcbiAgICAgICAgbGV0IGJhc2VOYW1lID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcsIGkpO1xuICAgICAgICBsZXQgbmFtZSA9IGJhc2VOYW1lO1xuICAgICAgICBsZXQgY291bnQgPSAyO1xuICAgICAgICBcbiAgICAgICAgd2hpbGUgKG5hbWVzLmhhcyhuYW1lKSkge1xuICAgICAgICAgICAgbmFtZSA9IGJhc2VOYW1lICsgY291bnQudG9TdHJpbmcoKTtcbiAgICAgICAgICAgIGNvdW50Kys7XG4gICAgICAgIH1cblxuICAgICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICAgIHJldHVybiBuYW1lOyAgICAgICAgXG4gICAgfSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmNyZXRlIHZhbHVlIGV4cHJlc3Npb24gZnJvbSBvb2wgdG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB2YWx1ZSAtIE9vbCBub2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgbGV0IFsgcmVmQmFzZSwgLi4ucmVzdCBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZSh2YWx1ZS5uYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlcGVuZGVuY3k7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIHVuZGVmaW5lZCB2YXJpYWJsZTogJHt2YWx1ZS5uYW1lfWApOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGlmIChjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0udHlwZSA9PT0gJ2VudGl0eScgJiYgIWNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXS5vbmdvaW5nKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2U7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlZkJhc2UgPT09ICdsYXRlc3QnICYmIHJlc3QubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIC8vbGF0ZXN0LnBhc3N3b3JkXG4gICAgICAgICAgICAgICAgbGV0IHJlZkZpZWxkTmFtZSA9IHJlc3QucG9wKCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlZkZpZWxkTmFtZSAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkZpZWxkTmFtZSArICc6cmVhZHknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0VtcHR5KHJlc3QpKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2UgKyAnOnJlYWR5JztcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGlmIChkZXBlbmRlbmN5KSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1JlZ0V4cCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSkpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZSA9IF8ubWFwVmFsdWVzKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGtleSkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJy4nICsga2V5KTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICB2YWx1ZSA9IF8ubWFwKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGluZGV4KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnWycgKyBpbmRleCArICddJyk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgIGlmIChuYW1lID09PSAnTk9XJykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgIFwiY2FsbGVlXCI6IHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgXCJjb21wdXRlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBcIm9iamVjdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgXCJjb21wdXRlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgXCJvYmplY3RcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJjb21wdXRlZFwiOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwib2JqZWN0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwiVHlwZXNcIlxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwicHJvcGVydHlcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJEQVRFVElNRVwiXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIFwicHJvcGVydHlcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwidHlwZU9iamVjdFwiXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIFwicHJvcGVydHlcIjoge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcImxvY2FsXCJcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgXCJhcmd1bWVudHNcIjogW11cbiAgICAgICAgfTtcbiAgICB9IFxuICAgIFxuICAgIHRocm93IG5ldyBFcnJvcignbm90IHN1cHBvcnQ6ICcgKyBuYW1lKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYW4gYXJyYXkgb2YgZnVuY3Rpb24gYXJndW1lbnRzIGZyb20gb29sIGludG8gYXN0LlxuICogQHBhcmFtIHRvcG9JZCAtIFRoZSBtb2RpZmllciBmdW5jdGlvbiB0b3BvIFxuICogQHBhcmFtIGFyZ3MgLSBcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dCAtIFxuICogQHJldHVybnMge0FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgYXJncywgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhcmdzID0gXy5jYXN0QXJyYXkoYXJncyk7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IGNhbGxBcmdzID0gW107XG5cbiAgICBfLmVhY2goYXJncywgKGFyZywgaSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgbGV0IGFyZ1RvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzphcmdbJyArIChpKzEpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihhcmdUb3BvSWQsIGFyZywgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgdG9wb0lkKTtcblxuICAgICAgICBjYWxsQXJncyA9IGNhbGxBcmdzLmNvbmNhdChfLmNhc3RBcnJheShnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCkpKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBjYWxsQXJncztcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGFyYW0gb2YgaW50ZXJmYWNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0gaW5kZXhcbiAqIEBwYXJhbSBwYXJhbVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlUGFyYW0oaW5kZXgsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB0eXBlID0gcGFyYW0udHlwZTsgICAgXG5cbiAgICBsZXQgdHlwZU9iamVjdCA9IFR5cGVzW3R5cGVdO1xuXG4gICAgaWYgKCF0eXBlT2JqZWN0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBmaWVsZCB0eXBlOiAnICsgdHlwZSk7XG4gICAgfVxuXG4gICAgbGV0IHNhbml0aXplck5hbWUgPSBgVHlwZXMuJHt0eXBlLnRvVXBwZXJDYXNlKCl9LnNhbml0aXplYDtcblxuICAgIGxldCB2YXJSZWYgPSBKc0xhbmcuYXN0VmFyUmVmKHBhcmFtLm5hbWUpO1xuICAgIGxldCBjYWxsQXN0ID0gSnNMYW5nLmFzdENhbGwoc2FuaXRpemVyTmFtZSwgW3ZhclJlZiwgSnNMYW5nLmFzdEFycmF5QWNjZXNzKCckbWV0YS5wYXJhbXMnLCBpbmRleCksIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMuZGIuaTE4bicpXSk7XG5cbiAgICBsZXQgcHJlcGFyZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRwYXJhbXM6c2FuaXRpemVbJyArIGluZGV4LnRvU3RyaW5nKCkgKyAnXScpO1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmc7XG5cbiAgICAvL2lmIChpbmRleCA9PT0gMCkge1xuICAgICAgICAvL2RlY2xhcmUgJHNhbml0aXplU3RhdGUgdmFyaWFibGUgZm9yIHRoZSBmaXJzdCB0aW1lXG4gICAgLy8gICAgc2FuaXRpemVTdGFydGluZyA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhclJlZiwgY2FsbEFzdCwgZmFsc2UsIGZhbHNlLCBgU2FuaXRpemUgcGFyYW0gXCIke3BhcmFtLm5hbWV9XCJgKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZyA9IDtcblxuICAgICAgICAvL2xldCBsYXN0UHJlcGFyZVRvcG9JZCA9ICckcGFyYW1zOnNhbml0aXplWycgKyAoaW5kZXggLSAxKS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAvL2RlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFByZXBhcmVUb3BvSWQsIHByZXBhcmVUb3BvSWQpO1xuICAgIC8vfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3ByZXBhcmVUb3BvSWRdID0gW1xuICAgICAgICBKc0xhbmcuYXN0QXNzaWduKHZhclJlZiwgY2FsbEFzdCwgYFNhbml0aXplIGFyZ3VtZW50IFwiJHtwYXJhbS5uYW1lfVwiYClcbiAgICBdO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkVcbiAgICB9KTtcblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQpO1xuXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW0ubmFtZSk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdG9wb0lkKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShwYXJhbS5uYW1lLCBwYXJhbSk7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSh0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RlbCBmaWVsZCBwcmVwcm9jZXNzIGluZm9ybWF0aW9uIGludG8gYXN0LlxuICogQHBhcmFtIHtvYmplY3R9IHBhcmFtIC0gRmllbGQgaW5mb3JtYXRpb25cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaWVsZChwYXJhbU5hbWUsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIC8vIDEuIHJlZmVyZW5jZSB0byB0aGUgbGF0ZXN0IG9iamVjdCB0aGF0IGlzIHBhc3NlZCBxdWFsaWZpZXIgY2hlY2tzXG4gICAgLy8gMi4gaWYgbW9kaWZpZXJzIGV4aXN0LCB3cmFwIHRoZSByZWYgaW50byBhIHBpcGVkIHZhbHVlXG4gICAgLy8gMy4gcHJvY2VzcyB0aGUgcmVmIChvciBwaXBlZCByZWYpIGFuZCBtYXJrIGFzIGVuZFxuICAgIC8vIDQuIGJ1aWxkIGRlcGVuZGVuY2llczogbGF0ZXN0LmZpZWxkIC0+IC4uLiAtPiBmaWVsZDpyZWFkeSBcbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbU5hbWUpO1xuICAgIGxldCBjb250ZXh0TmFtZSA9ICdsYXRlc3QuJyArIHBhcmFtTmFtZTtcbiAgICAvL2NvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdFZhclJlZihjb250ZXh0TmFtZSwgdHJ1ZSk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UoY29udGV4dE5hbWUsIHBhcmFtKTsgICAgXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbih0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG5mdW5jdGlvbiB3cmFwUGFyYW1SZWZlcmVuY2UobmFtZSwgdmFsdWUpIHtcbiAgICBsZXQgcmVmID0gT2JqZWN0LmFzc2lnbih7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBuYW1lIH0pO1xuICAgIFxuICAgIGlmICghXy5pc0VtcHR5KHZhbHVlLm1vZGlmaWVycykpIHtcbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ1BpcGVkVmFsdWUnLCB2YWx1ZTogcmVmLCBtb2RpZmllcnM6IHZhbHVlLm1vZGlmaWVycyB9O1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gcmVmO1xufVxuXG5mdW5jdGlvbiBoYXNNb2RlbEZpZWxkKG9wZXJhbmQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcGVyYW5kKSAmJiBvcGVyYW5kLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgIGxldCBbIGJhc2VWYXIsIC4uLnJlc3QgXSA9IG9wZXJhbmQubmFtZS5zcGxpdCgnLicpO1xuXG4gICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbYmFzZVZhcl0gJiYgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW2Jhc2VWYXJdLm9uZ29pbmcgJiYgcmVzdC5sZW5ndGggPiAwOyAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlOyAgICBcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSB0aGVuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdCBpbiByZXR1cm4gYmxvY2suXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRJZFxuICogQHBhcmFtIHtzdHJpbmd9IGVuZElkXG4gKiBAcGFyYW0gdGhlblxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblRoZW5Bc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVGhyb3dFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZ3M7XG4gICAgICAgICAgICBpZiAodGhlbi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IHRyYW5zbGF0ZUFyZ3Moc3RhcnRJZCwgdGhlbi5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0VGhyb3codGhlbi5lcnJvclR5cGUgfHwgZGVmYXVsdEVycm9yLCB0aGVuLm1lc3NhZ2UgfHwgYXJncyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydElkLCBlbmRJZCwgdGhlbi52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICAvL3RoZW4gZXhwcmVzc2lvbiBpcyBhbiBvb2xvbmcgY29uY3JldGUgdmFsdWUgICAgXG4gICAgaWYgKF8uaXNBcnJheSh0aGVuKSB8fCBfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgbGV0IHZhbHVlRW5kSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpOyAgICBcbiAgICAgICAgdGhlbiA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2YWx1ZUVuZElkXTsgXG4gICAgfSAgIFxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4odGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgdGhlbiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydElkXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kSWRcbiAqIEBwYXJhbSB0aGVuXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhc3NpZ25Ub1xuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVUaGVuQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLCBjb21waWxlQ29udGV4dCwgYXNzaWduVG8pIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdUaHJvd0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJncztcbiAgICAgICAgICAgIGlmICh0aGVuLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gdHJhbnNsYXRlQXJncyhzdGFydElkLCB0aGVuLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBhcmdzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICBzd2l0Y2ggKHRoZW4ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAoIWhhc01vZGVsRmllbGQodGhlbi5sZWZ0LCBjb21waWxlQ29udGV4dCkpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHF1ZXJ5IGNvbmRpdGlvbjogdGhlIGxlZnQgb3BlcmFuZCBuZWVkIHRvIGJlIGFuIGVudGl0eSBmaWVsZC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGhhc01vZGVsRmllbGQodGhlbi5yaWdodCwgY29tcGlsZUNvbnRleHQpKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBxdWVyeSBjb25kaXRpb246IHRoZSByaWdodCBvcGVyYW5kIHNob3VsZCBub3QgYmUgYW4gZW50aXR5IGZpZWxkLiBVc2UgZGF0YXNldCBpbnN0ZWFkIGlmIGpvaW5pbmcgaXMgcmVxdWlyZWQuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7fTtcbiAgICAgICAgICAgIGxldCBzdGFydFJpZ2h0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0SWQgKyAnJGJpbk9wOnJpZ2h0Jyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0SWQsIHN0YXJ0UmlnaHRJZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFJpZ2h0SWQsIHRoZW4ucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZElkKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHRoZW4ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb25bdGhlbi5sZWZ0Lm5hbWUuc3BsaXQoJy4nLCAyKVsxXV0gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbbGFzdFJpZ2h0SWRdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb25bdGhlbi5sZWZ0Lm5hbWUuc3BsaXQoJy4nLCAyKVsxXV0gPSB7IFtPUEVSQVRPUl9UT0tFTltvcF1dOiBjb21waWxlQ29udGV4dC5hc3RNYXBbbGFzdFJpZ2h0SWRdIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0QXNzaWduKGFzc2lnblRvLCBKc0xhbmcuYXN0VmFsdWUoY29uZGl0aW9uKSk7ICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vdGhlbiBleHByZXNzaW9uIGlzIGFuIG9vbG9uZyBjb25jcmV0ZSB2YWx1ZSAgICBcbiAgICBpZiAoXy5pc0FycmF5KHRoZW4pIHx8IF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBsZXQgdmFsdWVFbmRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydElkLCB0aGVuLCBjb21waWxlQ29udGV4dCk7ICAgIFxuICAgICAgICB0aGVuID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZhbHVlRW5kSWRdOyBcbiAgICB9ICAgXG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdEFzc2lnbihhc3NpZ25UbywgdGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgZW5kaW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB2YWx1ZVRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICBpZiAodmFsdWVUb3BvSWQgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdmFsdWVUb3BvSWQsIGVuZFRvcG9JZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4oZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YodmFsdWVUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVJldHVybihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19WSUVXX1JFVFVSTlxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgZmluZCBvbmUgb3BlcmF0aW9uIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge2ludH0gaW5kZXhcbiAqIEBwYXJhbSB7b2JqZWN0fSBvcGVyYXRpb24gLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC1cbiAqIEBwYXJhbSB7c3RyaW5nfSBkZXBlbmRlbmN5XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIHByZTogZGVwZW5kZW5jeTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICdvcCQnICsgaW5kZXgudG9TdHJpbmcoKSk7XG4gICAgbGV0IGNvbmRpdGlvblZhck5hbWUgPSBlbmRUb3BvSWQgKyAnJGNvbmRpdGlvbic7XG5cbiAgICBsZXQgYXN0ID0gW1xuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShjb25kaXRpb25WYXJOYW1lKVxuICAgIF07XG5cbiAgICBhc3NlcnQ6IG9wZXJhdGlvbi5jb25kaXRpb247XG5cbiAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbb3BlcmF0aW9uLm1vZGVsXSA9IHsgdHlwZTogJ2VudGl0eScsIHNvdXJjZTogJ2ZpbmRPbmUnLCBvbmdvaW5nOiB0cnVlIH07XG5cbiAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIC8vc3BlY2lhbCBjb25kaXRpb25cblxuICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlID09PSAnY2FzZXMnKSB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkUHJlZml4ID0gZW5kVG9wb0lkICsgJyRjYXNlcyc7XG4gICAgICAgICAgICBsZXQgbGFzdFN0YXRlbWVudDtcblxuICAgICAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSkge1xuICAgICAgICAgICAgICAgIGxldCBlbHNlU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZWxzZScpO1xuICAgICAgICAgICAgICAgIGxldCBlbHNlRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZVN0YXJ0LCBlbHNlRW5kKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VFbmQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gdHJhbnNsYXRlVGhlbkFzdChlbHNlU3RhcnQsIGVsc2VFbmQsIG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gSnNMYW5nLmFzdFRocm93KCdTZXJ2ZXJFcnJvcicsICdVbmV4cGVjdGVkIHN0YXRlLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdNaXNzaW5nIGNhc2UgaXRlbXMnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgXy5yZXZlcnNlKG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBjYXNlIGl0ZW0uJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaSA9IG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMubGVuZ3RoIC0gaSAtIDE7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVByZWZpeCA9IHRvcG9JZFByZWZpeCArICdbJyArIGkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgICAgICAgICBsZXQgY2FzZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBjYXNlVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUmVzdWx0VmFyTmFtZSA9ICckJyArIHRvcG9JZFByZWZpeCArICdfJyArIGkudG9TdHJpbmcoKTtcblxuICAgICAgICAgICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbihpdGVtLnRlc3QsIGNvbXBpbGVDb250ZXh0LCBjYXNlVG9wb0lkKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FzZVR0ZW0gPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGFzdENhc2VUdGVtKSwgJ0ludmFsaWQgY2FzZSBpdGVtIGFzdC4nO1xuXG4gICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0gPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShjYXNlUmVzdWx0VmFyTmFtZSwgYXN0Q2FzZVR0ZW0sIHRydWUsIGZhbHNlLCBgQ29uZGl0aW9uICR7aX0gZm9yIGZpbmQgb25lICR7b3BlcmF0aW9uLm1vZGVsfWApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGlmU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBsZXQgaWZFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgaWZTdGFydCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZlN0YXJ0LCBpZkVuZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gW1xuICAgICAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdElmKEpzTGFuZy5hc3RWYXJSZWYoY2FzZVJlc3VsdFZhck5hbWUpLCBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlVGhlbkFzdChpZlN0YXJ0LCBpZkVuZCwgaXRlbS50aGVuLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSkpLCBsYXN0U3RhdGVtZW50KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZkVuZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhc3QgPSBhc3QuY29uY2F0KF8uY2FzdEFycmF5KGxhc3RTdGF0ZW1lbnQpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbycpO1xuICAgICAgICB9XG5cblxuICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbycpO1xuICAgIH1cblxuICAgIGFzdC5wdXNoKFxuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShvcGVyYXRpb24ubW9kZWwsIEpzTGFuZy5hc3RBd2FpdChgdGhpcy5maW5kT25lX2AsIEpzTGFuZy5hc3RWYXJSZWYoY29uZGl0aW9uVmFyTmFtZSkpKVxuICAgICk7XG5cbiAgICBkZWxldGUgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW29wZXJhdGlvbi5tb2RlbF0ub25nb2luZztcblxuICAgIGxldCBtb2RlbFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgb3BlcmF0aW9uLm1vZGVsKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgbW9kZWxUb3BvSWQpO1xuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gYXN0O1xuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBpbGVEYk9wZXJhdGlvbihpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIGxldCBsYXN0VG9wb0lkO1xuXG4gICAgc3dpdGNoIChvcGVyYXRpb24ub29sVHlwZSkge1xuICAgICAgICBjYXNlICdGaW5kT25lU3RhdGVtZW50JzpcbiAgICAgICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdmaW5kJzpcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnY3JlYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZGVsZXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnRG9TdGF0ZW1lbnQnOlxuICAgICAgICAgICAgbGV0IGRvQmxvY2sgPSBvcGVyYXRpb24uZG87XG4gICAgICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZURvU3RhdGVtZW50KGluZGV4LCBkb0Jsb2NrLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdhc3NpZ25tZW50JzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBvcGVyYXRpb24gdHlwZTogJyArIG9wZXJhdGlvbi50eXBlKTtcbiAgICB9XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OXG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGFzdFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY29tcGlsZURvU3RhdGVtZW50KGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgICAgIFxufVxuXG4vKipcbiAqIENvbXBpbGUgZXhjZXB0aW9uYWwgcmV0dXJuIFxuICogQHBhcmFtIHtvYmplY3R9IG9vbE5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXBlbmRlbmN5XVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG9vbE5vZGUsIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiAoXy5pc1BsYWluT2JqZWN0KG9vbE5vZGUpICYmIG9vbE5vZGUub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyksIGxhc3RFeGNlcHRpb25JZCA9IGRlcGVuZGVuY3k7XG5cbiAgICBpZiAoIV8uaXNFbXB0eShvb2xOb2RlLmV4Y2VwdGlvbnMpKSB7XG4gICAgICAgIG9vbE5vZGUuZXhjZXB0aW9ucy5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGV4Y2VwdGlvbmFsIHR5cGU6ICcgKyBpdGVtLm9vbFR5cGUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uRW5kSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXTpkb25lJyk7XG4gICAgICAgICAgICAgICAgaWYgKGxhc3RFeGNlcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZXhjZXB0aW9uU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRoZW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0aGVuU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0aGVuU3RhcnRJZCwgZXhjZXB0aW9uRW5kSWQpO1xuXG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2V4Y2VwdGlvbkVuZElkXSA9IEpzTGFuZy5hc3RJZihcbiAgICAgICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlUmV0dXJuVGhlbkFzdChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoZW5TdGFydElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgZXhjZXB0aW9uRW5kSWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0KSksXG4gICAgICAgICAgICAgICAgICAgIG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGBSZXR1cm4gb24gZXhjZXB0aW9uICMke2l9YFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvbkVuZElkLCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IEFTVF9CTEtfRVhDRVBUSU9OX0lURU1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGxhc3RFeGNlcHRpb25JZCA9IGV4Y2VwdGlvbkVuZElkO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBlbmRUb3BvSWQpO1xuXG4gICAgbGV0IHJldHVyblN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIG9vbE5vZGUudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTlxuICAgIH0pO1xuICAgIFxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgbmFtZSkge1xuICAgIGlmIChjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7bmFtZX1cIiBhbHJlYWR5IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgYXNzZXJ0OiAhY29tcGlsZUNvbnRleHQudG9wb1NvcnQuaGFzRGVwZW5kZW5jeShuYW1lKSwgJ0FscmVhZHkgaW4gdG9wb1NvcnQhJztcblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5hZGQobmFtZSk7XG5cbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmV2aW91c09wLCBjdXJyZW50T3ApIHtcbiAgICBwcmU6IHByZXZpb3VzT3AgIT09IGN1cnJlbnRPcCwgJ1NlbGYgZGVwZW5kaW5nJztcblxuICAgIGNvbXBpbGVDb250ZXh0Lmxpbmtlci5sb2coJ2RlYnVnJywgY3VycmVudE9wICsgJyBcXHgxYlszM21kZXBlbmRzIG9uXFx4MWJbMG0gJyArIHByZXZpb3VzT3ApO1xuXG4gICAgaWYgKCFjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKGN1cnJlbnRPcCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtjdXJyZW50T3B9XCIgbm90IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb1NvcnQuYWRkKHByZXZpb3VzT3AsIGN1cnJlbnRPcCk7XG59XG5cbmZ1bmN0aW9uIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdG9wb0lkLCBibG9ja01ldGEpIHtcbiAgICBpZiAoISh0b3BvSWQgaW4gY29tcGlsZUNvbnRleHQuYXN0TWFwKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFTVCBub3QgZm91bmQgZm9yIGJsb2NrIHdpdGggdG9wb0lkOiAke3RvcG9JZH1gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLnNldCh0b3BvSWQsIGJsb2NrTWV0YSk7XG5cbiAgICBjb21waWxlQ29udGV4dC5saW5rZXIubG9nKCd2ZXJib3NlJywgYEFkZGluZyAke2Jsb2NrTWV0YS50eXBlfSBcIiR7dG9wb0lkfVwiIGludG8gc291cmNlIGNvZGUuYCk7ICAgIFxufVxuXG5mdW5jdGlvbiBnZXRDb2RlUmVwcmVzZW50YXRpb25PZih0b3BvSWQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGxhc3RTb3VyY2VUeXBlID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQodG9wb0lkKTtcblxuICAgIGlmIChsYXN0U291cmNlVHlwZSAmJiAobGFzdFNvdXJjZVR5cGUudHlwZSA9PT0gQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCB8fCBsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX0FDVElWQVRPUl9DQUxMKSkge1xuICAgICAgICAvL2ZvciBtb2RpZmllciwganVzdCB1c2UgdGhlIGZpbmFsIHJlc3VsdFxuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFZhclJlZihsYXN0U291cmNlVHlwZS50YXJnZXQsIHRydWUpO1xuICAgIH1cblxuICAgIGxldCBhc3QgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXTtcbiAgICBpZiAoYXN0LnR5cGUgPT09ICdNZW1iZXJFeHByZXNzaW9uJyAmJiBhc3Qub2JqZWN0Lm5hbWUgPT09ICdsYXRlc3QnKSB7XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICBKc0xhbmcuYXN0Q2FsbCgnbGF0ZXN0Lmhhc093blByb3BlcnR5JywgWyBhc3QucHJvcGVydHkudmFsdWUgXSksIC8qKiB0ZXN0ICovXG4gICAgICAgICAgICBhc3QsIC8qKiBjb25zZXF1ZW50ICovXG4gICAgICAgICAgICB7IC4uLmFzdCwgb2JqZWN0OiB7IC4uLmFzdC5vYmplY3QsIG5hbWU6ICdleGlzdGluZycgfSB9XG4gICAgICAgICk7ICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVDb21waWxlQ29udGV4dChtb2R1bGVOYW1lLCBsaW5rZXIsIHNoYXJlZENvbnRleHQpIHtcbiAgICBsZXQgY29tcGlsZUNvbnRleHQgPSB7XG4gICAgICAgIG1vZHVsZU5hbWUsICAgICAgICBcbiAgICAgICAgbGlua2VyLFxuICAgICAgICB2YXJpYWJsZXM6IHt9LFxuICAgICAgICB0b3BvTm9kZXM6IG5ldyBTZXQoKSxcbiAgICAgICAgdG9wb1NvcnQ6IG5ldyBUb3BvU29ydCgpLFxuICAgICAgICBhc3RNYXA6IHt9LCAvLyBTdG9yZSB0aGUgQVNUIGZvciBhIG5vZGVcbiAgICAgICAgbWFwT2ZUb2tlblRvTWV0YTogbmV3IE1hcCgpLCAvLyBTdG9yZSB0aGUgc291cmNlIGNvZGUgYmxvY2sgcG9pbnRcbiAgICAgICAgbW9kZWxWYXJzOiBuZXcgU2V0KCksXG4gICAgICAgIG1hcE9mRnVuY3RvclRvRmlsZTogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpIHx8IHt9LCAvLyBVc2UgdG8gcmVjb3JkIGltcG9ydCBsaW5lc1xuICAgICAgICBuZXdGdW5jdG9yRmlsZXM6IChzaGFyZWRDb250ZXh0ICYmIHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzKSB8fCBbXVxuICAgIH07XG5cbiAgICBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRtYWluJyk7XG5cbiAgICBsaW5rZXIubG9nKCd2ZXJib3NlJywgYENyZWF0ZWQgY29tcGlsYXRpb24gY29udGV4dCBmb3IgXCIke21vZHVsZU5hbWV9XCIuYCk7XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQ7XG59XG5cbmZ1bmN0aW9uIGlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpIHtcbiAgICByZXR1cm4gdG9wb0lkLmluZGV4T2YoJzphcmdbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckY2FzZXNbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckZXhjZXB0aW9uc1snKSA9PT0gLTE7XG59XG5cbmZ1bmN0aW9uIHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYsIHRhcmdldFNjb3BlKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YXJSZWYpKSB7XG4gICAgICAgIGFzc2VydDogdmFyUmVmLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnO1xuXG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLm5hbWUsIHRhcmdldFNjb3BlKSB9OyAgICAgICAgXG4gICAgfSBcblxuICAgIGFzc2VydDogdHlwZW9mIHZhclJlZiA9PT0gJ3N0cmluZyc7XG5cbiAgICBsZXQgcGFydHMgPSB2YXJSZWYuc3BsaXQoJy4nKTtcbiAgICBhc3NlcnQ6IHBhcnRzLmxlbmd0aCA+IDE7XG5cbiAgICBwYXJ0cy5zcGxpY2UoMCwgMSwgdGFyZ2V0U2NvcGUpO1xuICAgIHJldHVybiBwYXJ0cy5qb2luKCcuJyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIGNvbXBpbGVQYXJhbSxcbiAgICBjb21waWxlRmllbGQsXG4gICAgY29tcGlsZURiT3BlcmF0aW9uLFxuICAgIGNvbXBpbGVFeGNlcHRpb25hbFJldHVybixcbiAgICBjb21waWxlUmV0dXJuLFxuICAgIGNyZWF0ZVRvcG9JZCxcbiAgICBjcmVhdGVDb21waWxlQ29udGV4dCxcbiAgICBkZXBlbmRzT24sXG4gICAgYWRkQ29kZUJsb2NrLFxuXG4gICAgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyxcbiAgICBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIEFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfVklFV19SRVRVUk4sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiwgXG4gICAgQVNUX0JMS19FWENFUFRJT05fSVRFTSxcblxuICAgIE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdcbn07Il19