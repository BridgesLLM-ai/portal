import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ChevronRight, ChevronDown, File, Folder, FolderOpen,
  Plus, Trash2, Edit3
} from 'lucide-react';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileNode[];
  size?: number;
  modified?: string;
}

interface FileTreeProps {
  files: FileNode[];
  selectedFile?: string;
  onFileSelect?: (file: FileNode) => void;
  onFileCreate?: (parentPath: string, type: 'file' | 'folder') => void;
  onFileDelete?: (file: FileNode) => void;
  onFileRename?: (file: FileNode, newName: string) => void;
  className?: string;
}

// Flatten tree for keyboard navigation
function flattenTree(nodes: FileNode[], parentExpanded = true): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.type === 'folder' && node.children && parentExpanded) {
      result.push(...flattenTree(node.children, true));
    }
  }
  return result;
}

function FileTreeNode({ 
  node, 
  level = 0, 
  selectedFile,
  focusedFile,
  onFileSelect, 
  onFileCreate, 
  onFileDelete, 
  onFileRename,
  onFocus,
  expandedFolders,
  setExpandedFolders,
}: {
  node: FileNode;
  level?: number;
  selectedFile?: string;
  focusedFile?: string;
  onFileSelect?: (file: FileNode) => void;
  onFileCreate?: (parentPath: string, type: 'file' | 'folder') => void;
  onFileDelete?: (file: FileNode) => void;
  onFileRename?: (file: FileNode, newName: string) => void;
  onFocus?: (nodeId: string) => void;
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const [hovering, setHovering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(node.name);
  const nodeRef = useRef<HTMLDivElement>(null);

  const expanded = expandedFolders.has(node.id);
  const isSelected = selectedFile === node.id;
  const isFocused = focusedFile === node.id;
  const hasChildren = node.children && node.children.length > 0;

  // Scroll into view when focused
  useEffect(() => {
    if (isFocused && nodeRef.current) {
      nodeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isFocused]);

  const handleClick = () => {
    if (node.type === 'folder') {
      setExpandedFolders(prev => {
        const next = new Set(prev);
        if (expanded) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    }
    onFileSelect?.(node);
    onFocus?.(node.id);
  };

  const handleRename = () => {
    if (editName.trim() && editName !== node.name) {
      onFileRename?.(node, editName.trim());
    }
    setEditing(false);
  };

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
        return '📄';
      case 'json':
        return '⚙️';
      case 'md':
        return '📝';
      case 'css':
      case 'scss':
        return '🎨';
      case 'html':
        return '🌐';
      case 'py':
        return '🐍';
      case 'jpg':
      case 'png':
      case 'gif':
        return '🖼️';
      default:
        return '📄';
    }
  };

  return (
    <>
      <motion.div
        ref={nodeRef}
        className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer select-none transition-all group
          ${isSelected ? 'bg-emerald-500/20 text-emerald-300' : ''}
          ${isFocused && !isSelected ? 'ring-2 ring-emerald-500/40 bg-white/5' : ''}
          ${!isSelected && !isFocused ? 'hover:bg-white/5' : ''}
        `}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onClick={handleClick}
        initial={false}
        whileHover={{ x: 2 }}
        tabIndex={0}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.type === 'folder' ? expanded : undefined}
        aria-label={`${node.type} ${node.name}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          } else if (e.key === 'ArrowRight' && node.type === 'folder' && !expanded) {
            e.preventDefault();
            setExpandedFolders(prev => new Set([...prev, node.id]));
          } else if (e.key === 'ArrowLeft' && node.type === 'folder' && expanded) {
            e.preventDefault();
            setExpandedFolders(prev => {
              const next = new Set(prev);
              next.delete(node.id);
              return next;
            });
          } else if (e.key === 'F2') {
            e.preventDefault();
            setEditing(true);
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (confirm(`Delete ${node.name}?`)) {
              onFileDelete?.(node);
            }
          }
        }}
      >
        {/* Expansion indicator */}
        <div className="w-4 h-4 flex items-center justify-center">
          {node.type === 'folder' && hasChildren && (
            expanded ? 
              <ChevronDown className="w-3 h-3 text-gray-400" /> : 
              <ChevronRight className="w-3 h-3 text-gray-400" />
          )}
        </div>

        {/* Icon */}
        <div className="w-4 h-4 flex items-center justify-center text-xs">
          {node.type === 'folder' ? (
            expanded ? <FolderOpen className="w-4 h-4 text-blue-400" /> : <Folder className="w-4 h-4 text-blue-400" />
          ) : (
            <span>{getFileIcon(node.name)}</span>
          )}
        </div>

        {/* Name */}
        {editing ? (
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="bg-slate-800 text-white px-2 py-1 rounded text-sm flex-1 min-w-0"
            autoFocus
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <span className="flex-1 truncate text-sm">{node.name}</span>
        )}

        {/* Actions */}
        <AnimatePresence>
          {hovering && !editing && (
            <motion.div 
              className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              {node.type === 'folder' && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onFileCreate?.(node.path, 'file');
                    }}
                    className="p-1 rounded hover:bg-white/10"
                    title="New file (Ctrl+N)"
                    aria-label="New file"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onFileCreate?.(node.path, 'folder');
                    }}
                    className="p-1 rounded hover:bg-white/10"
                    title="New folder"
                    aria-label="New folder"
                  >
                    <Folder className="w-3 h-3" />
                  </button>
                </>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                className="p-1 rounded hover:bg-white/10"
                title="Rename (F2)"
                aria-label="Rename"
              >
                <Edit3 className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete ${node.name}?`)) {
                    onFileDelete?.(node);
                  }
                }}
                className="p-1 rounded hover:bg-red-500/20 text-red-400"
                title="Delete (Del)"
                aria-label="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Children */}
      <AnimatePresence>
        {expanded && node.children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {node.children.map(child => (
              <FileTreeNode
                key={child.id}
                node={child}
                level={level + 1}
                selectedFile={selectedFile}
                focusedFile={focusedFile}
                onFileSelect={onFileSelect}
                onFileCreate={onFileCreate}
                onFileDelete={onFileDelete}
                onFileRename={onFileRename}
                onFocus={onFocus}
                expandedFolders={expandedFolders}
                setExpandedFolders={setExpandedFolders}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function FileTreeEnhanced({ 
  files, 
  selectedFile, 
  onFileSelect, 
  onFileCreate, 
  onFileDelete, 
  onFileRename,
  className = '' 
}: FileTreeProps) {
  const [focusedFile, setFocusedFile] = useState<string | undefined>(selectedFile);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const treeRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!treeRef.current?.contains(document.activeElement)) return;

      const flatList = flattenTree(files);
      const currentIndex = flatList.findIndex(n => n.id === focusedFile);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = Math.min(flatList.length - 1, currentIndex + 1);
        setFocusedFile(flatList[nextIndex]?.id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = Math.max(0, currentIndex - 1);
        setFocusedFile(flatList[prevIndex]?.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [files, focusedFile]);

  // Initialize expanded folders (expand first 2 levels)
  useEffect(() => {
    const expandFirstLevels = (nodes: FileNode[], level = 0): string[] => {
      if (level >= 2) return [];
      const ids: string[] = [];
      for (const node of nodes) {
        if (node.type === 'folder' && node.children) {
          ids.push(node.id);
          ids.push(...expandFirstLevels(node.children, level + 1));
        }
      }
      return ids;
    };
    setExpandedFolders(new Set(expandFirstLevels(files)));
  }, [files]);

  return (
    <div
      ref={treeRef}
      className={`space-y-1 ${className}`}
      role="tree"
      aria-label="File tree"
    >
      {files.map(file => (
        <FileTreeNode
          key={file.id}
          node={file}
          selectedFile={selectedFile}
          focusedFile={focusedFile}
          onFileSelect={onFileSelect}
          onFileCreate={onFileCreate}
          onFileDelete={onFileDelete}
          onFileRename={onFileRename}
          onFocus={setFocusedFile}
          expandedFolders={expandedFolders}
          setExpandedFolders={setExpandedFolders}
        />
      ))}
    </div>
  );
}
