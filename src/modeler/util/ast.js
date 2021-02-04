"use strict";

/**
 * @module
 * @ignore
 */

const { _ } = require('rk-utils');
const escodegen = require('escodegen');
const esprima = require('esprima');

const AST_OBJECT_TYPES = [
    'ThisExpression',
    'MemberExpression',
    'BinaryExpression',
    'UnaryExpression',
    'ArrowFunctionExpression',
    'FunctionExpression',
    'ArrayExpression',
    'ObjectExpression',
    'CallExpression',
    'YieldExpression',
    'AwaitExpression',
    'AssignmentExpression',
    'Literal',
    'Identifier'
];

function astParams(params) {
    params = Array.isArray(params) ? params : [ params ];

    return params.map(p => {
         if (typeof p === 'string') {
             return astId(p);
         }

        if (_.isPlainObject(p)) {
            if (p.type === 'Identifier' || p.type === 'AssignmentPattern') {
                return p;
            }

            if (p.oolType === 'Parameter') {
                if (p.defaultValue) {
                    return {
                        "type": "AssignmentPattern",
                        "left": {
                            "type": "Identifier",
                            "name": p.name
                        },
                        "right": astLiteral(p.defaultValue)
                    };
                }

                return astId(p.name);
            }
        }

        throw new Error('Invalid param: ' + JSON.stringify(p));
    });
}

function mapArgs(args) {
    args = Array.isArray(args) ? args : [ args ];

    if (_.isEmpty(args)) return [];

    return args.map(a => {
        if (_.isPlainObject(a) && 'type' in a) {
            return a;
        }

        return astValue(a);
    });
}

function mapBody(body) {
    if (Array.isArray(body)) {
        return astBlock(body);
    }
    
    if (_.isPlainObject(body) && 'type' in body) {
        return body;
    }

    return astValue(body);
}

function astProgram(strict = true) {
    return {
        "type": "Program",
        "body": strict ? [astExpression(astValue('use strict'))] : [],
        "sourceType": "script"
    };
}

function astRequire(varName, requirePath, isObjDestruct = false) {
    return {
        "type": "VariableDeclaration",
        "declarations": [
            {
                "type": "VariableDeclarator",
                "id": isObjDestruct ? astObjPat(varName) : astId(varName),
                "init": astCall('require', [ astValue(requirePath) ])
            }
        ],
        "kind": "const"
    };
}

function astLeadingComments(comment, type = 'Line') {
    return comment ? { "leadingComments": [
        {
            "type": type,
            "value": comment,
            "range": [
                1,
                comment.length+3
            ]
        }
    ]} : {};
}

function astVarDeclare(left, right, isConstant = false, isObjDestruct = false, comment = false) {
    return {
        "type": "VariableDeclaration",
        "declarations": [
            {
                "type": "VariableDeclarator",
                "id": isObjDestruct ? astObjPat(left) : astId(left),
                "init": _.isNil(right) ? null : astValue(right)
            }
        ],
        "kind": isConstant ? "const" : "let",
        ...astLeadingComments(comment)
    };
}

function astClassDeclare(className, superClassName, body, comment = false) {
    let ast = {
        "type": "ClassDeclaration",
        "id": astId(className),
        ...(comment ? astLeadingComments(`*\n * ${comment}\n * @class\n `, 'Block') : {})
    };

    if (superClassName) {
        ast['superClass'] = astId(superClassName);
    }

    ast['body'] = {
        "type": "ClassBody",
        "body": body ? (Array.isArray(body) ? body : [ body ]) : []
    };

    return ast;
}

function astMemberMethod(name, params, body, generator = false, async = false, isStatic = false, comment = false) {
    return {
        "type": "MethodDefinition",
        "key": astId(name),
        "computed": false,
        "value": astAnonymousFunction(params, body, generator, async),
        "kind": "method",
        "static": isStatic,
        //"*\n * \n * @param identity\n * @param password\n * @returns {*}\n "
        ...(comment ? astLeadingComments(`*\n * ${comment}${params.map(p => `\n * @param ${p}`).join('')}${Array.isArray(body) && _.last(body).type === 'ReturnStatement' ? '\n * @returns {*}' : ''}\n `, 'Block') : {})
    };
}

