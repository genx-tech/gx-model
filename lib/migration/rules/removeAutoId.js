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
        subEntity.forEach(item => applyRule(db, SubEntity, item));
      } else {
        const SubEntity = db.model(assoc.entity);
        applyRule(db, SubEntity, subEntity);
        delete entity[anchor];
      }
    }
  });
  const autoId = Entity.meta.features.autoId;

  if (autoId) {
    delete entity[autoId.field];
  }
}

;
module.exports = applyRule;
//# sourceMappingURL=removeAutoId.js.map