import React from 'react';
import {
  Bot,
  Brain,
  Cloud,
  FileText,
  Globe,
  Image,
  List,
  MessageSquare,
  Mic,
  Monitor,
  Pencil,
  Radio,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { getToolPresentation } from '../../utils/toolPresentation';

export default function ToolGlyph({
  toolName,
  toolArguments,
  size = 12,
  className,
}: {
  toolName: string;
  toolArguments?: unknown;
  size?: number;
  className?: string;
}) {
  const presentation = getToolPresentation(toolName, toolArguments);

  switch (presentation.key) {
    case 'bridgesllm':
      return <img src="/favicon-192.png" alt="BridgesLLM" width={size} height={size} className={`shrink-0 object-contain ${className || ''}`} />;
    case 'read':
      return <FileText size={size} className={className} />;
    case 'write':
    case 'edit':
      return <Pencil size={size} className={className} />;
    case 'exec':
      return <Terminal size={size} className={className} />;
    case 'process':
      return <List size={size} className={className} />;
    case 'search':
      return <Search size={size} className={className} />;
    case 'fetch':
      return <Globe size={size} className={className} />;
    case 'browser':
      return <Monitor size={size} className={className} />;
    case 'gateway':
      return <Radio size={size} className={className} />;
    case 'memory':
      return <Brain size={size} className={className} />;
    case 'media':
      return <Image size={size} className={className} />;
    case 'message':
      return <MessageSquare size={size} className={className} />;
    case 'voice':
      return <Mic size={size} className={className} />;
    case 'session':
      return <Bot size={size} className={className} />;
    case 'weather':
      return <Cloud size={size} className={className} />;
    default:
      return <Wrench size={size} className={className} />;
  }
}
