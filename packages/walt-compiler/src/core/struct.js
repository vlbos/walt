/**
 * Structs Plugin
 *
 * @flow
 */
import Syntax from 'walt-syntax';
import invariant from 'invariant';
import { find } from 'walt-parser-tools/scope';
import walkNode from 'walt-parser-tools/walk-node';
import { extendNode } from '../utils/extend-node';
import type { NodeType, SemanticPlugin } from '../flow/types';

const STRUCT_NATIVE_TYPE = 'i32';
const DIRECT_ADDRESS = '__DIRECT_ADDRESS__';
const sizeMap = {
  i64: 8,
  f64: 8,
  i32: 4,
  f32: 4,
  [DIRECT_ADDRESS]: 4,
};

export const getByteOffsetsAndSize = (objectLiteralNode: NodeType) => {
  const offsetsByKey = {};
  const keyTypeMap = {};
  let size = 0;
  walkNode({
    [Syntax.Pair]: keyTypePair => {
      const [lhs] = keyTypePair.params;
      const key = lhs.value;
      const type = keyTypePair.params[1].value;

      invariant(
        offsetsByKey[key] == null,
        `Duplicate key ${key} not allowed in object type`
      );

      keyTypeMap[key] = `${lhs.Type === 'AddressOf' ? '&' : ''}${type}`;
      offsetsByKey[key] = size;
      size += sizeMap[type] || 4;
    },
  })(objectLiteralNode);

  return [offsetsByKey, size, keyTypeMap];
};

type StructType = {
  load: NodeType,
  store: any => NodeType,
  offset: NodeType,
  type: string,
};
const makeStruct = stmt => (base, field): StructType => {
  const unreachable = stmt`throw;`;
  const fatal = {
    load: extendNode(
      { range: field.range },
      stmt`i32.load(${unreachable}, ${unreachable});`
    ),
    store: rhs =>
      extendNode(
        { range: field.range },
        stmt`i32.store(${unreachable}, ${rhs});`
      ),
    offset: unreachable,
    type: 'void',
  };
  if (base.meta.STRUCT_TYPE == null) {
    return fatal;
  }

  const typedef = base.meta.STRUCT_TYPE;
  const offsetMap = typedef.meta.TYPE_OBJECT;
  const typeMap = typedef.meta.OBJECT_KEY_TYPES;
  const address = offsetMap[field.value];

  if (address == null) {
    return fatal;
  }

  let type = typeMap[field.value];
  const direct = type[0] === '&';
  const offset = address ? stmt`(${base} + ${address});` : stmt`(${base});`;
  let STRUCT_TYPE = null;
  let TYPE_ARRAY = null;

  // Nested stuct type access
  if (type != null && typeof type === 'object') {
    STRUCT_TYPE = type;
    type = STRUCT_NATIVE_TYPE;
  }

  if (String(type).endsWith('[]')) {
    TYPE_ARRAY = type.slice(0, -2).replace('&', '');
    type = 'i32';
  }

  const withMeta = extendNode({
    range: base.range,
    meta: { STRUCT_TYPE, TYPE_ARRAY },
  });

  return {
    offset,
    type,
    store: rhs => withMeta(stmt`${type}.store(${offset}, ${rhs});`),
    load: withMeta(direct ? offset : stmt`${type}.load(${offset});`),
  };
};

