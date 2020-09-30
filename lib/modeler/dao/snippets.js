"use strict";

require("source-map-support/register");

const {
  _,
  quote
} = require("rk-utils");

const {
  extractDotSeparateName
} = require("../../lang/GemlUtils");

const JsLang = require("../util/ast");

const _applyModifiersHeader = [{
  type: "VariableDeclaration",
  declarations: [{
    type: "VariableDeclarator",
    id: {
      type: "ObjectPattern",
      properties: [{
        type: "Property",
        key: {
          type: "Identifier",
          name: "raw"
        },
        computed: false,
        value: {
          type: "Identifier",
          name: "raw"
        },
        kind: "init",
        method: false,
        shorthand: true
      }, {
        type: "Property",
        key: {
          type: "Identifier",
          name: "latest"
        },
        computed: false,
        value: {
          type: "Identifier",
          name: "latest"
        },
        kind: "init",
        method: false,
        shorthand: true
      }, {
        type: "Property",
        key: {
          type: "Identifier",
          name: "existing"
        },
        computed: false,
        value: {
          type: "Identifier",
          name: "existing"
        },
        kind: "init",
        method: false,
        shorthand: true
      }, {
        type: "Property",
        key: {
          type: "Identifier",
          name: "i18n"
        },
        computed: false,
        value: {
          type: "Identifier",
          name: "i18n"
        },
        kind: "init",
        method: false,
        shorthand: true
      }]
    },
    init: {
      type: "Identifier",
      name: "context"
    }
  }],
  kind: "let"
}, {
  type: "ExpressionStatement",
  expression: {
    type: "LogicalExpression",
    operator: "||",
    left: {
      type: "Identifier",
      name: "existing"
    },
    right: {
      type: "AssignmentExpression",
      operator: "=",
      left: {
        type: "Identifier",
        name: "existing"
      },
      right: {
        type: "ObjectExpression",
        properties: []
      }
    }
  }
}];

const _checkAndAssign = (astBlock, assignTo, comment) => {
  return [JsLang.astVarDeclare("activated", astBlock, false, false, comment), {
    type: "IfStatement",
    test: {
      type: "BinaryExpression",
      operator: "!==",
      left: {
        type: "UnaryExpression",
        operator: "typeof",
        argument: {
          type: "Identifier",
          name: "activated"
        },
        prefix: true
      },
      right: {
        type: "Literal",
        value: "undefined",
        raw: "'undefined'"
      }
    },
    consequent: {
      type: "BlockStatement",
      body: [{
        type: "ExpressionStatement",
        expression: {
          type: "AssignmentExpression",
          operator: "=",
          left: assignTo,
          right: {
            type: "Identifier",
            name: "activated"
          }
        }
      }]
    },
    alternate: null
  }];
};

const _validateCheck = (fieldName, validatingCall) => {
  let comment = `Validating "${fieldName}"`;
  return {
    type: "IfStatement",
    test: {
      type: "UnaryExpression",
      operator: "!",
      argument: validatingCall,
      prefix: true
    },
    consequent: {
      type: "BlockStatement",
      body: [{
        type: "ThrowStatement",
        argument: {
          type: "NewExpression",
          callee: {
            type: "Identifier",
            name: "ValidationError"
          },
          arguments: [{
            type: "Literal",
            value: `Invalid "${fieldName}".`,
            raw: `'Invalid "${fieldName}".'`
          }, {
            type: "ObjectExpression",
            properties: [{
              type: "Property",
              key: {
                type: "Identifier",
                name: "entity"
              },
              computed: false,
              value: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "ThisExpression"
                  },
                  property: {
                    type: "Identifier",
                    name: "meta"
                  }
                },
                property: {
                  type: "Identifier",
                  name: "name"
                }
              },
              kind: "init",
              method: false,
              shorthand: false
            }, {
              type: "Property",
              key: {
                type: "Identifier",
                name: "field"
              },
              computed: false,
              value: JsLang.astValue(fieldName),
              kind: "init",
              method: false,
              shorthand: false
            }, {
              type: "Property",
              key: {
                type: "Identifier",
                name: "value"
              },
              computed: false,
              value: {
                type: "MemberExpression",
                computed: true,
                object: {
                  type: "Identifier",
                  name: "latest"
                },
                property: {
                  type: "Literal",
                  value: fieldName,
                  raw: quote(fieldName, "'")
                }
              },
              kind: "init",
              method: false,
              shorthand: false
            }]
          }]
        }
      }]
    },
    alternate: null,
    leadingComments: [{
      type: "Line",
      value: comment,
      range: [1, comment.length + 1]
    }]
  };
};

