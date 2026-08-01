import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const FORM_TAGS = new Set(['input', 'select', 'textarea']);
const CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);
const NON_FIELD_INPUT_TYPES = new Set(['button', 'hidden', 'image', 'reset', 'submit']);
const NON_TEXT_NAME_PATTERN = /(?:icon|spinner|loader|glyph|avatar|image|logo)$/i;

function elementAttributes(node) {
  if (ts.isJsxElement(node)) return node.openingElement.attributes.properties;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes.properties;
  return [];
}

function tagName(node) {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function attribute(node, name) {
  return elementAttributes(node).find(
    (item) => ts.isJsxAttribute(item) && item.name.getText().toLowerCase() === name,
  );
}

function attributeValue(node, name, sourceFile) {
  const item = attribute(node, name);
  if (!item || !ts.isJsxAttribute(item) || !item.initializer) return null;
  if (ts.isStringLiteral(item.initializer)) return item.initializer.text.trim();
  if (!ts.isJsxExpression(item.initializer) || !item.initializer.expression) return null;
  const expression = item.initializer.expression;
  if (ts.isStringLiteralLike(expression)) return expression.text.trim();
  return expression.getText(sourceFile).trim();
}

function hasAttribute(node, name) {
  return Boolean(attribute(node, name));
}

function hasNonEmptyAttribute(node, name, sourceFile) {
  const value = attributeValue(node, name, sourceFile);
  return value !== null && value !== "''" && value !== '""' && value !== 'undefined' && value !== 'null';
}

function associationKey(node, name, sourceFile) {
  const value = attributeValue(node, name, sourceFile);
  return value ? value.replace(/\s+/g, ' ') : null;
}

function isAriaHidden(node, sourceFile) {
  return attributeValue(node, 'aria-hidden', sourceFile) === 'true';
}

function isTextExpression(expression, sourceFile) {
  if (!expression) return false;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return isTextExpression(expression.expression, sourceFile);
  }
  if (ts.isStringLiteralLike(expression)) return expression.text.trim().length > 0;
  if (ts.isNumericLiteral(expression)) return true;
  if (ts.isTemplateExpression(expression)) {
    return (
      expression.head.text.trim().length > 0 ||
      expression.templateSpans.some((span) => isTextExpression(span.expression, sourceFile))
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isTextExpression(expression.whenTrue, sourceFile) &&
      isTextExpression(expression.whenFalse, sourceFile)
    );
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return isTextExpression(expression.right, sourceFile);
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return (
        isTextExpression(expression.left, sourceFile) &&
        isTextExpression(expression.right, sourceFile)
      );
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return (
        isTextExpression(expression.left, sourceFile) ||
        isTextExpression(expression.right, sourceFile)
      );
    }
    return false;
  }
  if (ts.isIdentifier(expression)) return !NON_TEXT_NAME_PATTERN.test(expression.text);
  if (ts.isPropertyAccessExpression(expression)) return !NON_TEXT_NAME_PATTERN.test(expression.name.text);
  if (ts.isCallExpression(expression)) {
    return !NON_TEXT_NAME_PATTERN.test(expression.expression.getText(sourceFile));
  }
  if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) {
    return hasAccessibleContent(expression, sourceFile);
  }
  if (ts.isJsxFragment(expression)) {
    return expression.children.some((child) => childHasAccessibleContent(child, sourceFile));
  }
  return false;
}

function childHasAccessibleContent(child, sourceFile) {
  if (ts.isJsxText(child)) return child.text.trim().length > 0;
  if (ts.isJsxExpression(child)) return isTextExpression(child.expression, sourceFile);
  if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
    return hasAccessibleContent(child, sourceFile);
  }
  return false;
}

function hasAccessibleContent(node, sourceFile) {
  if (isAriaHidden(node, sourceFile)) return false;
  if (
    hasNonEmptyAttribute(node, 'aria-label', sourceFile) ||
    hasNonEmptyAttribute(node, 'aria-labelledby', sourceFile)
  ) {
    return true;
  }

  const tag = tagName(node);
  if (tag === 'img') return hasNonEmptyAttribute(node, 'alt', sourceFile);
  if (/^(?:[A-Z].*)?(?:Icon|Spinner|Loader)$/.test(tag)) return false;
  if (ts.isJsxSelfClosingElement(node)) return false;
  return node.children.some((child) => childHasAccessibleContent(child, sourceFile));
}

