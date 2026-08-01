import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const THEMES = ['dark', 'light'];
const MINIMUM_NORMAL_TEXT_RATIO = 4.5;

function staticAttributeValue(node, name, sourceFile) {
  const attributes = ts.isJsxElement(node)
    ? node.openingElement.attributes.properties
    : node.attributes.properties;
  const attribute = attributes.find(
    (item) => ts.isJsxAttribute(item) && item.name.getText(sourceFile) === name,
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text.trim();
  if (
    ts.isJsxExpression(attribute.initializer)
    && attribute.initializer.expression
    && ts.isStringLiteralLike(attribute.initializer.expression)
  ) {
    return attribute.initializer.expression.text.trim();
  }
  return null;
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

function contrastControls(sourceRoot) {
  const controls = [];
  const diagnostics = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const contract = staticAttributeValue(node, 'data-contrast-check', sourceFile);
        if (contract) {
          const className = staticAttributeValue(node, 'className', sourceFile);
          const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const location = `${path.relative(process.cwd(), file)}:${point.line + 1}:${point.character + 1}`;
          if (!className) {
            diagnostics.push(`${location} [contrast-contract] ${contract} needs a static className`);
          } else {
            controls.push({ contract, className, location });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return { controls, diagnostics };
}

function parseColor(value) {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([\da-f]{6})$/i);
  if (hex) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = normalized.match(/^rgba?\(\s*(\d+)(?:\s+|,\s*)(\d+)(?:\s+|,\s*)(\d+)(?:\s*\/\s*|,\s*)?([\d.]+)?\s*\)$/);
  if (!rgb) return null;
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

function resolveColor(value, controlStyle, rootStyle) {
  let resolved = value.trim();
  const seen = new Set();
  while (resolved.includes('var(')) {
    let replaced = false;
    resolved = resolved.replace(
      /var\(\s*(--[-\w]+)(?:\s*,\s*([^)]+))?\s*\)/g,
      (_expression, property, fallback = '') => {
        if (seen.has(property)) return '';
        seen.add(property);
        replaced = true;
        return (
          controlStyle.getPropertyValue(property)
          || rootStyle.getPropertyValue(property)
          || fallback
        ).trim();
      },
    );
    if (!replaced) return null;
  }
  return parseColor(resolved);
}

function linearChannel(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (
    0.2126 * linearChannel(color.r)
    + 0.7152 * linearChannel(color.g)
    + 0.0722 * linearChannel(color.b)
  );
}

function contrastRatio(first, second) {
  const bright = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (bright + 0.05) / (dark + 0.05);
}

function compiledCss(distRoot) {
  const assetsRoot = path.join(distRoot, 'assets');
  if (!fs.existsSync(assetsRoot)) {
    throw new Error(`Compiled frontend assets are missing at ${assetsRoot}; run the build first.`);
  }
  const files = fs.readdirSync(assetsRoot)
    .filter((name) => name.endsWith('.css'))
    .sort();
  if (files.length === 0) throw new Error(`No compiled CSS bundles found in ${assetsRoot}.`);
  return files.map((name) => fs.readFileSync(path.join(assetsRoot, name), 'utf8')).join('\n');
}

export function validateContrast({ sourceRoot, distRoot }) {
  const { controls, diagnostics } = contrastControls(sourceRoot);
  if (controls.length === 0) {
    diagnostics.push('No data-contrast-check controls were found; the themed contrast gate cannot be empty.');
    return diagnostics;
  }

  const css = compiledCss(distRoot);
  for (const control of controls) {
    for (const theme of THEMES) {
      const dom = new JSDOM(
        `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body><button class="${control.className}">Contrast probe</button></body></html>`,
        { pretendToBeVisual: true },
      );
      const rootStyle = dom.window.getComputedStyle(dom.window.document.documentElement);
      const controlStyle = dom.window.getComputedStyle(dom.window.document.querySelector('button'));
      const foreground = resolveColor(controlStyle.color, controlStyle, rootStyle);
      const background = resolveColor(controlStyle.backgroundColor, controlStyle, rootStyle);
      dom.window.close();

      if (!foreground || !background || foreground.a !== 1 || background.a !== 1) {
        diagnostics.push(
          `${control.location} [contrast-${theme}] ${control.contract} must compile to opaque foreground and background colors `
          + `(got color=${controlStyle.color || 'unset'}, background=${controlStyle.backgroundColor || 'unset'})`,
        );
        continue;
      }
      const ratio = contrastRatio(foreground, background);
      if (ratio < MINIMUM_NORMAL_TEXT_RATIO) {
        diagnostics.push(
          `${control.location} [contrast-${theme}] ${control.contract} is ${ratio.toFixed(2)}:1; `
          + `${MINIMUM_NORMAL_TEXT_RATIO.toFixed(1)}:1 is required`,
        );
      }
    }
  }
  return diagnostics;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let diagnostics;
  try {
    diagnostics = validateContrast({
      sourceRoot: path.join(frontendRoot, 'src'),
      distRoot: path.join(frontendRoot, 'dist'),
    });
  } catch (error) {
    console.error(`Themed interactive-control contrast gate failed: ${error.message}`);
    process.exit(1);
  }
  for (const issue of diagnostics) console.error(issue);
  if (diagnostics.length > 0) {
    console.error(`\nThemed interactive-control contrast gate failed with ${diagnostics.length} violation(s).`);
    process.exit(1);
  }
  console.log(`Themed interactive-control contrast gate passed for ${THEMES.join(' and ')} themes.`);
}
