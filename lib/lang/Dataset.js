"use strict";

require("source-map-support/register");

const {
  _
} = require('rk-utils');

const {
  deepCloneField,
  Clonable,
  isDotSeparateName
} = require('./GemlUtils');

class Dataset extends Clonable {
  constructor(linker, name, gemlModule, info) {
    this.linker = linker;
    this.name = _.camelCase(name);
    this.gemlModule = gemlModule;
    this.info = info;
  }

  link() {
    if (this.info.entity) {
      let entity = this.linker.getReferencedEntity(this.gemlModule, this.info.entity);
      this.mainEntity = entity.name;
    } else {
      let dataset = this.linker.loadDataset(this.gemlModule, this.info.dataset);
      this.mainEntity = dataset.mainEntity;
      this.joinWith = _.cloneDeep(dataset.joinWith);
    }

    if (!_.isEmpty(this.info.joinWith)) {
      if (!this.joinWith) {
        this.joinWith = _.cloneDeep(this.info.joinWith);
      } else {
        this.joinWith = this.joinWith.concat(this.info.joinWith);
      }
    }

    this.linked = true;
    return this;
  }

  buildHierarchy(inSchema) {
    return this._flattenDataset(inSchema, this);
  }

  _flattenDataset(inSchema, dataset) {
    let hierarchy = {};
    let leftEntity = inSchema.entities[dataset.mainEntity];

    if (dataset.joinWith) {
      dataset.joinWith.forEach(joining => {
        let leftField, rightEntity, rightField;

        if (isDotSeparateName(joining.on.left)) {
          let lastPos = joining.on.left.lastIndexOf('.');
          let fieldRef = joining.on.left.substr(lastPos + 1);
          let entityRef = joining.on.left.substr(0, lastPos);

          if (entityRef === leftEntity.name) {
            leftField = leftEntity.getEntityAttribute(fieldRef);
          } else {
            throw new Error(`Unsupported syntax of left side joining field "${joining.on.left}".`);
          }
        } else {
          leftField = leftEntity.getEntityAttribute(joining.on.left);
        }

        if (joining.dataset) {
          let rightHierarchy = inSchema.getDocumentHierachy(this.gemlModule, joining.dataset);

          if (isDotSeparateName(joining.on.right)) {
            let parts = joining.on.right.split('.');

            if (parts.length > 2) {
              throw new Error('Joining a document should only referencing to a field of its main entity.');
            }

            let [entityRef, fieldRef] = parts;

            if (entityRef !== rightHierarchy.entity) {
              throw new Error(`Referenced field "${joining.on.right}" not found while linking to document "${joining.dataset}".`);
            }

            rightEntity = inSchema.entities[entityRef];
            rightField = rightEntity.getEntityAttribute(fieldRef);
            hierarchy[leftField.name] = Object.assign({}, rightHierarchy, {
              linkWithField: rightField.name
            });
            return;
          }

          rightEntity = inSchema.entities[joining.dataset.mainEntity];
        } else {
          rightEntity = inSchema.entities[joining.entity];

          if (isDotSeparateName(joining.on.right)) {
            throw new Error(`Referenced field "${joining.on.right}" not found while linking to entity "${joining.entity}".`);
          }
        }

        rightField = rightEntity.getEntityAttribute(joining.on.right);
        hierarchy[leftField.name] = {
          oolType: 'DocumentHierarchyNode',
          entity: rightEntity.name,
          linkWithField: rightField.name
        };
      });
    }

    return {
      oolType: 'DocumentHierarchyNode',
      entity: leftEntity.name,
      subDocuments: hierarchy
    };
  }

  clone() {
    super.clone();
    let dataset = new Dataset(this.linker, this.name, this.gemlModule, this.info);
    dataset.mainEntity = this.mainEntity;
    deepCloneField(this, dataset, 'joinWith');
    dataset.linked = true;
    return dataset;
  }

  toJSON() {
    return {
      name: this.name,
      mainEntity: this.mainEntity.toJSON(),
      joinWith: this.joinWith
    };
  }

}