const _fieldRequirementCheck = (fieldName, references, content, requireTargetField) => {
  if (!references) references = [];
  references = references.map(ref => extractDotSeparateName(ref).pop());
  let throwMessage = `"${fieldName}" is required due to change of its dependencies. (e.g: ${references.join(" or ")})`;
  let checks = requireTargetField && references.length > 0 ? [{
    type: "IfStatement",
    test: {
      type: "LogicalExpression",
      operator: "&&",
      left: {
        type: "Identifier",
        name: "isUpdating"
      },
      right: {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "isNothing"
        },
        arguments: [{
          type: "MemberExpression",
          computed: true,
          object: {
            type: "Identifier",
            name: "latest"
          },
          property: {
            type: "Literal",
            value: fieldName,
            raw: quote(fieldName, "'")
          }
        }]
      }
    },
    consequent: {
      type: "BlockStatement",
      body: [{
        type: "ThrowStatement",
        argument: {
          type: "NewExpression",
          callee: {
            type: "Identifier",
            name: "ValidationError"
          },
          arguments: [{
            type: "Literal",
            value: throwMessage,
            raw: quote(throwMessage, "'")
          }]
        }
      }]
    },
    alternate: null
  }] : [];
  return requireTargetField ? {
    type: "IfStatement",
    test: {
      type: "LogicalExpression",
      operator: "&&",
      left: {
        type: "UnaryExpression",
        operator: "!",
        argument: {
          type: "CallExpression",
          callee: {
            type: "Identifier",
            name: "isNothing"
          },
          arguments: [{
            type: "MemberExpression",
            computed: true,
            object: {
              type: "Identifier",
              name: "latest"
            },
            property: {
              type: "Literal",
              value: fieldName,
              raw: quote(fieldName, "'")
            }
          }]
        },
        prefix: true
      },
      right: {
        type: "UnaryExpression",
        operator: "!",
        argument: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "MemberExpression",
            computed: true,
            object: {
              type: "Identifier",
              name: "latest"
            },
            property: {
              type: "Literal",
              value: fieldName,
              raw: quote(fieldName, "'")
            }
          },
          property: {
            type: "Identifier",
            name: "oorType"
          }
        },
        prefix: true
      }
    },
    consequent: {
      type: "BlockStatement",
      body: checks.concat(content)
    },
    alternate: null
  } : {
    type: "IfStatement",
    test: {
      type: "LogicalExpression",
      operator: "&&",
      left: {
        type: "LogicalExpression",
        operator: "||",
        left: {
          type: "CallExpression",
          callee: {
            type: "Identifier",
            name: "isNothing"
          },
          arguments: [{
            type: "MemberExpression",
            computed: true,
            object: {
              type: "Identifier",
              name: "latest"
            },
            property: {
              type: "Literal",
              value: fieldName,
              raw: quote(fieldName, "'")
            }
          }]
        },
        right: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "MemberExpression",
            computed: true,
            object: {
              type: "MemberExpression",
              computed: false,
              object: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "ThisExpression"
                },
                property: {
                  type: "Identifier",
                  name: "meta"
                }
              },
              property: {
                type: "Identifier",
                name: "fields"
              }
            },
            property: {
              type: "Literal",
              value: fieldName,
              raw: quote(fieldName, "'")
            }
          },
          property: {
            type: "Identifier",
            name: "forceUpdate"
          }
        }
      },
      right: {
        type: "LogicalExpression",
        operator: "||",
        left: {
          type: "UnaryExpression",
          operator: "!",
          argument: {
            type: "Identifier",
            name: "isUpdating"
          },
          prefix: true
        },
        right: {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: {
              type: "ThisExpression"
            },
            property: {
              type: "Identifier",
              name: "_dependencyChanged"
            }
          },
          arguments: [{
            type: "Literal",
            value: fieldName,
            raw: quote(fieldName, "'")
          }, {
            type: "Identifier",
            name: "context"
          }]
        }
      }
    },
    consequent: {
      type: "BlockStatement",
      body: checks.concat(content)
    },
    alternate: null
  };
};

