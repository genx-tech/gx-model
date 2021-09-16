"use strict";

require("source-map-support/register");

const {
  _
} = require('@genx/july');

function applyRule(db, Entity, entity) {
  const associations = Entity.meta.associations;
  associations && _.forOwn(associations, (assoc, anchor) => {
    const key = ':' + anchor;
    const subEntity = entity[key];

    if (subEntity) {
      if (assoc.list) {
        const SubEntity = db.model(assoc.entity);
        subEntity.forEach(item => {
          delete item[assoc.field];
          applyRule(db, SubEntity, item);
        });
      }
    }
  });
}

;
module.exports = applyRule;
//# sourceMappingURL=removeBackReference.js.map