const path = require("path");
const fse = require("fs-extra");
const childProcess = require("child_process");

const outputStartKey = "<renderTsxOutput>";
const outputEndKey = "</renderTsxOutput>";
const outputContentRegex = new RegExp(`${outputStartKey}(.*?)${outputEndKey}`);

/**
 * 这个组件主要的流程是，通过插件配置，拿到要生成的页面名称及组件路径。
 * 然后生成一个临时的ssr.ts文件在执行目录下，用 ts-node 执行他
 * 这个文件的作用就是用renderToString在nodejs中渲染出html并console.log出来
 * 主进程根据outputStartKey和endKey这两个特殊标志，从输出中截取渲染好的html
 * 根据index.html的模板，插入生成好的html，生成出一个页面
 */
function generateSsrScript(componentsPath, globalVariables) {
  const importStatement = generateImportStatement(componentsPath);
  const functionRenderTsx = generateRenderTsx(componentsPath);
  const ssrScriptContent = `
  require.extensions['.css'] = () => undefined

  import * as Window from "window";
  import * as _ from "lodash";

  export function declareGlobalVariable(variables) {
    Object.keys(variables).forEach((key) => {
      global[key] = variables[key];
    });
  }

  const window = new Window();
  const customGlobalVariable = ${globalVariables ? JSON.stringify(globalVariables) : "{}"};
  const globalVariable = _.merge({window: window, document: window.document, navigator: window.navigator}, customGlobalVariable);

  declareGlobalVariable(globalVariable);

  import * as React from "react";
  import { renderToString } from "react-dom/server";

  ${importStatement}

  ${functionRenderTsx}

  const result = renderTsx();

  console.log("${outputStartKey}" + JSON.stringify(result) + "${outputEndKey}");
  `;

  return ssrScriptContent;
}

const tempFolder = ".SSRCodegenWebpackPluginTemp";

function execScript(componentsPath, globalVariables, tsConfigFilePath) {
  const ssrScript = generateSsrScript(componentsPath, globalVariables);
  const tempFolderPath = path.resolve(process.cwd(), tempFolder);
  const filePath = path.resolve(tempFolder, "ssr.tsx");
  const tsConfigPath = tsConfigFilePath || path.resolve(process.cwd(), "tsconfig.json");

  fse.removeSync(tempFolderPath);
  fse.outputFileSync(filePath, ssrScript);

  let result = "{}";

  try {
    result = childProcess.execSync(`../node_modules/.bin/ts-node --project ${tsConfigPath} --transpileOnly -r tsconfig-paths/register ${filePath}`, {
      cwd: process.cwd(),
    });
  } catch (e) {
    return { result: null, error: e };
  } finally {
    fse.removeSync(tempFolderPath);
  }

  const matchResult = outputContentRegex.exec(String(result));
  const jsonResult = matchResult && matchResult.length && matchResult.length === 2 ? matchResult[1] : "";

  return { result: JSON.parse(jsonResult), error: null };
}

const componentKey = "Component";

function generateImportStatement(componentsPath) {
  return componentsPath
    .map((componentPath, index) => {
      const componentPathWithoutExtname = componentPath.lastIndexOf(".") !== -1 ? componentPath.slice(0, componentPath.lastIndexOf(".")) : componentPath;
      return `import { default as ${componentKey}${index} } from "${componentPathWithoutExtname}";`;
    })
    .join("\n");
}

function generateRenderTsx(componentsPath) {
  const arrayBody = componentsPath
    .map((componentPath, index) => {
      return `
        "${componentPath}": renderToString(<${componentKey}${index} />),
      `;
    })
    .join("\n");
  const returnArray = `return {${arrayBody}};`;
  const returnFunc = `
  export function renderTsx() {
    ${returnArray}
  }
  `;

  return returnFunc;
}

function SSRCodegenWebpackPlugin(options) {
  this.options = options;
}

SSRCodegenWebpackPlugin.prototype.apply = function(compiler) {
  compiler.plugin("emit", (compilation, cb) => {
    const options = this.options;
    const pages = options.pages;
    const outputPath = options.outputPath;
    const globalVariables = options.globalVariables;
    const tsConfigFilePath = options.tsConfigFilePath;
    const indexHtmlFilename = options.indexHtmlFilename;
    const containerId = options.containerId;
    const assets = {};

    const sourcePaths = Object.keys(pages).map((name) => {
      const sourcePath = pages[name];

      return {
        filePath: name,
        sourcePath: path.resolve(process.cwd(), sourcePath),
      };
    });
    const sourcePathArray = sourcePaths.map((item) => item.sourcePath);
    const { result, error } = execScript(sourcePathArray, globalVariables, tsConfigFilePath);

    if (error != null) {
      compilation.errors.push(error);

      cb();

      return;
    }

    Object.keys(result).forEach((resultSourcePath) => {
      sourcePaths.find((item) => {
        const sourcePath = item.sourcePath;

        if (sourcePath === resultSourcePath) {
          const resultContent = result[resultSourcePath];
          const outputFiltPath = outputPath ? path.join(outputPath, item.filePath) : item.filePath;

          assets[outputFiltPath] = resultContent;
        }
      });
    });

    const indexHtmlAsset = compilation.assets[indexHtmlFilename];
    const indexHtmlContent = indexHtmlAsset.source();
    const indexHtmlReplaceRegex = new RegExp(`(<.*?id="${containerId}">)(</.*?>)`);

    Object.keys(assets).forEach((outputFilePath) => {
      const content = `${assets[outputFilePath]}`;
      const completeContent = indexHtmlContent.replace(indexHtmlReplaceRegex, `$1${content}$2`);

      compilation.assets[outputFilePath] = {
        source: function() {
          return completeContent;
        },
        size: function() {
          return completeContent.length;
        },
      };
    });

    cb();
  });
};

module.exports = SSRCodegenWebpackPlugin;
