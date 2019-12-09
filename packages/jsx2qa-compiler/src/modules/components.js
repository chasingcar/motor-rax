const { join, relative, dirname, resolve } = require('path');
const { readJSONSync } = require('fs-extra');
const resolveModule = require('resolve');
const t = require('@babel/types');
const { _transform: transformTemplate } = require('./element');
const genExpression = require('../codegen/genExpression');
const traverse = require('../utils/traverseNodePath');
const moduleResolve = require('../utils/moduleResolve');
const createJSX = require('../utils/createJSX');
const Expression = require('../utils/Expression');
const compiledComponents = require('../compiledComponents');
const baseComponents = require('../baseComponents');
const replaceComponentTagName = require('../utils/replaceComponentTagName');

const RELATIVE_COMPONENTS_REG = /^\..*(\.jsx?)?$/i;
const PKG_NAME_REG = /^.*\/node_modules\/([^\/]*).*$/;
let tagCount = 0;

/**
 * Transform the component name is identifier
 * @param {Object} path
 * @param {Object} alias
 * @param {Object} dynamicValue
 * @param {Object} parsed
 * @param {Object} options
 */
function transformIdentifierComponentName(path, alias, dynamicValue, parsed, options) {
  const { node, parentPath } = path;
  const {
    renderFunctionPath,
    componentDependentProps,
  } = parsed;
  // Miniapp template tag name does not support special characters.
  const componentTag = alias.name.replace(/@|\//g, '_');
  const pureComponentTag = componentTag.replace('_ali_', '')
  replaceComponentTagName(path, t.jsxIdentifier(pureComponentTag));

  if (!compiledComponents[componentTag]) {
    const parentJSXListEl = path.findParent(p => p.node.__jsxlist);
    // <tag __tagId="tagId" />
    let tagId = '' + tagCount++;

    if (parentJSXListEl) {
      const { args } = parentJSXListEl.node.__jsxlist;
      const indexValue = args.length > 1 ? genExpression(args[1]) : 'index';
      parentPath.node.__tagIdExpression = [tagId, new Expression(indexValue)];
      tagId += '-{{' + indexValue + '}}';
    }
    parentPath.node.__tagId = tagId;
    componentDependentProps[tagId] = componentDependentProps[tagId] || {};
    if (parentPath.node.__tagIdExpression) {
      componentDependentProps[tagId].tagIdExpression =
        parentPath.node.__tagIdExpression;

      if (renderFunctionPath) {
        const { loopFnBody } = parentJSXListEl.node.__jsxlist;
        componentDependentProps[tagId].parentNode = loopFnBody.body;
      }
    }

    if (baseComponents.indexOf(componentTag) < 0) {
      node.attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier('parent-id'),
          t.stringLiteral('{{tag-id}}'),
        ),
      );
    }

    node.attributes.push(
      t.jsxAttribute(t.jsxIdentifier('tag-id'), t.stringLiteral(tagId)),
    );

    /**
     * Handle with special attrs.
     */
    if (!RELATIVE_COMPONENTS_REG.test(alias.from)) {
      const pkg = getComponentConfig(alias.from, options.resourcePath);
      if (
        pkg &&
        pkg.miniappConfig &&
        Array.isArray(pkg.miniappConfig.renderSlotProps)
      ) {
        path.traverse({
          JSXAttribute(attrPath) {
            const { node } = attrPath;
            if (
              pkg.miniappConfig.renderSlotProps.indexOf(node.name.name) > -1
            ) {
              if (t.isJSXExpressionContainer(node.value)) {
                let fnExp;
                if (t.isFunction(node.value.expression)) {
                  fnExp = node.value.expression;
                } else if (t.isIdentifier(node.value.expression)) {
                  const binding = attrPath.scope.getBinding(
                    node.value.expression.name,
                  );
                  fnExp = binding.path.node;
                } else if (t.isMemberExpression(node.value.expression)) {
                  throw new Error(
                    `NOT_SUPPORTED: Not support MemberExpression at render function: "${genExpression(
                      node,
                    )}", please use anonymous function instead.`,
                  );
                }

                if (fnExp) {
                  const { params, body } = fnExp;
                  let jsxEl = body;
                  if (t.isBlockStatement(body)) {
                    const returnEl = body.body.filter(el =>
                      t.isReturnStatement(el),
                    )[0];
                    if (returnEl) jsxEl = returnEl.argument;
                  }
                  const {
                    node: slotComponentNode,
                    dynamicValue: slotComponentDynamicValue,
                  } = createSlotComponent(jsxEl, node.name.name, params);
                  Object.assign(dynamicValue, slotComponentDynamicValue);
                  path.parentPath.node.children.push(slotComponentNode);
                }
                attrPath.remove();
              }
            }
          },
        });
      }
    }
    return componentTag;
  }
}