const restMethods = (serviceId, entityName, className) => ({
  type: "Program",
  body: [{
    type: "ExpressionStatement",
    expression: {
      type: "Literal",
      value: "use strict",
      raw: '"use strict"'
    },
    directive: "use strict"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "Mowa"
      },
      init: {
        type: "CallExpression",
        callee: {
          type: "Identifier",
          name: "require"
        },
        arguments: [{
          type: "Literal",
          value: "mowa",
          raw: "'mowa'"
        }]
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "dbId"
      },
      init: {
        type: "Literal",
        value: serviceId,
        raw: `'${serviceId}'`
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "modelName"
      },
      init: {
        type: "Literal",
        value: entityName,
        raw: `'${entityName}'`
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "query"
      },
      init: {
        type: "ArrowFunctionExpression",
        id: null,
        params: [{
          type: "Identifier",
          name: "ctx"
        }],
        body: {
          type: "BlockStatement",
          body: [{
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "db"
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "ctx"
                    },
                    property: {
                      type: "Identifier",
                      name: "appModule"
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "db"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "dbId"
                }, {
                  type: "Identifier",
                  name: "ctx"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: className
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "db"
                  },
                  property: {
                    type: "Identifier",
                    name: "model"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "modelName"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "ReturnStatement",
            argument: {
              type: "CallExpression",
              callee: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "Identifier",
                  name: className
                },
                property: {
                  type: "Identifier",
                  name: "find"
                }
              },
              arguments: [{
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "Identifier",
                  name: "ctx"
                },
                property: {
                  type: "Identifier",
                  name: "query"
                }
              }, {
                type: "Literal",
                value: true,
                raw: "true"
              }]
            }
          }]
        },
        generator: false,
        expression: false,
        async: true
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "detail"
      },
      init: {
        type: "ArrowFunctionExpression",
        id: null,
        params: [{
          type: "Identifier",
          name: "ctx"
        }],
        body: {
          type: "BlockStatement",
          body: [{
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "id"
              },
              init: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "ctx"
                  },
                  property: {
                    type: "Identifier",
                    name: "params"
                  }
                },
                property: {
                  type: "Identifier",
                  name: "id"
                }
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "db"
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "ctx"
                    },
                    property: {
                      type: "Identifier",
                      name: "appModule"
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "db"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "dbId"
                }, {
                  type: "Identifier",
                  name: "ctx"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: className
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "db"
                  },
                  property: {
                    type: "Identifier",
                    name: "model"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "modelName"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: entityName
              },
              init: {
                type: "AwaitExpression",
                argument: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: className
                    },
                    property: {
                      type: "Identifier",
                      name: "findOne"
                    }
                  },
                  arguments: [{
                    type: "Identifier",
                    name: "id"
                  }]
                }
              }
            }],
            kind: "let"
          }, {
            type: "IfStatement",
            test: {
              type: "UnaryExpression",
              operator: "!",
              argument: {
                type: "Identifier",
                name: entityName
              },
              prefix: true
            },
            consequent: {
              type: "BlockStatement",
              body: [{
                type: "ReturnStatement",
                argument: {
                  type: "ObjectExpression",
                  properties: [{
                    type: "Property",
                    key: {
                      type: "Identifier",
                      name: "error"
                    },
                    computed: false,
                    value: {
                      type: "Literal",
                      value: "record_not_found",
                      raw: "'record_not_found'"
                    },
                    kind: "init",
                    method: false,
                    shorthand: false
                  }]
                }
              }]
            },
            alternate: null
          }, {
            type: "ReturnStatement",
            argument: {
              type: "MemberExpression",
              computed: false,
              object: {
                type: "Identifier",
                name: entityName
              },
              property: {
                type: "Identifier",
                name: "data"
              }
            }
          }]
        },
        generator: false,
        expression: false,
        async: true
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "create"
      },
      init: {
        type: "ArrowFunctionExpression",
        id: null,
        params: [{
          type: "Identifier",
          name: "ctx"
        }],
        body: {
          type: "BlockStatement",
          body: [{
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "db"
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "ctx"
                    },
                    property: {
                      type: "Identifier",
                      name: "appModule"
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "db"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "dbId"
                }, {
                  type: "Identifier",
                  name: "ctx"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: className
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "db"
                  },
                  property: {
                    type: "Identifier",
                    name: "model"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "modelName"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: entityName
              },
              init: {
                type: "NewExpression",
                callee: {
                  type: "Identifier",
                  name: className
                },
                arguments: [{
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "ctx"
                    },
                    property: {
                      type: "Identifier",
                      name: "request"
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "fields"
                  }
                }]
              }
            }],
            kind: "let"
          }, {
            type: "ReturnStatement",
            argument: {
              type: "MemberExpression",
              computed: false,
              object: {
                type: "AwaitExpression",
                argument: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: entityName
                    },
                    property: {
                      type: "Identifier",
                      name: "save"
                    }
                  },
                  arguments: []
                }
              },
              property: {
                type: "Identifier",
                name: "data"
              }
            }
          }]
        },
        generator: false,
        expression: false,
        async: true
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "update"
      },
      init: {
        type: "ArrowFunctionExpression",
        id: null,
        params: [{
          type: "Identifier",
          name: "ctx"
        }],
        body: {
          type: "BlockStatement",
          body: [{
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "id"
              },
              init: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "ctx"
                  },
                  property: {
                    type: "Identifier",
                    name: "params"
                  }
                },
                property: {
                  type: "Identifier",
                  name: "id"
                }
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "db"
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "ctx"
                    },
                    property: {
                      type: "Identifier",
                      name: "appModule"
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "db"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "dbId"
                }, {
                  type: "Identifier",
                  name: "ctx"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: className
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "db"
                  },
                  property: {
                    type: "Identifier",
                    name: "model"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "modelName"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: entityName
              },
              init: {
                type: "AwaitExpression",
                argument: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: className
                    },
                    property: {
                      type: "Identifier",
                      name: "findOne"
                    }
                  },
                  arguments: [{
                    type: "Identifier",
                    name: "id"
                  }]
                }
              }
            }],
            kind: "let"
          }, {
            type: "IfStatement",
            test: {
              type: "Identifier",
              name: entityName
            },
            consequent: {
              type: "BlockStatement",
              body: [{
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "Object"
                    },
                    property: {
                      type: "Identifier",
                      name: "assign"
                    }
                  },
                  arguments: [{
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: entityName
                    },
                    property: {
                      type: "Identifier",
                      name: "data"
                    }
                  }, {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "MemberExpression",
                      computed: false,
                      object: {
                        type: "Identifier",
                        name: "ctx"
                      },
                      property: {
                        type: "Identifier",
                        name: "request"
                      }
                    },
                    property: {
                      type: "Identifier",
                      name: "fields"
                    }
                  }]
                }
              }, {
                type: "ReturnStatement",
                argument: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "AwaitExpression",
                    argument: {
                      type: "CallExpression",
                      callee: {
                        type: "MemberExpression",
                        computed: false,
                        object: {
                          type: "Identifier",
                          name: entityName
                        },
                        property: {
                          type: "Identifier",
                          name: "save"
                        }
                      },
                      arguments: []
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "data"
                  }
                }
              }]
            },
            alternate: null
          }, {
            type: "ReturnStatement",
            argument: {
              type: "ObjectExpression",
              properties: [{
                type: "Property",
                key: {
                  type: "Identifier",
                  name: "error"
                },
                computed: false,
                value: {
                  type: "Literal",
                  value: "record_not_found",
                  raw: "'record_not_found'"
                },
                kind: "init",
                method: false,
                shorthand: false
              }]
            }
          }]
        },
        generator: false,
        expression: false,
        async: true
      }
    }],
    kind: "const"
  }, {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: "remove"
      },
      init: {
        type: "ArrowFunctionExpression",
        id: null,
        params: [{
          type: "Identifier",
          name: "ctx"
        }],
        body: {
          type: "BlockStatement",
          body: [{
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "id"
              },
              init: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "ctx"
                  },
                  property: {
                    type: "Identifier",
                    name: "params"
                  }
                },
                property: {
                  type: "Identifier",
                  name: "id"
                }
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: "db"
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "MemberExpression",
                    computed: false,
                    object: {
                      type: "Identifier",
                      name: "ctx"
                    },
                    property: {
                      type: "Identifier",
                      name: "appModule"
                    }
                  },
                  property: {
                    type: "Identifier",
                    name: "db"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "dbId"
                }, {
                  type: "Identifier",
                  name: "ctx"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "VariableDeclaration",
            declarations: [{
              type: "VariableDeclarator",
              id: {
                type: "Identifier",
                name: className
              },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: "db"
                  },
                  property: {
                    type: "Identifier",
                    name: "model"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "modelName"
                }]
              }
            }],
            kind: "let"
          }, {
            type: "ExpressionStatement",
            expression: {
              type: "AwaitExpression",
              argument: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: {
                    type: "Identifier",
                    name: className
                  },
                  property: {
                    type: "Identifier",
                    name: "removeOne"
                  }
                },
                arguments: [{
                  type: "Identifier",
                  name: "id"
                }]
              }
            }
          }, {
            type: "ReturnStatement",
            argument: {
              type: "ObjectExpression",
              properties: [{
                type: "Property",
                key: {
                  type: "Identifier",
                  name: "status"
                },
                computed: false,
                value: {
                  type: "Literal",
                  value: "ok",
                  raw: "'ok'"
                },
                kind: "init",
                method: false,
                shorthand: false
              }]
            }
          }]
        },
        generator: false,
        expression: false,
        async: true
      }
    }],
    kind: "const"
  }, {
    type: "ExpressionStatement",
    expression: {
      type: "AssignmentExpression",
      operator: "=",
      left: {
        type: "MemberExpression",
        computed: false,
        object: {
          type: "Identifier",
          name: "module"
        },
        property: {
          type: "Identifier",
          name: "exports"
        }
      },
      right: {
        type: "ObjectExpression",
        properties: [{
          type: "Property",
          key: {
            type: "Identifier",
            name: "query"
          },
          computed: false,
          value: {
            type: "Identifier",
            name: "query"
          },
          kind: "init",
          method: false,
          shorthand: true
        }, {
          type: "Property",
          key: {
            type: "Identifier",
            name: "detail"
          },
          computed: false,
          value: {
            type: "Identifier",
            name: "detail"
          },
          kind: "init",
          method: false,
          shorthand: true
        }, {
          type: "Property",
          key: {
            type: "Identifier",
            name: "create"
          },
          computed: false,
          value: {
            type: "Identifier",
            name: "create"
          },
          kind: "init",
          method: false,
          shorthand: true
        }, {
          type: "Property",
          key: {
            type: "Identifier",
            name: "update"
          },
          computed: false,
          value: {
            type: "Identifier",
            name: "update"
          },
          kind: "init",
          method: false,
          shorthand: true
        }, {
          type: "Property",
          key: {
            type: "Identifier",
            name: "remove"
          },
          computed: false,
          value: {
            type: "Identifier",
            name: "remove"
          },
          kind: "init",
          method: false,
          shorthand: true
        }]
      }
    }
  }],
  sourceType: "script"
});

