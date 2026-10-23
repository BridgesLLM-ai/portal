import { describe, expect, it } from 'vitest';
import { rewriteWidgetDirectives, widgetPresentationFor } from './widgetPresentation';
import type { ChatMessage, ToolCall } from '../../../contexts/ChatStateProvider';
const directive = '[embed ref="cv_owned" title="Counter" height="160" /]';
const tool: ToolCall = { id: 'call-owned', name: 'show_widget', startedAt: 1, status: 'done', result: JSON.stringify({
  schema: 'bridgesllm.widget-ref.v1', toolCallId: 'call-owned', title: 'Counter', mode: 'inline', presentationRef: 'cv_owned' }) };
const message = (content: string, toolCalls: ToolCall[] = []): ChatMessage => ({ id: 'm', role: 'assistant', content, toolCalls, createdAt: new Date() });
const consume = (s: string) => rewriteWidgetDirectives(s, p => p.ref === 'cv_owned');
describe('native widget presentation across assistant messages', () => {
  it('consumes standalone directives and preserves adjacent prose', () => {
    expect(consume(directive)).toBe('');
    expect(consume(`Before\n\n${directive}\n\nAfter`)).toBe('Before\n\n\n\nAfter');
    expect(consume(`Before\n${directive}\nAfter`)).toBe('Before\n\nAfter');
    expect(consume(directive.replace(' /]', ']'))).toBe('');
  });
  it.each(['\r\n', '\r'])('preserves original %j line endings and prose bytes', newline => {
    const input = ['Before', '', directive, '', 'After'].join(newline);
    expect(consume(input)).toBe(['Before', '', '', '', 'After'].join(newline));
    const unknown = input.replace('cv_owned', 'cv_unknown');
    expect(consume(unknown)).toBe(unknown);
  });
  it.each([
    '`'+directive+'`', '```text\n'+directive+'\n```', '~~~\n'+directive+'\n~~~',
    '    '+directive, '> '+directive, '<pre>\n'+directive+'\n</pre>',
    '`before\n'+directive+'\nafter`', 'Explain '+directive, '[example]('+directive+')',
    directive.replace('cv_owned','cv_unknown'), directive.replace('height="160"','height="auto"'),
    directive.replace('height="160"','height="-1"'), directive.replace('height="160"','height="160" height="200"'),
    directive.replace('height="160"','onload="alert(1)"'), directive.replace('cv_owned','../owned'), directive.slice(0,-1),
  ])('retains examples, partial/invalid and unmatched markup: %s', text => { expect(consume(text)).toBe(text); });
  it('correlates separate messages and height after history reload', () => {
    const history=[message('',[tool]),message(directive)], p=widgetPresentationFor(history);
    expect([...p.refs]).toEqual(['cv_owned']);expect(p.heights.get('call-owned')).toBe(160);
    const replay=widgetPresentationFor(JSON.parse(JSON.stringify(history)));
    expect([...replay.refs]).toEqual([...p.refs]);expect([...replay.heights]).toEqual([...p.heights]);
  });
  it('takes late live presentation without changing the original binding', () => {
    expect(widgetPresentationFor([message('',[tool])]).heights.size).toBe(0);
    expect(widgetPresentationFor([message('',[tool])],[{text:directive}]).heights.get(tool.id)).toBe(160);
  });
  it('does not bind user text, arbitrary tool text, failed results or another conversation', () => {
    for (const candidate of [{...tool,name:'exec'},{...tool,status:'error' as const},{...tool,status:'running' as const}])
      expect(widgetPresentationFor([message(directive,[candidate])]).refs.size).toBe(0);
    expect(widgetPresentationFor([{...message(directive,[tool]),role:'user'}]).refs.size).toBe(0);
    expect(widgetPresentationFor([message(directive)]).refs.size).toBe(0);
    expect(widgetPresentationFor([message('',[tool]),{...message(directive),role:'user'}]).heights.size).toBe(0);
    expect(widgetPresentationFor([message('',[tool])],[{text:directive,kind:'thinking'}]).heights.size).toBe(0);
  });
  it('refuses ambiguous references and bounds height', () => {
    const second={...tool,id:'call-other',result:tool.result!.replace('call-owned','call-other')};
    expect(widgetPresentationFor([message(directive,[tool,second])]).refs.size).toBe(0);
    expect(widgetPresentationFor([message(directive.replace('160','9999'),[tool])]).heights.get(tool.id)).toBe(720);
    expect(widgetPresentationFor([message(directive.replace('160','1'),[tool])]).heights.get(tool.id)).toBe(120);
  });
});