function transformComponents(parsed, options) {
  const { ast, templateAST, imported } = parsed;
  const dynamicValue = {};
  const contextList = [];
  const componentsAlias = {};
  traverse(templateAST, {
    JSXOpeningElement(path) {
      const { node } = path;
      if (t.isJSXIdentifier(node.name)) {
        // <View/>
        const alias = getComponentAlias(node.name.name, imported);
        if (alias) {
          removeImport(ast, alias);
          const componentTag = transformIdentifierComponentName(path, alias, dynamicValue, parsed, options);
          if (componentTag) {
            // Collect renamed component tag & path info
            componentsAlias[componentTag] = alias;
          }
        }
      } else if (t.isJSXMemberExpression(node.name)) {
        // <RecyclerView.Cell /> or <Context.Provider>
        const { object, property } = node.name;
        if (t.isJSXIdentifier(object) && t.isJSXIdentifier(property)) {
          if (property.name === 'Provider') {
            // <Context.Provider>
            const valueAttribute = node.attributes.find(a =>
              t.isJSXIdentifier(a.name, { name: 'value' }),
            );
            const contextInitValue = valueAttribute.value.expression;
            const contextItem = {
              contextInitValue,
              contextName: object.name,
            };
            contextList.push(contextItem);
            replaceComponentTagName(path, t.jsxIdentifier('block'));
            node.attributes = [];
          } else {
            // <RecyclerView.Cell />
            const alias = getComponentAlias(object.name, imported);
            removeImport(parsed.ast, alias);
            if (alias) {
              const pkg = getComponentConfig(alias.from, options.resourcePath);
              if (
                pkg &&
                pkg.miniappConfig &&
                pkg.miniappConfig.subComponents &&
                pkg.miniappConfig.subComponents[property.name]
              ) {
                let subComponent =
                  pkg.miniappConfig.subComponents[property.name];
                replaceComponentTagName(
                  path,
                  t.jsxIdentifier(subComponent.tagNameMap),
                );
                // subComponent default style
                if (subComponent.attributes && subComponent.attributes.style) {
                  node.attributes.push(
                    t.jsxAttribute(
                      t.jsxIdentifier('style'),
                      t.stringLiteral(subComponent.attributes.style),
                    ),
                  );
                }
              }
            }
          }
        } else {
          throw new Error(
            `NOT_SUPPORTED: Unsupported type of sub components. ${genExpression(
              node,
            )}`,
          );
        }
      }
    },
    JSXExpressionContainer(path) {
      const { node, parentPath } = path;
      // Only process under JSXEelement
      if (parentPath.isJSXElement()) {
        if (
          ['this.props.children', 'props.children', 'children'].indexOf(
            genExpression(node.expression),
          ) > -1
        ) {
          path.replaceWith(createJSX('slot'));
        }
      }
    },
  });
  return {
    contextList,
    dynamicValue,
    componentsAlias
  };
}

function transformComTemplate(parsed, options, code) {
  const { ast, templateAST, imported, usingComponents } = parsed;
  traverse(templateAST, {
    JSXOpeningElement(path) {
      const { node, parentPath } = path;
      if(node.name.name === 'template') {
        Object.keys(usingComponents).forEach((v) => {
          parentPath.node.children.unshift(createJSX('import', {
            src: t.stringLiteral(usingComponents[v]),
            name: t.stringLiteral(v)
          }))
        })
      }
    }
  })
}

/**
 * Rax components.
 */
module.exports = {
  parse(parsed, code, options) {
    if (!parsed.componentDependentProps) {
      parsed.componentDependentProps = {};
    }
    const { contextList, dynamicValue, componentsAlias } = transformComponents(parsed, options, code);
    console.log('componentsAlias', componentsAlias);
    // Collect used components
    Object.keys(componentsAlias).forEach(componentTag => {
      if (!parsed.usingComponents) {
        parsed.usingComponents = {};
      }
      // _ali_motor-rax-image => motor-rax-image
      parsed.usingComponents[componentTag.replace('_ali_', '')] = getComponentPath(componentsAlias[componentTag], options);
    });
    transformComTemplate(parsed, options, code)
    // Assign used context
    parsed.contextList = contextList;
    // Collect dynamicValue
    if (parsed.dynamicValue) {
      Object.assign(parsed.dynamicValue, dynamicValue);
    } else {
      parsed.dynamicValue = dynamicValue;
    }
  },
  generate(ret, parsed, options) {
    ret.usingComponents = parsed.usingComponents;
  },
  // For test case.
  _transformComponents: transformComponents,
  _transformComTemplate: transformComTemplate
};