export default function Struct(): SemanticPlugin {
  return {
    semantics({ stmt }) {
      const structure = makeStruct(stmt);

      function access(_next) {
        return (args, transform) => {
          const [node, context] = args;
          const [lookup, key] = node.params;
          const s = structure(transform([lookup, context]), key);
          return transform([s.load, context]);
        };
      }

      function fieldAssignment(args, transform) {
        const [node, context] = args;
        const [lhs, rhs] = node.params;
        const [root, key] = lhs.params;
        const s = structure(transform([root, context]), key);
        return transform([s.store(rhs), context]);
      }

      function objectAssignment(args, transform) {
        const [node, context] = args;
        const [lhs, rhs] = node.params;
        const base = transform([lhs, context]);
        const kvs = [];

        // We have to walk the nodes twice, once for regular prop keys and then again
        // for ...(spread)
        walkNode({
          // Top level Identifiers _inside_ an object literal === shorthand
          // Notice that we ignore chld mappers in both Pairs and Spread(s) so the
          // only way this is hit is if the identifier is TOP LEVEL
          [Syntax.Identifier]: (value, _) => {
            const field = structure(base, value);
            kvs.push({ field, value });
          },
          [Syntax.Pair]: (pair, _) => {
            const [property, value] = pair.params;
            const field = structure(base, property);
            kvs.push({ field, value });
          },
          [Syntax.Spread]: (spread, _) => {
            // find userType
            const target = transform([spread.params[0], context]);
            // map over the keys
            Object.keys(target.meta.TYPE_OBJECT).forEach(key => {
              const field = structure(base, {
                value: key,
                type: null,
                range: target.range,
              });
              const s = structure(target, {
                value: key,
                type: null,
                range: target.range,
              });

              kvs.push({
                field,
                value: s.load,
              });
            });
          },
        })(rhs);

        const params: NodeType[] = kvs
          .filter(({ field }) => field != null)
          /* $FlowFixMe */
          .map(kv => transform([kv.field.store(kv.value), context]));

        return {
          ...lhs,
          Type: Syntax.Block,
          params: params,
        };
      }

      return {
        [Syntax.Struct]: _ => ([node, context], transform) => {
          const { userTypes, aliases } = context;
          const [union] = node.params;

          let structNode = {
            ...node,
            meta: {
              ...node.meta,
              TYPE_OBJECT: {},
              OBJECT_SIZE: 0,
              OBJECT_KEY_TYPES: {},
            },
          };

          const Alias = () => {
            aliases[node.value] = union.value;
          };
          const objectLiteral = (obj, __) => {
            const [offsets, size, typeMap] = getByteOffsetsAndSize(obj);
            structNode.meta.TYPE_OBJECT = {
              ...structNode.meta.TYPE_OBJECT,
              ...offsets,
            };
            structNode.meta.OBJECT_SIZE += size;
            structNode.meta.OBJECT_KEY_TYPES = {
              ...structNode.meta.OBJECT_KEY_TYPES,
              ...typeMap,
            };
          };

          const parsers = {
            [Syntax.Type]: Alias,
            [Syntax.Identifier]: Alias,
            [Syntax.ObjectLiteral]: () => {
              objectLiteral(node);
              userTypes[structNode.value] = structNode;
            },
            [Syntax.UnionType]: () => {
              walkNode({
                [Syntax.ObjectLiteral]: objectLiteral,
                [Syntax.ArrayType]: type => {
                  structNode.meta.TYPE_ARRAY = type.type.slice(0, -2);
                },
                [Syntax.Identifier]: id => {
                  const structReference =
                    userTypes[transform([id, context]).value];

                  structNode.meta.TYPE_OBJECT = {
                    ...structNode.meta.TYPE_OBJECT,
                    ...structReference.meta.TYPE_OBJECT,
                  };
                  structNode.meta.OBJECT_SIZE = Math.max(
                    structNode.meta.OBJECT_SIZE,
                    structReference.meta.OBJECT_SIZE
                  );
                  structNode.meta.OBJECT_KEY_TYPES = {
                    ...structNode.meta.OBJECT_KEY_TYPES,
                    ...structReference.meta.OBJECT_KEY_TYPES,
                  };
                },
              })(union);

              userTypes[structNode.value] = structNode;
            },
          };

          parsers[union.Type]();

          // Map over the strings for key types and replace them with struct
          // references where necessary. We do this after creating the object
          // to allow for self-referencing structs (linked lists etc)
          structNode.meta.OBJECT_KEY_TYPES = Object.entries(
            structNode.meta.OBJECT_KEY_TYPES
          ).reduce((acc, [key, value]) => {
            acc[key] = userTypes[value] || value;
            return acc;
          }, {});

          return structNode;
        },
        // Declaration type remapping is done for aliases here but not for struct
        // types since that is achieved in the declaration parser.
        [Syntax.DeclType]: next => (args, transform) => {
          const [node, context] = args;
          const { aliases } = context;

          if (aliases[node.value]) {
            return transform([
              extendNode(
                { value: aliases[node.value], type: aliases[node.value] },
                node
              ),
              context,
            ]);
          }

          return next(args);
        },
        [Syntax.FunctionResult]: next => (args, transform) => {
          const [node, context] = args;
          const { userTypes, aliases } = context;

          // If this type is an alias, then:
          //  * unroll it to be pointed to type
          //  * recursively untill the type is a base type or a struct
          if (aliases[node.type]) {
            // This operation is RECURSIVE, because:
            //
            // transform() applies ALL transforms top to bottom including the one
            // we are in currently.
            return transform([
              extendNode({ type: aliases[node.type] }, node),
              context,
            ]);
          }

          if (!userTypes[String(node.type)]) {
            return next(args);
          }

          return next([
            extendNode(
              {
                type: STRUCT_NATIVE_TYPE,
                meta: { STRUCT_TYPE: userTypes[node.type] },
                params: node.params.map(p => transform([p, context])),
              },
              node
            ),
            context,
          ]);
        },
        [Syntax.Identifier]: next => args => {
          const [node, context] = args;
          const { userTypes, scopes } = context;
          const ref = find(scopes, node.value);
          // Ignore anything not typed as a struct
          if (!(ref && userTypes[ref.type])) {
            return next(args);
          }

          // Convert all struct uses to STRUCT_NATIVE_TYPE types
          return {
            ...node,
            meta: {
              ...node.meta,
              ...ref.meta,
              ...userTypes[ref.type].meta,
              STRUCT_TYPE: userTypes[ref.type],
            },
            type: STRUCT_NATIVE_TYPE,
          };
        },
        [Syntax.Access]: access,
        [Syntax.Assignment]: next => (args, transform) => {
          const [node] = args;
          const [lhs, rhs] = node.params;

          if (lhs.Type === Syntax.Access) {
            return fieldAssignment(args, transform);
          }

          if (rhs.Type === Syntax.ObjectLiteral) {
            return objectAssignment(args, transform);
          }

          return next(args);
        },

        /**
         * Short-circuit parser for Struct[] type array subscripts. Since an
         * array of structs is a contiguous list of struct data in memory we
         * don't want to "load" the data at index into a variable, instead we
         * want the address-of the index!
         */
        [Syntax.ArraySubscript]: next => (args, t) => {
          const [node, context] = args;
          const parsed = next(args);
          if (context.userTypes[parsed.meta.TYPE_ARRAY] == null) {
            return parsed;
          }

          // instead of using a .load() instruction like for native i32s for
          // example, we simply return an offset from base.
          const [base, offset] = node.params.map(p => t([p, context]));

          return t([
            extendNode(
              {
                type: STRUCT_NATIVE_TYPE,
                meta: {
                  STRUCT_TYPE: context.userTypes[parsed.meta.TYPE_ARRAY],
                },
              },
              stmt`(${base} + (${offset} * sizeof(${parsed.meta.TYPE_ARRAY})));`
            ),
            context,
          ]);
        },
      };
    },
  };
}