function hasAccessibleName(node, sourceFile) {
  return (
    hasNonEmptyAttribute(node, 'aria-label', sourceFile) ||
    hasNonEmptyAttribute(node, 'aria-labelledby', sourceFile) ||
    hasNonEmptyAttribute(node, 'title', sourceFile) ||
    hasAccessibleContent(node, sourceFile)
  );
}

function isNamedControl(node, sourceFile) {
  const tag = tagName(node);
  const role = attributeValue(node, 'role', sourceFile);
  if (tag === 'button') return true;
  if (tag === 'a' && hasAttribute(node, 'href')) return true;
  if (tag === 'input' && NON_FIELD_INPUT_TYPES.has(attributeValue(node, 'type', sourceFile) ?? 'text')) {
    return attributeValue(node, 'type', sourceFile) !== 'hidden';
  }
  return role !== null && CONTROL_ROLES.has(role);
}

function isFormField(node, sourceFile) {
  const tag = tagName(node);
  if (FORM_TAGS.has(tag)) {
    return tag !== 'input' || !NON_FIELD_INPUT_TYPES.has(attributeValue(node, 'type', sourceFile) ?? 'text');
  }
  const role = attributeValue(node, 'role', sourceFile);
  return role !== null && ['combobox', 'searchbox', 'slider', 'spinbutton', 'textbox'].includes(role);
}

function isWrappedByLabel(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current) && tagName(current) === 'label') return true;
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) current = current.parent;
    else break;
  }
  return false;
}

function location(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: point.line + 1, column: point.character + 1 };
}

export function analyzeSource(sourceText, fileName = 'source.tsx') {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const labelTargets = new Set();
  const elements = [];

  function collect(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      elements.push(node);
      if (tagName(node) === 'label') {
        const target = associationKey(node, 'htmlfor', sourceFile);
        if (target) labelTargets.add(target);
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  const diagnostics = [];
  for (const node of elements) {
    if (isAriaHidden(node, sourceFile)) continue;
    const tag = tagName(node);
    if (isNamedControl(node, sourceFile) && !hasAccessibleName(node, sourceFile)) {
      diagnostics.push({
        ...location(sourceFile, node),
        kind: 'control-name',
        message: `<${tag}> has no statically verifiable accessible name`,
      });
    }
    if (isFormField(node, sourceFile)) {
      const id = associationKey(node, 'id', sourceFile);
      const labelled =
        hasNonEmptyAttribute(node, 'aria-label', sourceFile) ||
        hasNonEmptyAttribute(node, 'aria-labelledby', sourceFile) ||
        hasNonEmptyAttribute(node, 'title', sourceFile) ||
        isWrappedByLabel(node) ||
        (id !== null && labelTargets.has(id));
      if (!labelled) {
        diagnostics.push({
          ...location(sourceFile, node),
          kind: 'form-label',
          message: `<${tag}> has no statically associated label`,
        });
      }
    }
  }
  return diagnostics;
}

function sourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    else if (entry.name.endsWith('.tsx') && !/\.(?:test|spec)\.tsx$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

export function validateTree(root) {
  const diagnostics = [];
  for (const file of sourceFiles(root)) {
    const sourceText = fs.readFileSync(file, 'utf8');
    for (const issue of analyzeSource(sourceText, file)) diagnostics.push({ file, ...issue });
  }
  return diagnostics;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const diagnostics = validateTree(sourceRoot);
  for (const issue of diagnostics) {
    console.error(
      `${path.relative(process.cwd(), issue.file)}:${issue.line}:${issue.column} ` +
        `[${issue.kind}] ${issue.message}`,
    );
  }
  if (diagnostics.length > 0) {
    console.error(`\nAccessibility source gate failed with ${diagnostics.length} violation(s).`);
    process.exit(1);
  }
  console.log('Accessibility source gate passed.');
}
