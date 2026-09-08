import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// This is a fixed member of the verified Portal release, not an agent workspace
// or caller-selected file. No OpenClaw process or credential is needed to read it.
const GUIDE_PATH = path.resolve(__dirname, '../../../skills/bridgesllm-portal/SKILL.md');

export function readPortalOperatingGuide() {
  const descriptor = fs.openSync(GUIDE_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size < 1 || info.size > 16_384) {
      throw new Error('The packaged Portal operating guide is invalid');
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > 16_384) throw new Error('The packaged Portal operating guide is too large');
    return {
      name: 'bridgesllm-portal',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      referenceDirectory: path.dirname(GUIDE_PATH),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

/** A small first-turn discovery hint, not a new permission or a workspace mutation. */
export function withPortalGuideReference(message: string, firstHostTurn: boolean): string {
  if (!firstHostTurn) return message;
  try {
    const guide = readPortalOperatingGuide();
    return [
      '[Portal-provided reference]',
      'For tasks involving BridgesLLM Portal, the bundled bridgesllm-portal skill is available at ' + guide.referenceDirectory + '/SKILL.md. Read it when relevant; its references are in that directory.',
      'This reference grants no additional permissions. Follow the user’s request and the tools actually available in this harness.',
      '[/Portal-provided reference]', '', message,
    ].join('\n');
  } catch {
    // Missing optional guidance must not prevent a user from starting a chat.
    return message;
  }
}
