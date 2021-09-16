"use strict";

require("source-map-support/register");

const path = require('path');

const {
  _,
  naming
} = require('@genx/july');

const {
  fs
} = require('@genx/sys');

const {
  toGraphQLType
} = require('./graphql/lang');

class GraphQLModeler {
  constructor(context, linker, connector) {
    this.linker = linker;
    this.outputPath = context.modelPath;
    this.manifestPath = context.manifestPath;
    this.connector = connector;
  }

  modeling_(schema) {
    this.linker.log('info', 'Generating graphql models for schema "' + schema.name + '"...');

    this._generateGraphQLModel(schema);
  }

  _generateEnumTypes(schema) {
    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      _.forOwn(entity.fields, (field, fieldName) => {
        if (field.type === 'enum') {}
      });
    });
  }

  _generateGraphQLModel(schema) {
    const generated = new Set();
    const typeDefs = [];

    _.forOwn(schema.entities, (entity, entityInstanceName) => {
      let capitalized = naming.pascalCase(entityInstanceName);

      let fields = _.map(entity.fields, (field, fieldName) => {
        if (fieldName === entity.key) {
          return `${fieldName}: ID!`;
        }

        const typeInfo = toGraphQLType(field);

        if (typeInfo.newType) {
          if (!generated.has(typeInfo.newType)) {
            generated.add(typeInfo.newType);

            switch (typeInfo.typeName) {
              case 'scalar':
                typeDefs.push(`scalar ${typeInfo.newType}`);
                break;

              case 'enum':
                typeDefs.push(`enum ${typeInfo.newType} {
    ${typeInfo.values.map(v => _.snakeCase(v).toUpperCase()).join('\n    ')}
}`);
                break;

              default:
                throw new Error(`Unsupported graphql type: ${typeInfo.newType}`);
            }
          }
        }

        return `${fieldName}: ${typeInfo.type}`;
      });

      if (_.isEmpty(!entity.associations)) {
        _.each(entity.associations, (assoc, anchor) => {
          const typeName = naming.pascalCase(assoc.entity);

          if (assoc.list) {
            fields.push(`${anchor}_: [${typeName}!]`);
          } else {
            fields.push(`${anchor}_: ${typeName}`);
          }
        });
      }

      let classCode = `type ${capitalized} {
    ${fields.join('\n    ')}
}`;
      typeDefs.push(classCode);
    });

    let modelFilePath = path.resolve(this.manifestPath, 'graphql', schema.name + '.graphql');
    fs.ensureFileSync(modelFilePath);
    fs.writeFileSync(modelFilePath, typeDefs.join('\n\n'));
    this.linker.log('info', 'Generated graphql model: ' + modelFilePath);
  }

  _generateEntityManifest(schema) {
    let entities = Object.keys(schema.entities).sort().reduce((result, v) => {
      result[v] = {};
      return result;
    }, {});
    let outputFilePath = path.resolve(this.manifestPath, schema.name + '.manifest.json');
    fs.ensureFileSync(outputFilePath);
    fs.writeFileSync(outputFilePath, JSON.stringify(entities, null, 4));
    this.linker.log('info', 'Generated schema manifest: ' + outputFilePath);
  }

}

module.exports = GraphQLModeler;
//# sourceMappingURL=GraphQL.js.map