function getComponentAlias(tagName, imported) {
  if (imported) {
    for (let [key, value] of Object.entries(imported)) {
      for (let i = 0, l = value.length; i < l; i++) {
        if (value[i].local === tagName)
          return Object.assign({ from: key }, value[i]);
      }
    }
  }
}

function getComponentConfig(pkgName, resourcePath) {
  const pkgPath = moduleResolve(resourcePath, join(pkgName, 'package.json'));
  if (!pkgPath) {
    throw new Error(
      `MODULE_NOT_RESOLVE: Can not resolve rax component "${pkgName}", please check you have this module installed.`,
    );
  }
  return readJSONSync(pkgPath);
}

// for tnpm, the package name will be like _rax-image@1.1.2@rax-image
function getRealNpmPkgName(filePath) {
  const result = PKG_NAME_REG.exec(filePath);
  return result && result[1];
}

function getComponentPath(alias, options) {
  if (RELATIVE_COMPONENTS_REG.test(alias.from)) {
    // alias.local
    if (!options.resourcePath) {
      throw new Error('`resourcePath` must be passed to calc dependency path.');
    }

    const filename =
      moduleResolve(options.resourcePath, alias.from, '.jsx') ||
      moduleResolve(options.resourcePath, alias.from, '.js');
    return filename;
  } else {
    const { disableCopyNpm } = options;
    const realNpmFile = resolveModule.sync(alias.from, { basedir: dirname(options.resourcePath), preserveSymlinks: false });
    const pkgName = getRealNpmPkgName(realNpmFile);
    // npm module
    const pkg = getComponentConfig(alias.from, options.resourcePath);
    let mainName = 'main';
    if (options.platform.type !== 'quickapp') {
      mainName += `:${options.platform.type}`;
    }
    if (pkg.miniappConfig && pkg.miniappConfig[mainName]) {
      if (disableCopyNpm) {
        return join(pkg.name, pkg.miniappConfig[mainName]);
      }

      const targetFileDir = dirname(join(options.outputPath, relative(options.sourcePath, options.resourcePath)));
      let npmRelativePath = relative(targetFileDir, join(options.outputPath, '/npm'));
      npmRelativePath = npmRelativePath[0] !== '.' ? './' + npmRelativePath : npmRelativePath;

      const miniappConfigRelativePath = relative(pkg.main, pkg.miniappConfig[mainName]);
      const realMiniappAbsPath = resolve(realNpmFile, miniappConfigRelativePath);
      const realMiniappRelativePath = realMiniappAbsPath.slice(realMiniappAbsPath.indexOf(pkgName) + pkgName.length);
      return './' + join(npmRelativePath, pkgName.replace(/@/g, '_'), realMiniappRelativePath);
    } else {
      console.warn(
        'Can not found compatible rax miniapp component "' + pkg.name + '".',
      );
    }
  }
}

function removeImport(ast, alias) {
  if (!alias) return;
  traverse(ast, {
    ImportDeclaration(path) {
      const { node } = path;
      if (t.isStringLiteral(node.source) && node.source.value === alias.from) {
        path.remove();
      }
    },
  });
}

function createSlotComponent(jsxEl, slotName, args) {
  const params = {};
  if (Array.isArray(args)) {
    args.forEach(id => params[id.name] = true);
  }

  let enableScopeSlot = false;

  traverse(jsxEl, {
    Identifier(path) {
      if (params[path.node.name]) {
        path.replaceWith(t.identifier(`props.${path.node.name}`));
        enableScopeSlot = true;
      }
    },
  });

  const dynamicValue = transformTemplate(jsxEl, slotName);
  // Remove dynamicValue that created by params.
  Object.keys(dynamicValue).forEach(key => {
    if (params.hasOwnProperty(key) || /^props\./.test(key))
      delete dynamicValue[key];
  });

  if (enableScopeSlot) {
    // Add scope slot
    jsxEl.openingElement.attributes.push(
      t.jsxAttribute(t.jsxIdentifier('slot-scope'), t.stringLiteral('props')),
    );
  }

  // Add slot attr
  jsxEl.openingElement.attributes.push(
    t.jsxAttribute(t.jsxIdentifier('slot'), t.stringLiteral(slotName)),
  );

  return { dynamicValue, node: jsxEl };
}
