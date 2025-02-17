const _ = require('lodash');
const compiler = require('vue-template-compiler');
const ts = require('typescript');
const { getSpecifiedFiles, readFile } = require('./file');
const { getProjectConfig } = require('./config');
const { yellow } = require('chalk');

const CONFIG = getProjectConfig();
const DOUBLE_BYTE_REGEX = /[^\x00-\xff]/g;
const PART_DOUBLE_BYTE_REGEX = /[^\x00-\xff]+/g;

function findTextInTemplate(code) {
  const matches = [];

  const { ast } = compiler.compile(code, {
    outputSourceRange: true,
    whitespace: 'preserve',
  });

  function visitAttr(attr) {
    const { name, value, start, end } = attr;
    if (value && value.match(DOUBLE_BYTE_REGEX)) {
      matches.push({
        range: { start, end },
        text: value,
        name,
        isAttr: true,
        isTemplate: true,
        isInMustache: false
      });
    }
  }

  function visit(node) {
    const { type, text, start } = node;
    if ((type === 3 || type === 2) && text && text.match(DOUBLE_BYTE_REGEX)) {
      const pureTexts = getPureText(text, 'template')
      pureTexts.forEach(pureText => {
        matches.push({
          range: { start: start + pureText.start, end: start + pureText.start + pureText.text.length },
          text: pureText.text,
          isAttr: false,
          isTemplate: true,
          isInMustache: pureText.isInMustache,
          inInTemplateString: pureText.inInTemplateString
        });
      })
    }

    if (node.attrsList && node.attrsList.length) {
      node.attrsList.forEach(visitAttr);
    }

    if (node.scopedSlots) {
      node.children = Object.values(node.scopedSlots);
      node.children.forEach(visit);
    } else if (
      node.ifConditions &&
      node.ifConditions.filter((item) => item.block.end !== node.end).length > 0
    ) {
      node.ifConditions
        .filter((item) => item.block.end !== node.end)
        .map((item) => item.block)
        .forEach(visit);
      node.children.forEach(visit);
    } else if (node.children && node.children.length) {
      node.children.forEach(visit);
    }
  }

  visit(ast);

  return matches;
}

function findTextInJs(code) {
  const matches = [];
  const ast = ts.createSourceFile(
    '',
    code,
    ts.ScriptTarget.ES2015,
    true,
    ts.ScriptKind.TSX
  );

  function visit(node) {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral: {
        /** 判断 Ts 中的字符串含有中文 */
        const { text } = node;
        if (text.match(DOUBLE_BYTE_REGEX)) {
          const start = node.getStart();
          const end = node.getEnd();
          const range = { start, end };
          matches.push({
            range,
            text,
            isAttr: false,
          });
        }
        break;
      }
      case ts.SyntaxKind.TemplateExpression: {
        // 模板字符串情况
        const { pos, end } = node;
        const templateContent = code.slice(pos, end);

        if (templateContent.match(DOUBLE_BYTE_REGEX)) {
          const pureTexts = getPureText(templateContent, 'js')
          const start = node.getStart();
          pureTexts.forEach(pureText => {
            matches.push({
              range: { start: start + pureText.start, end: start + pureText.start + pureText.text.length },
              text: pureText.text,
              isAttr: false,
              isTemplate: false,
              isInMustache: false,
              inInTemplateString: true
            });
          })
        }
        break;
      }
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
        const { pos, end } = node;
        const templateContent = code.slice(pos, end);

        if (templateContent.match(DOUBLE_BYTE_REGEX)) {
          const start = node.getStart();
          const end = node.getEnd();
          const range = { start, end };
          matches.push({
            range,
            text: code.slice(start + 1, end - 1),
            isAttr: false,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(ast, visit);

  return matches;
}

/**
 * 从AST节点text中提取出纯文字内容
 * @param {*} text 原始文本
 * @param {*} from 文本来源 template | js
 * @returns 纯文本数组
 */
function getPureText(text, from) {
  let matchTexts = text.match(PART_DOUBLE_BYTE_REGEX) ?? []
  if (from === 'js') {
    matchTexts = matchTexts.filter(matchText => {
      // 模板字符串${}中出现的"文字"将被重复计入，在这里去掉
      return !text.match(new RegExp(`["']\s*${matchText}\s*["']`, 'g'))
    })
  }

  return matchTexts.map(matchText => {
    const isInMustache = from === 'template' ? !!text.match(new RegExp(`\\{\\{((.|\\n|\\r)(?!}}))*${matchText}((.|\\n|\\r)(?!\\{\\{))*}}`, 'g')) : false
    const left = text.split(matchText)[0]
    const backQuoteNum = left.split('').filter(t => t === '`').length
    const inInTemplateString = !!(backQuoteNum % 2)
    return {
      start: text.indexOf(matchText),
      text: matchText,
      isInMustache,
      inInTemplateString
    }
  })
}

function findChineseText(filePath) {
  const fileContent = readFile(filePath);
  if (!fileContent) {
    return [];
  }
  if (filePath.endsWith('.vue')) {
    const { template, script } = compiler.parseComponent(fileContent);
    const textInTemplate = template ? findTextInTemplate(template.content) : [];
    const textInJs = script ? findTextInJs(script.content) : [];
    return [...textInTemplate, ...textInJs];
  } else if (filePath.endsWith('.js') || filePath.endsWith('.ts')) {
    return findTextInJs(fileContent);
  }
}

function findAllChineseText(dirPath) {
  const filesPath = getSpecifiedFiles(
    dirPath,
    CONFIG.ignoreDir,
    CONFIG.ignoreFile
  );
  const filterFiles = filesPath.filter((filePath) => {
    return (
      filePath.endsWith('.vue') ||
      filePath.endsWith('.js') ||
      filePath.endsWith('.ts')
    );
  });
  const allTexts = filterFiles.reduce((all, filePath) => {
    const texts = findChineseText(filePath);
    // 调整文案顺序，保证从后面的文案往前替换，避免位置更新导致替换出错
    const sortTexts = _.sortBy(texts, (obj) => -obj.range.start);

    if (texts.length > 0) {
      console.log(`发现中文文案：${yellow(filePath)} `);
    }

    return texts.length > 0 ? all.concat({ filePath, texts: sortTexts }) : all;
  }, []);

  return allTexts;
}

module.exports = { findAllChineseText };