module.exports = {
  _checkAndAssign,
  _applyModifiersHeader,
  _validateCheck,
  _fieldRequirementCheck,
  restMethods
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL2Rhby9zbmlwcGV0cy5qcyJdLCJuYW1lcyI6WyJfIiwicXVvdGUiLCJyZXF1aXJlIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkpzTGFuZyIsIl9hcHBseU1vZGlmaWVyc0hlYWRlciIsInR5cGUiLCJkZWNsYXJhdGlvbnMiLCJpZCIsInByb3BlcnRpZXMiLCJrZXkiLCJuYW1lIiwiY29tcHV0ZWQiLCJ2YWx1ZSIsImtpbmQiLCJtZXRob2QiLCJzaG9ydGhhbmQiLCJpbml0IiwiZXhwcmVzc2lvbiIsIm9wZXJhdG9yIiwibGVmdCIsInJpZ2h0IiwiX2NoZWNrQW5kQXNzaWduIiwiYXN0QmxvY2siLCJhc3NpZ25UbyIsImNvbW1lbnQiLCJhc3RWYXJEZWNsYXJlIiwidGVzdCIsImFyZ3VtZW50IiwicHJlZml4IiwicmF3IiwiY29uc2VxdWVudCIsImJvZHkiLCJhbHRlcm5hdGUiLCJfdmFsaWRhdGVDaGVjayIsImZpZWxkTmFtZSIsInZhbGlkYXRpbmdDYWxsIiwiY2FsbGVlIiwiYXJndW1lbnRzIiwib2JqZWN0IiwicHJvcGVydHkiLCJhc3RWYWx1ZSIsImxlYWRpbmdDb21tZW50cyIsInJhbmdlIiwibGVuZ3RoIiwiX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayIsInJlZmVyZW5jZXMiLCJjb250ZW50IiwicmVxdWlyZVRhcmdldEZpZWxkIiwibWFwIiwicmVmIiwicG9wIiwidGhyb3dNZXNzYWdlIiwiam9pbiIsImNoZWNrcyIsImNvbmNhdCIsInJlc3RNZXRob2RzIiwic2VydmljZUlkIiwiZW50aXR5TmFtZSIsImNsYXNzTmFtZSIsImRpcmVjdGl2ZSIsInBhcmFtcyIsImdlbmVyYXRvciIsImFzeW5jIiwic291cmNlVHlwZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBZUMsT0FBTyxDQUFDLFVBQUQs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SFAsWUFBQUEsSUFBSSxFQUFFLFlBREg7QUFFSEssWUFBQUEsSUFBSSxFQUFFO0FBRkgsV0FQWDtBQVdJRyxVQUFBQSxJQUFJLEVBQUUsTUFYVjtBQVlJQyxVQUFBQSxNQUFNLEVBQUUsS0FaWjtBQWFJQyxVQUFBQSxTQUFTLEVBQUU7QUFiZixTQTlDUSxFQTZEUjtBQUNJVixVQUFBQSxJQUFJLEVBQUUsVUFEVjtBQUVJSSxVQUFBQSxHQUFHLEVBQUU7QUFDREosWUFBQUEsSUFBSSxFQUFFLFlBREw7QUFFREssWUFBQUEsSUFBSSxFQUFFO0FBRkwsV0FGVDtBQU1JQyxVQUFBQSxRQUFRLEVBQUUsS0FOZDtBQU9JQyxVQUFBQSxLQUFLLEVBQUU7QUFDSFAsWUFBQUEsSUFBSSxFQUFFLFlBREg7QUFFSEssWUFBQUEsSUFBSSxFQUFFO0FBRkgsV0FQWDtBQVdJRyxVQUFBQSxJQUFJLEVBQUUsTUFYVjtBQVlJQyxVQUFBQSxNQUFNLEVBQUUsS0FaWjtBQWFJQyxVQUFBQSxTQUFTLEVBQUU7QUFiZixTQTdEUTtBQUZUO0FBZkM7QUFGaEIsR0FqbkNFLENBRmlEO0FBdXRDdkRnRCxFQUFBQSxVQUFVLEVBQUU7QUF2dEMyQyxDQUF2QyxDQUFwQjs7QUEwdENBQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYjVDLEVBQUFBLGVBRGE7QUFFYmpCLEVBQUFBLHFCQUZhO0FBR2I2QixFQUFBQSxjQUhhO0FBSWJXLEVBQUFBLHNCQUphO0FBS2JXLEVBQUFBO0FBTGEsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgeyBfLCBxdW90ZSB9ID0gcmVxdWlyZShcInJrLXV0aWxzXCIpO1xuY29uc3QgeyBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSByZXF1aXJlKFwiLi4vLi4vbGFuZy9HZW1sVXRpbHNcIik7XG5jb25zdCBKc0xhbmcgPSByZXF1aXJlKFwiLi4vdXRpbC9hc3RcIik7XG5cbmNvbnN0IF9hcHBseU1vZGlmaWVyc0hlYWRlciA9IFtcbiAgICB7XG4gICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICBkZWNsYXJhdGlvbnM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgIGlkOiB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiT2JqZWN0UGF0dGVyblwiLFxuICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJQcm9wZXJ0eVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJyYXdcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJyYXdcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlByb3BlcnR5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImxhdGVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImxhdGVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJpbml0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG9ydGhhbmQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZXhpc3RpbmdcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJleGlzdGluZ1wiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJpbml0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG9ydGhhbmQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiaTE4blwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImkxOG5cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiY29udGV4dFwiLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICBraW5kOiBcImxldFwiLFxuICAgIH0sXG4gICAge1xuICAgICAgICB0eXBlOiBcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIixcbiAgICAgICAgZXhwcmVzc2lvbjoge1xuICAgICAgICAgICAgdHlwZTogXCJMb2dpY2FsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgb3BlcmF0b3I6IFwifHxcIixcbiAgICAgICAgICAgIGxlZnQ6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICBuYW1lOiBcImV4aXN0aW5nXCIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcmlnaHQ6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgb3BlcmF0b3I6IFwiPVwiLFxuICAgICAgICAgICAgICAgIGxlZnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZXhpc3RpbmdcIixcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHJpZ2h0OiB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiT2JqZWN0RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiBbXSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICB9LFxuXTtcblxuY29uc3QgX2NoZWNrQW5kQXNzaWduID0gKGFzdEJsb2NrLCBhc3NpZ25UbywgY29tbWVudCkgPT4ge1xuICAgIHJldHVybiBbXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKFwiYWN0aXZhdGVkXCIsIGFzdEJsb2NrLCBmYWxzZSwgZmFsc2UsIGNvbW1lbnQpLFxuICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcIklmU3RhdGVtZW50XCIsXG4gICAgICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJCaW5hcnlFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgb3BlcmF0b3I6IFwiIT09XCIsXG4gICAgICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlVuYXJ5RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogXCJ0eXBlb2ZcIixcbiAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJhY3RpdmF0ZWRcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgcHJlZml4OiB0cnVlLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgcmlnaHQ6IHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlOiBcInVuZGVmaW5lZFwiLFxuICAgICAgICAgICAgICAgICAgICByYXc6IFwiJ3VuZGVmaW5lZCdcIixcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGNvbnNlcXVlbnQ6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIkJsb2NrU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgYm9keTogW1xuICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4cHJlc3Npb246IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6IFwiPVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxlZnQ6IGFzc2lnblRvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImFjdGl2YXRlZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYWx0ZXJuYXRlOiBudWxsLFxuICAgICAgICB9LFxuICAgIF07XG59O1xuXG5jb25zdCBfdmFsaWRhdGVDaGVjayA9IChmaWVsZE5hbWUsIHZhbGlkYXRpbmdDYWxsKSA9PiB7XG4gICAgbGV0IGNvbW1lbnQgPSBgVmFsaWRhdGluZyBcIiR7ZmllbGROYW1lfVwiYDtcblxuICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwiSWZTdGF0ZW1lbnRcIixcbiAgICAgICAgdGVzdDoge1xuICAgICAgICAgICAgdHlwZTogXCJVbmFyeUV4cHJlc3Npb25cIixcbiAgICAgICAgICAgIG9wZXJhdG9yOiBcIiFcIixcbiAgICAgICAgICAgIGFyZ3VtZW50OiB2YWxpZGF0aW5nQ2FsbCxcbiAgICAgICAgICAgIHByZWZpeDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgY29uc2VxdWVudDoge1xuICAgICAgICAgICAgdHlwZTogXCJCbG9ja1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgYm9keTogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJUaHJvd1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICBhcmd1bWVudDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJOZXdFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIlZhbGlkYXRpb25FcnJvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiLmAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogYCdJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIuJ2AsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiT2JqZWN0RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJQcm9wZXJ0eVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJlbnRpdHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJUaGlzRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtZXRhXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIm5hbWVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJQcm9wZXJ0eVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJmaWVsZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBKc0xhbmcuYXN0VmFsdWUoZmllbGROYW1lKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImluaXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNob3J0aGFuZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwidmFsdWVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImxhdGVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZTogZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBxdW90ZShmaWVsZE5hbWUsIFwiJ1wiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIGFsdGVybmF0ZTogbnVsbCxcbiAgICAgICAgbGVhZGluZ0NvbW1lbnRzOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJMaW5lXCIsXG4gICAgICAgICAgICAgICAgdmFsdWU6IGNvbW1lbnQsXG4gICAgICAgICAgICAgICAgcmFuZ2U6IFsxLCBjb21tZW50Lmxlbmd0aCArIDFdLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICB9O1xufTtcblxuLyoqXG4gKiBDaGVjayBleGlzdGVuY2Ugb2YgYWxsIHJlcXVpcmVkIGZpZWxkc1xuICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSAtIFRhcmdldCBmaWVsZCBuYW1lXG4gKiBAcGFyYW0geyp9IHJlZmVyZW5jZXMgLSBBbGwgcmVmZXJlbmNlcyB0byBvdGhlciBmaWVsZHNcbiAqIEBwYXJhbSB7Kn0gY29udGVudCAtIENvbnRlbnQgY29kZSBibG9ja1xuICogQHBhcmFtIHtib29sfSByZXF1aXJlVGFyZ2V0RmllbGQgLSBXaGV0aGVyIHRoZSBmdW5jdGlvbiByZXF1aXJlcyB0YXJnZXQgZmllbGQgYXMgaW5wdXRcbiAqL1xuY29uc3QgX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayA9IChmaWVsZE5hbWUsIHJlZmVyZW5jZXMsIGNvbnRlbnQsIHJlcXVpcmVUYXJnZXRGaWVsZCkgPT4ge1xuICAgIGlmICghcmVmZXJlbmNlcykgcmVmZXJlbmNlcyA9IFtdO1xuXG4gICAgcmVmZXJlbmNlcyA9IHJlZmVyZW5jZXMubWFwKChyZWYpID0+IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUocmVmKS5wb3AoKSk7XG5cbiAgICBsZXQgdGhyb3dNZXNzYWdlID0gYFwiJHtmaWVsZE5hbWV9XCIgaXMgcmVxdWlyZWQgZHVlIHRvIGNoYW5nZSBvZiBpdHMgZGVwZW5kZW5jaWVzLiAoZS5nOiAke3JlZmVyZW5jZXMuam9pbihcbiAgICAgICAgXCIgb3IgXCJcbiAgICApfSlgO1xuXG4gICAgbGV0IGNoZWNrcyA9XG4gICAgICAgIHJlcXVpcmVUYXJnZXRGaWVsZCAmJiByZWZlcmVuY2VzLmxlbmd0aCA+IDBcbiAgICAgICAgICAgID8gW1xuICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWZTdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTG9naWNhbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6IFwiJiZcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlzVXBkYXRpbmdcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiaXNOb3RoaW5nXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImxhdGVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZTogZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBxdW90ZShmaWVsZE5hbWUsIFwiJ1wiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgIGNvbnNlcXVlbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJCbG9ja1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBib2R5OiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJUaHJvd1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTmV3RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJWYWxpZGF0aW9uRXJyb3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IHRocm93TWVzc2FnZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IHF1b3RlKHRocm93TWVzc2FnZSwgXCInXCIpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgIGFsdGVybmF0ZTogbnVsbCxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF1cbiAgICAgICAgICAgIDogW107XG5cbiAgICAvKlxuICAgIHJlZmVyZW5jZXMuZm9yRWFjaChyZWYgPT4ge1xuICAgICAgICBsZXQgcmVmVGhyb3dNZXNzYWdlID0gYE1pc3NpbmcgXCIke3JlZn1cIiB2YWx1ZSwgd2hpY2ggaXMgYSBkZXBlbmRlbmN5IG9mIFwiJHtmaWVsZE5hbWV9XCIuYDtcblxuICAgICAgICBjaGVja3MucHVzaCh7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJJZlN0YXRlbWVudFwiLFxuICAgICAgICAgICAgXCJ0ZXN0XCI6IHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJMb2dpY2FsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgIFwib3BlcmF0b3JcIjogXCImJlwiLFxuICAgICAgICAgICAgICAgIFwibGVmdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIlVuYXJ5RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICBcIm9wZXJhdG9yXCI6IFwiIVwiLFxuICAgICAgICAgICAgICAgICAgICBcImFyZ3VtZW50XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIkJpbmFyeUV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwib3BlcmF0b3JcIjogXCJpblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJsZWZ0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJ2YWx1ZVwiOiByZWYsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJyYXdcIjogcXVvdGUocmVmLCBcIidcIilcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBcInJpZ2h0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwibGF0ZXN0XCJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXCJwcmVmaXhcIjogdHJ1ZVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgXCJyaWdodFwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIlVuYXJ5RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICBcIm9wZXJhdG9yXCI6IFwiIVwiLFxuICAgICAgICAgICAgICAgICAgICBcImFyZ3VtZW50XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIkJpbmFyeUV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwib3BlcmF0b3JcIjogXCJpblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJsZWZ0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJ2YWx1ZVwiOiByZWYsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJyYXdcIjogcXVvdGUocmVmLCBcIidcIilcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBcInJpZ2h0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwiZXhpc3RpbmdcIlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBcInByZWZpeFwiOiB0cnVlXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgXCJjb25zZXF1ZW50XCI6IHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJCbG9ja1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgIFwiYm9keVwiOiBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIlRocm93U3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcImFyZ3VtZW50XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJOZXdFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJjYWxsZWVcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcIlZhbGlkYXRpb25FcnJvclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcImFyZ3VtZW50c1wiOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIkxpdGVyYWxcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidmFsdWVcIjogcmVmVGhyb3dNZXNzYWdlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJyYXdcIjogcXVvdGUocmVmVGhyb3dNZXNzYWdlLCBcIidcIilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIF1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBcImFsdGVybmF0ZVwiOiBudWxsXG4gICAgICAgIH0pO1xuICAgIH0pO1xuICAgICovXG5cbiAgICByZXR1cm4gcmVxdWlyZVRhcmdldEZpZWxkXG4gICAgICAgID8ge1xuICAgICAgICAgICAgICB0eXBlOiBcIklmU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgIHRlc3Q6IHtcbiAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTG9naWNhbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcIiYmXCIsXG4gICAgICAgICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJVbmFyeUV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogXCIhXCIsXG4gICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJpc05vdGhpbmdcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImxhdGVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogcXVvdGUoZmllbGROYW1lLCBcIidcIiksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICBwcmVmaXg6IHRydWUsXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgcmlnaHQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlVuYXJ5RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcIiFcIixcbiAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImxhdGVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IHF1b3RlKGZpZWxkTmFtZSwgXCInXCIpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJvb3JUeXBlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICBwcmVmaXg6IHRydWUsXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBjb25zZXF1ZW50OiB7XG4gICAgICAgICAgICAgICAgICB0eXBlOiBcIkJsb2NrU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICBib2R5OiBjaGVja3MuY29uY2F0KGNvbnRlbnQpLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBhbHRlcm5hdGU6IG51bGwsXG4gICAgICAgICAgfVxuICAgICAgICA6IHtcbiAgICAgICAgICAgICAgLy8gZm9yIGFjdGl2YXRvclxuICAgICAgICAgICAgICB0eXBlOiBcIklmU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgIHRlc3Q6IHtcbiAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTG9naWNhbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcIiYmXCIsXG4gICAgICAgICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMb2dpY2FsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcInx8XCIsXG4gICAgICAgICAgICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlzTm90aGluZ1wiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwibGF0ZXN0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkxpdGVyYWxcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBxdW90ZShmaWVsZE5hbWUsIFwiJ1wiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgIHJpZ2h0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlRoaXNFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwibWV0YVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZmllbGRzXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTGl0ZXJhbFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBxdW90ZShmaWVsZE5hbWUsIFwiJ1wiKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZm9yY2VVcGRhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIHJpZ2h0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMb2dpY2FsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgIG9wZXJhdG9yOiBcInx8XCIsXG4gICAgICAgICAgICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlVuYXJ5RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBvcGVyYXRvcjogXCIhXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiaXNVcGRhdGluZ1wiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmaXg6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICByaWdodDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlRoaXNFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIl9kZXBlbmRlbmN5Q2hhbmdlZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IHF1b3RlKGZpZWxkTmFtZSwgXCInXCIpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImNvbnRleHRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGNvbnNlcXVlbnQ6IHtcbiAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQmxvY2tTdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgIGJvZHk6IGNoZWNrcy5jb25jYXQoY29udGVudCksXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGFsdGVybmF0ZTogbnVsbCxcbiAgICAgICAgICB9O1xufTtcblxuY29uc3QgcmVzdE1ldGhvZHMgPSAoc2VydmljZUlkLCBlbnRpdHlOYW1lLCBjbGFzc05hbWUpID0+ICh7XG4gICAgdHlwZTogXCJQcm9ncmFtXCIsXG4gICAgYm9keTogW1xuICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIixcbiAgICAgICAgICAgIGV4cHJlc3Npb246IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIkxpdGVyYWxcIixcbiAgICAgICAgICAgICAgICB2YWx1ZTogXCJ1c2Ugc3RyaWN0XCIsXG4gICAgICAgICAgICAgICAgcmF3OiAnXCJ1c2Ugc3RyaWN0XCInLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGRpcmVjdGl2ZTogXCJ1c2Ugc3RyaWN0XCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIk1vd2FcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJyZXF1aXJlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkxpdGVyYWxcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IFwibW93YVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IFwiJ21vd2EnXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBraW5kOiBcImNvbnN0XCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiSWRcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZTogc2VydmljZUlkLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBgJyR7c2VydmljZUlkfSdgLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAga2luZDogXCJjb25zdFwiLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtb2RlbE5hbWVcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJMaXRlcmFsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZTogZW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJhdzogYCcke2VudGl0eU5hbWV9J2AsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBraW5kOiBcImNvbnN0XCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInF1ZXJ5XCIsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQXJyb3dGdW5jdGlvbkV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgIGlkOiBudWxsLFxuICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkJsb2NrU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9keTogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJkYlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbml0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImFwcE1vZHVsZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJJZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwibGV0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIm1vZGVsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIm1vZGVsTmFtZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJsZXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJSZXR1cm5TdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImZpbmRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiY3R4XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInF1ZXJ5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkxpdGVyYWxcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBcInRydWVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGdlbmVyYXRvcjogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzeW5jOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAga2luZDogXCJjb25zdFwiLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJkZXRhaWxcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJBcnJvd0Z1bmN0aW9uRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IG51bGwsXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgYm9keToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQmxvY2tTdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib2R5OiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInBhcmFtc1wiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJsZXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdG9yXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlkOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJhcHBNb2R1bGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiSWRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiY3R4XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImxldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbml0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtb2RlbFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtb2RlbE5hbWVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwibGV0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBlbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbml0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkF3YWl0RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZmluZE9uZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJpZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJsZXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZlN0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGVzdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVW5hcnlFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3BlcmF0b3I6IFwiIVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBlbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZml4OiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNlcXVlbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkJsb2NrU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9keTogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlJldHVyblN0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk9iamVjdEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZXJyb3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTGl0ZXJhbFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBcInJlY29yZF9ub3RfZm91bmRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IFwiJ3JlY29yZF9ub3RfZm91bmQnXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJpbml0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsdGVybmF0ZTogbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJSZXR1cm5TdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogZW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRhdGFcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGdlbmVyYXRvcjogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzeW5jOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAga2luZDogXCJjb25zdFwiLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjcmVhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJBcnJvd0Z1bmN0aW9uRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IG51bGwsXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgYm9keToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQmxvY2tTdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib2R5OiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiY3R4XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiYXBwTW9kdWxlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJkYlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJkYklkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJsZXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdG9yXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlkOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJkYlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwibW9kZWxcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwibW9kZWxOYW1lXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImxldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogZW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJOZXdFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwicmVxdWVzdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJmaWVsZHNcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwibGV0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUmV0dXJuU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJBd2FpdEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJzYXZlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGF0YVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2VuZXJhdG9yOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4cHJlc3Npb246IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXN5bmM6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBraW5kOiBcImNvbnN0XCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInVwZGF0ZVwiLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBpbml0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkFycm93RnVuY3Rpb25FeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBpZDogbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiY3R4XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICBib2R5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJCbG9ja1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvZHk6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdG9yXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlkOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiaWRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwicGFyYW1zXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiaWRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImxldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJkYlwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbml0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImFwcE1vZHVsZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJJZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwibGV0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIm1vZGVsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcIm1vZGVsTmFtZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJsZXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdG9yXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlkOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQXdhaXRFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJmaW5kT25lXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImxldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklmU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0ZXN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogZW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zZXF1ZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJCbG9ja1N0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvZHk6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJFeHByZXNzaW9uU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJPYmplY3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJhc3NpZ25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRhdGFcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInJlcXVlc3RcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJmaWVsZHNcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUmV0dXJuU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJBd2FpdEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQ2FsbEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxlZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IGVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJzYXZlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGF0YVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWx0ZXJuYXRlOiBudWxsLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlJldHVyblN0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk9iamVjdEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZXJyb3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTGl0ZXJhbFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBcInJlY29yZF9ub3RfZm91bmRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXc6IFwiJ3JlY29yZF9ub3RfZm91bmQnXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJpbml0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGdlbmVyYXRvcjogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzeW5jOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAga2luZDogXCJjb25zdFwiLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJyZW1vdmVcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJBcnJvd0Z1bmN0aW9uRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IG51bGwsXG4gICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImN0eFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgYm9keToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQmxvY2tTdGF0ZW1lbnRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib2R5OiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVjbGFyYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRvclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluaXQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInBhcmFtc1wiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImlkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJsZXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWNsYXJhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiVmFyaWFibGVEZWNsYXJhdG9yXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlkOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5pdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjdHhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJhcHBNb2R1bGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiSWRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiY3R4XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImxldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlY2xhcmF0aW9uczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJWYXJpYWJsZURlY2xhcmF0b3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbml0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcImRiXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9wZXJ0eToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtb2RlbFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtb2RlbE5hbWVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwibGV0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiRXhwcmVzc2lvblN0YXRlbWVudFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhwcmVzc2lvbjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiQXdhaXRFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJndW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJDYWxsRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsZWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnR5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJyZW1vdmVPbmVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFyZ3VtZW50czogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiaWRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUmV0dXJuU3RhdGVtZW50XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmd1bWVudDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiT2JqZWN0RXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJQcm9wZXJ0eVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJzdGF0dXNcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiTGl0ZXJhbFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiBcIm9rXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF3OiBcIidvaydcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImluaXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG9ydGhhbmQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2VuZXJhdG9yOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4cHJlc3Npb246IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXN5bmM6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBraW5kOiBcImNvbnN0XCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6IFwiRXhwcmVzc2lvblN0YXRlbWVudFwiLFxuICAgICAgICAgICAgZXhwcmVzc2lvbjoge1xuICAgICAgICAgICAgICAgIHR5cGU6IFwiQXNzaWdubWVudEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICBvcGVyYXRvcjogXCI9XCIsXG4gICAgICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICBvYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJtb2R1bGVcIixcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgcHJvcGVydHk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJleHBvcnRzXCIsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICByaWdodDoge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIk9iamVjdEV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgcHJvcGVydGllczogW1xuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwicXVlcnlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJxdWVyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJpbml0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG9ydGhhbmQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGV0YWlsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwiZGV0YWlsXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImluaXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNob3J0aGFuZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJQcm9wZXJ0eVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjcmVhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXB1dGVkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogXCJjcmVhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtpbmQ6IFwiaW5pdFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvcnRoYW5kOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIlByb3BlcnR5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInVwZGF0ZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiBcInVwZGF0ZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2luZDogXCJpbml0XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG9ydGhhbmQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6IFwiUHJvcGVydHlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwicmVtb3ZlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wdXRlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5hbWU6IFwicmVtb3ZlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBraW5kOiBcImluaXRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNob3J0aGFuZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgXSxcbiAgICBzb3VyY2VUeXBlOiBcInNjcmlwdFwiLFxufSk7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIF9jaGVja0FuZEFzc2lnbixcbiAgICBfYXBwbHlNb2RpZmllcnNIZWFkZXIsXG4gICAgX3ZhbGlkYXRlQ2hlY2ssXG4gICAgX2ZpZWxkUmVxdWlyZW1lbnRDaGVjayxcbiAgICByZXN0TWV0aG9kcyxcbn07XG4iXX0=