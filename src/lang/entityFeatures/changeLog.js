"use strict";

const { _ } = require('rk-utils');

const FEATURE_NAME = 'changeLog';

/**
 * Keep track of changes made to the entity.
 * @module EntityFeature_ChangeLog
 */

/**
 * Initialize the feature
 * @param {OolongEntity} entity - Entity to apply this feature
 */
function feature(entity, args = []) {
    let [ options ] = args;

    options = { storeEntity: 'changeLogs', ...options };

    entity.addFeature(FEATURE_NAME, options);
}

module.exports = feature;