function astIf(test, consequent, alternate, comment = false) {
    return {
        "type": "IfStatement",
        "test": astValue(test),
        "consequent": mapBody(consequent),
        "alternate": _.isNil(alternate) ? null : mapBody(alternate),
        ...astLeadingComments(comment)
    };
}

function astBinExp(left, operator, right) {
    return {
        "type": "BinaryExpression",
        "operator": operator,
        "left": astValue(left),
        "right": astValue(right)
    }
}

function astLogicalExp(left, operator, right) {
    return {
        "type": "LogicalExpression",
        "operator": operator,
        "left": astValue(left),
        "right": astValue(right)
    }
}

function astCall(functionName, args) {
    return {
        "type": "CallExpression",
        "callee": _.isPlainObject(functionName) ? functionName : astVarRef(functionName),
        "arguments": mapArgs(args)
    };
}

function astYield(target, delegate = false) {
    return {
        "type": "YieldExpression",
        "argument": target,
        "delegate": delegate
    };
}

function astAwait(functionName, args) {
    return {
        "type": "AwaitExpression",
        "argument": astCall(functionName, args)
    };
}

function astArrayAccess(name, index) {
    return {
        "type": "MemberExpression",
        "computed": true,
        "object": astVarRef(name),
        "property": {
            "type": "Literal",
            "value": index,
            "raw": `${index}`
        }
    }
}

function astVarRef(name, elementStyle = false) {
    if (_.isPlainObject(name)) {
        if (name.type === 'MemberExpression' || name.type === 'Identifier') {
            return name;
        }

        if (name.oolType === 'ObjectReference') {
            return astVarRef(name.name, elementStyle);
        }

        throw new Error('Invalid reference: ' + JSON.stringify(name));
    }

    let p = name.split('.');
    if (p.length > 1) {
        //p.reverse();
        let result = {
            "type": "MemberExpression",
            "computed": elementStyle,
            "property": elementStyle ? astLiteral(p.pop()) : astId(p.pop())
        };

        let last = result;

        while (p.length > 1) {
            last["object"] = {
                "type": "MemberExpression",
                "computed": elementStyle,
                "property": elementStyle ? astLiteral(p.pop()) : astId(p.pop())
            };

            last = last["object"];
        }

        last["object"] = p[0] === 'this' 
            ? astThis()
            : astId(p[0]);

        return result;
    } else {
        return astId(name);
    }
}

function astThis() {
    return { "type": "ThisExpression" };
}

function astId(name) {
    if (typeof name === 'string') {
        return {
            "type": "Identifier",
            "name": name
        };
    } else if (_.isPlainObject(name) && name.type === 'Identifier') {
        return name;
    }

    throw new Error('Invalid identifier name: ' + JSON.stringify(name));
}

function astObjPat(keys) {
    return {
        "type": "ObjectPattern",
        "properties": _.map(keys, (k) => ({
            "type": "Property",
            "key": astId(k),
            "computed": false,
            "value": astId(k),
            "kind": "init",
            "method": false,
            "shorthand": true
        }))
    };
}

function astMember(key, any, shorthand = false) {
    return {
        "type": "Property",
        "key": astId(key),
        "computed": false,
        "value": any,
        "kind": "init",
        "method": false,
        "shorthand": shorthand
    };
}

function astValue(value) {
    if (Array.isArray(value)) {
        return {
            "type": "ArrayExpression",
            "elements": _.map(value, e => astValue(e))
        };
    }

    if (_.isPlainObject(value)) {
        if (AST_OBJECT_TYPES.indexOf(value.type) !== -1) {
            return value;
        }

        if (value.oolType === 'ObjectReference') {
            return astVarRef(value.name, true);
        }

        if (value.oolType === 'RegExp') {
            let [ literal ] = esprima.tokenize(value.value);
            return {
                "type": "NewExpression",
                "callee": {
                    "type": "Identifier",
                    "name": "RegExp"
                },
                "arguments": [
                    astLiteral(literal.regex.pattern),
                    ...(literal.regex.flags ? [ astLiteral(literal.regex.flags) ] : [])
                ]
            };
        }

        let props = [];

        _.forOwn(value, (any, key) => {
            props.push(astMember(key, astValue(any)));
        });

        return {
            "type": "ObjectExpression",
            "properties": props
        };
    }

    if (_.isObject(value)) {
        throw new Error('Only plain object supported. Given: ' + JSON.stringify(value));
    }

    return astLiteral(value);
}