module.exports = Dataset;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9sYW5nL0RhdGFzZXQuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJkZWVwQ2xvbmVGaWVsZCIsIkNsb25hYmxlIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJEYXRhc2V0IiwiY29uc3RydWN0b3IiLCJsaW5rZXIiLCJuYW1lIiwiZ2VtbE1vZHVsZSIsImluZm8iLCJjYW1lbENhc2UiLCJsaW5rIiwiZW50aXR5IiwiZ2V0UmVmZXJlbmNlZEVudGl0eSIsIm1haW5FbnRpdHkiLCJkYXRhc2V0IiwibG9hZERhdGFzZXQiLCJqb2luV2l0aCIsImNsb25lRGVlcCIsImlzRW1wdHkiLCJjb25jYXQiLCJsaW5rZWQiLCJidWlsZEhpZXJhcmNoeSIsImluU2NoZW1hIiwiX2ZsYXR0ZW5EYXRhc2V0IiwiaGllcmFyY2h5IiwibGVmdEVudGl0eSIsImVudGl0aWVzIiwiZm9yRWFjaCIsImpvaW5pbmciLCJsZWZ0RmllbGQiLCJyaWdodEVudGl0eSIsInJpZ2h0RmllbGQiLCJvbiIsImxlZnQiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJmaWVsZFJlZiIsInN1YnN0ciIsImVudGl0eVJlZiIsImdldEVudGl0eUF0dHJpYnV0ZSIsIkVycm9yIiwicmlnaHRIaWVyYXJjaHkiLCJnZXREb2N1bWVudEhpZXJhY2h5IiwicmlnaHQiLCJwYXJ0cyIsInNwbGl0IiwibGVuZ3RoIiwiT2JqZWN0IiwiYXNzaWduIiwibGlua1dpdGhGaWVsZCIsIm9vbFR5cGUiLCJzdWJEb2N1bWVudHMiLCJjbG9uZSIsInRvSlNPTiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsY0FBRjtBQUFrQkMsRUFBQUEsUUFBbEI7QUFBNEJDLEVBQUFBO0FBQTVCLElBQWtESCxPQUFPLENBQUMsYUFBRCxDQUEvRDs7QUFN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QUc7QUFDSixVQUFNQSxLQUFOO0FBRUEsUUFBSXRDLE9BQU8sR0FBRyxJQUFJWCxPQUFKLENBQVksS0FBS0UsTUFBakIsRUFBeUIsS0FBS0MsSUFBOUIsRUFBb0MsS0FBS0MsVUFBekMsRUFBcUQsS0FBS0MsSUFBMUQsQ0FBZDtBQUVBTSxJQUFBQSxPQUFPLENBQUNELFVBQVIsR0FBcUIsS0FBS0EsVUFBMUI7QUFDQWIsSUFBQUEsY0FBYyxDQUFDLElBQUQsRUFBT2MsT0FBUCxFQUFnQixVQUFoQixDQUFkO0FBRUFBLElBQUFBLE9BQU8sQ0FBQ00sTUFBUixHQUFpQixJQUFqQjtBQUVBLFdBQU9OLE9BQVA7QUFDSDs7QUFPRHVDLEVBQUFBLE1BQU0sR0FBRztBQUNMLFdBQU87QUFDSC9DLE1BQUFBLElBQUksRUFBRSxLQUFLQSxJQURSO0FBRUhPLE1BQUFBLFVBQVUsRUFBRSxLQUFLQSxVQUFMLENBQWdCd0MsTUFBaEIsRUFGVDtBQUdIckMsTUFBQUEsUUFBUSxFQUFFLEtBQUtBO0FBSFosS0FBUDtBQUtIOztBQWxMMEI7O0FBcUwvQnNDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBELE9BQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IHsgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgZGVlcENsb25lRmllbGQsIENsb25hYmxlLCBpc0RvdFNlcGFyYXRlTmFtZSB9ID0gcmVxdWlyZSgnLi9HZW1sVXRpbHMnKTtcblxuLyoqXG4gKiBPb2xvbmcgZGF0YXNldCBjbGFzcy5cbiAqIEBjbGFzcyBPb2xvbmdEYXRhc2V0XG4gKi9cbmNsYXNzIERhdGFzZXQgZXh0ZW5kcyBDbG9uYWJsZSB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09vbG9uZ0xpbmtlcn0gbGlua2VyXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgLSBEYXRhc2V0IG5hbWVcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZ2VtbE1vZHVsZSAtIFNvdXJjZSBvb2wgbW9kdWxlXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGluZm8gLSBEYXRhc2V0IGluZm9cbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihsaW5rZXIsIG5hbWUsIGdlbWxNb2R1bGUsIGluZm8pIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIExpbmtlciB0byBwcm9jZXNzIHRoaXMgZG9jdW1lbnRcbiAgICAgICAgICogQG1lbWJlciB7T29sb25nTGlua2VyfVxuICAgICAgICAgKi9cbiAgICAgICAgdGhpcy5saW5rZXIgPSBsaW5rZXI7XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIE5hbWUgb2YgdGhpcyBkb2N1bWVudFxuICAgICAgICAgKiBAbWVtYmVyIHtzdHJpbmd9XG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLm5hbWUgPSBfLmNhbWVsQ2FzZShuYW1lKTtcblxuICAgICAgICAvKipcbiAgICAgICAgICogT3duZXIgb29sb25nIG1vZHVsZVxuICAgICAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLmdlbWxNb2R1bGUgPSBnZW1sTW9kdWxlO1xuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBSYXcgbWV0YWRhdGFcbiAgICAgICAgICogQG1lbWJlciB7T2JqZWN0fVxuICAgICAgICAgKi9cbiAgICAgICAgdGhpcy5pbmZvID0gaW5mbztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBsaW5raW5nIHRoaXMgZGF0YXNldFxuICAgICAqIEByZXR1cm5zIHtPb2xvbmdEYXRhc2V0fVxuICAgICAqL1xuICAgIGxpbmsoKSB7XG4gICAgICAgIHByZTogIXRoaXMubGlua2VkO1xuXG4gICAgICAgIGlmICh0aGlzLmluZm8uZW50aXR5KSB7XG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gdGhpcy5saW5rZXIuZ2V0UmVmZXJlbmNlZEVudGl0eSh0aGlzLmdlbWxNb2R1bGUsIHRoaXMuaW5mby5lbnRpdHkpO1xuICAgICAgICAgICAgdGhpcy5tYWluRW50aXR5ID0gZW50aXR5Lm5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZGF0YXNldCA9IHRoaXMubGlua2VyLmxvYWREYXRhc2V0KHRoaXMuZ2VtbE1vZHVsZSwgdGhpcy5pbmZvLmRhdGFzZXQpO1xuICAgICAgICAgICAgYXNzZXJ0OiBkYXRhc2V0LmxpbmtlZDtcblxuICAgICAgICAgICAgdGhpcy5tYWluRW50aXR5ID0gZGF0YXNldC5tYWluRW50aXR5O1xuICAgICAgICAgICAgdGhpcy5qb2luV2l0aCA9IF8uY2xvbmVEZWVwKGRhdGFzZXQuam9pbldpdGgpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh0aGlzLmluZm8uam9pbldpdGgpKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuam9pbldpdGgpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmpvaW5XaXRoID0gXy5jbG9uZURlZXAodGhpcy5pbmZvLmpvaW5XaXRoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5qb2luV2l0aCA9IHRoaXMuam9pbldpdGguY29uY2F0KHRoaXMuaW5mby5qb2luV2l0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmxpbmtlZCA9IHRydWU7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgYnVpbGRIaWVyYXJjaHkoaW5TY2hlbWEpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2ZsYXR0ZW5EYXRhc2V0KGluU2NoZW1hLCB0aGlzKTtcbiAgICB9XG5cbiAgICBfZmxhdHRlbkRhdGFzZXQoaW5TY2hlbWEsIGRhdGFzZXQpIHtcbiAgICAgICAgbGV0IGhpZXJhcmNoeSA9IHt9O1xuICAgICAgICBsZXQgbGVmdEVudGl0eSA9IGluU2NoZW1hLmVudGl0aWVzW2RhdGFzZXQubWFpbkVudGl0eV07XG5cbiAgICAgICAgaWYgKGRhdGFzZXQuam9pbldpdGgpIHtcbiAgICAgICAgICAgIGRhdGFzZXQuam9pbldpdGguZm9yRWFjaChqb2luaW5nID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdEZpZWxkLCByaWdodEVudGl0eSwgcmlnaHRGaWVsZDtcblxuICAgICAgICAgICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShqb2luaW5nLm9uLmxlZnQpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBsYXN0UG9zID0gam9pbmluZy5vbi5sZWZ0Lmxhc3RJbmRleE9mKCcuJyk7XG4gICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZFJlZiA9IGpvaW5pbmcub24ubGVmdC5zdWJzdHIobGFzdFBvcysxKTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGVudGl0eVJlZiA9IGpvaW5pbmcub24ubGVmdC5zdWJzdHIoMCwgbGFzdFBvcyk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGVudGl0eVJlZiA9PT0gbGVmdEVudGl0eS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZWZ0RmllbGQgPSBsZWZ0RW50aXR5LmdldEVudGl0eUF0dHJpYnV0ZShmaWVsZFJlZik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHN5bnRheCBvZiBsZWZ0IHNpZGUgam9pbmluZyBmaWVsZCBcIiR7am9pbmluZy5vbi5sZWZ0fVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL2ZpZWxkIG9mIGxlZnRFbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGVmdEZpZWxkID0gbGVmdEVudGl0eS5nZXRFbnRpdHlBdHRyaWJ1dGUoam9pbmluZy5vbi5sZWZ0KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoam9pbmluZy5kYXRhc2V0KSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCByaWdodEhpZXJhcmNoeSA9IGluU2NoZW1hLmdldERvY3VtZW50SGllcmFjaHkodGhpcy5nZW1sTW9kdWxlLCBqb2luaW5nLmRhdGFzZXQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShqb2luaW5nLm9uLnJpZ2h0KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHBhcnRzID0gam9pbmluZy5vbi5yaWdodC5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0pvaW5pbmcgYSBkb2N1bWVudCBzaG91bGQgb25seSByZWZlcmVuY2luZyB0byBhIGZpZWxkIG9mIGl0cyBtYWluIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgZW50aXR5UmVmLCBmaWVsZFJlZiBdID0gcGFydHM7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlbnRpdHlSZWYgIT09IHJpZ2h0SGllcmFyY2h5LmVudGl0eSkge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIGZpZWxkIFwiJHtqb2luaW5nLm9uLnJpZ2h0fVwiIG5vdCBmb3VuZCB3aGlsZSBsaW5raW5nIHRvIGRvY3VtZW50IFwiJHtqb2luaW5nLmRhdGFzZXR9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWhpZXJhcmNoeVtsZWZ0RmllbGQubmFtZV0sICdEdXBsaWNhdGUgam9pbmluZ3Mgb24gdGhlIHNhbWUgZmllbGQgb2YgdGhlIGxlZnQgc2lkZSBlbnRpdHkuJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHRFbnRpdHkgPSBpblNjaGVtYS5lbnRpdGllc1tlbnRpdHlSZWZdO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmlnaHRGaWVsZCA9IHJpZ2h0RW50aXR5LmdldEVudGl0eUF0dHJpYnV0ZShmaWVsZFJlZik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGhpZXJhcmNoeVtsZWZ0RmllbGQubmFtZV0gPSBPYmplY3QuYXNzaWduKHt9LCByaWdodEhpZXJhcmNoeSwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpbmtXaXRoRmllbGQ6IHJpZ2h0RmllbGQubmFtZVxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vam9pbmluZy5vbi5yaWdodCBpcyBmaWVsZCBuYW1lIG9mIHRoZSBtYWluIGVudGl0eVxuICAgICAgICAgICAgICAgICAgICByaWdodEVudGl0eSA9IGluU2NoZW1hLmVudGl0aWVzW2pvaW5pbmcuZGF0YXNldC5tYWluRW50aXR5XTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodEVudGl0eSA9IGluU2NoZW1hLmVudGl0aWVzW2pvaW5pbmcuZW50aXR5XTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoam9pbmluZy5vbi5yaWdodCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBmaWVsZCBcIiR7am9pbmluZy5vbi5yaWdodH1cIiBub3QgZm91bmQgd2hpbGUgbGlua2luZyB0byBlbnRpdHkgXCIke2pvaW5pbmcuZW50aXR5fVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9maWVsZCBvZiByaWdodEVudGl0eVxuICAgICAgICAgICAgICAgIHJpZ2h0RmllbGQgPSByaWdodEVudGl0eS5nZXRFbnRpdHlBdHRyaWJ1dGUoam9pbmluZy5vbi5yaWdodCk7XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6ICFoaWVyYXJjaHlbbGVmdEZpZWxkLm5hbWVdLCAnRHVwbGljYXRlIGpvaW5pbmdzIG9uIHRoZSBzYW1lIGZpZWxkIG9mIHRoZSBsZWZ0IHNpZGUgZW50aXR5Lic7XG5cbiAgICAgICAgICAgICAgICBoaWVyYXJjaHlbbGVmdEZpZWxkLm5hbWVdID0ge1xuICAgICAgICAgICAgICAgICAgICBvb2xUeXBlOiAnRG9jdW1lbnRIaWVyYXJjaHlOb2RlJyxcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiByaWdodEVudGl0eS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBsaW5rV2l0aEZpZWxkOiByaWdodEZpZWxkLm5hbWVcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb29sVHlwZTogJ0RvY3VtZW50SGllcmFyY2h5Tm9kZScsXG4gICAgICAgICAgICBlbnRpdHk6IGxlZnRFbnRpdHkubmFtZSxcbiAgICAgICAgICAgIHN1YkRvY3VtZW50czogaGllcmFyY2h5XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvbmUgdGhlIGRvY3VtZW50XG4gICAgICogQHJldHVybnMge09vbG9uZ0RhdGFzZXR9XG4gICAgICovXG4gICAgY2xvbmUoKSB7XG4gICAgICAgIHN1cGVyLmNsb25lKCk7XG5cbiAgICAgICAgbGV0IGRhdGFzZXQgPSBuZXcgRGF0YXNldCh0aGlzLmxpbmtlciwgdGhpcy5uYW1lLCB0aGlzLmdlbWxNb2R1bGUsIHRoaXMuaW5mbyk7XG5cbiAgICAgICAgZGF0YXNldC5tYWluRW50aXR5ID0gdGhpcy5tYWluRW50aXR5O1xuICAgICAgICBkZWVwQ2xvbmVGaWVsZCh0aGlzLCBkYXRhc2V0LCAnam9pbldpdGgnKTtcblxuICAgICAgICBkYXRhc2V0LmxpbmtlZCA9IHRydWU7XG5cbiAgICAgICAgcmV0dXJuIGRhdGFzZXQ7XG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBUcmFuc2xhdGUgdGhlIGRvY3VtZW50IGludG8gYSBwbGFpbiBKU09OIG9iamVjdFxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgdG9KU09OKCkge1xuICAgICAgICByZXR1cm4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbmFtZTogdGhpcy5uYW1lLFxuICAgICAgICAgICAgbWFpbkVudGl0eTogdGhpcy5tYWluRW50aXR5LnRvSlNPTigpLFxuICAgICAgICAgICAgam9pbldpdGg6IHRoaXMuam9pbldpdGhcbiAgICAgICAgfTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRGF0YXNldDsiXX0=