function astLiteral(value) {
    return {
        "type": "Literal",
        "value": value,
        "raw": JSON.stringify(value)
    };
}

function astAddMember(obj, member) {
    obj.properties.push(member);
}

function astPushInBody(obj, expr) {
    if (Array.isArray(obj.body)) {
        obj.body = obj.body.concat(_.castArray(expr));
    } else {
        obj.body.body = obj.body.body.concat(_.castArray(expr));
    }
}

function astFunction(name, params, body, generator = false, async = false) {
    return {
        "type": "FunctionDeclaration",
        "id": astId(name),
        "generator": generator,
        "expression": false,
        "async": async,
        "defaults": [],
        "params": astParams(params),
        "body": astBlock(body)
    };
}

function astAnonymousFunction(params, body, generator = false, async = false) {
    return {
        "type": "FunctionExpression",
        "id": null,
        "params": astParams(params),
        "defaults": [],
        "body": astBlock(body),
        "generator": generator,
        "expression": false,
        "async": async
    };
}

function astArrowFunction(params, body, generator = false, async = false) {
    return {
        "type": "ArrowFunctionExpression",
        "id": null,
        "params": astParams(params),
        "body": mapBody(body),
        "generator": generator,
        "expression": true,
        "async": async
    }
}

function astBlock(body) {
    return {
        "type": "BlockStatement",
        "body": Array.isArray(body) ? body : [ body ]
    };
}

function astMatchObject(idList, right, isConstant = true) {
    return {
        "type": "VariableDeclaration",
        "declarations": [
            {
                "type": "VariableDeclarator",
                "id": {
                    "type": "ObjectPattern",
                    "properties": _.map(idList, id => astMember(id, astId(id), true))
                },
                "init": right
            }
        ],
        "kind": isConstant ? "const" : "let"
    };
}

function astExpression(expr, comment = false) {
    return {
        "type": "ExpressionStatement",
        "expression": expr,
        ...astLeadingComments(comment)
    };
}

function astAssign(left, right, comment = false) {
    return astExpression({
        "type": "AssignmentExpression",
        "operator": "=",
        "left": astVarRef(left),
        "right": astValue(right)
    }, comment);
}

function astConditional(test, consequent, alternate) {
    return {
        "type": "ConditionalExpression",
        "test": astValue(test),
        "consequent": astValue(consequent),
        "alternate": astValue(alternate)
    }
}

function astThrow(name, args) {
    return {
        "type": "ThrowStatement",
        "argument": {
            "type": "NewExpression",
            "callee": astVarRef(name),
            "arguments": mapArgs(args)
        }
    };
}

function astNot(expr) {
    return {
        "type": "UnaryExpression",
        "operator": "!",
        "argument": astValue(expr),
        "prefix": true
    };
}

function astReturn(val) {
    return {
        "type": "ReturnStatement",
        "argument": astValue(val)
    };
}

function astToCode(ast) {       
    return escodegen.generate(ast, {
        format: {
            indent: {
                style: '    ',
                base: 0,
                adjustMultilineComment: false
            },
            newline: '\n',
            space: ' ',
            json: false,
            renumber: false,
            hexadecimal: false,
            quotes: 'single',
            escapeless: false,
            compact: false,
            parentheses: true,
            semicolons: true,
            safeConcatenation: false
        },
        comment: true
    });
}

module.exports = {
    astProgram,
    astRequire,
    astVarDeclare,
    astClassDeclare,
    astMemberMethod,
    astCall,
    astYield,
    astAwait,
    astThis,
    astId,
    astVarRef,
    astValue,
    astFunction,
    astAnonymousFunction,
    astArrowFunction,
    astIf,
    astConditional,
    astBinExp,
    astLogicalExp,
    astBlock,
    astMatchObject,
    astExpression,
    astAssign,
    astAddMember,
    astMember,
    astPushInBody,
    astThrow,
    astNot,
    astReturn,
    astLiteral,
    astParams,
    astArrayAccess,
    astToCode
};